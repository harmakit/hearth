import { buildRooms, roleNames, taskForAgent } from './workshop.mjs';
import { paintRooms } from './room-art.mjs';

const bridge = window.hearth;
const $ = selector => document.querySelector(selector);
const content = $('#content');
const dialog = $('#dialog');
const form = $('#dialog-form');
const runtimeNames = { codex: 'Codex', claude: 'Claude Code' };
const modeNames = { inherit: 'Как у директора', fixed: 'Фиксированные модель и усилие', dynamic: 'Из списка студии' };
const views = { overview: 'Обзор', inbox: 'Входящие', workshop: 'Мастерская', settings: 'Настройки' };
const icons = {
  overview: '<rect x="3" y="3" width="7" height="8" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="3" y="15" width="7" height="6" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/>',
  inbox: '<path d="M5 4h14l3 9v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6zM2 13h6l2 3h4l2-3h6"/>',
  workshop: '<path d="M5 13V8a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v5M6 19v2m12-2v2M4 19h16a1 1 0 0 0 1-1v-5a2 2 0 0 0-4 0v2H7v-2a2 2 0 0 0-4 0v5a1 1 0 0 0 1 1Z"/>',
  settings: '<path d="M3 6h6m4 0h8M3 12h12m4 0h2M3 18h2m4 0h12M9 4v4m6 2v4M5 16v4"/>',
};
const statuses = {
  queued: ['В очереди', ''], running: ['В работе', 'good'], waiting: ['Ждёт ответа', 'warn'],
  completed: ['Готово', 'good'], failed: ['Ошибка', 'attention'],
  interrupted: ['Прервана', 'attention'], cancelled: ['Отменена', ''],
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

function stored(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(`hearth:${key}`);
    localStorage.setItem(`hearth:${key}`, value);
  } catch { /* The app can run without saved UI preferences. */ }
}

const studio = () => state.studios.find(item => String(item.id) === studioId);
const tasks = () => state.tasks.filter(item => String(item.studioId) === studioId);
const entries = () => state.inbox.filter(item => String(item.studioId) === studioId);
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
  const focusTarget = focusRoot && Object.entries(focused.dataset).find(([key]) => ['view', 'agent', 'task', 'inbox', 'scope', 'open', 'inspect', 'editAgent', 'allow'].includes(key));
  picker.disabled = !state.studios.length;
  picker.innerHTML = state.studios.map(item => option(String(item.id), item.name, studioId)).join('') || '<option>Нет студий</option>';
  const openCount = entries().filter(item => item.status === 'open').length;
  $('#navigation').innerHTML = Object.entries(views).map(([key, label]) => `<button type="button" data-view="${key}"${view === key ? ' aria-current="page"' : ''}>${glyph(key)}<span>${label}</span>${key === 'inbox' && openCount ? `<span class="nav-count">${openCount}</span>` : ''}</button>`).join('');
  $('#breadcrumb').innerHTML = `<span>${safe(current?.name || 'Hearth Studio')}</span><span aria-hidden="true">›</span><strong>${views[view]}</strong>`;
  content.innerHTML = current || view === 'settings'
    ? ({ overview, inbox, workshop, settings })[view]()
    : heading(views[view]) + empty('Создайте студию', 'Выберите папку проекта, чтобы добавить первую задачу.', button('Создать студию', 'data-open="studio"'));
  if (view === 'workshop' && current) paintRooms(content);
  if (focusTarget) {
    const [key, value] = focusTarget;
    Array.from(focusRoot.querySelectorAll('button')).find(node => node.dataset[key] === value)?.focus();
  }
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
  const decision = open.find(item => item.kind === 'question') ?? open[0];
  const last = all.find(task => task.status === 'completed');
  const rooms = buildRooms(current);
  const workCount = all.filter(task => ['running', 'queued'].includes(task.status)).length;
  return heading('Обзор студии', current.brief || current.name, button('Новая задача', 'data-open="task"')) +
    `<div class="split"><div class="stack">
      ${decision ? `<article class="panel padded decision">
        <div class="row">${badge(decision.kind === 'question' ? 'Нужно решение' : 'Требуется внимание', 'attention')}<small>${open.length} открыто</small></div>
        <h2>${safe(decision.title)}</h2><p class="clamp">${safe(decision.body)}</p>
        <div>${actionFor('Открыть во входящих', 'inbox', decision.id, false)}</div>
      </article>` : ''}
      <section class="stack compact"><h2>Последний отчёт</h2>
        ${last ? `<article class="panel report">
          <div class="excerpt">${safe(last.summary || 'Результат сохранён в задаче.')}</div>
          <div class="padded stack compact"><div class="row"><h3>${safe(last.title)}</h3>${status(last)}</div>
          <div>${actionFor('Читать отчёт', 'task', last.id)}</div></div></article>`
          : empty('Отчётов пока нет', 'Здесь появится результат первой завершённой задачи.')}</section>
    </div><aside class="stack">
      <section class="panel padded stack compact"><div class="row"><h2>Мастерская</h2>${glyph('workshop')}</div>
        <p class="muted">Комнат: ${rooms.length} · В работе и очереди: ${workCount}</p>
        <div>${button('Открыть карту', 'data-view="workshop"', true)}</div></section>
      <section class="stack compact"><h2>Задачи</h2>
        ${all.length ? `<div class="panel work-list">${all.map(taskRow).join('')}</div>` : empty('Задач пока нет', 'Поставьте задачу директору или участнику студии.')}</section>
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
  const task = tasks().find(entry => entry.id === item.taskId);
  const isQuestion = item.kind === 'question';
  return `<article class="panel padded stack compact">
    <div class="row">${badge(isQuestion ? 'Вопрос' : 'Ошибка', isQuestion ? 'warn' : 'attention')}
      <small class="muted">${safe(task?.title)}</small></div>
    <h2>${safe(item.title)}</h2><div class="long-text">${safe(item.body)}</div>
    ${item.answer ? `<div class="inline-result"><strong>Ответ</strong>${plain(item.answer)}</div>` : ''}
    <div class="actions">
      ${item.status === 'open' && isQuestion ? actionFor('Ответить', 'inbox', item.id, false) : ''}
      ${task ? actionFor('Открыть задачу', 'task', task.id) : ''}
      ${item.status === 'open' && !isQuestion ? actionFor('Просмотреть ошибку', 'inbox', item.id) : ''}
    </div>
  </article>`;
}

function workshop() {
  const current = studio();
  const rooms = buildRooms(current);
  const roster = rooms.flatMap(room => room.desks.map(({ agent }) => ({ room, agent })));
  const selection = roster.find(({ agent }) => (agent.id == null ? '' : String(agent.id)) === selectedAgent) ?? roster[0];
  const { agent, room } = selection;
  const job = taskForAgent(state.tasks, current.id, agent.id);
  const renderAgent = (person, pin = false, props = '') => {
    const key = person.id == null ? '' : String(person.id);
    const chosen = person === agent;
    return `<button type="button" class="${pin ? 'map-pin' : 'list-row role-row'}" data-agent="${safe(key)}" aria-pressed="${chosen}">
      <canvas width="40" height="40" data-desk="${props || 'notebook'}" aria-hidden="true"></canvas>
      <span><strong>${safe(nameFor(person))}</strong>${pin ? '' : `<small>${safe(roleNames[person.role] || person.role)}</small>`}</span>
    </button>`;
  };
  return heading('Мастерская', `Комнат: ${rooms.length} · Участников: ${roster.length}`, button('Настроить состав', 'data-view="settings"', true)) +
    `<div class="work-map" role="group" aria-label="Карта мастерской">
      ${rooms.map(zone => `<section class="work-room"><div class="room-header"><h2>${zone.name}</h2><span aria-label="Участников в комнате: ${zone.desks.length}">${zone.desks.length}</span></div>
        <div class="room-floor"><canvas class="room-art" width="200" height="126" data-room="${zone.id}" aria-hidden="true"></canvas>
          <div class="room-occupants">${zone.desks.map(({ agent: person, props }) => renderAgent(person, true, props)).join('')}</div>
        </div></section>`).join('')}
    </div><div class="split workshop-detail"><article class="panel padded stack compact">
      <div class="row"><h2>${safe(nameFor(agent))}</h2>${job ? status(job) : badge('Свободен')}</div>
      <p class="muted">${room.name}</p>
      ${job ? `<div class="inline-result"><strong>${safe(job.title)}</strong>${job.summary ? plain(job.summary, 'muted clamp') : ''}</div>`
        : '<p>У агента пока нет задачи.</p>'}
      <div class="actions">${job ? actionFor('Открыть задачу', 'task', job.id, false) : ''}${actionFor('Поставить задачу', 'new-task', agent.id ?? '', !!job)}</div>
    </article><section class="stack compact"><h2>Роли</h2><div class="panel work-list">${rooms.flatMap(zone => zone.desks.map(({ agent: person, props }) => renderAgent(person, false, props))).join('')}</div></section></div>`;
}

function settings() {
  const current = studio();
  const providers = Object.entries(runtimeNames).map(([id, label]) => {
    const info = providerState[id];
    const checking = inspecting.has(id);
    const detail = info ? [info.version, info.detail].filter(Boolean).join(' · ') : '';
    const auth = info?.authenticated == null ? '' : info.authenticated ? ' · Вход подтверждён' : ' · Требуется вход';
    return `<article class="panel padded stack compact"><div class="row"><h3>${label}</h3>
      ${checking ? badge('Проверяем…') : info ? badge(info.available ? 'CLI найден' + auth : 'Недоступен', info.available && info.authenticated !== false ? 'good' : 'warn') : badge('Не проверен')}</div>
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
        ${current.brief ? plain(current.brief) : ''}<dl class="studio-meta"><dt>Рабочая папка</dt><dd>${safe(current.root || 'Не выбрана')}</dd><dt>Язык отчётов</dt><dd>${safe(current.language || 'Не выбран')}</dd></dl>
      </div></section>
      <section class="stack compact"><h2>Модели</h2><div class="panel padded stack compact">
        <div class="row"><div><h3>Директор</h3><p class="muted">${safe(configText(current.director) || 'Модель и усилие по умолчанию')}</p></div>${button('Настроить директора', 'data-open="director"', true)}</div>
        <div class="inline-result stack compact"><div class="row"><h3>Разрешённые модели</h3>${button('Добавить модель', 'data-open="allow-model"', true)}</div>
          ${current.allowed?.length ? current.allowed.map((entry, index) => `<div class="row allowed-row"><span>${safe([runtimeName(entry.runtime), entry.model, entry.efforts?.join(', ')].filter(Boolean).join(' · '))}</span>
            <div class="actions">${actionFor('Изменить', 'allow', index)}${actionFor('Убрать', 'remove-allow', index)}</div></div>`).join('')
            : '<p class="muted">Список пуст. Добавьте модели для ролей с автоматическим выбором.</p>'}
        </div>
      </div></section>
      <section class="stack compact"><div class="row"><h2>Роли</h2>${button('Добавить агента', 'data-open="agent"')}</div>
        <div class="panel work-list">${current.agents?.length ? current.agents.map(agent => `<div class="list-row static-row"><span><strong>${safe(nameFor(agent))}</strong>
          <small>${safe([roleNames[agent.role] || agent.role, modeNames[agent.mode], agent.mode === 'fixed' ? configText(agent) : ''].filter(Boolean).join(' · '))}</small></span>
          ${actionFor('Настроить', 'edit-agent', agent.id)}</div>`).join('')
          : '<p class="padded muted">Добавьте участников, чтобы распределять задачи по ролям.</p>'}</div></section>` : ''}
      <section class="stack compact"><h2>Предварительный импорт</h2><div class="panel padded stack compact">
        <p class="muted">Проверка структуры старой студии и сводка найденных данных.</p>
        <div>${button('Проверить папку', 'data-open="import"', true)}</div>
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
  const initialFocus = $('#dialog-body').querySelector('input:not([readonly]), textarea, select, button');
  (initialFocus ?? dialog.querySelector('[data-close]'))?.focus();
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

function pathField(root = '') {
  return `<div class="folder-field">${input('Рабочая папка', 'root', root, 'readonly')}
    ${button('Выбрать папку', 'data-folder', true)}</div>`;
}

function studioEditor(current) {
  const id = current?.id;
  dialogTo(current ? 'Параметры студии' : 'Новая студия',
    input('Название', 'name', current?.name, 'required maxlength="120"') +
    pathField(current?.root) + textarea('Бриф', 'brief', current?.brief) +
    input('Язык отчётов', 'language', current?.language || 'Русский', 'required'),
    'Сохранить студию', async values => {
      if (!values.root) throw new Error('Выберите рабочую папку.');
      const created = await bridge.request(current ? 'updateStudio' : 'createStudio',
        current ? { studioId: id, ...values } : values);
      selectStudio(created.id);
      if (!current) view = 'overview';
    });
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
  const entry = entries().find(item => item.taskId === latest.id && item.status === 'open' && item.kind === 'question');
  const canCancel = ['running', 'waiting', 'queued'].includes(latest.status);
  const canRun = ['failed', 'interrupted', 'queued'].includes(latest.status);
  const artifact = typeof latest.artifact === 'object' && latest.artifact
    ? JSON.stringify(latest.artifact, null, 2) : latest.artifact;
  const block = (label, value) => value ? `<section class="inline-result"><h3>${label}</h3>${plain(value)}</section>` : '';
  const isOpen = taskDialog?.id === latest.id;
  const previousFocus = dialog.contains(document.activeElement) ? Object.entries(document.activeElement.dataset)[0]?.[0] : '';
  dialogTo(latest.title, `<div class="row">${status(latest)}<span class="muted">${safe(nameFor(taskAgent(latest)))}</span></div>` +
    block('Постановка задачи', latest.prompt) + block('Ошибка', latest.error) +
    (latest.summary && latest.summary !== artifact ? block('Краткий отчёт', latest.summary) : '') +
    block('Результат', artifact) +
    `<div class="actions">
      ${entry ? actionFor('Ответить на вопрос', 'inbox', entry.id, false) : ''}
      ${canRun ? actionFor(latest.status === 'queued' ? 'Запустить' : 'Запустить снова', 'start-task', latest.id, false) : ''}
      ${canCancel ? actionFor('Отменить задачу', 'cancel-task', latest.id) : ''}
    </div>`);
  taskDialog = latest;
  if (isOpen && previousFocus) Array.from(dialog.querySelectorAll('button')).find(node => Object.hasOwn(node.dataset, previousFocus))?.focus();
}

function openInbox(item) {
  const question = item.kind === 'question';
  const open = item.status === 'open';
  const body = `<div>${badge(question ? 'Вопрос' : 'Ошибка', question ? 'warn' : 'attention')}</div>` + plain(item.body) +
    (item.answer ? `<section class="inline-result"><h3>Ответ</h3>${plain(item.answer)}</section>` : '');
  inboxScope = open ? 'open' : 'resolved';
  if (view !== 'inbox') route('inbox');
  dialogTo(item.title, body + (open && question
    ? textarea('Ваш ответ', 'answer', '', 'required')
    : item.taskId ? actionFor('Открыть задачу', 'task', item.taskId) : ''),
    question ? 'Отправить ответ' : 'Отметить просмотренной', open ? ({ answer }) => bridge.request('answerInbox', {
      inboxId: item.id, answer: question ? answer : '',
    }) : undefined);
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
    input('Имя', 'name', agent?.name, 'required maxlength="120"') + select('Роль', 'role', roleChoices) +
    select('Выбор модели', 'mode', Object.entries(modeNames).map(([id, name]) => option(id, name, mode)).join('')) +
    `<div class="form-body" id="fixed-options"${mode === 'fixed' ? '' : ' hidden'}>${runtimeFields(agent, effortField(agent))}</div>
      <p class="muted" id="dynamic-options"${mode === 'dynamic' ? '' : ' hidden'}>Для автоматического выбора используются разрешённые модели студии.</p>`,
    'Сохранить агента', ({ name, role, mode, ...config }) => {
      if (mode === 'fixed' && !config.model) throw new Error('Укажите фиксированную модель.');
      const payload = { studioId: current.id, name, role, mode, ...(mode === 'fixed' ? modelConfig(config) : {}) };
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
      (result.warnings?.length ? `<section><h3>Замечания</h3>${items(result.warnings)}</section>` : ''));
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
  try {
    providerState[runtime] = await bridge.request('inspect', { runtime });
  } catch (error) {
    providerState[runtime] = { available: false, detail: error.message || 'Проверка подключения не удалась.' };
  } finally {
    inspecting.delete(runtime);
    render();
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

const commands = {
  studio: () => studioEditor(),
  'edit-studio': () => studioEditor(studio()),
  task: () => taskEditor(),
  director: directorEditor,
  'allow-model': () => allowEditor(),
  agent: () => agentEditor(),
  import: importPreview,
};

document.addEventListener('click', event => {
  const target = event.target.closest('button');
  if (!target) return;
  const data = target.dataset;
  if (data.close !== undefined) dialog.close();
  else if (!bridge || dialogBusy) return;
  else if (data.reload !== undefined) void refresh();
  else if (data.folder !== undefined) void pickFolder(form.elements.root);
  else if (data.view) route(data.view);
  else if (data.open) commands[data.open]();
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
  } else if (data.newTask !== undefined) taskEditor(data.newTask);
  else if (data.inspect) void inspect(data.inspect);
  else if (data.editAgent !== undefined) agentEditor(studio().agents.find(agent => same(agent.id, data.editAgent)));
  else if (data.allow !== undefined) allowEditor(data.allow);
  else if (data.removeAllow !== undefined) void removeModel(Number(data.removeAllow));
  else if (data.startTask !== undefined) void changeTask('startTask', data.startTask);
  else if (data.cancelTask !== undefined) void changeTask('cancelTask', data.cancelTask);
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!submission || dialogBusy) return;
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
  if (target.name === 'mode') {
    $('#fixed-options').hidden = target.value !== 'fixed';
    $('#dynamic-options').hidden = target.value !== 'dynamic';
  }
  if (target.name === 'runtime' || target.name === 'model') {
    const models = providerState[form.elements.runtime.value]?.models ?? [];
    const model = models.find(item => item.id === form.elements.model.value);
    $('#model-catalog').innerHTML = models.map(item => option(item.id, item.name)).join('');
    if ($('#effort-catalog')) {
      $('#effort-catalog').innerHTML = (model?.efforts?.length ? model.efforts : effortPresets).map(value => option(value)).join('');
    }
  }
});

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
