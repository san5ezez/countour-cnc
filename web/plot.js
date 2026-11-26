const word = /([A-Z])([+-]?(?:\d+(?:\.\d*)?|\.\d+))/g;
const planes = {
  17: [0, 1, 'I', 'J'],
  18: [2, 0, 'K', 'I'],
  19: [1, 2, 'J', 'K'],
};
const axes = ['X', 'Y', 'Z'];
const tau = 2 * Math.PI;

function arcPoints(start, end, args, plane, clockwise, unit) {
  const [a, b, i, j] = planes[plane];
  const dx = end[a] - start[a];
  const dy = end[b] - start[b];
  const chord = Math.hypot(dx, dy);
  let centerA = start[a] + (args.get(i) || 0) * unit;
  let centerB = start[b] + (args.get(j) || 0) * unit;
  if (args.has('R')) {
    const radius = args.get('R') * unit;
    if (!chord || Math.abs(radius) * 2 + 1e-5 < chord) return null;
    const distance = Math.sqrt(Math.max(0, radius * radius - chord * chord / 4));
    const sign = (clockwise ? -1 : 1) * Math.sign(radius);
    centerA = (start[a] + end[a]) / 2 - dy * distance * sign / chord;
    centerB = (start[b] + end[b]) / 2 + dx * distance * sign / chord;
  }
  const radius = Math.hypot(start[a] - centerA, start[b] - centerB);
  if (!radius || Math.abs(radius - Math.hypot(end[a] - centerA, end[b] - centerB)) > Math.max(.005, radius * .001)) return null;
  const first = Math.atan2(start[b] - centerB, start[a] - centerA);
  const last = Math.atan2(end[b] - centerB, end[a] - centerA);
  let sweep = clockwise ? -((first - last + tau) % tau) : (last - first + tau) % tau;
  if (!chord || Math.abs(sweep) < .000001) sweep = clockwise ? -tau : tau;
  const count = Math.max(4, Math.ceil(Math.abs(sweep) * 18));
  const fractions = Array.from({length: count - 1}, (_, index) => (index + 1) / count);
  // Include axis extrema so sampled arcs retain their original dimensions.
  for (const angle of [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]) {
    const travelled = clockwise ? first - angle : angle - first;
    const progress = ((travelled % tau + tau) % tau) / Math.abs(sweep);
    if (progress > 1e-9 && progress < 1 - 1e-9) fractions.push(progress);
  }
  const points = [];
  for (const progress of fractions.sort((a, b) => a - b)) {
    const angle = first + sweep * progress;
    const point = start.map((value, index) => value + (end[index] - value) * progress);
    point[a] = centerA + radius * Math.cos(angle);
    point[b] = centerB + radius * Math.sin(angle);
    points.push(point);
  }
  return [...points, end];
}

export function parsePath(source, start = [0, 0, 0]) {
  const segments = [];
  let pos = start;
  let absolute = true;
  let unit = 1;
  let motion = 0;
  let plane = 17;
  let fixture = 54;
  let approximate = false;
  let truncated = false;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const [index, raw] of source.split(/\r\n?|\n/).entries()) {
    const line = raw.split(';', 1)[0].replace(/\([^()]*\)/g, '').replace(/\s/g, '').toUpperCase();
    const pairs = Array.from(line.matchAll(word), ([, key, value]) => [key, Number(value)]);
    const args = new Map(pairs);
    const g = new Set(pairs.filter(([key]) => key === 'G').map(([, value]) => value));
    if (g.has(20) || g.has(21)) unit = g.has(20) ? 25.4 : 1;
    if (g.has(90) || g.has(91)) absolute = g.has(90);
    for (const next of [17, 18, 19]) if (g.has(next)) plane = next;
    for (const next of [0, 1, 2, 3, 80]) if (g.has(next)) motion = next;
    if (Array.from(g).some(code => code >= 54 && code <= 59 && code !== fixture)) {
      fixture = Array.from(g).find(code => code >= 54 && code <= 59);
      approximate = true;
    }
    if ([10, 28, 28.1, 30, 30.1, 43.1, 53, 92, 92.1].some(code => g.has(code)) ||
        Array.from(g).some(code => code >= 38 && code < 39 || code >= 81 && code < 90)) {
      approximate = true;
      continue;
    }
    if (motion === 80 || (!axes.some(axis => args.has(axis)) &&
        !([2, 3].includes(motion) && ['I', 'J', 'K'].some(axis => args.has(axis))))) continue;
    const next = axes.map((axis, index) => {
      if (!args.has(axis)) return pos[index];
      return args.get(axis) * unit + (absolute ? 0 : pos[index]);
    });
    if (next.some(value => !Number.isFinite(value) || Math.abs(value) > 1e9)) {
      approximate = true;
      continue;
    }
    let points = [next];
    if (motion === 2 || motion === 3) {
      const arc = arcPoints(pos, next, args, plane, motion === 2, unit);
      if (arc) points = arc;
      else approximate = true;
    }
    if (segments.length + points.length > 40_000) {
      truncated = true;
      break;
    }
    for (const point of points) {
      if (point.some((value, index) => value !== pos[index])) {
        segments.push({from: pos, to: point, rapid: motion === 0, arc: motion === 2 || motion === 3, line: index + 1});
        for (let axis = 0; axis < 3; axis++) {
          min[axis] = Math.min(min[axis], pos[axis], point[axis]);
          max[axis] = Math.max(max[axis], pos[axis], point[axis]);
        }
      }
      pos = point;
    }
  }
  if (!segments.length) return {segments, min: [0, 0, 0], max: [0, 0, 0], approximate, truncated};
  return {segments, min, max, approximate, truncated};
}

const interpolate = (from, to, fraction) => from.map((value, axis) => value + (to[axis] - value) * fraction);

export function traceProgress(segments, progress, [, lastLine, x, y, z]) {
  const first = Math.floor(progress);
  let closest = Infinity;
  let result = progress;
  for (let index = first; index < segments.length; index++) {
    const {from, to, arc, line} = segments[index];
    if (line > lastLine) break;
    const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
    const px = x - from[0], py = y - from[1], pz = z - from[2];
    const lengthSquared = dx * dx + dy * dy + dz * dz;
    const along = (px * dx + py * dy + pz * dz) / lengthSquared;
    const fraction = Math.max(index === first ? progress - first : 0, Math.min(1, along));
    const distance = Math.hypot(px - dx * fraction, py - dy * fraction, pz - dz * fraction);
    const tolerance = .04 + (arc ? .008 * Math.sqrt(lengthSquared) : 0);
    // At a crossing prefer the earlier segment when both fit the reading.
    if (distance <= tolerance && distance + .01 < closest) {
      closest = distance;
      result = index + fraction;
    }
  }
  return result;
}

function project(point, view) {
  const [x, y, z] = point;
  if (view === 'iso') return [x * .866 - y * .69, -x * .37 - y * .5 - z * .92];
  if (view === 'xz') return [x, -z];
  if (view === 'yz') return [y, -z];
  return [x, -y];
}

function gridInterval(span) {
  const ideal = Math.max(span / 12, .001);
  const base = 10 ** Math.floor(Math.log10(ideal));
  return (ideal / base < 2 ? 2 : ideal / base < 5 ? 5 : 10) * base;
}

const axisNumber = new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 6, useGrouping: false});

export class Plot {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.data = parsePath('');
    this.position = null;
    this.view = 'iso';
    this.grid = true;
    this.rapids = true;
    this.drag = null;
    this.frame = null;
    this.fit();
    new ResizeObserver(() => this.schedule()).observe(canvas);
    canvas.addEventListener('wheel', event => {
      event.preventDefault();
      this.zoom(Math.exp(-event.deltaY * .0015), event.offsetX, event.offsetY);
    }, {passive: false});
    canvas.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      canvas.setPointerCapture(event.pointerId);
      this.drag = [event.clientX, event.clientY, this.panX, this.panY];
      this.dragged = false;
    });
    canvas.addEventListener('pointermove', event => {
      if (!this.drag) return;
      if (Math.hypot(event.clientX - this.drag[0], event.clientY - this.drag[1]) > 5) this.dragged = true;
      if (this.onPick && !this.dragged) return;
      this.panX = this.drag[2] + event.clientX - this.drag[0];
      this.panY = this.drag[3] + event.clientY - this.drag[1];
      this.schedule();
    });
    canvas.addEventListener('pointerup', event => {
      if (!this.onPick || !this.drag || this.dragged || !this.screenToXY ||
          Math.hypot(event.clientX - this.drag[0], event.clientY - this.drag[1]) > 5) return;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      if (x >= 0 && y >= 0 && x <= rect.width && y <= rect.height) this.onPick(this.screenToXY(x, y));
    });
    canvas.addEventListener('lostpointercapture', () => { this.drag = null; });
    canvas.addEventListener('dblclick', () => this.fit());
  }

  schedule() {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.draw();
    });
  }

  set(source) {
    this.source = source;
    this.data = parsePath(source);
    this.tracedJob = undefined;
    this.tracedData = null;
    this.traceCursor = 0;
    this.traceSample = 0;
    this.fit();
    return this.data;
  }

  setView(view) {
    if (this.view !== view) {
      this.view = view;
      this.fit();
    }
  }

  setPosition(position, drawing) {
    if (position?.join(',') === this.position?.join(',') && drawing === this.drawing) return;
    this.position = position;
    this.drawing = drawing;
    this.schedule();
  }

  setExecutionView(enabled) {
    this.executionView = enabled;
    this.schedule();
  }

  setJobProgress(job) {
    if (this.tracedJob !== job?.id) {
      this.tracedJob = job?.id;
      this.tracedData = job?.start_position ? parsePath(this.source, job.start_position) : null;
      this.traceSample = 0;
      const segments = (this.tracedData || this.data).segments;
      const first = job?.recovery_line ? segments.findIndex(segment => segment.line >= job.recovery_line) : 0;
      this.traceCursor = first < 0 ? segments.length : first;
      if (this.executionView) this.schedule();
    }
    if (!job) return;
    const data = this.tracedData || this.data;
    let next = this.traceCursor;
    if (job.status === 'complete') {
      next = data.segments.length;
    } else {
      for (const sample of job.trace) {
        if (sample[0] <= this.traceSample) continue;
        next = traceProgress(data.segments, next, sample);
        this.traceSample = sample[0];
      }
    }
    if (next !== this.traceCursor) {
      this.traceCursor = next;
      if (this.executionView) this.schedule();
    }
  }

  setSheet(sheet) {
    this.sheet = sheet;
    this.fit();
  }

  trackedLine() {
    const segments = (this.tracedData || this.data).segments;
    return segments[Math.floor(this.traceCursor)]?.line ?? segments.at(-1)?.line;
  }

  setTarget(target) {
    this.target = target;
    this.schedule();
  }

  fit() {
    this.factor = 1;
    this.panX = this.panY = 0;
    this.schedule();
  }

  zoom(factor, x = this.canvas.clientWidth / 2, y = this.canvas.clientHeight / 2) {
    const next = Math.max(.2, Math.min(30, this.factor * factor));
    const offsetX = x - this.canvas.clientWidth / 2;
    const offsetY = y - this.canvas.clientHeight / 2;
    this.panX = offsetX - (offsetX - this.panX) * next / this.factor;
    this.panY = offsetY - (offsetY - this.panY) * next / this.factor;
    this.factor = next;
    this.schedule();
  }

  draw() {
    const {canvas, context: ctx, view} = this;
    const data = this.executionView && this.tracedData ? this.tracedData : this.data;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    const pixelRatio = Math.min(devicePixelRatio || 1, 2);
    const bitmapWidth = Math.round(width * pixelRatio);
    const bitmapHeight = Math.round(height * pixelRatio);
    if (canvas.width !== bitmapWidth) canvas.width = bitmapWidth;
    if (canvas.height !== bitmapHeight) canvas.height = bitmapHeight;
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const xy = view === 'xy';
    const sheet = xy ? this.sheet : null;
    const empty = xy && !sheet && data.min[0] === data.max[0] && data.min[1] === data.max[1];
    const min = xy ? [Math.min(data.min[0], 0), Math.min(data.min[1], 0), data.min[2]] : data.min;
    const max = xy ? [
      Math.max(data.max[0], sheet?.width || (empty ? 110 : 0)),
      Math.max(data.max[1], sheet?.height || (empty ? 110 : 0)),
      data.max[2],
    ] : data.max;
    const corners = [min[0], max[0]].flatMap(x =>
      [min[1], max[1]].flatMap(y => [min[2], max[2]].map(z => project([x, y, z], view))));
    const extents = [0, 1].map(axis => [Math.min(...corners.map(p => p[axis])), Math.max(...corners.map(p => p[axis]))]);
    const ranges = extents.map(([a, b]) => b - a);
    const mid = extents.map(([a, b]) => (a + b) / 2);
    const scale = Math.min(width * .77 / Math.max(ranges[0], 1), height * .70 / Math.max(ranges[1], 1), 30) * this.factor;
    const toCanvas = point => {
      const [x, y] = project(point, view);
      return [width / 2 + (x - mid[0]) * scale + this.panX, height / 2 + (y - mid[1]) * scale + this.panY];
    };
    const trace = (a, b) => {
      ctx.moveTo(...toCanvas(a));
      ctx.lineTo(...toCanvas(b));
    };
    const origin = xy ? toCanvas([0, 0, 0]) : null;
    this.screenToXY = xy ? (x, y) => [(x - origin[0]) / scale, (origin[1] - y) / scale] : null;
    const tick = xy ? gridInterval(12 * 42 / scale) : 0;

    if (sheet) {
      const [left, top] = toCanvas([0, sheet.height, 0]);
      const paperWidth = sheet.width * scale;
      const paperHeight = sheet.height * scale;
      ctx.fillStyle = '#e7eef7';
      ctx.fillRect(left, top, paperWidth, paperHeight);
      if (sheet.grid && scale * sheet.grid >= 3) {
        ctx.beginPath();
        for (let x = sheet.grid; x < sheet.width; x += sheet.grid) {
          ctx.moveTo(left + x * scale, top);
          ctx.lineTo(left + x * scale, top + paperHeight);
        }
        for (let y = sheet.grid; y < sheet.height; y += sheet.grid) {
          ctx.moveTo(left, top + y * scale);
          ctx.lineTo(left + paperWidth, top + y * scale);
        }
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#c5d7e9';
        ctx.stroke();
      }
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#8da8c6';
      ctx.strokeRect(left, top, paperWidth, paperHeight);
    }

    if (this.grid) {
      const [horizontal, vertical] = view === 'xz' ? [0, 2] : view === 'yz' ? [1, 2] : [0, 1];
      const divisions = xy && Math.round(tick / 10 ** Math.floor(Math.log10(tick))) !== 5 ? 2 : 5;
      const interval = xy ? tick / divisions : gridInterval(Math.max(max[horizontal] - min[horizontal], max[vertical] - min[vertical], 20));
      const lower = xy ? [-origin[0] / scale, (origin[1] - height) / scale] : [min[horizontal], min[vertical]];
      const upper = xy ? [(width - origin[0]) / scale, origin[1] / scale] : [max[horizontal], max[vertical]];
      const padding = xy ? 1 : 3;
      const low = lower.map(value => (Math.floor(value / interval) - padding) * interval);
      const high = upper.map(value => (Math.ceil(value / interval) + padding) * interval);
      const make = (a, b) => {
        const point = [0, 0, view === 'iso' ? Math.min(0, min[2]) : 0];
        point[horizontal] = a;
        point[vertical] = b;
        return point;
      };
      for (const major of [false, true]) {
        ctx.beginPath();
        for (let index = 0; index <= Math.round((high[0] - low[0]) / interval); index++) {
          const value = low[0] + index * interval;
          if ((Math.round(value / interval) % divisions === 0) === major) trace(make(value, low[1]), make(value, high[1]));
        }
        for (let index = 0; index <= Math.round((high[1] - low[1]) / interval); index++) {
          const value = low[1] + index * interval;
          if ((Math.round(value / interval) % divisions === 0) === major) trace(make(low[0], value), make(high[0], value));
        }
        ctx.strokeStyle = major ? '#29425e' : '#1c3048';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    if (xy) this.drawXYAxes(ctx, width, height, origin, scale, tick);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const rapid of [true, false]) {
      if (rapid && !this.rapids) continue;
      ctx.beginPath();
      for (const segment of data.segments) if (segment.rapid === rapid) trace(segment.from, segment.to);
      ctx.setLineDash(rapid ? [4, 5] : []);
      if (!rapid && !this.executionView) {
        ctx.lineWidth = 5;
        ctx.strokeStyle = '#348cff32';
        ctx.stroke();
      }
      ctx.lineWidth = rapid ? 1 : 1.75;
      ctx.strokeStyle = this.executionView ? (rapid ? '#758aa554' : '#5e728c') :
        sheet ? (rapid ? '#808fa8' : '#347acb') : (rapid ? '#8498b4b0' : '#62adff');
      ctx.stroke();
    }
    ctx.setLineDash([]);
    if (this.executionView && this.traceCursor > 0) {
      ctx.beginPath();
      for (let index = 0; index < this.traceCursor; index++) {
        const {from, to, rapid} = data.segments[index];
        if (rapid) continue;
        const fraction = Math.min(1, this.traceCursor - index);
        trace(from, fraction === 1 ? to : interpolate(from, to, fraction));
      }
      ctx.strokeStyle = '#348cff46';
      ctx.lineWidth = 5;
      ctx.stroke();
      ctx.strokeStyle = '#62adff';
      ctx.lineWidth = 1.85;
      ctx.stroke();
    }

    if (xy && this.target) {
      const [x, y] = toCanvas([...this.target, 0]);
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, tau);
      ctx.moveTo(x - 11, y);
      ctx.lineTo(x + 11, y);
      ctx.moveTo(x, y - 11);
      ctx.lineTo(x, y + 11);
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = '#70e4bd';
      ctx.stroke();
    }
    const marker = this.position;
    if (marker?.length >= 3) {
      const [x, y] = toCanvas(marker);
      if (view === 'iso' && marker[2]) {
        ctx.beginPath();
        trace([marker[0], marker[1], Math.min(0, min[2])], marker);
        ctx.strokeStyle = '#edb36585';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(x, y, this.drawing ? 10 : 8, 0, tau);
      ctx.fillStyle = '#f5b25e36';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, tau);
      ctx.fillStyle = '#ffc577';
      ctx.fill();
    }
    if (!xy) this.drawAxes(ctx, width, height);
  }

  drawXYAxes(ctx, width, height, [x, y], scale, interval) {
    const gap = 12;
    const axes = [
      {name: 'X', zero: x, cross: y, length: width, crossLength: height, color: '#e45367', vertical: false},
      {name: 'Y', zero: height - y, cross: x, length: height, crossLength: width, color: '#2fb58b', vertical: true},
    ];
    ctx.font = '11px monospace';
    ctx.lineWidth = 1.4;
    const label = (text, ...position) => {
      ctx.save();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#111b2c';
      ctx.strokeText(text, ...position);
      ctx.fillText(text, ...position);
      ctx.restore();
    };
    for (const axis of axes) {
      const {name, zero, cross, length, crossLength, color, vertical} = axis;
      if (cross < 0 || cross > crossLength) continue;
      const point = (value, offset = 0) => vertical ? [cross + offset, height - value] : [value, cross + offset];
      const start = Math.max(gap, Math.min(length - gap, zero));
      const line = (a, b) => {
        ctx.beginPath();
        ctx.moveTo(...point(a));
        ctx.lineTo(...point(b));
        ctx.stroke();
      };
      ctx.strokeStyle = color;
      if (start > gap) {
        ctx.setLineDash([4, 4]);
        line(gap, start);
      }
      ctx.setLineDash([]);
      if (start < length - gap) {
        line(start, length - gap);
        ctx.fillStyle = color;
        ctx.textAlign = vertical ? 'left' : 'right';
        ctx.textBaseline = 'bottom';
        label(name, ...point(length - gap, vertical ? 5 : -5));
      }
      const labelSide = vertical ? (cross < 30 ? 1 : -1) : (cross > crossLength - 24 ? -1 : 1);
      const pixels = interval * scale;
      for (let index = Math.ceil((gap - zero) / pixels); index <= Math.floor((length - 2 * gap - zero) / pixels); index++) {
        if (index === 0) continue;
        const position = zero + index * pixels;
        ctx.beginPath();
        ctx.moveTo(...point(position, -3));
        ctx.lineTo(...point(position, 3));
        ctx.stroke();
        ctx.fillStyle = '#a5b4ca';
        ctx.textAlign = vertical ? (labelSide > 0 ? 'left' : 'right') : 'center';
        ctx.textBaseline = vertical ? 'middle' : (labelSide > 0 ? 'top' : 'bottom');
        label(axisNumber.format(index * interval), ...point(position, labelSide * 6));
      }
    }
    if (x >= 0 && x <= width && y >= 0 && y <= height) {
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, tau);
      ctx.fillStyle = '#ffc577';
      ctx.fill();
      ctx.textAlign = x > width - 38 ? 'right' : 'left';
      ctx.textBaseline = y > height - 20 ? 'bottom' : 'top';
      label('0, 0', x > width - 38 ? x - 7 : x + 7, y > height - 20 ? y - 7 : y + 7);
    }
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  drawAxes(ctx, width, height) {
    const base = [Math.min(42, width * .12), height - 35];
    const colors = ['#ff8c9e', '#64dbac', '#75afff'];
    ctx.font = '11px monospace';
    ctx.lineWidth = 1.35;
    for (let axis = 0; axis < 3; axis++) {
      const point = [0, 0, 0];
      point[axis] = 23;
      const [dx, dy] = project(point, this.view);
      if (Math.hypot(dx, dy) < 1) continue;
      ctx.beginPath();
      ctx.moveTo(...base);
      ctx.lineTo(base[0] + dx, base[1] + dy);
      ctx.strokeStyle = ctx.fillStyle = colors[axis];
      ctx.stroke();
      ctx.fillText(axes[axis], base[0] + dx + (dx < 0 ? -8 : 4), base[1] + dy + (dy < -15 ? -3 : 5));
    }
    ctx.beginPath();
    ctx.arc(...base, 2.5, 0, tau);
    ctx.fillStyle = '#acbbd0';
    ctx.fill();
  }
}
