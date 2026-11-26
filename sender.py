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

    def read(self, _size):
        return self.lines.popleft() if self.lines else b""

    def close(self):
        self.lines.clear()

    def write(self, data):
        data = data.decode("ascii")
        now = time.monotonic()
        if self.state in ("Run", "Jog", "Home") and now >= self.finish:
            self.state = "Idle"
        if data == "?":
            divisor = 25.4 if self.report_inches else 1
            precision = 4 if self.report_inches else 3
            position = ",".join(f"{value / divisor:.{precision}f}" for value in self.machine)
            offset = ",".join(f"{value / divisor:.{precision}f}" for value in self.offset)
            feed = self.feed if self.state in ("Run", "Jog") else 0
            spindle = self.spindle if self.spindle_on else 0
            self.lines.append(f"<{self.state}|MPos:{position}|FS:{feed / divisor:.{0 if divisor == 1 else 1}f},{spindle:.0f}|WCO:{offset}>\n".encode())
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
            self.lines.append(b"Grbl 1.1h [Simulator]\n")
        else:
            self.execute(data.strip(), now)
        return len(data)

    def execute(self, command, now):
        if command == "$$":
            self.lines.append(f"$13={int(self.report_inches)}\n".encode())
            self.lines.append(b"$20=0\n$21=0\n$22=0\n$110=5000.000\n$111=5000.000\n")
        elif command.startswith("$13="):
            self.report_inches = bool(float(command[4:]))
        elif command == "$H":
            self.machine = [0.0, 0.0, 0.0]
            self.state, self.finish = "Home", now + 0.45
        elif command == "$X":
            self.state = "Idle"
        else:
            jog = command.startswith("$J=")
            words = [(key, float(value)) for key, value in WORD.findall(command)]
            args = dict(words)
            g_codes = {value for key, value in words if key == "G"}
            for motion in (0, 1, 2, 3):
                if motion in g_codes and not jog:
                    self.motion = motion
            if jog:
                scale = 25.4 if 20 in g_codes else 1
                absolute = 91 not in g_codes
            else:
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
                self.state, self.finish = ("Jog" if jog else "Run"), now + 0.10
        self.lines.append(b"ok\n")


@dataclass
class Job:
    total: int
    acknowledged: int = 0
    line: int = 0
    status: str = "running"
    detail: str = ""
    started_at: float = 0.0
    finished_at: float = 0.0


class Sender:
    """One acknowledged command at a time. Real-time bytes bypass that queue."""

    def __init__(self, demo_path):
        self.lock = threading.RLock()
        self.closed = threading.Event()
        self.link = None
        self.port = None
        self.baud = None
        self.report_scale = None
        self.connected_at = 0.0
        self.state = "Offline"
        self.last_status = 0.0
        self.next_poll = 0.0
        self.resetting = False
        self.reset_deadline = 0.0
        self.position = self.machine = self.offset = None
        self.feed = self.spindle = 0
        self.receive = b""
        self.pending = None
        self.pending_deadline = 0.0
        self.awaiting_idle = False
        self.job = None
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
                link.close()
            except OSError:
                pass
        self.port = None
        self.baud = None
        self.report_scale = None
        self.receive = b""
        self.pending = None
        self.awaiting_idle = self.resetting = False
        self.position = self.machine = self.offset = None
        self.feed = self.spindle = 0
        self.last_status = 0.0
        self.state = "Offline"
        self.log_message("system", reason)

    def fresh(self):
        return bool(self.link) and not self.resetting and (time.monotonic() - self.last_status) < 1.5

    def idle(self):
        return self.fresh() and self.report_scale is not None and self.state == "Idle" and not self.pending and not self.awaiting_idle

    def active(self):
        return self.job is not None and self.job.status in {"running", "paused", "stopping"}

    def finish_job(self, status, detail=""):
        self.job.status = status
        self.job.detail = detail
        self.job.finished_at = time.monotonic()

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
        if role not in ("job", "setup"):
            self.log_message("send", command)

    def reset(self):
        self.realtime(b"\x18")
        self.pending = None
        self.awaiting_idle = False
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
            self.revision = uuid4().hex
            self.log_message("system", f"Загружен файл {self.program_name} · {len(rows)} команд.")
            return self.file_info()
        elif action == "clear-log":
            self.log.clear()
        elif not self.link:
            raise ValueError("Подключите контроллер или симулятор.")
        elif action == "start":
            self.require_idle()
            if data.get("revision") != self.revision:
                raise ValueError("Программа изменилась. Проверьте файл и запустите его снова.")
            self.job = Job(len(self.program), started_at=time.monotonic())
            self.log_message("system", f"Запуск программы {self.program_name}.")
        elif action == "pause":
            if not self.job or self.job.status != "running":
                raise ValueError("Нет запущенной программы.")
            self.realtime(b"!")
            self.job.status = "paused"
            self.log_message("system", "Запрошена пауза.")
        elif action == "resume":
            if not self.job or self.job.status != "paused" or not self.fresh() or self.state not in {"Hold:0", "Idle"}:
                raise ValueError("Дождитесь полной остановки перед продолжением.")
            if self.state == "Hold:0":
                self.realtime(b"~")
            self.job.status = "running"
            self.log_message("system", "Программа продолжена.")
        elif action == "stop":
            if not self.active() or self.job.status == "stopping":
                raise ValueError("Нет запущенной программы.")
            self.realtime(b"!")
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
        elif action == "home":
            if self.active() or self.pending or not self.fresh() or self.report_scale is None or self.state not in {"Idle", "Alarm"}:
                raise ValueError("Поиск машинного нуля доступен в Idle или Alarm.")
            self.send("$H", "manual")
        elif action == "zero":
            self.require_idle()
            axes = data.get("axes")
            if axes not in ("X", "Y", "Z", "XY", "XYZ"):
                raise ValueError("Выберите оси для обнуления.")
            self.send("G10L20P0" + "".join(axis + "0" for axis in axes), "manual")
        elif action == "jog":
            self.require_idle()
            axis = data.get("axis")
            step, feed = data.get("step"), data.get("feed")
            if axis not in ("X", "Y", "Z"):
                raise ValueError("Выберите ось X, Y или Z.")
            if type(step) not in (float, int) or not 0.001 <= abs(step) <= 1000:
                raise ValueError("Шаг должен быть от 0,001 до 1000 мм.")
            if type(feed) not in (float, int) or not 1 <= feed <= 30000:
                raise ValueError("Подача должна быть от 1 до 30 000 мм/мин.")
            self.send(f"$J=G91G21{axis}{step:.3f}F{feed:.1f}", "manual")
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
            return {
                "revision": self.revision, "port": self.port, "baud": self.baud,
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
        self.state, self.last_status = state, time.monotonic()
        if state in {"Idle", "Alarm"}:
            self.awaiting_idle = False

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
            self.resetting = False
            self.last_status = 0.0
            self.connected_at = time.monotonic()
            self.report_scale = self.report_scale if self.port == "simulator" else None
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
                if role == "setup":
                    if line != "ok" or self.report_scale is None:
                        self.disconnect("GRBL не сообщил единицы координат в настройке $13.")
                    else:
                        self.log_message("system", "GRBL ответил. Координаты отображаются в миллиметрах.")
                    return
                if command.startswith("$13=") and line == "ok":
                    self.set_report_units(bool(float(command[4:])))
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
