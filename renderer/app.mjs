import { agentActivity, buildRooms, languageChoices, pendingStudioPlan, roleDetails, roleNames, taskForAgent } from './workshop.mjs';
import { paintRooms } from './room-art.mjs';
import { renderWork } from './work-view.mjs';

const bridge = window.hearth;
const $ = selector => document.querySelector(selector);
const content = $('#content');
const dialog = $('#dialog');
const form = $('#dialog-form');
const runtimeNames = { codex: 'Codex', claude: 'Claude Code' };
const modeNames = { inherit: 'Как у директора', fixed: 'Фиксированные модель и усилие', dynamic: 'Выбирает директор' };
const views = { overview: 'Обзор', work: 'Работа', inbox: 'Входящие', workshop: 'Мастерская', settings: 'Настройки' };
const icons = {
  overview: '<rect x="3" y="3" width="7" height="8" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="3" y="15" width="7" height="6" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/>',
  work: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16m6-16v16M5.5 8h1m5 0h1m5 0h1"/>',
  inbox: '<path d="M5 4h14l3 9v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6zM2 13h6l2 3h4l2-3h6"/>',
  workshop: '<path d="M5 13V8a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v5M6 19v2m12-2v2M4 19h16a1 1 0 0 0 1-1v-5a2 2 0 0 0-4 0v2H7v-2a2 2 0 0 0-4 0v5a1 1 0 0 0 1 1Z"/>',
  settings: '<path d="M3 6h6m4 0h8M3 12h12m4 0h2M3 18h2m4 0h12M9 4v4m6 2v4M5 16v4"/>',
};
const statuses = {
  queued: ['В очереди', ''], running: ['В работе', 'good'], waiting: ['Ждёт ответа', 'warn'],
  completed: ['Готово', 'good'], failed: ['Ошибка', 'attention'],
  interrupted: ['Прервана', 'attention'], cancelled: ['Отменена', ''],
};
const studioStatuses = {
  draft: ['Черновик', ''], planning: ['Подготовка плана', 'good'],
  'awaiting-approval': ['Ждёт согласования', 'warn'], active: ['В работе', 'good'],
  paused: ['На паузе', 'warn'], idle: ['Нет активной работы', ''], error: ['Требуется внимание', 'attention'],
};
const effortPresets = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const providerState = {};
const inspecting = new Set();
let state = { studios: [], tasks: [], inbox: [] };
let studioId = stored('studio');
let view = 'overview';
let inboxScope = 'open';
let selectedAgent = '';
let ready = false;
let snapshotVersion = 0;
let submission;
let dialogBusy = false;
let opener;
let taskDialog;
let notificationTarget;
let openingNotification = false;
let workBusy = false;
let workTab;
let advancedOpen = false;

function stored(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(`hearth:${key}`);
    localStorage.setItem(`hearth:${key}`, value);
  } catch { /* The app can run without saved UI preferences. */ }
}

const studio = () => state.studios.find(item => String(item.id) === studioId);
const tasks = () => state.tasks.filter(item => String(item.studioId) === studioId);
const entries = () => state.inbox.filter(item => String(item.studioId) === studioId);
const plans = () => (state.plans ?? []).filter(item => String(item.studioId) === studioId);
const planById = raw => plans().find(plan => same(plan.id, raw));
const same = (id, raw) => String(id) === raw;
const escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const safe = value => String(value ?? '').replace(/[&<>"']/g, character => escapeMap[character]);
const glyph = key => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[key]}</svg>`;
const button = (label, attributes, secondary = false) => `<button class="action${secondary ? ' secondary' : ''}" type="button" ${attributes}>${safe(label)}</button>`;
const actionFor = (label, target, id, secondary = true) => button(label, `data-${target}="${safe(id)}"`, secondary);
const heading = (title, detail = '', actions = '') => `<header class="page-heading"><div><h1>${safe(title)}</h1>${detail ? `<p class="muted">${safe(detail)}</p>` : ''}</div>${actions && `<div class="actions">${actions}</div>`}</header>`;
const empty = (title, detail, action = '') => `<div class="panel empty"><h2>${safe(title)}</h2><p class="muted">${safe(detail)}</p>${action}</div>`;
const badge = (label, tone = '') => `<span class="status ${tone}"><span aria-hidden="true"></span>${safe(label)}</span>`;
const status = task => badge(...(statuses[task.status] ?? [task.status, '']));
const nameFor = agent => agent ? (agent.name || roleNames[agent.role] || agent.role) : 'Директор';
const taskAgent = task => studio()?.agents?.find(agent => agent.id === task.agentId);
const runtimeName = runtime => runtimeNames[runtime] ?? runtime;
const configText = value => [runtimeName(value?.runtime), value?.model, value?.effort].filter(Boolean).join(' · ');
const option = (value, label = value, selected) => `<option value="${safe(value)}"${value === selected ? ' selected' : ''}>${safe(label)}</option>`;
const select = (label, name, options) => `<label class="field"><span>${safe(label)}</span><select name="${name}">${options}</select></label>`;
const input = (label, name, value = '', attrs = '') => `<label class="field"><span>${safe(label)}</span><input name="${name}" value="${safe(value)}" ${attrs}></label>`;
const textarea = (label, name, value = '', attrs = '') => `<label class="field"><span>${safe(label)}</span><textarea name="${name}" rows="4" ${attrs}>${safe(value)}</textarea></label>`;
const plain = (value, cls = 'long-text') => `<div class="${cls}">${safe(value)}</div>`;

function notice(message = '', error = false) {
  const node = $('#notice');
  node.hidden = !message;
  node.textContent = message;
  node.classList.toggle('is-error', error);
}

function selectStudio(id) {
  studioId = id == null ? '' : String(id);
  selectedAgent = '';
  inboxScope = 'open';
  workTab = undefined;
  advancedOpen = false;
  stored('studio', studioId);
}

async function refresh() {
  const version = ++snapshotVersion;
  try {
    const snapshot = await bridge.request('snapshot');
    if (version !== snapshotVersion) return;
    state = snapshot;
    if (!studio()) selectStudio(snapshot.studios[0]?.id);
    ready = true;
    render();
    if (dialog.open && !dialogBusy && taskDialog) {
      const latest = snapshot.tasks.find(task => task.id === taskDialog.id);
      if (latest && JSON.stringify(latest) !== JSON.stringify(taskDialog)) openTask(latest);
    }
  } catch (error) {
    if (version === snapshotVersion) {
      notice(error.message || 'Не удалось загрузить студии.', true);
      if (!ready) content.innerHTML = empty('Студии недоступны', 'Проверьте подключение к локальному хранилищу.', button('Повторить загрузку', 'data-reload'));
    }
  }
}

function render() {
  const current = studio();
  const picker = $('#studio-select');
  const focused = document.activeElement;
  const focusRoot = [content, $('#navigation')].find(container => container.contains(focused) && focused !== container);
  const focusTarget = focusRoot && Object.entries(focused.dataset).find(([key]) => ['view', 'agent', 'task', 'inbox', 'scope', 'open', 'inspect', 'editAgent', 'allow', 'plan', 'initialize', 'runAction', 'artifact', 'workTab'].includes(key));
  const autonomyFocused = focused?.getAttribute('name') === 'approveSprints';
  picker.disabled = !state.studios.length;
  picker.innerHTML = state.studios.map(item => option(String(item.id), item.name, studioId)).join('') || '<option>Нет студий</option>';
  const openCount = entries().filter(item => item.status === 'open').length;
  $('#navigation').innerHTML = Object.entries(views).map(([key, label]) => `<button type="button" data-view="${key}"${view === key ? ' aria-current="page"' : ''}>${glyph(key)}<span>${label}</span>${key === 'inbox' && openCount ? `<span class="nav-count">${openCount}</span>` : ''}</button>`).join('');
  $('#breadcrumb').innerHTML = `<span>${safe(current?.name || 'Hearth Studio')}</span><span aria-hidden="true">›</span><strong>${views[view]}</strong>`;
  content.innerHTML = current || view === 'settings'
    ? ({ overview, work, inbox, workshop, settings })[view]()
    : heading(views[view]) + empty('Создайте студию', 'Опишите проект, выберите рабочую папку и подключение директора.', button('Создать студию', 'data-open="studio"'));
  if (view === 'workshop' && current) paintRooms(content);
  if (focusTarget) {
    const [key, value] = focusTarget;
    Array.from(focusRoot.querySelectorAll('button')).find(node => node.dataset[key] === value)?.focus();
  }
  if (autonomyFocused) content.querySelector('[name="approveSprints"]')?.focus();
}

function work() {
  const rows = key => (state[key] ?? []).filter(item => String(item.studioId) === studioId);
  return heading('Работа', studio().name, button('Новая задача', 'data-open="task"')) + renderWork({
    studio: studio(), tasks: tasks(), epics: rows('epics'), stories: rows('stories'),
    sprints: rows('sprints'), meetings: rows('meetings'), plans: plans(), tab: workTab,
  });
}

function route(next) {
  view = next;
  notice();
  content.focus();
  render();
}

function overview() {
  const current = studio();
  const all = tasks().toSorted((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const open = entries().filter(item => item.status === 'open');
  const decision = open.find(item => item.kind === 'question') ?? open.find(item => item.kind !== 'plan');
  const last = all.find(task => task.status === 'completed' && (!task.stage || task.stage === 'done'));
  const rooms = buildRooms(current);
  const workCount = all.filter(task => ['running', 'queued'].includes(task.status)).length;
  const pendingPlan = pendingStudioPlan(plans(), current.id);
  const activePlan = plans().findLast(plan => plan.status === 'approved');
  const initial = plans().some(plan => plan.kind === 'initial' && plan.status === 'approved');
  const canInitialize = current.lifecycle === 'draft';
  const running = ['active', 'planning'].includes(current.lifecycle) || (current.lifecycle === 'idle' && initial);
  const runButtons = ['error', 'paused'].includes(current.lifecycle)
    ? actionFor(current.lifecycle === 'error' ? 'Повторить шаг' : 'Возобновить', 'run-action', 'resume', false) + actionFor('Остановить', 'run-action', 'stop')
    : running ? actionFor('Пауза', 'run-action', 'pause') + actionFor('Остановить', 'run-action', 'stop') : '';
  const intro = canInitialize ? '<p class="muted">Директор предложит команду, первый спринт и критерии результата.</p>' : '';
  const activity = current.activity || (current.lifecycle === 'planning' ? 'Директор готовит предложение по проекту.' : '');
  return heading('Обзор студии', current.name, (canInitialize ? '' : button('Новая задача', 'data-open="task"')) + runButtons) +
    `<div class="split"><div class="stack">
      ${current.lifecycle || activity || pendingPlan ? `<section class="panel padded stack compact">
        <div class="row"><h2>${canInitialize ? 'Начало работы' : 'Студия'}</h2>${studioStatuses[current.lifecycle] ? badge(...studioStatuses[current.lifecycle]) : ''}</div>
        ${intro}${activity ? `<p class="activity" role="status">${safe(activity)}</p>` : ''}
        <div class="actions">${canInitialize ? button('Инициализировать студию', 'data-initialize' + (workBusy ? ' disabled' : '')) : ''}
          ${pendingPlan ? actionFor('Посмотреть план', 'plan', pendingPlan.id, false) : activePlan ? actionFor('Открыть план', 'plan', activePlan.id) : ''}</div>
      </section>` : ''}
      ${decision ? `<article class="panel padded decision">
        <div class="row">${badge(decision.kind === 'acceptance' ? 'На приёмке' : decision.kind === 'question' ? 'Нужно решение' : 'Требуется внимание', 'attention')}<small>${open.length} открыто</small></div>
        <h2>${safe(decision.title)}</h2><p class="clamp">${safe(decision.body)}</p>
        <div>${actionFor('Открыть во входящих', 'inbox', decision.id, false)}</div>
      </article>` : ''}
      <section class="stack compact"><h2>Последний отчёт</h2>
        ${last ? `<article class="panel report">
          <div class="excerpt">${safe(last.summary || 'Результат сохранён в задаче.')}</div>
          <div class="padded stack compact"><div class="row"><h3>${safe(last.title)}</h3>${status(last)}</div>
          <div class="actions">${actionFor('Читать отчёт', 'task', last.id)}${last.artifactPath ? actionFor('Открыть файл', 'artifact', last.id, false) : ''}</div></div></article>`
          : empty('Отчётов пока нет', 'Здесь появится результат первой завершённой задачи.')}</section>
    </div><aside class="stack">
      <section class="panel padded stack compact"><div class="row"><h2>Мастерская</h2>${glyph('workshop')}</div>
        <p class="muted">Комнат: ${rooms.length} · В работе и очереди: ${workCount}</p>
        <div>${button('Открыть карту', 'data-view="workshop"', true)}</div></section>
      <section class="stack compact"><h2>Задачи</h2>
        ${all.length ? `<div class="panel work-list">${all.map(taskRow).join('')}</div>` :
          empty('Задач пока нет', canInitialize ? 'Первые задачи появятся после согласования плана.' : 'Поставьте задачу директору или участнику студии.')}</section>
    </aside></div>`;
}

function taskRow(task) {
  return `<button type="button" class="list-row" data-task="${safe(task.id)}"><span><strong>${safe(task.title)}</strong><small>${safe(nameFor(taskAgent(task)))}</small></span>${status(task)}</button>`;
}

function inbox() {
  const all = entries();
  const open = all.filter(item => item.status === 'open');
  const resolved = all.filter(item => item.status === 'resolved');
  const shown = inboxScope === 'open' ? open : resolved;
  const scope = (value, label, count) => `<button type="button" data-scope="${value}" aria-pressed="${inboxScope === value}">${label} <span>${count}</span></button>`;
  return heading('Входящие', studio().name) +
    `<div class="segmented" role="group" aria-label="Состояние входящих">${scope('open', 'Открытые', open.length)}${scope('resolved', 'Решённые', resolved.length)}</div>
      ${shown.length ? `<div class="stack">${shown.map(inboxCard).join('')}</div>`
        : empty(inboxScope === 'open' ? 'Нет открытых входящих' : 'Нет решённых входящих', inboxScope === 'open'
          ? 'Здесь появятся вопросы агентов и ошибки запуска.' : 'Здесь сохраняются данные по принятым решениям.')}`;
}

function inboxCard(item) {
  if (item.kind === 'plan') {
    const plan = planById(String(item.planId));
    return `<article class="panel padded stack compact">
      <div>${badge(item.status === 'open' ? 'Нужно согласовать' : 'Решение сохранено', item.status === 'open' ? 'warn' : 'good')}</div>
      <h2>${safe(item.title)}</h2><p>${safe(item.body)}</p>
      <div>${plan ? actionFor('Посмотреть план', 'plan', plan.id, false) : ''}</div>
    </article>`;
  }
  const task = tasks().find(entry => entry.id === item.taskId);
  const isQuestion = item.kind === 'question';
  const isAcceptance = item.kind === 'acceptance';
  return `<article class="panel padded stack compact">
    <div class="row">${badge(isQuestion ? 'Вопрос' : isAcceptance ? 'Приёмка результата' : 'Ошибка', isQuestion || isAcceptance ? 'warn' : 'attention')}
      <small class="muted">${safe(task?.title)}</small></div>
    <h2>${safe(item.title)}</h2><div class="long-text">${safe(item.body)}</div>
    ${item.answer ? `<div class="inline-result"><strong>Ответ</strong>${plain(item.answer)}</div>` : ''}
    <div class="actions">
      ${item.status === 'open' && isQuestion ? actionFor('Ответить', 'inbox', item.id, false) : ''}
      ${task ? actionFor('Открыть задачу', 'task', task.id) : ''}
      ${item.status === 'open' && isAcceptance ? actionFor('Открыть приёмку', 'inbox', item.id, false) : ''}
      ${item.status === 'open' && !isQuestion && !isAcceptance ? actionFor('Просмотреть ошибку', 'inbox', item.id) : ''}
    </div>
  </article>`;
}

function workshop() {
  const current = studio();
  const rooms = buildRooms(current);
  const roster = rooms.flatMap(room => room.desks.map(({ agent }) => ({ room, agent })));
  const selection = roster.find(({ agent }) => (agent.id == null ? '' : String(agent.id)) === selectedAgent) ?? roster[0];
  const { agent, room } = selection;
  const direction = state.attempts?.find(attempt => attempt.studioId === current.id && attempt.purpose === 'director' && attempt.status === 'running');
  const currentTasks = tasks();
  const directionTask = direction && currentTasks.find(task => task.id === direction.taskId);
  const jobFor = person => {
    if (person.id == null && directionTask) return { ...directionTask, stage: 'director', status: 'running' };
    return taskForAgent(currentTasks, current.id, person.id);
  };
  const job = jobFor(agent);
  const activityFor = person => agentActivity(jobFor(person), person.id == null ? current.lifecycle : undefined);
  const renderAgent = (person, pin = false, props = '') => {
    const key = person.id == null ? '' : String(person.id);
    const chosen = person === agent;
    const currentJob = jobFor(person);
    const [activity, tone] = activityFor(person);
    const openJob = pin && currentJob && ['running', 'waiting', 'queued'].includes(currentJob.status) && currentJob.stage !== 'backlog';
    return `<button type="button" class="${pin ? 'map-pin' : 'list-row role-row'}" data-agent="${safe(key)}" data-activity="${tone}" aria-pressed="${chosen}"${openJob ? ` data-desk-task="${safe(currentJob.id)}" aria-haspopup="dialog"` : ''}>
      <canvas width="40" height="40" data-desk="${props || 'notebook'}" aria-hidden="true"></canvas>
      <span><strong>${safe(nameFor(person))}</strong><small>${pin ? safe(activity) : safe([roleNames[person.role] || person.role, activity].join(' · '))}</small></span>
    </button>`;
  };
  return heading('Мастерская', `Комнат: ${rooms.length} · Участников: ${roster.length}`, button('Настроить состав', 'data-view="settings"', true)) +
    `<div class="work-map" role="group" aria-label="Карта мастерской">
      ${rooms.map(zone => `<section class="work-room"><div class="room-header"><h2>${zone.name}</h2><span aria-label="Участников в комнате: ${zone.desks.length}">${zone.desks.length}</span></div>
        <div class="room-floor"><canvas class="room-art" width="200" height="126" data-room="${zone.id}" aria-hidden="true"></canvas>
          <div class="room-occupants">${zone.desks.map(({ agent: person, props }) => renderAgent(person, true, props)).join('')}</div>
        </div></section>`).join('')}
    </div><div class="split workshop-detail"><article class="panel padded stack compact">
      <div class="row"><h2>${safe(nameFor(agent))}</h2>${badge(...activityFor(agent))}</div>
      <p class="muted">${room.name}</p>
      ${agent.description ? `<p>${safe(agent.description)}</p>` : ''}
      ${job ? `<div class="inline-result"><strong>${safe(job.title)}</strong>${job.summary ? plain(job.summary, 'muted clamp') : ''}</div>`
        : '<p>У агента пока нет задачи.</p>'}
      <div class="actions">${job ? actionFor('Открыть задачу', 'task', job.id, false) : ''}${actionFor('Поставить задачу', 'new-task', agent.id ?? '', !!job)}</div>
    </article><section class="stack compact"><h2>Роли</h2><div class="panel work-list">${rooms.flatMap(zone => zone.desks.map(({ agent: person, props }) => renderAgent(person, false, props))).join('')}</div></section></div>`;
}

function providerBadge(id) {
  const info = providerState[id];
  if (inspecting.has(id)) return badge('Проверяем…');
  if (!info) return badge('Не проверен');
  if (!info.available) return badge('Недоступен', 'warn');
  if (info.authenticated === false) return badge('CLI найден · Требуется вход', 'warn');
  return badge(info.authenticated ? 'Вход подтверждён' : 'CLI найден', 'good');
}

function settings() {
  const current = studio();
  const providers = Object.entries(runtimeNames).map(([id, label]) => {
    const info = providerState[id];
    const checking = inspecting.has(id);
    const detail = info ? [info.version, info.detail].filter(Boolean).join(' · ') : '';
    return `<article class="panel padded stack compact"><div class="row"><h3>${label}</h3>
      ${providerBadge(id)}</div>
      ${id === 'claude' ? '<p class="muted">Текстовые задачи. Доступ к файлам проекта отключён.</p>' : ''}
      ${detail ? `<p class="muted">${safe(detail)}</p>` : ''}
      ${info?.models?.length ? `<p class="muted">Моделей в каталоге: ${info.models.length}</p>` : ''}
      <div>${button(checking ? 'Проверяем…' : 'Проверить подключение', `data-inspect="${id}"${checking ? ' disabled' : ''}`, true)}</div>
    </article>`;
  }).join('');
  return heading('Настройки', current?.name || 'Подключения приложения') +
    `<div class="stack settings"><section class="stack compact"><h2>Подключения</h2><div class="columns">${providers}</div></section>
      ${current ? `<section class="stack compact"><h2>Студия</h2><div class="panel padded stack compact">
        <div class="row"><h3>${safe(current.name)}</h3>${button('Изменить', 'data-open="edit-studio"', true)}</div>
        ${current.brief ? plain(current.brief) : ''}<dl class="studio-meta"><dt>Рабочая папка</dt><dd>${safe(current.root || 'Не выбрана')}</dd><dt>Язык отчётов</dt><dd>${safe(current.language || 'Не выбран')}</dd>
          ${current.projectLanguage ? `<dt>Язык материалов</dt><dd>${safe(current.projectLanguage)}</dd>` : ''}</dl>
      </div></section>
      <section class="stack compact" id="autonomy" tabindex="-1"><h2>Автономность</h2><div class="panel padded stack compact">
        <label class="checkbox-field"><input type="checkbox" name="approveSprints"${current.approveSprints !== false ? ' checked' : ''}${workBusy ? ' disabled' : ''}> <span>Согласовывать план спринта</span></label>
        <p class="muted">При инициализации Hearth всегда запрашивает согласование. Настройка применяется к будущим спринтам.</p>
      </div></section>
      <details class="panel padded advanced" id="advanced"${advancedOpen ? ' open' : ''}><summary>Расширенные настройки</summary><div class="stack">
      <section class="stack compact"><h2>Модели</h2><div class="inline-result stack compact">
        <div class="row"><div><h3>Директор</h3><p class="muted">${safe(configText(current.director) || 'Модель и усилие по умолчанию')}</p></div>${button('Настроить директора', 'data-open="director"', true)}</div>
        <div class="inline-result stack compact"><div class="row"><h3>Разрешённые модели</h3>${button('Добавить модель', 'data-open="allow-model"', true)}</div>
          ${current.allowed?.length ? current.allowed.map((entry, index) => `<div class="row allowed-row"><span>${safe([runtimeName(entry.runtime), entry.model, entry.efforts?.join(', ')].filter(Boolean).join(' · '))}</span>
            <div class="actions">${actionFor('Изменить', 'allow', index)}${actionFor('Убрать', 'remove-allow', index)}</div></div>`).join('')
            : '<p class="muted">Список пуст. Добавьте модели для ролей с автоматическим выбором.</p>'}
        </div>
      </div></section>
      <section class="stack compact"><div class="row"><h2>Роли</h2>${button('Добавить агента', 'data-open="agent"')}</div>
        <div class="panel work-list">${current.agents?.length ? current.agents.map(agent => `<div class="list-row static-row"><span><strong>${safe(nameFor(agent))}</strong>
          <small>${safe([roleNames[agent.role] || agent.role, modeNames[agent.mode], agent.mode === 'fixed' ? configText(agent) : ''].filter(Boolean).join(' · '))}</small>
          ${agent.description ? `<small>${safe(agent.description)}</small>` : ''}</span>
          ${actionFor('Настроить', 'edit-agent', agent.id)}</div>`).join('')
          : '<p class="padded muted">Роли появятся после согласования плана. Здесь можно добавить агента вручную.</p>'}</div></section></div></details>` : ''}
      <section class="stack compact"><h2>Импорт и экспорт</h2><div class="panel padded stack compact">
        <div class="actions">${button('Импортировать файл Hearth', 'data-open="import-bundle"', true)}${button('Проверить старую студию', 'data-open="import"', true)}</div>
        ${current ? `<div class="actions">${actionFor('Экспортировать шаблон', 'export-mode', 'template')}${actionFor('Экспортировать снимок', 'export-mode', 'snapshot')}</div>` : ''}
      </div></section></div>`;
}

function dialogTo(title, body, submitLabel, submit) {
  opener = dialog.open ? opener : document.activeElement;
  taskDialog = undefined;
  submission = submit;
  $('#dialog-title').textContent = title;
  $('#dialog-body').innerHTML = body;
  $('#dialog-actions').innerHTML = button(submit ? 'Отмена' : 'Закрыть', 'data-close', true) +
    (submit ? `<button type="submit" class="action">${safe(submitLabel)}</button>` : '');
  dialogError();
  if (!dialog.open) dialog.showModal();
  const initialFocus = dialogBodyFocus();
  (initialFocus ?? dialog.querySelector('[data-close]'))?.focus();
}

function dialogBodyFocus() {
  return Array.from($('#dialog-body').querySelectorAll('input:not([readonly]), textarea, select, button'))
    .find(element => !element.closest('[hidden]'));
}

function dialogError(message = '') {
  const node = $('#dialog-error');
  node.hidden = !message;
  node.textContent = message;
}

function setDialogBusy(value) {
  dialogBusy = value;
  form.toggleAttribute('aria-busy', value);
  form.querySelectorAll('button').forEach(element => { element.disabled = value; });
}

function pathField(root = '', { label = 'Рабочая папка', name = 'root' } = {}) {
  return `<div class="folder-field">${input(label, name, root, 'readonly')}
    ${button('Выбрать папку', `data-folder="${name}"`, true)}</div>`;
}

function languageField(label, name, value, inherit = false) {
  const choices = languageChoices(value).map(language => option(language, language, value));
  if (inherit) choices.unshift(option('', 'Как в отчётах', value));
  return select(label, name, choices.join(''));
}

function studioEditor(current) {
  if (!current) {
    newStudio();
    return;
  }
  dialogTo('Параметры студии',
    input('Название', 'name', current.name, 'required maxlength="120"') +
    pathField(current.root) + textarea('Что должно получиться?', 'brief', current.brief) +
    languageField('Язык отчётов', 'language', current.language || 'Русский') +
    languageField('Язык материалов проекта', 'projectLanguage', current.projectLanguage || '', true),
    'Сохранить студию', async values => {
      if (!values.root) throw new Error('Выберите рабочую папку.');
      await bridge.request('updateStudio', { studioId: current.id, ...values });
    });
}

const wizardNames = ['Что создаём', 'Папка и язык', 'Подключение директора'];
const templates = {
  book: ['Книга', 'Например, план первой главы с тремя ключевыми сценами'],
  game: ['Игра', 'Например, описание первого игрового цикла и условий победы'],
  art: ['Арт', 'Например, три визуальных направления с пояснениями'],
  other: ['Другой проект', 'Например, краткое описание первого результата и способа его проверить'],
};

function newStudio() {
  const step = (number, fields) => `<section class="form-body" data-wizard-step="${number}"${number ? ' hidden' : ''}>
    <h3>${wizardNames[number]}</h3>${fields}</section>`;
  const templateChoices = Object.entries(templates).map(([id, [title]]) => option(id, title, 'other')).join('');
  dialogTo('Новая студия',
    '<ol class="wizard-progress" aria-label="Шаги настройки">' +
    wizardNames.map((name, index) => `<li${index === 0 ? ' aria-current="step"' : ''}>${name}</li>`).join('') + '</ol>' +
    step(0, input('Название студии', 'name', '', 'required maxlength="120"') +
      select('Тип проекта', 'template', templateChoices) +
      textarea('Что должно получиться?', 'brief', '', 'required placeholder="Например, короткая игра об исследовании острова"') +
      input('Для кого?', 'audience', '', 'placeholder="Например, для любителей неспешных игр"') +
      input('Какой первый результат хотите увидеть?', 'firstResult', '', `placeholder="${safe(templates.other[1])}"`)) +
    step(1, pathField() + '<p class="muted">Выберите существующую папку или создайте новую в окне выбора.</p>' +
      languageField('Язык отчётов', 'language', 'Русский') +
      languageField('Язык материалов проекта', 'projectLanguage', '', true)) +
    step(2, select('Подключение директора', 'runtime',
      Object.entries(runtimeNames).map(([id, label]) => option(id, label, 'codex')).join('')) +
      '<div id="wizard-provider" class="stack compact" role="status"></div>' +
      '<p class="muted">Для запуска нужно рабочее подключение. Черновик можно сохранить в любом случае.</p>'),
    'Создать студию', async ({ template, brief, audience, firstResult, runtime, ...values }) => {
      if (!values.root) throw new Error('Выберите рабочую папку.');
      const completeBrief = [brief, audience && `Аудитория — ${audience}`, firstResult && `Первый результат — ${firstResult}`].filter(Boolean).join('\n\n');
      const created = await bridge.request('createStudio', { ...values, brief: completeBrief, director: { runtime } });
      selectStudio(created.id);
      view = 'overview';
    });
  $('#dialog-actions').insertAdjacentHTML('afterbegin', button('Назад', 'data-wizard-back hidden', true));
  $('#dialog-actions').insertAdjacentHTML('beforeend', button('Далее', 'data-wizard-next'));
  showWizardStep(0);
}

function updateWizardProvider() {
  const node = $('#wizard-provider');
  if (!node) return;
  const runtime = form.elements.runtime.value;
  const info = providerState[runtime];
  node.innerHTML = `<div class="row">${providerBadge(runtime)}
    ${button('Проверить подключение', `data-inspect="${safe(runtime)}"${inspecting.has(runtime) ? ' disabled' : ''}`, true)}</div>
    ${info?.detail ? `<p class="muted">${safe(info.detail)}</p>` : ''}`;
}

function showWizardStep(index) {
  const steps = Array.from(form.querySelectorAll('[data-wizard-step]'));
  if (!steps[index]) return;
  steps.forEach((step, item) => { step.hidden = index !== item; });
  form.querySelectorAll('.wizard-progress li').forEach((step, item) => {
    if (item === index) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  });
  form.querySelector('[data-wizard-back]').hidden = index === 0;
  form.querySelector('[data-wizard-next]').hidden = index === steps.length - 1;
  form.querySelector('button[type="submit"]').hidden = index !== steps.length - 1;
  dialogError();
  (dialogBodyFocus() ?? form.querySelector('[data-wizard-next]'))?.focus();
  if (index === 2) {
    updateWizardProvider();
    const runtime = form.elements.runtime.value;
    if (!providerState[runtime]) void inspect(runtime);
  }
}

function moveWizard(direction) {
  const step = form.querySelector('[data-wizard-step]:not([hidden])');
  if (!step) return;
  const index = Number(step.dataset.wizardStep);
  if (direction > 0 && index === 0) {
    const missing = Array.from(step.querySelectorAll('[required]')).find(input => !input.value.trim());
    if (missing) {
      dialogError('Заполните обязательное поле.');
      missing.focus();
      return;
    }
  }
  if (direction > 0 && index === 1 && !form.elements.root.value) {
    dialogError('Выберите рабочую папку.');
    form.querySelector('[data-folder]').focus();
    return;
  }
  showWizardStep(index + direction);
}

function taskEditor(agentId = '') {
  const current = studio();
  const agents = current.agents ?? [];
  const choices = [option('', 'Директор', agentId), ...agents.map(agent => option(String(agent.id), nameFor(agent), agentId))].join('');
  dialogTo('Новая задача', input('Название', 'title', '', 'required maxlength="160"') +
    textarea('Что нужно сделать', 'prompt', '', 'required') + select('Исполнитель', 'agentId', choices),
    'Создать и запустить', async ({ agentId: raw, ...values }) => {
      const agent = agents.find(item => same(item.id, raw));
      const task = await bridge.request('createTask', { studioId: current.id, ...values, ...(agent ? { agentId: agent.id } : {}) });
      try {
        await bridge.request('startTask', { taskId: task.id });
      } catch (error) {
        await refresh();
        openTask(tasks().find(entry => entry.id === task.id) ?? task);
        dialogError(error.message || 'Задача сохранена. Повторите запуск.');
        return false;
      }
    });
}

function openTask(task) {
  const latest = tasks().find(entry => entry.id === task.id) ?? task;
  const entry = entries().find(item => item.taskId === latest.id && item.status === 'open' && ['question', 'acceptance'].includes(item.kind));
  const canCancel = !latest.workflowManaged && !latest.legacyWorktreeReview && ['running', 'waiting', 'queued'].includes(latest.status);
  const canRun = !latest.workflowManaged && ['failed', 'interrupted', 'queued'].includes(latest.status);
  const needsWorktreeReview = latest.legacyWorktreeReview === true;
  const artifact = typeof latest.artifact === 'object' && latest.artifact
    ? JSON.stringify(latest.artifact, null, 2) : latest.artifact;
  const block = (label, value) => value ? `<section class="inline-result"><h3>${label}</h3>${plain(value)}</section>` : '';
  const isOpen = taskDialog?.id === latest.id;
  const attempts = (state.attempts ?? []).filter(attempt => attempt.taskId === latest.id).slice(-10).reverse();
  const purposes = { task: 'Исполнение', review: 'Ревью', director: 'Решение директора', publish: 'Запись файла' };
  const previousFocus = dialog.contains(document.activeElement) ? Object.entries(document.activeElement.dataset)[0]?.[0] : '';
  dialogTo(latest.title, `<div class="row">${needsWorktreeReview ? badge('Ждёт сверки рабочего дерева', 'warn') : status(latest)}<span class="muted">${safe(nameFor(taskAgent(latest)))}</span></div>` +
    block('Постановка задачи', latest.prompt) + block('Критерии', listText(latest.criteria)) + block('Ошибка', latest.error) +
    (latest.summary && latest.summary !== artifact ? block('Краткий отчёт', latest.summary) : '') +
    block('Ревью', latest.review) + block('Решение директора', latest.directorDecision) +
    block('Результат', artifact) +
    (attempts.length ? `<details class="advanced"><summary>Попытки запуска</summary><ul class="plan-list">${attempts.map(attempt => `<li>
      <div class="row"><strong>${safe(purposes[attempt.purpose] || 'Запуск')}</strong>${status(attempt)}</div>
      ${attempt.startedAt ? `<small class="muted">${safe(new Date(attempt.startedAt).toLocaleString('ru-RU'))}</small>` : ''}
      ${attempt.error ? plain(attempt.error) : ''}</li>`).join('')}</ul></details>` : '') +
    `<div class="actions">
      ${latest.artifactPath ? actionFor('Открыть файл', 'artifact', latest.id, false) : ''}
      ${entry ? actionFor(entry.kind === 'acceptance' ? 'Открыть приёмку' : 'Ответить на вопрос', 'inbox', entry.id, false) : ''}
      ${canRun ? needsWorktreeReview ? actionFor('Сверить рабочее дерево', 'review-worktree', latest.id, false)
        : actionFor(latest.status === 'queued' ? 'Запустить' : 'Запустить снова', 'start-task', latest.id, false) : ''}
      ${canCancel ? actionFor('Отменить задачу', 'cancel-task', latest.id) : ''}
    </div>`);
  taskDialog = latest;
  if (isOpen && previousFocus) Array.from(dialog.querySelectorAll('button')).find(node => Object.hasOwn(node.dataset, previousFocus))?.focus();
}

function confirmWorktreeReview(task) {
  dialogTo('Сверка рабочего дерева',
    '<p>Перед запуском проверьте рабочую папку новой студии, ветку и локальные изменения.</p>' +
    `<dl class="studio-meta"><dt>Рабочая папка</dt><dd>${safe(studio().root)}</dd>
    ${task.legacyBranch ? `<dt>Ветка в старой студии</dt><dd>${safe(task.legacyBranch)}</dd>` : ''}</dl>`,
    'Подтвердить сверку и запустить', async () => {
      await bridge.request('startTask', { taskId: task.id, confirmLegacy: true });
      await refresh();
      openTask(task);
      return false;
    });
}

function openInbox(item) {
  if (item.kind === 'plan') {
    const plan = planById(String(item.planId));
    if (plan) openPlan(plan);
    return;
  }
  const question = item.kind === 'question';
  const open = item.status === 'open';
  const body = `<div>${badge(question ? 'Вопрос' : 'Ошибка', question ? 'warn' : 'attention')}</div>` + plain(item.body) +
    (item.answer ? `<section class="inline-result"><h3>Ответ</h3>${plain(item.answer)}</section>` : '');
  inboxScope = open ? 'open' : 'resolved';
  if (view !== 'inbox') route('inbox');
  if (item.kind === 'acceptance') {
    openAcceptance(item);
    return;
  }
  dialogTo(item.title, body + (open && question
    ? textarea('Ваш ответ', 'answer', '', 'required')
    : item.taskId ? actionFor('Открыть задачу', 'task', item.taskId) : ''),
    question ? 'Отправить ответ' : 'Отметить просмотренной', open ? ({ answer }) => bridge.request('answerInbox', {
      inboxId: item.id, answer: question ? answer : '',
    }) : undefined);
}

function openAcceptance(item, revise = false) {
  const task = tasks().find(entry => entry.id === item.taskId);
  const pending = item.status === 'open';
  const send = (decision, answer) => bridge.request('answerInbox', { inboxId: item.id, decision, answer });
  dialogTo(item.title, `<div>${badge(pending ? 'Приёмка результата' : 'Решение сохранено', pending ? 'warn' : 'good')}</div>` +
    plain(item.body) + (task?.artifactPath ? actionFor('Открыть файл', 'artifact', task.id) : '') +
    (item.answer ? `<section class="inline-result"><h3>Решение</h3>${plain(item.answer)}</section>` : '') +
    (pending ? revise ? textarea('Что нужно исправить?', 'answer', '', 'required')
      : actionFor('Вернуть на доработку', 'revise-result', item.id) : ''),
    revise ? 'Отправить на доработку' : 'Принять результат',
    pending ? ({ answer }) => send(revise ? 'revise' : 'approve', answer) : undefined);
}

const listText = value => Array.isArray(value) ? value.join('\n') : value;
const publishedPaths = plan => (plan.publishedFiles ?? []).map(file => typeof file === 'string' ? file : file?.path).filter(Boolean);

function autonomyHint() {
  return '<p class="muted">Сверку плана можно отключить в <button type="button" class="text-button" data-autonomy>Настройки → Автономность</button>. Настройка действует для будущих спринтов.</p>';
}

function planBody(plan) {
  const agents = plan.agents ?? [];
  const published = new Set(publishedPaths(plan));
  const agentByKey = key => agents.find(agent => (agent.key ?? agent.id) === key);
  const titles = new Map((plan.tasks ?? []).map(task => [task.key ?? task.id, task.title]));
  const entity = (label, value) => value ? `<section class="inline-result"><h3>${label}</h3><p>${safe(value.title ?? value)}</p>
    ${value.description ? plain(value.description) : ''}${value.acceptance ? plain(listText(value.acceptance)) : ''}</section>` : '';
  return `<div>${badge(...({
    draft: ['Готовится', ''], pending: ['Ждёт согласования', 'warn'],
    approved: ['Подтверждён', 'good'], returned: ['Возвращён', 'warn'],
  }[plan.status] ?? [plan.status, '']))}</div>
    ${plan.goal ? `<p>${safe(plan.goal)}</p>` : ''}
    ${entity('Эпик', plan.epic)}${entity('Первая история', plan.story)}
    ${agents.length ? `<section class="stack compact"><h3>Команда</h3><ul class="plan-list">${agents.map(agent =>
      `<li><strong>${safe(nameFor(agent))}</strong>${agent.name ? `<span class="muted"> · ${safe(roleNames[agent.role] ?? agent.role)}</span>` : ''}
        <div>${safe(agent.description || roleDetails[agent.role] || '')}</div></li>`).join('')}</ul></section>` : ''}
    ${plan.tasks?.length ? `<section class="stack compact"><h3>Задачи</h3><ol class="plan-list">${plan.tasks.map(task => `<li>
      <strong>${safe(task.title)}</strong>
      ${task.agentKey ? `<p class="muted">Исполнитель — ${safe(nameFor(agentByKey(task.agentKey)))}</p>` : ''}
      ${task.reviewerKey ? `<p class="muted">Проверяет — ${safe(nameFor(agentByKey(task.reviewerKey)))}</p>` : ''}
      ${task.criteria ? `<div>${plain(listText(task.criteria))}</div>` : ''}
      ${task.dependsOn?.length ? `<small>После задач ${safe(task.dependsOn.map(key => titles.get(key) ?? key).join(', '))}</small>` : ''}
    </li>`).join('')}</ol></section>` : ''}
    ${plan.files?.length ? `<section class="stack compact"><h3>Файлы плана</h3><ul class="plan-list">${plan.files.map(file =>
      `<li>${published.has(file.path) ? `<button type="button" class="text-button" data-plan-file="${safe(file.path)}" data-plan-id="${safe(plan.id)}">${safe(file.path)}</button>`
        : safe(file.path)}</li>`).join('')}</ul></section>` : ''}
    ${plan.feedback ? `<section class="inline-result"><h3>Комментарий владельца</h3>${plain(plan.feedback)}</section>` : ''}`;
}

function openPlan(plan, revise = false) {
  const pending = plan.status === 'pending';
  dialogTo(plan.title || (plan.kind === 'initial' ? 'План инициализации' : 'План спринта'),
    planBody(plan) + (pending
      ? (revise ? textarea('Что изменить в плане?', 'feedback', '', 'required') :
        `<div class="actions">${actionFor('Подтвердить и запустить', 'approve-plan', plan.id, false)}
        ${actionFor('Вернуть на доработку', 'revise-plan', plan.id)}</div>`) + autonomyHint()
      : ''),
    revise && pending ? 'Отправить на доработку' : undefined, revise && pending ? ({ feedback }) =>
      bridge.request('decidePlan', { planId: plan.id, decision: 'revise', feedback }) : undefined);
}

async function approvePlan(raw) {
  const plan = planById(raw);
  if (!plan || plan.status !== 'pending') return;
  dialogError();
  setDialogBusy(true);
  try {
    await bridge.request('decidePlan', { planId: plan.id, decision: 'approve' });
    dialog.close();
    await refresh();
  } catch (error) {
    dialogError(error.message || 'Не удалось согласовать план.');
  } finally {
    setDialogBusy(false);
  }
}

function datalist(id, values) {
  return `<datalist id="${id}">${values.map(value => typeof value === 'string' ? option(value) : option(value.id, value.name)).join('')}</datalist>`;
}

function runtimeFields(config, append = '') {
  const runtime = config?.runtime || 'codex';
  const models = providerState[runtime]?.models ?? [];
  return select('Подключение', 'runtime', Object.entries(runtimeNames).map(([id, label]) => option(id, label, runtime)).join('')) +
    input('Модель', 'model', config?.model, 'list="model-catalog" placeholder="По умолчанию"') +
    datalist('model-catalog', models) + append;
}

function effortField(config) {
  const model = providerState[config?.runtime || 'codex']?.models?.find(item => item.id === config?.model);
  return input('Усилие', 'effort', config?.effort, 'list="effort-catalog" placeholder="По умолчанию"') +
    datalist('effort-catalog', model?.efforts?.length ? model.efforts : effortPresets);
}

function modelConfig(values) {
  return { runtime: values.runtime, model: values.model, effort: values.effort };
}

function directorEditor() {
  const current = studio();
  dialogTo('Модель директора', runtimeFields(current.director, effortField(current.director)), 'Сохранить директора',
    values => bridge.request('updateStudio', { studioId: current.id, director: modelConfig(values) }));
}

function allowEditor(raw) {
  const current = studio();
  const entries = current.allowed ?? [];
  const index = raw == null ? entries.length : Number(raw);
  const entry = entries[index];
  dialogTo(entry ? 'Разрешённая модель' : 'Добавить разрешённую модель', runtimeFields(entry,
    input('Разрешённые усилия через запятую', 'efforts', entry?.efforts?.join(', '), 'placeholder="low, medium, high"')),
  'Сохранить модель', ({ runtime, model, efforts }) => {
    if (!model) throw new Error('Укажите модель.');
    const allowed = [...entries];
    allowed[index] = { runtime, model, efforts: [...new Set(efforts.split(',').map(value => value.trim()).filter(Boolean))] };
    return bridge.request('updateStudio', { studioId: current.id, allowed });
  });
}

function agentEditor(agent) {
  const current = studio();
  const mode = agent?.mode ?? 'inherit';
  const role = agent?.role === 'director' ? 'other' : agent?.role ?? 'other';
  const roleChoices = Object.entries(roleNames).filter(([id]) => id !== 'director')
    .map(([id, name]) => option(id, name, role)).join('');
  dialogTo(agent ? 'Настроить агента' : 'Новый агент',
    input('Имя (необязательно)', 'name', agent?.name, 'maxlength="120"') + select('Роль', 'role', roleChoices) +
    `<p id="role-guide" class="muted">${safe(roleDetails[role])}</p>` + textarea('Назначение роли', 'description', agent?.description) +
    select('Выбор модели', 'mode', Object.entries(modeNames).map(([id, name]) => option(id, name, mode)).join('')) +
    `<div class="form-body" id="fixed-options"${mode === 'fixed' ? '' : ' hidden'}>${runtimeFields(agent, effortField(agent))}</div>
      <p class="muted" id="dynamic-options"${mode === 'dynamic' ? '' : ' hidden'}>Директор выбирает модель и усилие для задачи из разрешённого списка студии.</p>`,
    'Сохранить агента', ({ name, role, mode, description, ...config }) => {
      if (mode === 'fixed' && !config.model) throw new Error('Укажите фиксированную модель.');
      const payload = { studioId: current.id, name, role, mode, description, ...(mode === 'fixed' ? modelConfig(config) : {}) };
      return bridge.request(agent ? 'updateAgent' : 'addAgent', agent ? { ...payload, agentId: agent.id } : payload);
    });
}

async function importPreview() {
  notice();
  try {
    const root = await bridge.request('pickFolder');
    if (!root) return;
    dialogTo('Предварительный импорт', '<p role="status">Проверяем структуру папки…</p>');
    setDialogBusy(true);
    const result = await bridge.request('previewImport', { root });
    const fields = { tasks: 'Задачи', archivedTasks: 'Архивные задачи', roles: 'Роли', openQuestions: 'Открытые вопросы', worktrees: 'Рабочие деревья', artifacts: 'Артефакты' };
    const items = values => `<ul>${values.map(value => `<li>${safe(value)}</li>`).join('')}</ul>`;
    const size = result.artifactBytes == null ? '' : new Intl.NumberFormat('ru', { style: 'unit', unit: 'byte' }).format(result.artifactBytes);
    dialogTo('Предварительный импорт', `<div>${badge(result.valid ? 'Структура распознана' : 'Структура требует проверки', result.valid ? 'good' : 'warn')}</div>` +
      plain(result.root || root) + `<dl class="studio-meta">${Object.entries(fields).filter(([key]) => result.counts?.[key] != null)
        .map(([key, name]) => `<dt>${name}</dt><dd>${safe(result.counts[key])}</dd>`).join('')}${size ? `<dt>Объём артефактов</dt><dd>${safe(size)}</dd>` : ''}</dl>` +
      (result.projectCandidates?.length ? `<section><h3>Папки проектов</h3>${items(result.projectCandidates)}</section>` : '') +
      (result.warnings?.length ? `<section><h3>Замечания</h3>${items(result.warnings)}</section>` : '') +
      (result.valid ? actionFor('Импортировать в отдельную студию', 'import-legacy', root, false) : ''));
  } catch (error) {
    if (dialog.open) dialogError(error.message || 'Не удалось проверить папку.');
    else notice(error.message || 'Не удалось открыть папку.', true);
  } finally {
    if (dialog.open) setDialogBusy(false);
  }
}

async function inspect(runtime) {
  if (inspecting.has(runtime)) return;
  inspecting.add(runtime);
  notice();
  render();
  updateWizardProvider();
  try {
    providerState[runtime] = await bridge.request('inspect', { runtime });
  } catch (error) {
    providerState[runtime] = { available: false, detail: error.message || 'Проверка подключения не удалась.' };
  } finally {
    inspecting.delete(runtime);
    render();
    updateWizardProvider();
  }
}

async function changeTask(command, raw) {
  const task = tasks().find(entry => same(entry.id, raw));
  if (!task || dialogBusy) return;
  dialogError();
  setDialogBusy(true);
  try {
    await bridge.request(command, { taskId: task.id });
    await refresh();
    openTask(task);
  } catch (error) {
    dialogError(error.message || 'Не удалось обновить задачу.');
  } finally {
    setDialogBusy(false);
  }
}

async function pickFolder(target) {
  dialogError();
  setDialogBusy(true);
  try {
    const root = await bridge.request('pickFolder');
    if (root) target.value = root;
  } catch (error) {
    dialogError(error.message || 'Не удалось выбрать папку.');
  } finally {
    setDialogBusy(false);
  }
}

async function removeModel(index) {
  const current = studio();
  try {
    await bridge.request('updateStudio', { studioId: current.id, allowed: current.allowed.filter((_, i) => i !== index) });
    await refresh();
  } catch (error) {
    notice(error.message || 'Не удалось сохранить список моделей.', true);
  }
}

async function workCommand(command, payload, success) {
  if (workBusy) return;
  workBusy = true;
  notice();
  render();
  try {
    const result = await bridge.request(command, payload);
    if (success && result) notice(success);
    await refresh();
  } catch (error) {
    notice(error.message || 'Действие не выполнено.', true);
  } finally {
    workBusy = false;
    render();
  }
}

async function openArtifact(payload) {
  if (!dialog.open) {
    await workCommand('openArtifact', payload);
    return;
  }
  dialogError();
  setDialogBusy(true);
  try {
    await bridge.request('openArtifact', payload);
  } catch (error) {
    dialogError(error.message || 'Не удалось открыть файл.');
  } finally {
    setDialogBusy(false);
  }
}

function importEditor(source) {
  const legacy = Boolean(source);
  dialogTo(legacy ? 'Импорт старой студии' : 'Импорт файла Hearth',
    (legacy ? `<div class="muted">Источник${plain(source)}</div>` : '<p class="muted">После выбора рабочей папки откроется окно выбора файла экспорта.</p>') +
    input('Название новой студии (необязательно)', 'name', '', 'maxlength="120"') +
    pathField('', { label: 'Рабочая папка новой студии' }) +
    (legacy ? textarea('Артефакты для копирования (необязательно)', 'artifactPaths', '', 'placeholder="studio/artifacts/имя-файла.md"') +
      '<p class="muted">Укажите по одному относительному пути на строку.</p>' : ''),
    'Импортировать', async ({ root, name, artifactPaths = '' }) => {
      if (!root) throw new Error('Выберите рабочую папку для новой студии.');
      const paths = [...new Set(artifactPaths.split('\n').map(path => path.trim()).filter(Boolean))];
      const imported = await bridge.request(legacy ? 'importLegacy' : 'importBundle', {
        root, ...(name && { name }), ...(legacy && { source, artifactPaths: paths }),
      });
      const id = imported?.studio?.id ?? imported?.id;
      if (id) {
        selectStudio(id);
        view = 'overview';
        notice('Студия импортирована.');
      }
      if (imported?.warnings?.length) {
        dialogTo('Студия импортирована', '<ul>' + imported.warnings.map(warning => `<li>${safe(warning)}</li>`).join('') + '</ul>');
        return false;
      }
    });
}

function exportEditor(mode) {
  if (!['template', 'snapshot'].includes(mode)) return;
  const current = studio();
  const snapshot = mode === 'snapshot';
  const paths = [...new Set([...tasks().map(task => task.artifactPath).filter(Boolean), ...plans().flatMap(publishedPaths)])];
  const files = paths.length ? `<fieldset class="stack compact export-files"><legend>Файлы для экспорта</legend>
    ${paths.map((path, index) => `<label class="checkbox-field"><input type="checkbox" name="artifact-${index}"><span>${safe(path)}</span></label>`).join('')}
  </fieldset>` : '';
  dialogTo(snapshot ? 'Экспорт снимка' : 'Экспорт шаблона',
    snapshot ? '<p>Снимок включает состав студии, планы, задачи и решения.</p>' + files
      : '<p>Шаблон сохраняет настройки и роли студии для нового проекта.</p>',
    'Сохранить файл', async values => {
      const artifactPaths = snapshot ? paths.filter((_, index) => values[`artifact-${index}`]) : [];
      const result = await bridge.request('exportStudio', { studioId: current.id, mode, includeArtifacts: artifactPaths.length > 0, artifactPaths });
      if (result) notice('Файл экспорта сохранён.');
    });
}

const commands = {
  studio: () => studioEditor(),
  'edit-studio': () => studioEditor(studio()),
  task: () => taskEditor(),
  director: directorEditor,
  'allow-model': () => allowEditor(),
  agent: () => agentEditor(),
  import: importPreview,
  'import-bundle': () => importEditor(),
};

document.addEventListener('click', event => {
  const target = event.target.closest('button');
  if (!target) return;
  const data = target.dataset;
  if (data.close !== undefined) dialog.close();
  else if (!bridge || dialogBusy) return;
  else if (data.reload !== undefined) void refresh();
  else if (data.folder !== undefined) void pickFolder(form.elements[data.folder || 'root']);
  else if (data.wizardNext !== undefined) moveWizard(1);
  else if (data.wizardBack !== undefined) moveWizard(-1);
  else if (data.view) route(data.view);
  else if (data.workTab) {
    workTab = data.workTab;
    render();
  } else if (data.open) commands[data.open]?.();
  else if (data.initialize !== undefined) void workCommand('initializeStudio', { studioId: studio().id });
  else if (data.runAction) void workCommand('setStudioRunning', { studioId: studio().id, action: data.runAction });
  else if (data.plan !== undefined || data.revisePlan !== undefined) {
    const plan = planById(data.plan ?? data.revisePlan);
    if (plan) openPlan(plan, data.revisePlan !== undefined);
  } else if (data.approvePlan !== undefined) void approvePlan(data.approvePlan);
  else if (data.reviseResult !== undefined) {
    const item = entries().find(entry => same(entry.id, data.reviseResult) && entry.kind === 'acceptance');
    if (item) openAcceptance(item, true);
  }
  else if (data.artifact !== undefined) {
    const task = tasks().find(item => same(item.id, data.artifact));
    if (task) void openArtifact({ taskId: task.id });
  } else if (data.planFile !== undefined) {
    const plan = planById(data.planId);
    if (plan && publishedPaths(plan).includes(data.planFile)) void openArtifact({ planId: plan.id, path: data.planFile });
  }
  else if (data.autonomy !== undefined) {
    dialog.close();
    route('settings');
    $('#autonomy').focus();
  } else if (data.importLegacy !== undefined) importEditor(data.importLegacy);
  else if (data.exportMode) exportEditor(data.exportMode);
  else if (data.task !== undefined) {
    const task = tasks().find(entry => same(entry.id, data.task));
    if (task) openTask(task);
  } else if (data.inbox !== undefined) {
    const item = entries().find(entry => same(entry.id, data.inbox));
    if (item) openInbox(item);
  } else if (data.scope) {
    inboxScope = data.scope;
    render();
  } else if (data.agent !== undefined) {
    selectedAgent = data.agent;
    render();
    const task = data.deskTask && tasks().find(entry => same(entry.id, data.deskTask));
    if (task) openTask(task);
  } else if (data.newTask !== undefined) taskEditor(data.newTask);
  else if (data.inspect) void inspect(data.inspect);
  else if (data.editAgent !== undefined) agentEditor(studio().agents.find(agent => same(agent.id, data.editAgent)));
  else if (data.allow !== undefined) allowEditor(data.allow);
  else if (data.removeAllow !== undefined) void removeModel(Number(data.removeAllow));
  else if (data.reviewWorktree !== undefined) {
    const task = tasks().find(entry => same(entry.id, data.reviewWorktree));
    if (task?.legacyWorktreeReview) confirmWorktreeReview(task);
  }
  else if (data.startTask !== undefined) void changeTask('startTask', data.startTask);
  else if (data.cancelTask !== undefined) void changeTask('cancelTask', data.cancelTask);
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!submission || dialogBusy) return;
  if (form.querySelector('[data-wizard-next]:not([hidden])')) {
    moveWizard(1);
    return;
  }
  dialogError();
  const values = Object.fromEntries(Array.from(new FormData(form), ([key, value]) => [key, value.trim()]));
  for (const control of form.querySelectorAll('[required]')) {
    if (values[control.name]) continue;
    dialogError('Заполните обязательное поле.');
    control.focus();
    return;
  }
  setDialogBusy(true);
  try {
    const close = await submission(values);
    if (close !== false) dialog.close();
    await refresh();
  } catch (error) {
    dialogError(error.message || 'Не удалось сохранить изменения.');
  } finally {
    setDialogBusy(false);
  }
});

form.addEventListener('change', ({ target }) => {
  if (target.name === 'template') form.elements.firstResult.placeholder = templates[target.value][1];
  if (target.name === 'role') $('#role-guide').textContent = roleDetails[target.value] || '';
  if (target.name === 'runtime' && $('#wizard-provider')) {
    updateWizardProvider();
    if (!providerState[target.value]) void inspect(target.value);
    return;
  }
  if (target.name === 'mode') {
    $('#fixed-options').hidden = target.value !== 'fixed';
    $('#dynamic-options').hidden = target.value !== 'dynamic';
  }
  if ((target.name === 'runtime' || target.name === 'model') && $('#model-catalog')) {
    const models = providerState[form.elements.runtime.value]?.models ?? [];
    const model = models.find(item => item.id === form.elements.model.value);
    $('#model-catalog').innerHTML = models.map(item => option(item.id, item.name)).join('');
    if ($('#effort-catalog')) {
      $('#effort-catalog').innerHTML = (model?.efforts?.length ? model.efforts : effortPresets).map(value => option(value)).join('');
    }
  }
});

content.addEventListener('change', ({ target }) => {
  if (target.name === 'approveSprints') void workCommand('updateStudio', { studioId: studio().id, approveSprints: target.checked });
});
content.addEventListener('toggle', ({ target }) => {
  if (target.id === 'advanced' && target.isConnected) advancedOpen = target.open;
}, true);

dialog.addEventListener('cancel', event => { if (dialogBusy) event.preventDefault(); });
dialog.addEventListener('close', () => {
  taskDialog = undefined;
  if (opener?.isConnected) opener.focus();
  else content.focus();
  if (notificationTarget) void goToNotification();
});

$('#studio-select').addEventListener('change', ({ target }) => {
  selectStudio(target.value);
  route('overview');
});

function applyTheme(value) {
  document.documentElement.dataset.theme = ['light', 'dark'].includes(value) ? value : 'system';
  $('#theme-select').value = document.documentElement.dataset.theme;
}

$('#theme-select').addEventListener('change', ({ target }) => {
  stored('theme', target.value);
  applyTheme(target.value);
});
applyTheme(stored('theme'));

async function goToNotification() {
  if (dialog.open || openingNotification || !notificationTarget) return;
  openingNotification = true;
  try {
    await refresh();
    if (dialog.open) return;
    const target = notificationTarget;
    notificationTarget = undefined;
    if (!state.studios.some(item => item.id === target.studioId)) return;
    selectStudio(target.studioId);
    const item = entries().find(entry => entry.id === target.inboxId);
    inboxScope = item?.status === 'resolved' ? 'resolved' : 'open';
    route('inbox');
    if (item) openInbox(item);
  } finally {
    openingNotification = false;
  }
}

if (bridge) {
  const unsubscribe = bridge.subscribe(() => void refresh());
  const unsubscribeInbox = bridge.onInbox?.(target => {
    notificationTarget = target;
    void goToNotification();
  });
  window.addEventListener('pagehide', () => {
    unsubscribe?.();
    unsubscribeInbox?.();
  }, { once: true });
  void refresh();
} else {
  $('#studio-select').innerHTML = '<option>Нет студий</option>';
  $('[data-open="studio"]').disabled = true;
  content.innerHTML = empty('Откройте Hearth Studio', 'Для работы со студиями запустите настольное приложение.');
}
