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

  function message(text, error = false) {
    feedback.textContent = text;
    feedback.hidden = !text;
    feedback.classList.toggle('error', error);
  }

  function setSheet() {
    const format = formats[get('editor-sheet').value];
    const landscape = get('editor-orientation').value === 'landscape';
    const width = landscape ? format.height : format.width;
    const height = landscape ? format.width : format.height;
    const [min, max] = bounds;
    plot.setSheet({...format, width, height, x: (min[0] + max[0] - width) / 2, y: (min[1] + max[1] - height) / 2});
    get('editor-sheet-size').textContent = format.name + ' · ' + width + ' × ' + height + ' мм';
    const status = get('editor-fit-status');
    const exceeds = size[0] > width + .0001 || size[1] > height + .0001;
    const uncertain = data?.approximate || data?.truncated;
    status.toggleAttribute('data-outside', exceeds || uncertain);
    if (uncertain) status.textContent = 'Предпросмотр приблизительный';
    else if (!data?.segments.length) status.textContent = 'Лист центрируется по контуру';
    else if (exceeds) status.textContent = 'Контур выходит за границы листа';
    else status.textContent = 'Контур помещается на листе';
  }

  function paint() {
    clearTimeout(timer);
    timer = null;
    data = plot.set(code.value);
    bounds = outlineBounds(data);
    size = bounds[1].map((value, axis) => value - bounds[0][axis]);
    if (!size[reference]) reference = size[0] ? 0 : 1;
    for (const [index, field] of controls.entries()) {
      field.value = size[index] >= .001 ? fieldSize(size[index]) : '';
      field.disabled = size[index] < .001;
    }
    get('editor-size').textContent = 'Контур · X ' + number.format(size[0]) + ' · Y ' + number.format(size[1]) + ' мм';
    get('editor-lines').textContent = number.format(code.value ? code.value.trimEnd().split('\n').length : 0) + ' строк';
    get('editor-resize').querySelector('button').disabled = !size.slice(0, 2).some(value => value >= .001);
    setSheet();
  }

  function load({name, source}) {
    filename = name;
    get('editor-filename').textContent = name;
    get('editor-filename').title = name;
    code.value = source;
    dirty = false;
    message('');
    paint();
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
    await run(async source => {
      if (timer) paint();
      if (data?.approximate || data?.truncated) throw new Error('Для масштабирования нужен полный и точный предпросмотр траектории.');
      if (!size.slice(0, 2).some(value => value >= .001)) throw new Error('В файле нет траектории по XY для масштабирования.');
      const result = await request('/api/scale', {source, factor});
      code.value = result.source;
      dirty = true;
      paint();
      message('Масштаб XY обновлён. Z и подача сохранены.');
    });
  }

  code.addEventListener('input', () => {
    dirty = true;
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
  get('editor-sheet').addEventListener('change', setSheet);
  get('editor-orientation').addEventListener('change', setSheet);
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
