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


def arc_bounds(start, end, center, clockwise):
    radius = math.dist(start, center)
    first = math.atan2(start[1] - center[1], start[0] - center[0])
    last = math.atan2(end[1] - center[1], end[0] - center[0])
    direction = -1 if clockwise else 1
    sweep = ((last - first) * direction) % math.tau
    if math.dist(start, end) < .000001:
        sweep = math.tau
    points = [start, end]
    for angle in (0, math.pi / 2, math.pi, 3 * math.pi / 2):
        if ((angle - first) * direction) % math.tau <= sweep + 1e-9:
            points.append((center[0] + radius * math.cos(angle), center[1] + radius * math.sin(angle)))
    return points


def transform_xy(source, factor, angle, dx, dy, pivot, selection=None, selected_lines=None):
    """Move whole XY strokes and preserve the original paths outside the selection."""
    if (type(factor) not in (float, int) or not .0001 <= factor <= 10000
            or type(angle) not in (float, int) or not -36000 <= angle <= 36000
            or any(type(value) not in (float, int) or not -1_000_000 <= value <= 1_000_000 for value in (dx, dy))):
        raise ValueError("Проверьте масштаб, поворот и смещение.")
    if not isinstance(pivot, list) or len(pivot) != 2 or not all(type(value) in (float, int) and abs(value) <= 1_000_000 for value in pivot):
        raise ValueError("Некорректный центр преобразования.")
    if selection is not None:
        if not isinstance(selection, list) or len(selection) != 4 or not all(
                type(value) in (float, int) and abs(value) <= 1_000_000 for value in selection):
            raise ValueError("Некорректная рамка выделения.")
        if selection[0] >= selection[2] or selection[1] >= selection[3]:
            raise ValueError("Выделите область с контурами.")
    if selected_lines is not None and (not isinstance(selected_lines, list) or not selected_lines
            or not all(type(line) is int and line > 0 for line in selected_lines)):
        raise ValueError("Некорректный список выделенных штрихов.")
    angle = math.radians(angle % 360)
    cosine, sine = math.cos(angle) * factor, math.sin(angle) * factor

    def vector(x, y):
        return x * cosine - y * sine, x * sine + y * cosine

    def apply(point):
        x, y = vector(point[0] - pivot[0], point[1] - pivot[1])
        return x + pivot[0] + dx, y + pivot[1] + dy

    originals = source.splitlines(keepends=True)
    rows = []
    groups = []
    group = None
    anchor = None
    plane, motion, unit, absolute = 17, 0, 1, True
    position = (0, 0)
    ended = False
    for number, command in parse_program(source):
        original = originals[number - 1]
        prefix = original.split(";", 1)[0]
        masked = COMMENT.sub(lambda match: " " * len(match[0]), prefix).upper()
        tokens = list(TOKEN.finditer(masked))
        if ended or "".join(letter + value for letter, value in (match.groups() for match in tokens)) != command:
            raise ValueError(f"Строка {number}: запись команды не поддерживается для преобразования.")
        g = set()
        m = set()
        words = {}
        for token in tokens:
            letter, raw = token.groups()
            value = float(raw)
            if letter == "G" and value in G_CODES and value not in g:
                g.add(value)
            elif letter == "M" and value in M_CODES and value not in m:
                m.add(value)
            elif letter not in "NXYZIJRFSTP" or letter in words or not math.isfinite(value):
                raise ValueError(f"Строка {number}: преобразование не поддерживает {letter}{raw}.")
            else:
                words[letter] = (value, token.span())
        planes, motions = g & PLANES, g & MOTION_CODES
        if len(planes) > 1 or len(motions) > 1 or {20, 21} <= g or {90, 91} <= g:
            raise ValueError(f"Строка {number}: противоречивые режимы.")
        if planes:
            plane = next(iter(planes))
        if motions:
            motion = next(iter(motions))
        if g & {20, 21}:
            unit = 1 if 21 in g else 25.4
        if g & {90, 91}:
            absolute = 90 in g
        ended = bool(m & {2, 30})
        has_xy = bool(words.keys() & set("XY"))
        centers = words.keys() & set("IJR")
        if not has_xy and not centers:
            if "Z" in words or m & {3, 4, 5}:
                group = None
            continue
        if 4 in g or motion == 80 or (motion in (2, 3) and (plane != 17 or not centers)) or (motion not in (2, 3) and centers):
            raise ValueError(f"Строка {number}: неподдерживаемое движение в XY.")
        start = position
        position = tuple(words[axis][0] * unit + (0 if absolute else start[index])
                         if axis in words else start[index] for index, axis in enumerate("XY"))
        if not all(math.isfinite(value) and abs(value) <= 10_000_000 for value in position):
            raise ValueError(f"Строка {number}: координата за пределами редактора.")
        row = {"number": number, "words": words, "unit": unit, "absolute": absolute,
               "start": start, "end": position, "rapid": motion == 0, "transform": False}
        rows.append(row)
        if motion == 0:
            anchor, group = row, None
            continue
        if group is None:
            group = {"anchor": anchor, "rows": [], "bounds": [*start, *start]}
            groups.append(group)
            anchor = None
        group["rows"].append(row)
        points = (start, position)
        if motion in (2, 3):
            if "R" in centers:
                radius = words["R"][0] * unit
                arc_dx, arc_dy = position[0] - start[0], position[1] - start[1]
                chord = math.hypot(arc_dx, arc_dy)
                if len(centers) != 1 or not chord or abs(radius) * 2 + 1e-5 < chord:
                    raise ValueError(f"Строка {number}: неверный радиус дуги.")
                offset = math.sqrt(max(0, radius * radius - chord * chord / 4))
                sign = (-1 if motion == 2 else 1) * math.copysign(1, radius)
                center = ((start[0] + position[0]) / 2 - arc_dy * offset * sign / chord,
                          (start[1] + position[1]) / 2 + arc_dx * offset * sign / chord)
            else:
                center = tuple(start[index] + words.get(axis, (0,))[0] * unit for index, axis in enumerate("IJ"))
                if math.dist(start, center) == 0:
                    raise ValueError(f"Строка {number}: отсутствует смещение центра дуги.")
            points = arc_bounds(start, position, center, motion == 2)
        box = group["bounds"]
        for x, y in points:
            box[0], box[1] = min(box[0], x), min(box[1], y)
            box[2], box[3] = max(box[2], x), max(box[3], y)

    chosen = []
    if selection is None and selected_lines is None:
        for row in rows:
            row["transform"] = True
    else:
        if selected_lines is not None:
            ids = set(selected_lines)
            chosen = [group for group in groups if group["rows"][0]["number"] in ids]
            if len(chosen) != len(ids):
                raise ValueError("Контуры изменились. Выделите текст заново.")
        else:
            chosen = [group for group in groups if (
                group["bounds"][0] >= selection[0] - .00001 and group["bounds"][1] >= selection[1] - .00001
                and group["bounds"][2] <= selection[2] + .00001 and group["bounds"][3] <= selection[3] + .00001)]
        if not chosen:
            raise ValueError("В рамке нет целого штриха. Обведите текст чуть шире.")
        for group in chosen:
            if group["anchor"] is not None:
                group["anchor"]["transform"] = True
            for row in group["rows"]:
                row["transform"] = True

    current = (0, 0)
    for row in rows:
        number, words, unit = row["number"], row["words"], row["unit"]
        changed = row["transform"]
        want_start = apply(row["start"]) if changed else row["start"]
        if not row["rapid"] and math.dist(current, want_start) > .00005:
            raise ValueError(f"Строка {number}: перед штрихом нужен отдельный холостой ход G0 по XY.")
        end = apply(row["end"]) if changed else row["end"]
        original = originals[number - 1]
        if not changed and math.dist(current, row["start"]) <= .0000001:
            current = end
            continue
        xy = [end[i] / unit if row["absolute"] else (end[i] - current[i]) / unit for i in range(2)]
        replacements = dict(zip("XY", xy))
        if changed and "R" in words:
            replacements["R"] = words["R"][0] * factor
        elif changed and words.keys() & set("IJ"):
            replacements.update(zip("IJ", vector(*(words.get(axis, (0,))[0] for axis in "IJ"))))
        edits = []
        insertions = []
        for axis, value in replacements.items():
            if not math.isfinite(value) or abs(value * unit) > 10_000_000:
                raise ValueError(f"Строка {number}: координата вышла за пределы редактора.")
            text = f"{value:.6f}".rstrip("0").rstrip(".")
            text = axis + ("0" if text == "-0" else text)
            if axis in words:
                edits.append((*words[axis][1], text))
            else:
                insertions.append(text)
        for start, stop, value in sorted(edits, reverse=True):
            original = original[:start] + value + original[stop:]
        if insertions:
            # Keep number words, motion and comments in their original order.
            limit = original.find(";")
            if limit < 0:
                limit = len(original.rstrip("\r\n"))
            original = original[:limit] + " " + " ".join(insertions) + " " + original[limit:]
        clean_line(original.rstrip("\r\n").removeprefix("\ufeff"))
        originals[number - 1] = original
        realized = [round(value, 6) * unit for value in xy]
        current = tuple(realized[i] if row["absolute"] else current[i] + realized[i] for i in range(2))
    result = "".join(originals)
    parse_program(result)
    return (result, [group["rows"][0]["number"] for group in chosen],
            [row["number"] for group in chosen for row in group["rows"]])
