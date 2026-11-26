import {Plot} from './plot.js';

const get = id => document.getElementById(id);
const formats = {
  notebook: {width: 165, height: 205, grid: 5, name: 'Тетрадный'},
  a4: {width: 210, height: 297, grid: 0, name: 'A4'},
};
const number = new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 3});
const maxBytes = 2_000_000;

function outlineBounds(data) {
  const cutting = data.segments.filter(segment => !segment.rapid);
  if (!cutting.length) return [data.min, data.max];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const {from, to} of cutting) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], from[axis], to[axis]);
      max[axis] = Math.max(max[axis], from[axis], to[axis]);
    }
  }
  return [min, max];
}

function fieldSize(value) {
  return Number(value.toFixed(6)).toString();
}

function inside(point, area) {
  return point[0] >= area[0] - .00001 && point[0] <= area[2] + .00001 &&
    point[1] >= area[1] - .00001 && point[1] <= area[3] + .00001;
}

function rectangle(a, b) {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

function shiftBox(area, x, y) {
  return [area[0] + x, area[1] + y, area[2] + x, area[3] + y];
}

function outputName(name) {
  return name.replace(/\.[^.]+$/, '') + '-edited.nc';
}

export function createEditor({getFile, request, upload, showWorkspace}) {
  const code = get('editor-code');
  const controls = [get('editor-width'), get('editor-height')];
  const feedback = get('editor-feedback');
  const plot = new Plot(get('editor-plot'));
  plot.setView('xy');
  plot.grid = false;
  let data;
  let bounds = [[0, 0, 0], [0, 0, 0]];
  let size = [0, 0, 0];
  let filename = '';
  let dirty = false;
  let busy = false;
  let timer;
  let reference = 0;
  let tool = 'pan';
  let drag = null;
  let selection = null;
  let selectedLines = null;
  let selectedRows = null;
  let selectedBounds = null;
  let undo = null;

  function message(text, error = false) {
    feedback.textContent = text;
    feedback.hidden = !text;
    feedback.classList.toggle('error', error);
  }

  function setSheet(fit = true) {
    const chosen = get('editor-sheet').value;
    const custom = chosen === 'custom';
    const paper = [get('editor-paper-width'), get('editor-paper-height')];
    get('editor-sheet-custom').hidden = !custom;
    get('editor-orientation').disabled = custom;
    if (custom && paper.some(input => !input.checkValidity() || !Number.isFinite(input.valueAsNumber))) {
      get('editor-fit-status').textContent = 'Введите ширину и высоту листа в миллиметрах';
      return;
    }
    const format = custom ? {width: paper[0].valueAsNumber, height: paper[1].valueAsNumber, grid: 5, name: 'Свой лист'} : formats[chosen];
    const landscape = !custom && get('editor-orientation').value === 'landscape';
    const width = landscape ? format.height : format.width;
    const height = landscape ? format.width : format.height;
    const [min, max] = bounds;
    plot.setSheet({...format, width, height}, fit);
    get('editor-sheet-size').textContent = format.name + ' · ' + width + ' × ' + height + ' мм';
    const status = get('editor-fit-status');
    const exceeds = min[0] < -.0001 || min[1] < -.0001 || max[0] > width + .0001 || max[1] > height + .0001;
    const uncertain = data?.approximate || data?.truncated;
    status.toggleAttribute('data-outside', exceeds || uncertain);
    if (uncertain) status.textContent = 'Предпросмотр приблизительный';
    else if (!data?.segments.length) status.textContent = 'Нижний левый угол листа · X0 Y0';
    else if (exceeds) status.textContent = 'Контур выходит за границы листа';
    else status.textContent = 'Контур помещается на листе';
  }

  function updateSelection() {
    const parts = selection ? data.segments.filter(segment => !segment.rapid &&
      (selectedRows ? selectedRows.has(segment.line) : inside(segment.from, selection) && inside(segment.to, selection))) : [];
    selectedBounds = parts.length ? outlineBounds({segments: parts}) : null;
    if (selectedRows && selectedBounds) {
      const [min, max] = selectedBounds;
      selection = [min[0], min[1], max[0], max[1]];
    }
    plot.setSelection(selection);
    const active = selectedBounds || bounds;
    size = active[1].map((value, axis) => value - active[0][axis]);
    if (selection && !selectedBounds) size = [0, 0, 0];
    const guide = tool === 'select' ? 'Протяните рамку вокруг текста, оставьте метки снаружи.' :
      tool === 'move' ? 'Перетащите контур мышью. Вне выделения метки остаются на своих местах.' :
      selection ? 'Изменения применяются к штрихам внутри рамки.' :
      'Весь контур. Чтобы оставить угловые метки на месте, обведите рамкой только текст.';
    get('editor-selection').textContent = guide;
    get('editor-clear-selection').disabled = !selection;
    get('editor-undo').disabled = !undo;
    get('editor-size').textContent = (selection ? 'Выделено' : 'Контур') + ' · X ' + number.format(size[0]) + ' · Y ' + number.format(size[1]) + ' мм';
    updateSizeFields();
  }

  function updateSizeFields() {
    if (!size[reference]) reference = size[0] ? 0 : 1;
    for (const [index, field] of controls.entries()) {
      field.value = size[index] >= .001 ? fieldSize(size[index]) : '';
      field.disabled = size[index] < .001;
    }
    get('editor-resize').querySelector('button').disabled = !size.slice(0, 2).some(value => value >= .001);
  }

  function paint(fit = false) {
    clearTimeout(timer);
    timer = null;
    data = plot.set(code.value, fit);
    bounds = outlineBounds(data);
    updateSelection();
    get('editor-lines').textContent = number.format(code.value ? code.value.trimEnd().split('\n').length : 0) + ' строк';
    setSheet(fit);
  }

  function load({name, source}) {
    filename = name;
    get('editor-filename').textContent = name;
    get('editor-filename').title = name;
    code.value = source;
    dirty = false;
    selection = selectedLines = selectedRows = undo = null;
    message('');
    paint(true);
  }

  async function useCurrent() {
    try {
      load(await getFile());
    } catch (error) {
      message(error.message, true);
    }
  }

  function mayReplace() {
    return !dirty || window.confirm('Заменить черновик? Несохранённые правки будут потеряны.');
  }

  function checkSource(source) {
    if (new TextEncoder().encode(source).length > maxBytes) throw new Error('Допустимый размер программы — до 2 МБ.');
  }

  async function run(operation) {
    if (busy) return;
    busy = true;
    message('');
    code.readOnly = true;
    try {
      checkSource(code.value);
      await operation(code.value);
    } catch (error) {
      message(error.message, true);
    } finally {
      busy = false;
      code.readOnly = false;
    }
  }

  async function resize(factor) {
    if (selection) return transform(factor, 0, 0, 0);
    await run(async source => {
      if (timer) paint();
      if (data?.approximate || data?.truncated) throw new Error('Для масштабирования нужен полный и точный предпросмотр траектории.');
      if (!size.slice(0, 2).some(value => value >= .001)) throw new Error('В файле нет траектории по XY для масштабирования.');
      const result = await request('/api/scale', {source, factor});
      undo = {source, selection, selectedLines, selectedRows, dirty};
      code.value = result.source;
      dirty = true;
      paint();
      message('Масштаб XY обновлён. Z и подача сохранены.');
    });
  }

  async function transform(factor, angle, dx, dy) {
    await run(async source => {
      if (timer) paint();
      if (data?.approximate || data?.truncated) throw new Error('Для преобразования нужен полный предпросмотр траектории.');
      if (selection && !selectedBounds) throw new Error('Выделите область, содержащую текст.');
      if (!data?.segments.length) throw new Error('В файле нет траектории для преобразования.');
      const [min, max] = selectedBounds || bounds;
      const pivot = [0, 1].map(axis => (min[axis] + max[axis]) / 2);
      const result = await request('/api/transform', {
        source, factor, angle, dx, dy, pivot, selection: selectedLines ? null : selection, selectedLines,
      });
      undo = {source, selection, selectedLines, selectedRows, dirty};
      code.value = result.source;
      selectedLines = result.selectedLines.length ? result.selectedLines : null;
      selectedRows = result.selectedRows.length ? new Set(result.selectedRows) : null;
      dirty = true;
      for (const id of ['editor-dx', 'editor-dy', 'editor-angle']) get(id).value = 0;
      get('editor-scale').value = 100;
      paint();
      message(selection ? 'Выделенные штрихи изменены.' : 'Контур изменён.');
    });
  }

  function setTool(next) {
    tool = next;
    drag = null;
    get('editor-plot').dataset.tool = tool;
    for (const button of document.querySelectorAll('[data-editor-tool]')) {
      button.classList.toggle('active', button.dataset.editorTool === tool);
      button.setAttribute('aria-pressed', button.dataset.editorTool === tool);
    }
    plot.onGesture = next === 'pan' ? null : (phase, point) => {
      if (busy || !data) return;
      if (phase === 'start') {
        if (tool === 'move' && selection && !inside(point, selection)) return;
        drag = point;
        return;
      }
      if (!drag) return;
      if (phase === 'cancel') {
        drag = null;
        plot.setSelection(selection);
        return;
      }
      const delta = [point[0] - drag[0], point[1] - drag[1]];
      const frame = rectangle(drag, point);
      const area = selection || [bounds[0][0], bounds[0][1], bounds[1][0], bounds[1][1]];
      plot.setSelection(tool === 'select' ? frame : shiftBox(area, ...delta));
      if (phase === 'finish') {
        drag = null;
        if (tool === 'select' && frame[2] - frame[0] > .01 && frame[3] - frame[1] > .01) {
          selection = frame;
          selectedLines = selectedRows = null;
          setTool('pan');
        } else {
          plot.setSelection(selection);
          if (tool === 'move' && Math.hypot(...delta) > .01) transform(1, 0, ...delta);
        }
      }
    };
    if (data) updateSelection();
  }

  code.addEventListener('input', () => {
    dirty = true;
    selection = selectedLines = selectedRows = undo = null;
    message('');
    clearTimeout(timer);
    timer = setTimeout(paint, 180);
  });
  for (const [axis, field] of controls.entries()) {
    field.addEventListener('input', () => {
      reference = axis;
      const value = field.valueAsNumber;
      if (size[axis] && size[1 - axis] && Number.isFinite(value)) {
        controls[1 - axis].value = fieldSize(size[1 - axis] * value / size[axis]);
      }
    });
  }
  get('editor-resize').addEventListener('submit', event => {
    event.preventDefault();
    if (timer) {
      paint();
      message('Текст изменился. Проверьте новые размеры контура и повторите изменение размера.', true);
      return;
    }
    resize(controls[reference].valueAsNumber / size[reference]);
  });
  get('editor-calibrate').addEventListener('submit', event => {
    event.preventDefault();
    resize(get('editor-target').valueAsNumber / get('editor-measured').valueAsNumber);
  });
  get('editor-sheet').addEventListener('change', () => setSheet());
  get('editor-orientation').addEventListener('change', () => setSheet());
  for (const id of ['editor-paper-width', 'editor-paper-height']) get(id).addEventListener('input', () => setSheet());
  for (const button of document.querySelectorAll('[data-editor-tool]')) {
    button.addEventListener('click', () => { if (!busy) setTool(button.dataset.editorTool); });
  }
  get('editor-clear-selection').addEventListener('click', () => {
    if (busy) return;
    selection = selectedLines = selectedRows = null;
    setTool('pan');
  });
  get('editor-transform').addEventListener('submit', event => {
    event.preventDefault();
    transform(get('editor-scale').valueAsNumber / 100, get('editor-angle').valueAsNumber,
      get('editor-dx').valueAsNumber, get('editor-dy').valueAsNumber);
  });
  get('editor-undo').addEventListener('click', () => {
    if (!undo || busy) return;
    ({selection, selectedLines, selectedRows, dirty} = undo);
    code.value = undo.source;
    undo = null;
    paint();
    message('Предыдущая правка отменена.');
  });
  get('editor-fit').addEventListener('click', () => plot.fit());
  get('editor-current').addEventListener('click', () => { if (!busy && mayReplace()) useCurrent(); });
  get('editor-open').addEventListener('click', () => { if (!busy) get('editor-picker').click(); });
  get('editor-picker').addEventListener('change', async event => {
    const selected = event.target.files[0];
    event.target.value = '';
    if (!selected || busy || !mayReplace()) return;
    if (selected.size > maxBytes) {
      message('Допустимый размер программы — до 2 МБ.', true);
      return;
    }
    try {
      load({name: selected.name, source: await selected.text()});
    } catch (error) {
      message(error.message, true);
    }
  });
  get('editor-export').addEventListener('click', () => run(async source => {
    await request('/api/validate', {source});
    const url = URL.createObjectURL(new Blob([source], {type: 'text/plain;charset=utf-8'}));
    const link = document.createElement('a');
    link.href = url;
    link.download = outputName(filename || 'program.nc');
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    dirty = false;
    message('Файл NC подготовлен к скачиванию.');
  }));
  get('editor-load').addEventListener('click', () => run(async source => {
    if (await upload({name: outputName(filename || 'program.nc'), source})) showWorkspace();
  }));

  return {open: () => {
    if (!filename && !dirty) useCurrent();
    else plot.schedule();
  }};
}
