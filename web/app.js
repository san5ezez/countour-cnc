import {Plot} from './plot.js';

const get = id => document.getElementById(id);
const all = selector => [...document.querySelectorAll(selector)];
const number = new Intl.NumberFormat('ru-RU');
const dimensions = new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 2});
const defaults = {
  steps: [.1, 1, 10, 50], step: 1, feed: 600, decimals: 3, baud: 115200,
  view: 'iso', grid: true, rapids: true, keyboard: false,
};
const settingsKey = 'contour-cnc.settings.v1';
const viewLabels = {iso: 'ИЗОМЕТРИЯ', xy: 'ВИД СВЕРХУ · XY', xz: 'ВИД СПЕРЕДИ · XZ', yz: 'ВИД СБОКУ · YZ'};
const states = {
  Offline: ['Не подключён', ''], Connecting: ['Подключение', 'active'],
  Idle: ['Готов к работе', 'ready'], Run: ['Выполнение', 'active'],
  Jog: ['Перемещение', 'active'], Home: ['Поиск нуля', 'active'],
  Hold: ['Пауза', 'warning'], Alarm: ['Alarm', 'warning'],
  Door: ['Защитная дверь', 'warning'], Check: ['Режим проверки', 'active'], Sleep: ['Спящий режим', 'warning'],
};
const jobLabels = {
  running: 'Выполняется', paused: 'На паузе', stopping: 'Остановка',
  complete: 'Завершено', cancelled: 'Остановлено', error: 'Ошибка',
};

let prefs = {...defaults};
try {
  const stored = JSON.parse(localStorage.getItem(settingsKey) || '{}');
  if (stored && Array.isArray(stored.steps)) prefs = {...defaults, ...stored};
} catch {
  // The interface also runs when browser storage is unavailable.
}

const plot = new Plot(get('plot'));
const jobControls = ['start', 'pause', 'stop'];
let currentStep = prefs.step;
let coordinate = 'position';
let machine = null;
let file = null;
let busy = false;
let failed = false;
let toastTimer;
let renderedLog = '';
let stateSequence = 0;

function savePreferences() {
  try {
    localStorage.setItem(settingsKey, JSON.stringify(prefs));
  } catch {
    notify('Браузер не разрешил сохранить настройки. Они действуют до закрытия вкладки.');
  }
}

function notify(message, error = false) {
  const toast = get('toast');
  toast.textContent = message;
  toast.className = error ? 'error' : '';
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, error ? 5600 : 3300);
}

async function request(path, body) {
  const options = {signal: AbortSignal.timeout(5000)};
  if (body) {
    options.method = 'POST';
    options.headers = {'Content-Type': 'application/json', 'X-CNC-Panel': 'local'};
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Ошибка локального сервера.');
  return data;
}

function selectedPort() {
  return get('port').value;
}

async function refreshPorts(showMessage = false) {
  try {
    const {ports, serialAvailable} = await request('/api/ports');
    const select = get('port');
    const previous = machine?.port || select.value;
    select.replaceChildren(new Option('Симулятор', 'simulator'));
    for (const port of ports) select.append(new Option(port.label, port.id));
    if (machine?.port && ![...select.options].some(option => option.value === machine.port)) {
      select.append(new Option(machine.port, machine.port));
    }
    select.value = [...select.options].some(option => option.value === previous) ? previous : 'simulator';
    if (showMessage) {
      if (!serialAvailable) notify('Для USB установите pyserial из requirements.txt.');
      else notify(ports.length ? 'Список последовательных портов обновлён.' : 'Доступные USB-порты не найдены.');
    }
  } catch (error) {
    if (showMessage) notify(error.message, true);
  }
}

function isJobActive(job) {
  return ['running', 'paused', 'stopping'].includes(job?.status);
}

function updateControls() {
  const port = machine?.port;
  const job = machine?.job;
  const state = machine?.state;
  const active = isJobActive(job);
  const locked = busy || failed;
  const ready = machine?.ready && !locked;
  get('port').disabled = Boolean(port) || locked;
  get('baud').disabled = Boolean(port) || locked;
  get('connect').disabled = !machine || active || locked;
  get('connect').querySelector('span').textContent = port ? 'Отключить' : 'Подключить';
  get('open-file').disabled = active || locked;
  const homeDisabled = machine?.homing_enabled === false;
  const controllerAvailable = !locked && !active && !machine?.busy && ['Idle', 'Alarm'].includes(state);
  const home = get('home');
  home.disabled = !controllerAvailable || homeDisabled;
  if (homeDisabled && !failed) home.setAttribute('aria-describedby', 'home-hint');
  else home.removeAttribute('aria-describedby');
  get('home-help').hidden = !homeDisabled || failed;
  get('home-check').disabled = !controllerAvailable;
  get('unlock').disabled = locked || active || machine?.busy || state !== 'Alarm';
  get('reset').disabled = !port || locked;
  get('console-input').disabled = !ready;
  get('console-send').disabled = !ready;
  get('start').disabled = !ready || !file || file.revision !== machine.revision;
  get('pause').disabled = locked || (job?.status !== 'running' && !(job?.status === 'paused' && ['Idle', 'Hold:0'].includes(state)));
  get('pause').querySelector('span').textContent = job?.status === 'paused' ? 'Продолжить' : 'Пауза';
  get('pause').querySelector('use').setAttribute('href', '/icons.svg#' + (job?.status === 'paused' ? 'play' : 'pause'));
  get('stop').disabled = locked || !active || job.status === 'stopping';
  for (const button of all('[data-jog]')) button.disabled = !ready;
  for (const button of all('[data-zero]')) button.disabled = !ready || coordinate !== 'position';
}

function renderLog(log) {
  const key = log.length ? String(log.at(-1).id) + ':' + log.length : '';
  if (key === renderedLog) return;
  renderedLog = key;
  const output = get('console-log');
  const nearBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 18;
  const y = output.scrollTop;
  const rows = log.map(entry => {
    const row = document.createElement('div');
    const time = document.createElement('time');
    const text = document.createElement('span');
    row.className = 'log-row ' + entry.kind;
    time.textContent = entry.time;
    text.className = 'log-text';
    text.textContent = (entry.kind === 'send' ? '› ' : '') + entry.text;
    row.append(time, text);
    return row;
  });
  output.replaceChildren(...rows);
  output.scrollTop = nearBottom ? output.scrollHeight : y;
}

function renderCoordinates() {
  const position = failed ? null : machine?.[coordinate];
  for (const [index, axis] of ['X', 'Y', 'Z'].entries()) {
    const value = position?.[index];
    get('position-' + axis).textContent = Number.isFinite(value) ? value.toFixed(prefs.decimals) : '—';
  }
  for (const button of all('[data-coordinate]')) {
    const active = button.dataset.coordinate === coordinate;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active);
  }
}

function setSpeed(id, value, label) {
  const field = get(id);
  if (field.dataset.value === String(value)) return;
  field.dataset.value = value;
  const unit = document.createElement('small');
  unit.textContent = label;
  field.replaceChildren(number.format(Math.round(value)) + ' ', unit);
}

function render() {
  const state = failed ? 'Offline' : machine?.state || 'Connecting';
  const [label, color] = failed ? ['Нет связи с приложением', 'warning'] : states[state.split(':')[0]] || [state, ''];
  const indicator = get('header-status');
  indicator.className = 'indicator ' + color;
  indicator.lastElementChild.textContent = label;
  const port = machine?.port;
  if (port && port !== 'simulator' && machine.baud) get('baud').value = machine.baud;
  if (port && get('port').value !== port) {
    const select = get('port');
    if (![...select.options].some(option => option.value === port)) select.append(new Option(port, port));
    select.value = port;
  }
  get('footer-status').textContent = failed ? 'Связь с локальным сервером потеряна' :
    port === 'simulator' ? 'Режим симуляции' : port ? 'Подключён · ' + port : 'Локальный интерфейс';
  renderCoordinates();
  setSpeed('actual-feed', failed ? 0 : machine?.feed || 0, 'мм/мин');
  setSpeed('actual-spindle', failed ? 0 : machine?.spindle || 0, 'об/мин');
  plot.setPosition(failed ? null : machine?.position || null, machine?.job?.status === 'running');
  if (machine) renderLog(machine.log);
  const job = machine?.job;
  const acknowledged = job?.acknowledged || 0;
  const total = job?.total || file?.lines || 0;
  const percent = total ? Math.floor(acknowledged / total * 100) : 0;
  const jobStatus = get('job-status');
  jobStatus.textContent = jobLabels[job?.status] || 'Ожидание запуска';
  if (job?.status === 'running' && acknowledged === total) jobStatus.textContent = 'Завершение движения';
  jobStatus.title = job?.detail || '';
  get('job-percent').textContent = percent + '%';
  get('progress').value = percent;
  get('job-lines').textContent = acknowledged + ' / ' + total + ' команд';
  const elapsed = job?.elapsed || 0;
  get('job-elapsed').textContent = [Math.floor(elapsed / 60), elapsed % 60].map(value => String(value).padStart(2, '0')).join(':');
  updateControls();
}

function showFile(data) {
  file = data;
  const parsed = plot.set(data.source);
  get('visual-file').textContent = data.name + ' · предпросмотр G-кода';
  get('program-name').textContent = data.name;
  get('program-name').title = data.name;
  get('program-lines').textContent = number.format(data.lines) + ' команд G-кода';
  const [x, y, z] = parsed.max.map((value, axis) => dimensions.format(value - parsed.min[axis]));
  get('plot-size').textContent = 'X ' + x + ' · Y ' + y + ' · Z ' + z + ' мм';
  const warning = get('plot-warning');
  warning.hidden = !(parsed.truncated || parsed.approximate);
  warning.textContent = parsed.truncated ? 'Большой файл. Показано начало траектории.' :
    'Предпросмотр приблизительный. Часть команд зависит от настроек станка.';
  render();
}

async function poll() {
  const sequence = stateSequence;
  try {
    const data = await request('/api/state');
    if (sequence !== stateSequence) return;
    machine = data;
    failed = false;
    if (!file || machine.revision !== file.revision) {
      const next = await request('/api/file');
      if (sequence !== stateSequence) return;
      showFile(next);
    }
    render();
  } catch {
    if (sequence === stateSequence) {
      failed = true;
      render();
    }
  }
}

async function action(name, data = {}) {
  if (busy) return false;
  busy = true;
  stateSequence++;
  updateControls();
  try {
    const result = await request('/api/action', {action: name, ...data});
    if (name === 'upload') showFile(result);
    else machine = result;
    failed = false;
    return true;
  } catch (error) {
    notify(error.message, true);
    return false;
  } finally {
    busy = false;
    stateSequence++;
    render();
  }
}

function confirmAction(title, copy, label, callback) {
  const dialog = get('confirm');
  if (dialog.open) return;
  get('confirm-title').textContent = title;
  get('confirm-copy').textContent = copy;
  get('confirm-yes').textContent = label;
  dialog.returnValue = 'cancel';
  dialog.addEventListener('close', () => {
    if (dialog.returnValue === 'yes') callback();
  }, {once: true});
  dialog.showModal();
}

function handleHardware(label, copy, callback) {
  if (machine?.port === 'simulator') callback();
  else confirmAction(label, copy, label, callback);
}

function renderSteps() {
  get('steps').replaceChildren(...prefs.steps.map(step => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = String(step);
    button.classList.toggle('active', step === currentStep);
    button.setAttribute('aria-pressed', step === currentStep);
    button.addEventListener('click', () => {
      currentStep = step;
      renderSteps();
      all('#steps button')[prefs.steps.indexOf(step)].focus();
    });
    return button;
  }));
}

function setView(view) {
  plot.setView(view);
  get('plot-mode').textContent = viewLabels[view];
  for (const button of all('[data-view]')) {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active);
  }
}

function applyPreferences() {
  currentStep = prefs.step;
  get('feed').value = prefs.feed;
  if (!machine?.port || machine.port === 'simulator') get('baud').value = prefs.baud;
  plot.grid = prefs.grid;
  plot.rapids = prefs.rapids;
  plot.schedule();
  setView(prefs.view);
  renderSteps();
  renderCoordinates();
}

function fillSettings(source) {
  for (const field of ['step', 'feed', 'decimals', 'view', 'baud']) get('pref-' + field).value = source[field];
  get('pref-steps').value = source.steps.join(' ');
  for (const field of ['grid', 'rapids', 'keyboard']) get('pref-' + field).checked = source[field];
  get('settings-error').hidden = true;
}

function submitSettings(event) {
  event.preventDefault();
  const steps = get('pref-steps').value.trim().replace(/,/g, '.').split(/[\s;]+/).map(Number);
  const step = get('pref-step').valueAsNumber;
  const error = get('settings-error');
  if (steps.length > 8 || steps.some(value => !Number.isFinite(value) || value < .001 || value > 1000 || Math.abs(value * 1000 - Math.round(value * 1000)) > .0001)) {
    error.textContent = 'Введите до 8 шагов от 0,001 до 1000 мм через пробел. Допустимо до трёх знаков после запятой.';
    error.hidden = false;
    return;
  }
  if (!steps.includes(step)) {
    error.textContent = 'Шаг при запуске должен входить в набор.';
    error.hidden = false;
    return;
  }
  prefs = {
    steps: [...new Set(steps)].sort((a, b) => a - b),
    step,
    feed: get('pref-feed').valueAsNumber,
    decimals: +get('pref-decimals').value,
    baud: +get('pref-baud').value,
    view: get('pref-view').value,
    grid: get('pref-grid').checked,
    rapids: get('pref-rapids').checked,
    keyboard: get('pref-keyboard').checked,
  };
  savePreferences();
  applyPreferences();
  get('settings').close();
  notify('Настройки сохранены.');
}

async function openFile(selected) {
  if (!selected || busy || isJobActive(machine?.job)) return;
  if (selected.size > 2_000_000) {
    notify('Допустимый размер программы — до 2 МБ.', true);
    return;
  }
  try {
    await action('upload', {name: selected.name, source: await selected.text()});
  } catch (error) {
    notify(error.message, true);
  }
}

function bindButtons() {
  get('workspace-nav').addEventListener('click', () => window.scrollTo({top: 0, behavior: 'smooth'}));
  get('settings-open').addEventListener('click', () => {
    fillSettings(prefs);
    get('settings').showModal();
  });
  get('settings-form').addEventListener('submit', submitSettings);
  get('default-settings').addEventListener('click', () => fillSettings(defaults));
  all('[data-close]').forEach(button => button.addEventListener('click', () => get(button.dataset.close).close()));
  get('open-file').addEventListener('click', () => get('file-picker').click());
  get('file-picker').addEventListener('change', event => {
    openFile(event.target.files[0]);
    event.target.value = '';
  });
  get('refresh-ports').addEventListener('click', () => refreshPorts(true));
  get('connect').addEventListener('click', async () => {
    if (machine?.port) {
      if (await action('disconnect')) {
        get('baud').value = prefs.baud;
        refreshPorts();
      }
    } else {
      await action('connect', {port: selectedPort(), baud: +get('baud').value});
    }
  });
  get('start').addEventListener('click', () => {
    const revision = file?.revision;
    handleHardware('Запустить программу', 'Станок начнёт выполнять ' + file.name + ' с текущим рабочим нулём. Проверьте положение инструмента и заготовки.',
      () => action('start', {revision}));
  });
  get('pause').addEventListener('click', () => action(machine?.job?.status === 'paused' ? 'resume' : 'pause'));
  get('stop').addEventListener('click', () => action('stop'));
  get('home').addEventListener('click', () => {
    handleHardware('Найти машинный ноль', 'GRBL начнёт цикл поиска концевых выключателей по настройкам контроллера.', () => action('home'));
  });
  get('home-check').addEventListener('click', () => action('read-settings'));
  get('unlock').addEventListener('click', () => {
    handleHardware('Разблокировать', 'Убедитесь, что причина аварийного состояния устранена.', () => action('unlock'));
  });
  get('reset').addEventListener('click', () => {
    confirmAction('Сбросить GRBL', 'Программный сброс прервёт выполнение команд. После сброса может потребоваться поиск машинного нуля.', 'Сбросить',
      () => action('reset'));
  });
  all('[data-zero]').forEach(button => button.addEventListener('click', () => action('zero', {axes: button.dataset.zero})));
  all('[data-coordinate]').forEach(button => button.addEventListener('click', () => {
    coordinate = button.dataset.coordinate;
    renderCoordinates();
    updateControls();
  }));
  all('[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
  get('zoom-in').addEventListener('click', () => plot.zoom(1.25));
  get('zoom-out').addEventListener('click', () => plot.zoom(.8));
  get('zoom-fit').addEventListener('click', () => plot.fit());
  get('clear-log').addEventListener('click', () => action('clear-log'));
  get('console-form').addEventListener('submit', async event => {
    event.preventDefault();
    const input = get('console-input');
    const line = input.value.trim();
    if (line && await action('console', {line})) input.value = '';
  });
}

function jog(move) {
  if (!machine?.ready || failed || busy) return;
  const feed = get('feed');
  if (!feed.checkValidity() || !Number.isFinite(feed.valueAsNumber)) {
    notify('Укажите подачу от 1 до 30 000 мм/мин.', true);
    feed.focus();
    return;
  }
  action('jog', {axis: move[0], step: currentStep * (move[1] === '+' ? 1 : -1), feed: feed.valueAsNumber});
}

function bindJog() {
  for (const button of all('[data-jog]')) button.addEventListener('click', () => jog(button.dataset.jog));
  const moves = {ArrowUp: 'Y+', ArrowDown: 'Y-', ArrowLeft: 'X-', ArrowRight: 'X+', PageUp: 'Z+', PageDown: 'Z-'};
  document.addEventListener('keydown', event => {
    if (!prefs.keyboard || !get('editor-panel').hidden || event.repeat || event.altKey || event.ctrlKey || event.shiftKey || event.metaKey ||
        document.querySelector('dialog[open]') || event.target.closest('input, select, button, textarea, [contenteditable]')) return;
    if (moves[event.key] && machine?.ready && !failed && !busy) {
      event.preventDefault();
      jog(moves[event.key]);
    }
  });
}

async function enableEditor() {
  try {
    if (!(await request('/api/features')).editor) return;
    const {createEditor} = await import('./editor.js');
    const editor = createEditor({
      getFile: async () => file || request('/api/file'),
      request,
      upload: data => action('upload', data),
      showWorkspace,
    });
    document.body.dataset.editorEnabled = 'true';
    get('editor-nav').hidden = false;
    const showEditor = () => {
      get('workspace-panel').hidden = true;
      get('editor-panel').hidden = false;
      get('workspace-nav').classList.remove('current');
      get('editor-nav').classList.add('current');
      editor.open();
      window.scrollTo({top: 0});
    };
    get('editor-nav').addEventListener('click', showEditor);
    get('workspace-nav').addEventListener('click', showWorkspace);
    showEditor();
  } catch (error) {
    notify(error.message, true);
  }
}

function showWorkspace() {
  get('workspace-panel').hidden = false;
  get('editor-panel').hidden = true;
  get('editor-nav').classList.remove('current');
  get('workspace-nav').classList.add('current');
}

function bindDrop() {
  const area = get('plot-area');
  const target = get('drop-target');
  window.addEventListener('dragover', event => {
    if (event.dataTransfer.types.includes('Files')) event.preventDefault();
  });
  window.addEventListener('drop', event => {
    if (event.dataTransfer.files.length) event.preventDefault();
  });
  area.addEventListener('dragover', event => {
    if (event.dataTransfer.types.includes('Files') && !get('open-file').disabled) {
      event.preventDefault();
      target.hidden = false;
    }
  });
  area.addEventListener('dragleave', event => {
    if (!area.contains(event.relatedTarget)) target.hidden = true;
  });
  area.addEventListener('drop', event => {
    event.preventDefault();
    target.hidden = true;
    openFile(event.dataTransfer.files[0]);
  });
}

applyPreferences();
bindButtons();
bindJog();
bindDrop();
updateControls();
refreshPorts();
enableEditor();
async function refreshState() {
  if (!busy) await poll();
  setTimeout(refreshState, 250);
}
refreshState();
