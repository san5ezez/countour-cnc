import {Plot} from './plot.js';

const get = id => document.getElementById(id);
const all = selector => [...document.querySelectorAll(selector)];
const number = new Intl.NumberFormat('ru-RU');
const dimensions = new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 2});
const defaults = {
  steps: [.1, 1, 10, 50], step: 1, feed: 600, decimals: 3, baud: 115200,
  view: 'xy', grid: true, rapids: true, keyboard: false,
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
let gesture = null;
let pointMode = false;
let recoveryDraft = null;
let recoveryError = '';

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

async function request(path, body, keepalive = false) {
  const options = {signal: AbortSignal.timeout(5000)};
  if (body) {
    options.method = 'POST';
    options.headers = {'Content-Type': 'application/json', 'X-CNC-Panel': 'local'};
    options.body = JSON.stringify(body);
    options.keepalive = keepalive;
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
  const ready = machine?.ready && !locked && !gesture;
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
  get('pause').disabled = locked || (job?.status !== 'running' && !(machine?.pause_ready && machine.override_target == null));
  get('pause').querySelector('span').textContent = job?.status === 'paused' ? 'Продолжить' : 'Пауза';
  get('pause').querySelector('use').setAttribute('href', '/icons.svg#' + (job?.status === 'paused' ? 'play' : 'pause'));
  get('stop').disabled = locked || !active || job.status === 'stopping';
  for (const button of all('[data-jog]')) {
    button.disabled = !ready && button !== gesture?.button;
    button.toggleAttribute('data-held', button === gesture?.button);
  }
  const jogStop = get('jog-stop');
  jogStop.hidden = !machine?.jog_motion && !gesture?.started;
  jogStop.disabled = failed || jogStop.hidden;
  get('point-mode').disabled = !pointMode && (!ready || plot.view !== 'xy' || !machine?.position);
  get('recovery-open').disabled = !file;
  for (const button of all('[data-zero]')) button.disabled = !ready || coordinate !== 'position';
  updateFeedOverride(job, locked);
  renderRecovery();
}

function updateFeedOverride(job, locked) {
  const form = get('override-form');
  const field = get('override-percent');
  const status = get('override-status');
  const current = machine?.feed_override;
  const target = machine?.override_target;
  const factor = get('feed-factor');
  factor.hidden = failed || current == null || current === 100;
  if (!factor.hidden) factor.textContent = 'Подача ' + current + '%';
  if (job?.status === 'paused' && form.hidden) field.value = current ?? 100;
  form.hidden = job?.status !== 'paused';
  const available = !locked && machine?.pause_ready && current != null && target == null;
  field.disabled = !available;
  form.querySelector('button').disabled = !available;
  const message = target != null ? 'GRBL применяет ' + target + '%…' :
    !machine?.pause_ready ? 'Ожидание остановки' :
    current == null ? 'GRBL пока не сообщил процент подачи' : 'Текущая подача · ' + current + '%';
  if (status.textContent !== message) status.textContent = message;
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
  if (pointMode && (failed || !port || isJobActive(machine?.job))) setPointMode(false);
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
  plot.setJobProgress(file?.revision === machine?.revision ? job : null);
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
    if (name === 'upload' || name === 'load-recovery') showFile(result);
    else machine = result;
    failed = false;
    return true;
  } catch (error) {
    if (name.includes('recovery') && get('recovery-dialog').open) recoveryError = error.message;
    else notify(error.message, true);
    return false;
  } finally {
    busy = false;
    stateSequence++;
    render();
  }
}

function confirmAction(title, copy, label, callback) {
  endGesture();
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

function recoverySpec() {
  const clearance = get('recovery-clearance').valueAsNumber;
  return {
    revision: file?.revision, kind: get('recovery-kind').value,
    number: get('recovery-number').valueAsNumber,
    clearance: Number.isFinite(clearance) ? clearance : null,
  };
}

function openRecovery() {
  if (!file) return;
  endGesture();
  if (pointMode) setPointMode(false);
  const checkpoint = file.checkpoint;
  const suggested = machine?.job ? plot.trackedLine() : null;
  get('recovery-kind').value = suggested && !checkpoint ? 'line' : 'command';
  get('recovery-number').value = checkpoint?.number ?? suggested ?? 1;
  get('recovery-clearance').value = checkpoint?.clearance ?? '';
  get('recovery-origin').checked = false;
  recoveryDraft = null;
  recoveryError = '';
  get('recovery-dialog').showModal();
  renderRecovery();
}

function renderRecovery() {
  if (!get('recovery-dialog').open) return;
  const plan = machine?.recovery;
  const spec = recoverySpec();
  const matching = recoveryDraft?.revision === file?.revision && plan && spec.clearance === plan.clearance &&
    spec.number === (spec.kind === 'line' ? plan.line : plan.number);
  const current = matching ? plan : null;
  const moving = ['lifting', 'travelling'].includes(plan?.stage);
  const inProgress = moving || current?.stage === 'checking';
  const active = isJobActive(machine?.job);
  const status = get('recovery-status');
  const detail = recoveryError || current?.detail;
  const hint = {
    checking: 'Проверка режимов и рабочих смещений GRBL…',
    planned: 'Проверьте цель и подтвердите подвод.',
    lifting: 'Подъём ручки до безопасной высоты…',
    travelling: 'Переезд к началу команды…',
    arrived: 'Станок прибыл. Подтвердите, чтобы опустить ручку и продолжить.',
  };
  const message = detail || hint[current?.stage] ||
    (active ? 'Состояние можно сохранить сейчас. Для подвода остановите текущий запуск.' :
      'Введите номер команды или строку NC-файла. Начало выбранной команды рассчитывается по G-коду.');
  if (status.textContent !== message) status.textContent = message;
  status.classList.toggle('error', Boolean(detail));
  get('recovery-filename').textContent = file?.name || '—';
  const target = get('recovery-target');
  target.hidden = !current;
  if (current) {
    const [x, y, z] = current.entry.map(value => dimensions.format(value));
    const description = 'Команда ' + current.number + ' · строка ' + current.line + ' · ' + current.command +
      ' · X ' + x + ' · Y ' + y + ' · Z ' + z;
    if (target.textContent !== description) target.textContent = description;
  }
  for (const id of ['recovery-kind', 'recovery-number', 'recovery-clearance']) get(id).disabled = Boolean(inProgress || busy);
  get('recovery-prepare').disabled = !machine?.ready || busy || failed || Boolean(inProgress);
  get('recovery-confirm-origin').hidden = current?.stage !== 'planned' || !!detail;
  const move = get('recovery-move');
  move.hidden = current?.stage !== 'planned' || !!detail;
  move.disabled = busy || !machine?.ready || !get('recovery-origin').checked;
  const run = get('recovery-run');
  run.hidden = current?.stage !== 'arrived' || !!detail;
  run.disabled = busy || !machine?.ready;
  get('recovery-cancel').hidden = !moving;
  get('recovery-stop-job').hidden = !active || moving;
  get('recovery-stop-job').disabled = busy || machine?.job?.status === 'stopping';
  get('recovery-save').disabled = busy || !file;
  get('recovery-load').disabled = busy || active || moving;
}

function bindRecovery() {
  const dialog = get('recovery-dialog');
  get('recovery-open').addEventListener('click', openRecovery);
  get('editor-recovery').addEventListener('click', () => {
    showWorkspace();
    openRecovery();
  });
  get('recovery-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    if (['lifting', 'travelling'].includes(machine?.recovery?.stage)) action('jog-cancel');
  });
  for (const id of ['recovery-kind', 'recovery-number', 'recovery-clearance']) {
    get(id).addEventListener('input', () => {
      recoveryDraft = null;
      recoveryError = '';
      get('recovery-origin').checked = false;
      renderRecovery();
    });
  }
  get('recovery-origin').addEventListener('change', renderRecovery);
  get('recovery-form').addEventListener('submit', event => {
    event.preventDefault();
    recoveryError = '';
    const feed = jogFeed();
    if (feed === undefined) {
      recoveryError = 'Укажите допустимую подачу в панели «Перемещение».';
      renderRecovery();
      return;
    }
    const spec = recoverySpec();
    recoveryDraft = spec;
    get('recovery-origin').checked = false;
    action('prepare-recovery', {...spec, feed});
  });
  get('recovery-move').addEventListener('click', async () => {
    const moved = await action('move-recovery', {id: machine?.recovery?.id, confirmed: get('recovery-origin').checked});
    if (moved && !dialog.open && ['lifting', 'travelling'].includes(machine?.recovery?.stage)) action('jog-cancel');
  });
  get('recovery-run').addEventListener('click', async () => {
    if (await action('start-recovery', {id: machine?.recovery?.id, confirmed: true})) dialog.close();
  });
  get('recovery-cancel').addEventListener('click', () => action('jog-cancel'));
  get('recovery-stop-job').addEventListener('click', () => action('stop'));
  get('recovery-save').addEventListener('click', async () => {
    const field = get('recovery-number');
    if (!field.reportValidity()) return;
    try {
      const result = await request('/api/action', {action: 'save-recovery', ...recoverySpec()});
      const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], {type: 'application/json'}));
      const link = document.createElement('a');
      link.href = url;
      link.download = result.name.replace(/\.[^.]+$/, '') + '.contour-job.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      recoveryError = error.message;
      renderRecovery();
    }
  });
  get('recovery-load').addEventListener('click', () => get('recovery-picker').click());
  get('recovery-picker').addEventListener('change', async event => {
    const selected = event.target.files[0];
    event.target.value = '';
    if (!selected) return;
    try {
      if (selected.size > 12_004_096) throw new Error('Файл состояния слишком большой.');
      const {version, name, source, number, origin, clearance} = JSON.parse(await selected.text());
      recoveryError = '';
      if (await action('load-recovery', {version, name, source, number, origin, clearance})) {
        recoveryDraft = null;
        get('recovery-kind').value = 'command';
        get('recovery-number').value = file.checkpoint.number;
        get('recovery-clearance').value = file.checkpoint.clearance ?? '';
        get('recovery-origin').checked = false;
        renderRecovery();
      }
    } catch {
      recoveryError = 'Не удалось прочитать файл состояния Контур CNC.';
      renderRecovery();
    }
  });
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
  if (view !== 'xy' && pointMode) setPointMode(false);
  get('plot-mode').textContent = viewLabels[view];
  for (const button of all('[data-view]')) {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active);
  }
  updateControls();
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
    endGesture();
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
  get('override-form').addEventListener('submit', event => {
    event.preventDefault();
    action('feed-override', {percent: get('override-percent').valueAsNumber});
  });
  get('jog-stop').addEventListener('click', () => {
    endGesture();
    request('/api/action', {action: 'jog-cancel'}, true).catch(error => notify(error.message, true));
  });
  get('point-mode').addEventListener('click', () => setPointMode(!pointMode));
  get('execution-view').addEventListener('click', event => {
    const button = event.currentTarget;
    const enabled = button.getAttribute('aria-pressed') !== 'true';
    button.setAttribute('aria-pressed', enabled);
    get('work-legend').textContent = enabled ? 'Выполнено' : 'Рабочий ход';
    get('unwritten-legend').hidden = !enabled;
    plot.setExecutionView(enabled);
  });
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

function jogFeed() {
  const feed = get('feed');
  if (!feed.checkValidity() || !Number.isFinite(feed.valueAsNumber)) {
    notify('Укажите подачу от 1 до 30 000 мм/мин.', true);
    feed.focus();
    return;
  }
  return feed.valueAsNumber;
}

function setPointMode(enabled) {
  pointMode = enabled;
  get('plot').classList.toggle('point-mode', enabled);
  get('point-mode').setAttribute('aria-pressed', enabled);
  const status = get('point-status');
  status.hidden = !enabled;
  status.textContent = enabled ? 'Кликните точку XY. Высота Z сохранится.' : '';
  if (!enabled) plot.setTarget(null);
  plot.onPick = enabled ? async ([x, y]) => {
    if (!machine?.ready || failed || busy || gesture || !machine.position) return;
    const feed = jogFeed();
    if (feed === undefined) return;
    plot.setTarget([x, y]);
    status.textContent = 'Цель · X ' + dimensions.format(x) + ' · Y ' + dimensions.format(y) + ' мм';
    if (!await action('jog-point', {x, y, feed})) plot.setTarget(null);
  } : null;
  updateControls();
}

function stepJog(move, feed) {
  action('jog', {axis: move[0], step: currentStep * (move[1] === '+' ? 1 : -1), feed});
}

function releaseJog(token) {
  return request('/api/action', {action: 'jog-release', token}, true);
}

async function keepJog(current) {
  if (gesture !== current) return;
  try {
    await request('/api/action', {action: 'jog-keep', token: current.token});
  } catch (error) {
    if (gesture === current) {
      endGesture();
      notify(error.message, true);
    }
    return;
  }
  if (gesture === current) current.timer = setTimeout(() => keepJog(current), 125);
}

function beginGesture(move, input, button) {
  if (gesture || !machine?.ready || failed || busy) return false;
  const feed = jogFeed();
  if (feed === undefined) return false;
  const current = {move, input, button, feed, token: crypto.randomUUID(), started: false};
  gesture = current;
  current.timer = setTimeout(async () => {
    if (gesture !== current) return;
    current.started = true;
    updateControls();
    try {
      await request('/api/action', {
        action: 'jog-hold', token: current.token, axis: move[0], direction: move[1] === '+' ? 1 : -1, feed,
      });
      if (gesture === current) keepJog(current);
      else await releaseJog(current.token);
    } catch (error) {
      if (gesture === current) {
        endGesture();
        notify(error.message, true);
      }
    }
  }, 240);
  updateControls();
  return true;
}

function endGesture(tap = false) {
  const current = gesture;
  if (!current) return;
  gesture = null;
  clearTimeout(current.timer);
  if (current.started) {
    releaseJog(current.token).catch(error => notify(error.message, true));
  } else if (tap && machine?.ready && !busy && !failed) {
    stepJog(current.move, current.feed);
  }
  updateControls();
}

function bindJog() {
  for (const button of all('[data-jog]')) {
    const move = button.dataset.jog;
    button.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !event.isPrimary || !beginGesture(move, event.pointerId, button)) return;
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
    });
    button.addEventListener('pointerup', event => {
      if (gesture?.input === event.pointerId) endGesture(true);
    });
    for (const name of ['pointercancel', 'lostpointercapture']) {
      button.addEventListener(name, event => {
        if (gesture?.input === event.pointerId) endGesture();
      });
    }
    button.addEventListener('click', event => {
      if (event.detail !== 0 || !machine?.ready || failed || busy || gesture) return;
      const feed = jogFeed();
      if (feed !== undefined) stepJog(move, feed);
    });
  }
  const moves = {ArrowUp: 'Y+', ArrowDown: 'Y-', ArrowLeft: 'X-', ArrowRight: 'X+', PageUp: 'Z+', PageDown: 'Z-'};
  document.addEventListener('keydown', event => {
    if (!prefs.keyboard || !moves[event.key] || !get('editor-panel').hidden || event.altKey || event.ctrlKey || event.shiftKey || event.metaKey ||
        document.querySelector('dialog[open]') || event.target.closest('input, select, button, textarea, [contenteditable]')) return;
    if (gesture?.input === event.key || (!event.repeat && beginGesture(moves[event.key], event.key))) event.preventDefault();
  });
  document.addEventListener('keyup', event => {
    if (gesture?.input !== event.key) return;
    event.preventDefault();
    endGesture(true);
  });
  window.addEventListener('blur', () => endGesture());
  window.addEventListener('pagehide', () => endGesture());
  document.addEventListener('visibilitychange', () => { if (document.hidden) endGesture(); });
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
      endGesture();
      if (pointMode) setPointMode(false);
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
bindRecovery();
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
