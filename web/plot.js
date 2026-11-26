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

export function parsePath(source) {
  const segments = [];
  let pos = [0, 0, 0];
  let absolute = true;
  let unit = 1;
  let motion = 0;
  let plane = 17;
  let fixture = 54;
  let approximate = false;
  let truncated = false;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const raw of source.split(/\r\n?|\n/)) {
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
        segments.push({from: pos, to: point, rapid: motion === 0});
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
    });
    canvas.addEventListener('pointermove', event => {
      if (!this.drag) return;
      this.panX = this.drag[2] + event.clientX - this.drag[0];
      this.panY = this.drag[3] + event.clientY - this.drag[1];
      this.schedule();
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
    this.data = parsePath(source);
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

  setSheet(sheet) {
    this.sheet = sheet;
    this.fit();
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
    const {canvas, context: ctx, data, view} = this;
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

    const sheet = view === 'xy' ? this.sheet : null;
    const min = sheet ? [Math.min(data.min[0], sheet.x), Math.min(data.min[1], sheet.y), data.min[2]] : data.min;
    const max = sheet ? [Math.max(data.max[0], sheet.x + sheet.width), Math.max(data.max[1], sheet.y + sheet.height), data.max[2]] : data.max;
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

    if (sheet) {
      const [left, top] = toCanvas([sheet.x, sheet.y + sheet.height, 0]);
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
      const interval = gridInterval(Math.max(max[horizontal] - min[horizontal], max[vertical] - min[vertical], 20));
      const low = [horizontal, vertical].map(axis => (Math.floor(min[axis] / interval) - 3) * interval);
      const high = [horizontal, vertical].map(axis => (Math.ceil(max[axis] / interval) + 3) * interval);
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
          if ((Math.round(value / interval) % 5 === 0) === major) trace(make(value, low[1]), make(value, high[1]));
        }
        for (let index = 0; index <= Math.round((high[1] - low[1]) / interval); index++) {
          const value = low[1] + index * interval;
          if ((Math.round(value / interval) % 5 === 0) === major) trace(make(low[0], value), make(high[0], value));
        }
        ctx.strokeStyle = major ? '#29425e' : '#1c3048';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const rapid of [true, false]) {
      if (rapid && !this.rapids) continue;
      ctx.beginPath();
      for (const segment of data.segments) if (segment.rapid === rapid) trace(segment.from, segment.to);
      ctx.setLineDash(rapid ? [4, 5] : []);
      if (!rapid) {
        ctx.lineWidth = 5;
        ctx.strokeStyle = '#348cff32';
        ctx.stroke();
      }
      ctx.lineWidth = rapid ? 1 : 1.75;
      ctx.strokeStyle = sheet ? (rapid ? '#808fa8' : '#347acb') : (rapid ? '#8498b4b0' : '#62adff');
      ctx.stroke();
    }
    ctx.setLineDash([]);

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
    this.drawAxes(ctx, width, height);
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
