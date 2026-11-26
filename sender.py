"""Local GRBL 1.1 sender and serial-free simulator."""

import math
import re
import threading
import time
from collections import deque
from dataclasses import asdict, dataclass
from pathlib import Path
from uuid import uuid4

COMMENT = re.compile(r"\([^()]*\)")
WORD = re.compile(r"([A-Z])([+-]?(?:\d+(?:\.\d*)?|\.\d+))")
LINE = re.compile(r"(?:[A-Z][+-]?(?:\d+(?:\.\d*)?|\.\d+))+")
MAX_PROGRAM_BYTES = 2_000_000
BAUD_RATES = (9600, 19200, 38400, 57600, 115200, 230400, 250000)
JOG_CANCEL = b"\x85"
JOG_LEASE = 0.5


def jog_feed(value):
    if type(value) not in (int, float) or not 1 <= value <= 30000:
        raise ValueError("Подача должна быть от 1 до 30 000 мм/мин.")
    return value


def clean_line(source):
    line = COMMENT.sub("", source.split(";", 1)[0])
    line = re.sub(r"[ \t]", "", line).upper()
    if line in ("", "%"):
        return ""
    if len(line) > 79:
        raise ValueError("Строка превышает лимит GRBL в 79 символов.")
    if not LINE.fullmatch(line):
        raise ValueError("Строка содержит неподдерживаемую команду или символ.")
    return line


def parse_program(source):
    if not isinstance(source, str) or len(source.encode("utf-8")) > MAX_PROGRAM_BYTES:
        raise ValueError("Допустимый размер программы — до 2 МБ.")
    rows = []
    for number, original in enumerate(source.removeprefix("\ufeff").splitlines(), 1):
        try:
            command = clean_line(original)
        except ValueError as error:
            raise ValueError(f"Строка {number}. {error}") from error
        if command:
            rows.append((number, command))
    if not rows:
        raise ValueError("В файле нет команд G-кода.")
    return rows


def serial_ports():
    try:
        from serial.tools import list_ports
    except ImportError:
        return [], False
    return [
        {"id": port.device, "label": f"{port.device} · {port.description}"}
        for port in sorted(list_ports.comports())
    ], True


def open_serial(port, baud):
    try:
        import serial
    except ImportError as error:
        raise ValueError("Для USB установите pyserial из requirements.txt.") from error
    link = serial.Serial(baudrate=baud, timeout=0, write_timeout=0.3)
    link.port = port
    link.dtr = False
    link.rts = False
    link.open()
    return link


class Simulator:
    def __init__(self):
        self.lines = deque()
        self.machine = [0.0, 0.0, 0.0]
        self.offset = [0.0, 0.0, 0.0]
        self.state = "Idle"
        self.finish = 0.0
        self.absolute = True
        self.scale = 1.0
        self.feed = 0.0
        self.motion = 0
        self.spindle = 0.0
        self.spindle_on = False
        self.report_inches = False
        self.homing_enabled = True
        self.feed_override = 100
        self.jog_queue = deque()
        self.jog_origin = self.jog_target = None
        self.jog_started = 0.0

    def read(self, _size):
        return self.lines.popleft() if self.lines else b""

    def close(self):
        self.lines.clear()

    def write(self, data):
        now = time.monotonic()
        self.advance_jog(now)
        if self.state in ("Run", "Home") and now >= self.finish:
            self.state = "Idle"
        if data == JOG_CANCEL:
            self.jog_queue.clear()
            self.jog_target = None
            if self.state == "Jog":
                self.state = "Idle"
            return 1
        adjustments = {0x91: 10, 0x92: -10, 0x93: 1, 0x94: -1}
        if len(data) == 1 and data[0] in (0x90, *adjustments):
            self.feed_override = 100 if data[0] == 0x90 else max(10, min(200, self.feed_override + adjustments[data[0]]))
            return 1
        data = data.decode("ascii")
        if data == "?":
            divisor = 25.4 if self.report_inches else 1
            precision = 4 if self.report_inches else 3
            position = ",".join(f"{value / divisor:.{precision}f}" for value in self.machine)
            offset = ",".join(f"{value / divisor:.{precision}f}" for value in self.offset)
            feed = self.feed if self.state in ("Run", "Jog") else 0
            if self.state == "Run":
                feed *= self.feed_override / 100
            spindle = self.spindle if self.spindle_on else 0
            self.lines.append(
                f"<{self.state}|MPos:{position}|FS:{feed / divisor:.{0 if divisor == 1 else 1}f},{spindle:.0f}"
                f"|WCO:{offset}|Ov:{self.feed_override},100,100>\n".encode()
            )
        elif data == "!":
            if self.state in ("Run", "Jog", "Idle"):
                self.state = "Hold:0"
        elif data == "~":
            if self.state.startswith("Hold"):
                self.state = "Run"
                self.finish = now + 0.08
        elif data == "\x18":
            self.state = "Idle"
            self.absolute = True
            self.scale = 1.0
            self.spindle_on = False
            self.feed_override = 100
            self.jog_queue.clear()
            self.jog_target = None
            self.lines.append(b"Grbl 1.1h [Simulator]\n")
        else:
            self.execute(data.strip(), now)
        return len(data)

    def start_jog(self, target, feed, now):
        self.jog_started, self.jog_origin, self.jog_target = now, self.machine[:], target
        self.feed = feed
        self.finish = now + max(.025, math.dist(self.machine, target) * 60 / feed)
        self.state = "Jog"

    def advance_jog(self, now):
        while self.jog_target is not None and now >= self.finish:
            self.machine = self.jog_target
            self.jog_target = None
            if self.jog_queue:
                self.start_jog(*self.jog_queue.popleft(), self.finish)
            else:
                self.state = "Idle"
        if self.jog_target is not None:
            fraction = (now - self.jog_started) / (self.finish - self.jog_started)
            self.machine = [a + (b - a) * fraction for a, b in zip(self.jog_origin, self.jog_target)]

    def execute(self, command, now):
        if command == "$$":
            self.lines.append(
                f"$13={int(self.report_inches)}\n$20=0\n$21=0\n$22={int(self.homing_enabled)}\n"
                "$110=5000.000\n$111=5000.000\n".encode()
            )
        elif command.startswith("$13="):
            self.report_inches = bool(float(command[4:]))
        elif command.startswith("$22="):
            self.homing_enabled = bool(float(command[4:]))
        elif command == "$H":
            if not self.homing_enabled:
                self.lines.append(b"error:5\n")
                return
            self.machine = [0.0, 0.0, 0.0]
            self.state, self.finish = "Home", now + 0.45
        elif command == "$X":
            self.state = "Idle"
        elif command.startswith("$J="):
            words = {key: float(value) for key, value in WORD.findall(command)}
            scale = 25.4 if "G20" in command else 1
            relative = "G91" in command
            planned = self.jog_queue[-1][0] if self.jog_queue else self.jog_target or self.machine
            target = [
                words[axis] * scale + (planned[index] if relative else self.offset[index]) if axis in words else planned[index]
                for index, axis in enumerate("XYZ")
            ]
            if self.jog_target is None:
                self.start_jog(target, words["F"] * scale, now)
            else:
                self.jog_queue.append((target, words["F"] * scale))
        else:
            words = [(key, float(value)) for key, value in WORD.findall(command)]
            args = dict(words)
            g_codes = {value for key, value in words if key == "G"}
            for motion in (0, 1, 2, 3):
                if motion in g_codes:
                    self.motion = motion
            if 90 in g_codes or 91 in g_codes:
                self.absolute = 90 in g_codes
            if 20 in g_codes or 21 in g_codes:
                self.scale = 25.4 if 20 in g_codes else 1
            absolute, scale = self.absolute, self.scale
            self.feed = args.get("F", self.feed / scale) * scale
            self.spindle = args.get("S", self.spindle)
            if args.get("M") in (3, 4, 5):
                self.spindle_on = args["M"] in (3, 4)
            for index, axis in enumerate("XYZ"):
                if axis not in args:
                    continue
                value = args[axis] * scale
                if 10 in g_codes or 92 in g_codes:
                    self.offset[index] = self.machine[index] - value
                elif absolute:
                    self.machine[index] = value + (0 if 53 in g_codes else self.offset[index])
                else:
                    self.machine[index] += value
            if any(axis in args for axis in "XYZ") and not (g_codes & {10, 92}):
                self.state, self.finish = "Run", now + 0.10
        self.lines.append(b"ok\n")


@dataclass
class Job:
    total: int
    id: str = ""
    start_position: list | None = None
    acknowledged: int = 0
    line: int = 0
    status: str = "running"
    detail: str = ""
    started_at: float = 0.0
    finished_at: float = 0.0


@dataclass
class HeldJog:
    token: str
    axis: str
    feed: float
    step: float
    position_field: str
    target: float
    expires: float


class Sender:
    """One acknowledged command at a time. Real-time bytes bypass that queue."""

    def __init__(self, demo_path):
        self.lock = threading.RLock()
        self.closed = threading.Event()
        self.link = None
        self.port = None
        self.baud = None
        self.report_scale = None
        self.homing_enabled = None
        self.connected_at = 0.0
        self.state = "Offline"
        self.last_status = 0.0
        self.next_poll = 0.0
        self.resetting = False
        self.reset_deadline = 0.0
        self.position = self.machine = self.offset = None
        self.feed = self.spindle = 0
        self.feed_override = self.override_target = self.override_wait = None
        self.override_deadline = 0.0
        self.held_jog = None
        self.jog_motion = self.jog_cancel_after_reply = False
        self.pause_requested_at = 0.0
        self.receive = b""
        self.pending = None
        self.pending_deadline = 0.0
        self.awaiting_idle = False
        self.job = None
        self.job_trace = deque(maxlen=90)
        self.revision = uuid4().hex
        self.stop_requested_at = 0.0
        self.program_name = demo_path.name
        self.source = demo_path.read_text(encoding="utf-8")
        self.program = parse_program(self.source)
        self.log = deque(maxlen=150)
        self.log_index = 0
        self.log_message("system", "Файл примера загружен.")
        self.worker = threading.Thread(target=self.run, name="grbl-sender", daemon=True)
        self.worker.start()

    def log_message(self, kind, message):
        self.log_index += 1
        self.log.append({"id": self.log_index, "kind": kind, "text": message, "time": time.strftime("%H:%M:%S")})

    def connect(self, port, baud):
        if self.link:
            raise ValueError("Сначала отключите текущее соединение.")
        if not isinstance(port, str) or not port:
            raise ValueError("Выберите порт.")
        if baud not in BAUD_RATES:
            raise ValueError("Выберите поддерживаемую скорость порта.")
        if port != "simulator" and port not in {item["id"] for item in serial_ports()[0]}:
            raise ValueError("Порт не найден. Обновите список портов.")
        self.link = Simulator() if port == "simulator" else open_serial(port, baud)
        self.port = port
        self.baud = baud
        self.report_scale = 1 if port == "simulator" else None
        self.homing_enabled = True if port == "simulator" else None
        self.connected_at = time.monotonic()
        self.state = "Connecting"
        self.next_poll = 0.0
        self.last_status = 0.0
        self.log_message("system", "Симулятор подключён." if port == "simulator" else f"Порт {port} открыт · {baud} бод.")

    def disconnect(self, reason="Соединение закрыто."):
        if self.active():
            self.finish_job("error", reason)
        link, self.link = self.link, None
        if link:
            try:
                if self.jog_motion or self.held_jog:
                    link.write(JOG_CANCEL)
                link.close()
            except OSError:
                try:
                    link.close()
                except OSError:
                    pass
        self.port = None
        self.baud = None
        self.report_scale = None
        self.homing_enabled = None
        self.receive = b""
        self.pending = None
        self.awaiting_idle = self.resetting = False
        self.position = self.machine = self.offset = None
        self.feed = self.spindle = 0
        self.feed_override = self.override_target = self.override_wait = None
        self.held_jog = None
        self.jog_motion = self.jog_cancel_after_reply = False
        self.last_status = 0.0
        self.state = "Offline"
        self.log_message("system", reason)

    def fresh(self):
        return bool(self.link) and not self.resetting and (time.monotonic() - self.last_status) < 1.5

    def idle(self):
        return (self.fresh() and self.report_scale is not None and self.state == "Idle"
                and not self.pending and not self.awaiting_idle and not self.held_jog and not self.jog_motion)

    def active(self):
        return self.job is not None and self.job.status in {"running", "paused", "stopping"}

    def finish_job(self, status, detail=""):
        self.job.status = status
        self.job.detail = detail
        self.job.finished_at = time.monotonic()
        self.override_target = self.override_wait = None

    def pause_ready(self):
        return (self.job is not None and self.job.status == "paused" and self.fresh()
                and self.last_status > self.pause_requested_at
                and (self.state == "Hold:0" or (self.state == "Idle" and not self.pending)))

    def require_idle(self):
        if not self.idle() or self.active():
            raise ValueError("Команда доступна, когда GRBL в состоянии Idle и программа не запущена.")

    def write(self, data):
        try:
            if self.link.write(data) != len(data):
                raise OSError("Не все байты переданы.")
        except OSError as error:
            self.disconnect(f"Ошибка связи. {error}")
            raise ValueError("Соединение с контроллером прервано.") from error

    def realtime(self, data):
        self.write(data)
        self.next_poll = 0.0

    def send(self, command, role):
        timeout = 5 if role == "setup" else 600 if command == "$H" or (role == "job" and "G4" in command) else 90
        self.write(command.encode("ascii") + b"\n")
        self.pending = (role, command)
        self.pending_deadline = time.monotonic() + timeout
        if role in {"jog", "held-jog"}:
            self.jog_motion = True
        if role not in ("job", "setup", "held-jog"):
            self.log_message("send", command)

    def cancel_jog(self):
        self.held_jog = None
        self.jog_cancel_after_reply = bool(self.pending and self.pending[0] in {"jog", "held-jog"})
        self.awaiting_idle = True
        self.realtime(JOG_CANCEL)

    def advance_held_jog(self, now):
        jog = self.held_jog
        if jog is None:
            return
        if now >= jog.expires or not self.fresh() or self.state not in {"Jog", "Idle"}:
            self.cancel_jog()
            return
        position = getattr(self, jog.position_field)
        if not self.pending and position is not None and abs(jog.target - position["XYZ".index(jog.axis)]) <= abs(jog.step) * .45:
            self.send(f"$J=G91G21{jog.axis}{jog.step:.3f}F{jog.feed:.1f}", "held-jog")
            jog.target += jog.step

    def advance_override(self, now):
        target = self.override_target
        if target is None:
            return
        if self.feed_override == target:
            self.override_target = self.override_wait = None
            self.log_message("system", f"Подача программы установлена на {target}%.")
            return
        if now >= self.override_deadline:
            self.override_target = self.override_wait = None
            self.log_message("error", f"GRBL не подтвердил подачу {target}%. Проверьте текущий процент.")
            return
        if not self.pause_ready() or self.override_wait is not None or self.feed_override is None:
            return
        current = self.feed_override
        difference = target - current
        if target == 100:
            byte, expected = 0x90, 100
        elif abs(difference) >= 10:
            byte, expected = (0x91, current + 10) if difference > 0 else (0x92, current - 10)
        else:
            byte, expected = (0x93, current + 1) if difference > 0 else (0x94, current - 1)
        self.override_wait = expected
        self.override_deadline = now + 2.5
        self.realtime(bytes([byte]))

    def reset(self):
        self.realtime(b"\x18")
        self.pending = None
        self.awaiting_idle = False
        self.held_jog = None
        self.jog_motion = self.jog_cancel_after_reply = False
        self.feed_override = self.override_target = self.override_wait = None
        self.resetting = True
        self.reset_deadline = time.monotonic() + 5
        self.state = "Connecting"
        self.log_message("system", "GRBL отправлен программный сброс.")

    def command(self, action, data):
        with self.lock:
            return self.perform(action, data)

    def perform(self, action, data):
        if action == "connect":
            self.connect(data.get("port"), data.get("baud"))
        elif action == "disconnect":
            if self.active():
                raise ValueError("Сначала остановите программу.")
            self.disconnect()
        elif action == "upload":
            if self.active():
                raise ValueError("Дождитесь завершения текущей программы.")
            source = data.get("source")
            rows = parse_program(source)
            name = data.get("name")
            if not isinstance(name, str) or not name.strip():
                raise ValueError("Укажите имя файла.")
            self.program_name = Path(name.replace("\\", "/")).name[:180]
            self.source, self.program, self.job = source, rows, None
            self.job_trace.clear()
            self.revision = uuid4().hex
            self.log_message("system", f"Загружен файл {self.program_name} · {len(rows)} команд.")
            return self.file_info()
        elif action == "clear-log":
            self.log.clear()
        elif action == "jog-release":
            if self.held_jog and self.held_jog.token == data.get("token"):
                self.cancel_jog()
            return {}
        elif action == "jog-keep":
            if not self.held_jog or self.held_jog.token != data.get("token") or time.monotonic() >= self.held_jog.expires:
                raise ValueError("Ручное движение остановлено.")
            self.held_jog.expires = time.monotonic() + JOG_LEASE
            return {}
        elif not self.link:
            raise ValueError("Подключите контроллер или симулятор.")
        elif action == "start":
            self.require_idle()
            if data.get("revision") != self.revision:
                raise ValueError("Программа изменилась. Проверьте файл и запустите его снова.")
            self.job = Job(len(self.program), id=uuid4().hex, start_position=self.position, started_at=time.monotonic())
            self.job_trace.clear()
            self.log_message("system", f"Запуск программы {self.program_name}.")
        elif action == "pause":
            if not self.job or self.job.status != "running":
                raise ValueError("Нет запущенной программы.")
            self.realtime(b"!")
            self.job.status = "paused"
            self.pause_requested_at = time.monotonic()
            self.log_message("system", "Запрошена пауза.")
        elif action == "resume":
            if not self.pause_ready():
                raise ValueError("Дождитесь полной остановки перед продолжением.")
            if self.override_target is not None:
                raise ValueError("Дождитесь подтверждения подачи от GRBL.")
            if self.state == "Hold:0":
                self.realtime(b"~")
            self.job.status = "running"
            self.log_message("system", "Программа продолжена.")
        elif action == "feed-override":
            percent = data.get("percent")
            if type(percent) is not int or not 10 <= percent <= 200:
                raise ValueError("Укажите подачу от 10 до 200%.")
            if not self.pause_ready() or self.feed_override is None or self.override_target is not None:
                raise ValueError("Изменение подачи доступно после остановки и получения процента от GRBL.")
            if percent != self.feed_override:
                self.override_target = percent
                self.override_deadline = time.monotonic() + 2.5
        elif action == "stop":
            if not self.active() or self.job.status == "stopping":
                raise ValueError("Нет запущенной программы.")
            self.realtime(b"!")
            self.override_target = self.override_wait = None
            self.job.status = "stopping"
            self.stop_requested_at = time.monotonic()
            self.log_message("system", "Остановка. Ожидание завершения торможения.")
        elif action == "reset":
            self.reset()
            if self.active():
                self.finish_job("cancelled")
        elif action == "unlock":
            if not self.fresh() or self.report_scale is None or self.active() or self.pending or self.state != "Alarm":
                raise ValueError("Разблокировка доступна при активном Alarm.")
            self.send("$X", "manual")
        elif action in {"home", "read-settings"}:
            if (self.active() or self.pending or self.awaiting_idle or not self.fresh()
                    or self.report_scale is None or self.state not in {"Idle", "Alarm"}):
                raise ValueError("Дождитесь состояния Idle или Alarm и завершения текущей команды.")
            if action == "home" and self.homing_enabled is False:
                raise ValueError("Поиск машинного нуля выключен в GRBL ($22=0).")
            self.send("$H" if action == "home" else "$$", "manual")
        elif action == "zero":
            self.require_idle()
            axes = data.get("axes")
            if axes not in ("X", "Y", "Z", "XY", "XYZ"):
                raise ValueError("Выберите оси для обнуления.")
            self.send("G10L20P0" + "".join(axis + "0" for axis in axes), "manual")
        elif action in {"jog", "jog-hold"}:
            self.require_idle()
            axis = data.get("axis")
            feed = jog_feed(data.get("feed"))
            if axis not in ("X", "Y", "Z"):
                raise ValueError("Выберите ось X, Y или Z.")
            if action == "jog":
                step = data.get("step")
                if type(step) not in (float, int) or not 0.001 <= abs(step) <= 1000:
                    raise ValueError("Шаг должен быть от 0,001 до 1000 мм.")
                self.send(f"$J=G91G21{axis}{step:.3f}F{feed:.1f}", "jog")
            else:
                direction, token = data.get("direction"), data.get("token")
                if type(direction) is not int or direction not in (-1, 1) or not isinstance(token, str) or not re.fullmatch(r"[0-9a-f-]{36}", token):
                    raise ValueError("Неверная команда удержания.")
                field = "machine" if self.machine is not None else "position"
                position = getattr(self, field)
                if position is None:
                    raise ValueError("Дождитесь координат от GRBL.")
                step = round(direction * feed * .8 / 60, 3)
                self.send(f"$J=G91G21{axis}{step:.3f}F{feed:.1f}", "held-jog")
                self.held_jog = HeldJog(token, axis, feed, step, field, position["XYZ".index(axis)] + step, time.monotonic() + JOG_LEASE)
                self.log_message("send", f"Удержание {axis}{'+' if direction > 0 else '−'} · {feed:g} мм/мин")
        elif action == "jog-point":
            self.require_idle()
            x, y = data.get("x"), data.get("y")
            feed = jog_feed(data.get("feed"))
            if not all(type(value) in (float, int) and -1_000_000 <= value <= 1_000_000 for value in (x, y)):
                raise ValueError("Выберите допустимую точку XY.")
            if self.position is None:
                raise ValueError("Дождитесь рабочих координат от GRBL.")
            self.send(f"$J=G90G21X{x:.3f}Y{y:.3f}F{feed:.1f}", "jog")
        elif action == "jog-cancel":
            if not self.active() and (self.jog_motion or self.held_jog or self.state == "Jog"):
                self.cancel_jog()
        elif action == "console":
            self.require_idle()
            source = data.get("line")
            if not isinstance(source, str) or not 0 < len(source) <= 200:
                raise ValueError("Введите одну команду GRBL.")
            command = source.strip().upper()
            if command not in {"$$", "$#", "$G", "$I", "$N"} and not re.fullmatch(r"\$\d{1,3}=[+-]?\d+(?:\.\d+)?", command):
                command = clean_line(command)
            if not command:
                raise ValueError("Введите одну команду GRBL.")
            self.send(command, "manual")
        else:
            raise ValueError("Неизвестное действие.")
        return self.snapshot()

    def file_info(self):
        with self.lock:
            return {"name": self.program_name, "source": self.source, "lines": len(self.program), "revision": self.revision}

    def snapshot(self):
        with self.lock:
            job = None
            if self.job:
                job = {key: value for key, value in asdict(self.job).items() if key not in {"started_at", "finished_at"}}
                job["elapsed"] = int((self.job.finished_at or time.monotonic()) - self.job.started_at)
                job["trace"] = list(self.job_trace) if self.job.status != "complete" else []
            return {
                "revision": self.revision, "port": self.port, "baud": self.baud,
                "homing_enabled": self.homing_enabled,
                "jog_motion": self.jog_motion or self.held_jog is not None,
                "pause_ready": self.pause_ready(),
                "feed_override": self.feed_override,
                "override_target": self.override_target,
                "state": self.state if self.fresh() or not self.link else "Connecting",
                "ready": self.idle() and not self.active(),
                "busy": bool(self.pending or self.awaiting_idle or self.resetting or (self.link and self.report_scale is None)),
                "position": self.position if self.fresh() else None, "machine": self.machine if self.fresh() else None,
                "feed": self.feed if self.fresh() else 0, "spindle": self.spindle if self.fresh() else 0,
                "job": job, "log": list(self.log),
            }

    def status_report(self, line):
        state, *items = line[1:-1].split("|")
        if not state:
            return
        fields = dict(item.split(":", 1) for item in items if ":" in item)
        if "Ov" in fields:
            reported = fields["Ov"].split(",", 1)[0]
            if reported.isdecimal() and len(reported) <= 3:
                percent = int(reported)
                if 10 <= percent <= 200:
                    self.feed_override = percent
                    if percent == self.override_wait:
                        self.override_wait = None
        if self.report_scale is not None:
            try:
                vectors = {
                    key: [float(value) * self.report_scale for value in fields[key].split(",")[:3]]
                    for key in ("WCO", "MPos", "WPos") if key in fields
                }
                speeds = [float(value) for value in fields.get("FS", fields.get("F", "0")).split(",")]
                if any(len(values) != 3 or not all(map(math.isfinite, values)) for values in vectors.values()):
                    return
                if not all(map(math.isfinite, speeds)):
                    return
            except ValueError:
                return
            if "WCO" in vectors:
                self.offset = vectors["WCO"]
            if "MPos" in vectors:
                self.machine = vectors["MPos"]
                self.position = [a - b for a, b in zip(self.machine, self.offset)] if self.offset else None
            elif "WPos" in vectors:
                self.position = vectors["WPos"]
                self.machine = [a + b for a, b in zip(self.position, self.offset)] if self.offset else None
            self.feed = speeds[0] * self.report_scale
            self.spindle = speeds[1] if len(speeds) > 1 else 0
            if (self.active() and self.job.line and self.position is not None
                    and state.split(":", 1)[0] in {"Run", "Hold", "Idle"}
                    and ("MPos" in vectors or "WPos" in vectors)):
                point = tuple(self.position)
                last = self.job_trace[-1] if self.job_trace else None
                if last is None or last[2:] != point:
                    self.job_trace.append((last[0] + 1 if last else 1, self.job.line, *point))
        self.state, self.last_status = state, time.monotonic()
        if state in {"Idle", "Alarm"}:
            self.awaiting_idle = False
            if not self.pending or self.pending[0] not in {"jog", "held-jog"}:
                self.jog_motion = False

    def set_report_units(self, inches):
        scale = 25.4 if inches else 1
        if self.report_scale != scale:
            self.report_scale = scale
            self.position = self.machine = self.offset = None

    def on_line(self, line):
        if line.startswith("<") and line.endswith(">"):
            self.status_report(line)
            return
        if line.startswith("Grbl "):
            if self.active():
                self.finish_job("error", "Контроллер перезапустился.")
            self.pending = None
            self.awaiting_idle = False
            self.held_jog = None
            self.jog_motion = self.jog_cancel_after_reply = False
            self.feed_override = self.override_target = self.override_wait = None
            self.resetting = False
            self.last_status = 0.0
            self.connected_at = time.monotonic()
            self.report_scale = self.report_scale if self.port == "simulator" else None
            if self.port != "simulator":
                self.homing_enabled = None
            self.position = self.machine = self.offset = None
            self.next_poll = 0.0
        elif line.startswith("ALARM:"):
            self.state = "Alarm"
            self.last_status = time.monotonic()
            self.awaiting_idle = False
            if self.active():
                self.finish_job("error", line)
        elif line == "ok" or line.startswith("error:"):
            if self.pending:
                role, command = self.pending
                self.pending = None
                self.awaiting_idle = True
                self.next_poll = 0.0
                if role in {"jog", "held-jog"}:
                    if self.jog_cancel_after_reply:
                        self.jog_cancel_after_reply = False
                        self.realtime(JOG_CANCEL)
                    elif line != "ok" and self.held_jog:
                        self.cancel_jog()
                    if role == "held-jog" and line == "ok":
                        return
                if role == "setup":
                    if line != "ok" or self.report_scale is None:
                        self.disconnect("GRBL не сообщил единицы координат в настройке $13.")
                    else:
                        self.log_message("system", "GRBL ответил. Координаты отображаются в миллиметрах.")
                    return
                if command.startswith("$13=") and line == "ok":
                    self.set_report_units(bool(float(command[4:])))
                if command.startswith("$22=") and line == "ok":
                    self.homing_enabled = bool(float(command[4:]))
                if command == "$H" and line == "error:5":
                    self.homing_enabled = False
                    self.log_message("error", "error:5 · Поиск машинного нуля выключен в GRBL ($22=0).")
                    return
                if role == "job" and self.job:
                    if line == "ok":
                        self.job.acknowledged += 1
                        return
                    if self.active():
                        self.job.status = "stopping"
                        self.stop_requested_at = time.monotonic()
                        self.job.detail = f"Строка {self.job.line}. {line}"
                        self.realtime(b"!")
        elif line in {"$13=0", "$13=1"}:
            self.set_report_units(line.endswith("1"))
        elif line in {"$22=0", "$22=1"}:
            self.homing_enabled = line.endswith("1")
        if self.pending and self.pending[0] == "setup":
            return
        self.log_message("error" if line.startswith(("error:", "ALARM:")) else "receive", line)

    def tick(self):
        if not self.link:
            return
        chunk = self.link.read(4096)
        if chunk:
            self.receive += chunk
            while b"\n" in self.receive and self.link:
                raw, self.receive = self.receive.split(b"\n", 1)
                line = raw.decode("ascii", errors="replace").strip()
                if line:
                    self.on_line(line)
            if len(self.receive) > 16384:
                raise OSError("Контроллер передал слишком длинный ответ.")
        now = time.monotonic()
        if not self.link:
            return
        if self.resetting and now > self.reset_deadline:
            self.disconnect("GRBL не ответил после сброса.")
            return
        if not self.last_status and now - self.connected_at > 6:
            self.disconnect("GRBL не передал статус. Проверьте порт, скорость и прошивку.")
            return
        if self.pending and now > self.pending_deadline:
            if self.active():
                self.realtime(b"!")
            self.disconnect("Истекло время ожидания ответа GRBL.")
            return
        self.advance_held_jog(now)
        self.advance_override(now)
        if (self.active() and self.job.status == "stopping" and self.fresh()
                and self.last_status > self.stop_requested_at
                and (self.state == "Hold:0" or (self.state == "Idle" and not self.pending))):
            self.reset()
            self.finish_job("error" if self.job.detail else "cancelled", self.job.detail)
        if self.active() and self.job.status == "running" and not self.pending and self.fresh():
            if self.job.acknowledged == self.job.total:
                if self.state == "Idle" and not self.awaiting_idle:
                    self.finish_job("complete")
                    self.log_message("system", "Программа завершена.")
            elif self.state in {"Idle", "Run"}:
                number, command = self.program[self.job.acknowledged]
                self.job.line = number
                self.send(command, "job")
        if not self.pending and self.report_scale is None and self.fresh() and self.state in {"Idle", "Alarm"}:
            self.send("$$", "setup")
        if now >= self.next_poll:
            self.write(b"?")
            self.next_poll = now + 0.18

    def run(self):
        while not self.closed.wait(0.018):
            with self.lock:
                try:
                    self.tick()
                except OSError as error:
                    self.disconnect(f"Ошибка связи. {error}")
                except ValueError as error:
                    self.log_message("error", str(error))

    def close(self):
        self.closed.set()
        self.worker.join(timeout=2)
        with self.lock:
            if self.link:
                self.disconnect()
