"""Scale the XY geometry of supported GRBL programs in the active work coordinates."""

import math
import re

from sender import COMMENT, clean_line, parse_program

TOKEN = re.compile(r"([A-Z])[ \t]*([+-]?(?:\d+(?:\.\d*)?|\.\d+))", re.IGNORECASE | re.ASCII)
G_CODES = {0, 1, 2, 3, 4, 17, 18, 19, 20, 21, 40, 49, 54, 61, 80, 90, 91, 91.1, 93, 94}
M_CODES = {0, 1, 2, 3, 4, 5, 7, 8, 9, 30}
MOTION_CODES = {0, 1, 2, 3, 80}
PLANES = {17, 18, 19}


def scale_xy(source, factor):
    if type(factor) not in (int, float) or not 0.0001 <= factor <= 10_000:
        raise ValueError("Допустимый коэффициент масштаба — от 0,0001 до 10 000.")
    commands = dict(parse_program(source))
    result = []
    plane, motion = 17, 0
    ended = False
    for number, original in enumerate(source.splitlines(keepends=True), 1):
        command = commands.get(number)
        if not command:
            result.append(original)
            continue

        def fail(message):
            raise ValueError(f"Строка {number}. {message}")

        prefix = original.split(";", 1)[0]
        masked = COMMENT.sub(lambda match: " " * len(match[0]), prefix).upper()
        tokens = list(TOKEN.finditer(masked))
        if "".join(letter + value for letter, value in (match.groups() for match in tokens)) != command:
            fail("Запись команды не поддерживается для масштабирования.")
        if ended:
            fail("После команды завершения программы найдены дополнительные команды.")
        g_codes = set()
        values = {}
        for token in tokens:
            letter, spelling = token.groups()
            value = float(spelling)
            if not math.isfinite(value):
                fail("Недопустимое число.")
            if letter == "G":
                if value not in G_CODES or value in g_codes:
                    fail(f"Масштабирование для G{spelling} не поддерживается.")
                g_codes.add(value)
                continue
            if letter in values or letter not in "MNXYZIJKRFSTP":
                fail(f"Недопустимый или повторяющийся параметр {letter}.")
            if letter == "M" and value not in M_CODES:
                fail(f"Масштабирование для M{spelling} не поддерживается.")
            values[letter] = (value, token.span(2))
        planes, motions = g_codes & PLANES, g_codes & MOTION_CODES
        if len(planes) > 1 or len(motions) > 1:
            fail("Укажите одну плоскость и один режим движения на строку.")
        if planes:
            plane = next(iter(planes))
        if motions:
            motion = next(iter(motions))
        coordinates = set(values) & set("XYZIJKR")
        centers = coordinates & set("IJKR")
        if coordinates and (4 in g_codes or motion == 80):
            fail("Координаты без поддерживаемого режима движения.")
        if coordinates and motion in (2, 3):
            if plane != 17:
                fail("Масштабируются дуги только в плоскости XY (G17).")
            if "K" in centers or (centers and "R" in centers and len(centers) > 1):
                fail("Недопустимые параметры дуги XY.")
        elif centers:
            fail("Параметры центра или радиуса встречаются вне дуги.")
        if "P" in values and 4 not in g_codes:
            fail("Параметр P поддерживается для паузы G4.")
        replacements = []
        for letter in coordinates & set("XYIJR"):
            value, (start, end) = values[letter]
            scaled = value * factor
            if abs(scaled) > 10_000_000 or (scaled and abs(scaled) < 0.0000005):
                fail("После масштабирования координата выходит за пределы точности.")
            spelling = f"{scaled:.6f}".rstrip("0").rstrip(".")
            replacements.append((start, end, "0" if spelling == "-0" else spelling))
        for start, end, spelling in sorted(replacements, reverse=True):
            original = original[:start] + spelling + original[end:]
        try:
            clean_line(original.rstrip("\r\n").removeprefix("\ufeff"))
        except ValueError as error:
            fail(str(error))
        result.append(original)
        ended = "M" in values and values["M"][0] in (2, 30)
    return "".join(result)
