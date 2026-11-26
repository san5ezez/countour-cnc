"""Reconstruct the entry state of ordinary XY/Z pen-plotting programs."""

import math
import re
from dataclasses import dataclass

WORD = re.compile(r"([A-Z])([+-]?(?:\d+(?:\.\d*)?|\.\d+))")
MOTIONS = {0, 1, 2, 3, 80}
SUPPORTED_G = MOTIONS | {4, 17, 20, 21, 40, 49, 54, 61, 90, 91, 91.1, 94}
SUPPORTED_M = {2, 5, 9, 30}
AXES = "XYZ"


def coordinates(values):
    return (isinstance(values, (list, tuple)) and len(values) == 3
            and all(type(value) in (float, int) and -1_000_000 <= value <= 1_000_000 for value in values))


def close_position(actual, expected, tolerance=.015):
    return coordinates(actual) and coordinates(expected) and all(abs(a - b) <= tolerance for a, b in zip(actual, expected))


@dataclass
class Entry:
    position: tuple
    line: int
    command: str
    metric: bool
    absolute: bool
    feed: float | None
    motion: int
    cancels_tool_offset: bool = False


def prepare_entry(program, number, origin):
    if type(number) is not int or not 1 <= number <= len(program):
        raise ValueError(f"Укажите номер команды от 1 до {len(program)}.")
    if not coordinates(origin):
        raise ValueError("Для расчёта нужны рабочие координаты начала программы.")
    position = list(origin)
    metric = absolute = True
    feed = None
    motion = 0
    finished = False
    cancels_tool_offset = False
    entry = None
    for index, (line, command) in enumerate(program, 1):
        words = WORD.findall(command)
        g = set()
        m = set()
        values = {}
        for letter, raw in words:
            value = float(raw)
            if not math.isfinite(value):
                raise ValueError(f"Строка {line}: недопустимое число.")
            if letter == "G" and value in SUPPORTED_G and value not in g:
                g.add(value)
            elif letter == "M" and value in SUPPORTED_M and value not in m:
                m.add(value)
            elif letter in "GM" or letter in values or letter not in "NXYZIJRFSPT":
                raise ValueError(f"Строка {line}: восстановление не поддерживает {letter}{raw}.")
            else:
                values[letter] = value
        if finished or {2, 30} <= m:
            raise ValueError(f"Строка {line}: восстановление поддерживает программы для ручки с подъёмом по Z.")
        if len(g & MOTIONS) > 1 or {20, 21} <= g or {90, 91} <= g:
            raise ValueError(f"Строка {line}: противоречивые режимы.")
        cancels_tool_offset |= 49 in g
        if index == number:
            entry = Entry(tuple(position), line, command, metric, absolute, feed, motion)
        if g & {20, 21}:
            metric = 21 in g
        if g & {90, 91}:
            absolute = 90 in g
        if g & MOTIONS:
            motion = int(next(iter(g & MOTIONS)))
        scale = 1 if metric else 25.4
        if "F" in values:
            feed = values["F"] * scale
            if not 0 < feed <= 1_000_000:
                raise ValueError(f"Строка {line}: недопустимая подача.")
        axes = set(values) & set(AXES)
        arc = set(values) & set("IJR")
        if (axes and (motion == 80 or 4 in g)) or (arc and motion not in (2, 3)) or (axes and motion in (2, 3) and not arc):
            raise ValueError(f"Строка {line}: параметры движения не поддерживаются при восстановлении.")
        if (axes or arc) and motion in (1, 2, 3) and feed is None:
            raise ValueError(f"Строка {line}: у рабочего движения должна быть задана подача F.")
        for axis, letter in enumerate(AXES):
            if letter in axes:
                position[axis] = (0 if absolute else position[axis]) + values[letter] * scale
        if not coordinates(position):
            raise ValueError(f"Строка {line}: координаты выходят за пределы восстановления.")
        finished = bool(m & {2, 30})
    if number > 1 and (entry.command in {"M2", "M02", "M30"}):
        raise ValueError("Выберите команду до завершения программы.")
    entry.cancels_tool_offset = cancels_tool_offset
    return entry


def resumed_rows(program, number, entry, feed):
    """Commands starting at the raised entry point, after explicit confirmation."""
    # A motion-only modal block can be explicit, but an inherited arc needs the
    # first actual motion block to select its mode together with its offsets.
    prologue = [
        (0, "G21G90G17G54G94G40G61G91.1M5M9"),
        (0, f"G1Z{entry.position[2]:.6f}F{min(feed, 300):.3f}"),
        (0, ("G21" if entry.metric else "G20") + ("G90" if entry.absolute else "G91")),
    ]
    if entry.feed is not None:
        prologue.append((0, f"F{entry.feed / (1 if entry.metric else 25.4):.6f}"))
    tail = list(program[number - 1:])
    motion = entry.motion
    for index, (line, command) in enumerate(tail):
        tokens = WORD.findall(command)
        g = {float(value) for letter, value in tokens if letter == "G"}
        if g & MOTIONS:
            break
        if 4 not in g and any(letter in "XYZIJR" for letter, _ in tokens):
            command = f"G{motion}" + command
            if len(command) > 79:
                raise ValueError(f"Строка {line}: не помещается восстановленный режим движения.")
            tail[index] = (line, command)
            break
    return prologue + tail
