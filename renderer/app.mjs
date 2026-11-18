import { agentActivity, actorState, buildRooms, languageChoices, pendingStudioPlan, roleDetails, roleNames, taskForAgent } from './workshop.mjs';
import { paintRooms } from './room-art.mjs';
import { publishedPaths, renderWork } from './work-view.mjs';
import { installDialogSize } from './dialog-size.mjs';
import { catalogEfforts, fixedModelChoices, modelKey, readPolicyRows } from './model-policy.mjs';
import { coachTitle, parseSkillTopics, pendingDependencies, renderSkillLibrary, renderSkillPreview, renderTrainingDetails, roleReadiness, skillMinStars, skillStarLabel } from './coach-view.mjs';

const bridge = window.hearth;
const $ = selector => document.querySelector(selector);
const content = $('#content');
const dialog = $('#dialog');
const form = $('#dialog-form');
const configureDialogSize = installDialogSize(dialog, () => stored('dialog-size'), value => stored('dialog-size', value));
const runtimeNames = { codex: 'Codex', claude: 'Claude Code' };
const modeNames = { inherit: 'Как у директора', fixed: 'Фиксированные модель и усилие', dynamic: 'Выбирает директор' };
const views = { overview: 'Обзор', work: 'Работа', inbox: 'Входящие', workshop: 'Мастерская', skills: 'Библиотека', settings: 'Настройки' };
const icons = {
  skills: '<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="8" y="4" width="5" height="16" rx="1"/><path d="m16 5 4-1 3 15-4 1zM5 8h1m4 0h1"/>',
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
const expandedEpics = new Set();
let advancedOpen = false;
let policyPromptShown = false;
let policyRowId = 0;
let skillSearch = { topics: '', preview: {} };

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
const titleFor = agent => agent?.systemRole === 'coach' ? coachTitle : agent?.roleTitle || roleNames[agent?.role] || agent?.role || 'Директор';
const nameFor = agent => agent?.systemRole === 'coach' ? coachTitle : agent?.name || titleFor(agent);
const secondaryTitle = agent => nameFor(agent) !== titleFor(agent) ? titleFor(agent) : '';
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
  expandedEpics.clear();
  advancedOpen = false;
  skillSearch = { topics: '', preview: {} };
  stored('studio', studioId);
}

async function refresh() {
  const version = ++snapshotVersion;
  try {
    const snapshot = await bridge.request('snapshot');
    if (version !== snapshotVersion) return;
    const previousTraining = taskDialog && renderTrainingDetails(taskDialog, studio(), tasks());
    state = snapshot;
    if (!studio()) selectStudio(snapshot.studios[0]?.id);
    ready = true;
    render();
    maybePromptModelPolicy();
    if (dialog.open && !dialogBusy && taskDialog) {
      const latest = snapshot.tasks.find(task => task.id === taskDialog.id);
      if (latest && (JSON.stringify(latest) !== JSON.stringify(taskDialog) ||
          previousTraining !== renderTrainingDetails(latest, studio(), tasks()))) openTask(latest);
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
  const focusTarget = focusRoot && Object.entries(focused.dataset).find(([key]) => ['view', 'agent', 'task', 'inbox', 'scope', 'open', 'inspect', 'editAgent', 'plan', 'initialize', 'runAction', 'artifact', 'workTab'].includes(key));
  const autonomyFocused = focused?.getAttribute('name') === 'approveSprints';
  const skillFieldSelection = focused?.matches('[data-skill-search] [name="topics"]')
    ? [focused.selectionStart, focused.selectionEnd] : null;
  picker.disabled = !state.studios.length;
  picker.innerHTML = state.studios.map(item => option(String(item.id), item.name, studioId)).join('') || '<option>Нет студий</option>';
  const openCount = entries().filter(item => item.status === 'open').length;
  $('#navigation').innerHTML = Object.entries(views).map(([key, label]) => `<button type="button" data-view="${key}"${view === key ? ' aria-current="page"' : ''}>${glyph(key)}<span>${label}</span>${key === 'inbox' && openCount ? `<span class="nav-count">${openCount}</span>` : ''}</button>`).join('');
  $('#breadcrumb').innerHTML = `<span>${safe(current?.name || 'Hearth Studio')}</span><span aria-hidden="true">›</span><strong>${views[view]}</strong>`;
  content.innerHTML = current || view === 'settings'
    ? ({ overview, work, inbox, workshop, skills, settings })[view]()
    : heading(views[view]) + empty('Создайте студию', 'Опишите проект, выберите рабочую папку и подключение директора.', button('Создать студию', 'data-open="studio"'));
  if (view === 'workshop' && current) paintRooms(content);
  if (focusTarget) {
    const [key, value] = focusTarget;
    Array.from(focusRoot.querySelectorAll('button')).find(node => node.dataset[key] === value)?.focus();
  }
  if (autonomyFocused) content.querySelector('[name="approveSprints"]')?.focus();
  if (skillFieldSelection) {
    const topics = content.querySelector('[data-skill-search] [name="topics"]');
    topics?.focus();
    topics?.setSelectionRange(...skillFieldSelection);
  }
}

function work() {
  const rows = key => (state[key] ?? []).filter(item => String(item.studioId) === studioId);
  return heading('Работа', studio().name, button('Новая задача', 'data-open="task"')) + renderWork({
    studio: studio(), tasks: tasks(), epics: rows('epics'), stories: rows('stories'),
    sprints: rows('sprints'), meetings: rows('meetings'), plans: plans(), tab: workTab, expandedEpics,
  });
}

function skills() {
  const current = studio();
  return heading('Библиотека', current.name) + renderSkillLibrary({
    studio: current, skills: (state.skills ?? []).filter(skill => skill.studioId === current.id), ...skillSearch,
  });
}

function updateSkillPreview(search, preview) {
  if (skillSearch !== search) return;
  search.preview = preview;
  const results = content.querySelector('[data-skill-preview]');
  const submit = content.querySelector('[data-skill-search] button[type="submit"]');
  if (results && submit) {
    results.innerHTML = renderSkillPreview(preview);
    submit.setAttribute('aria-disabled', String(preview.status === 'pending'));
  }
}

async function searchSkills() {
  const search = skillSearch;
  if (search.preview.status === 'pending') return;
  const topics = parseSkillTopics(search.topics);
  if (!topics.length) {
    updateSkillPreview(search, { status: 'error', error: 'Введите хотя бы одну тему.' });
    return;
  }
  updateSkillPreview(search, { status: 'pending' });
  try {
    const { candidates, warnings } = await bridge.request('searchSkillRepositories', { studioId: studio().id, topics });
    updateSkillPreview(search, { status: 'done', candidates, warnings });
  } catch (error) {
    updateSkillPreview(search, { status: 'error', error: error.message || 'Поиск на GitHub недоступен. Попробуйте ещё раз.' });
  }
}

function route(next) {
  view = next;
  notice();
  content.focus();
  render();
}

function taskEpic(task) {
  const story = state.stories?.find(row => String(row.studioId) === studioId && row.id === task.storyId);
  return (state.epics ?? []).find(row => String(row.studioId) === studioId && row.id === (task.epicId || story?.epicId));
}

function showEpic(id) {
  if (!(state.epics ?? []).some(row => String(row.studioId) === studioId && same(row.id, id))) return;
  if (dialog.open) dialog.close();
  expandedEpics.clear();
  expandedEpics.add(id);
  workTab = 'epics';
  route('work');
  requestAnimationFrame(() => {
    const section = [...content.querySelectorAll('[data-epic-section]')].find(row => row.dataset.epicSection === id);
    section?.scrollIntoView({ block: 'nearest' });
    section?.querySelector('summary')?.focus({ preventScroll: true });
  });
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
  const running = ['active', 'planning'].includes(current.lifecycle) || (current.lifecycle === 'idle' && initial) || workCount > 0 || current.scheduleWaiting;
  const manuallyPaused = current.manualPaused || current.lifecycle === 'paused';
  const runButtons = manuallyPaused || current.lifecycle === 'error'
    ? actionFor(current.lifecycle === 'error' ? 'Повторить шаг' : 'Возобновить', 'run-action', 'resume', false) + actionFor('Остановить', 'run-action', 'stop')
    : running ? actionFor('Пауза', 'run-action', 'pause') + actionFor('Остановить', 'run-action', 'stop') : '';
  const intro = canInitialize ? '<p class="muted">Директор предложит команду, первый спринт и критерии результата.</p>' : '';
  const activity = current.scheduleWaiting ? 'Новые задачи запустятся в рабочее время студии.' :
    current.activity || (current.lifecycle === 'planning' ? 'Директор готовит предложение по проекту.' : '');
  return heading('Обзор студии', current.name, (canInitialize ? '' : button('Новая задача', 'data-open="task"')) + runButtons) +
    `<div class="split"><div class="stack">
      ${current.lifecycle || activity || pendingPlan ? `<section class="panel padded stack compact">
        <div class="row"><h2>${canInitialize ? 'Начало работы' : 'Студия'}</h2>${current.scheduleWaiting ? badge('Ждёт рабочего времени', 'warn') :
          manuallyPaused ? badge('На паузе', 'warn') :
          studioStatuses[current.lifecycle] ? badge(...studioStatuses[current.lifecycle]) : ''}</div>
        ${intro}${activity ? `<p class="activity" role="status">${safe(activity)}</p>` : ''}
        <div class="actions">${canInitialize ? button('Инициализировать студию', 'data-initialize' + (workBusy ? ' disabled' : '')) : ''}
          ${pendingPlan ? actionFor('Посмотреть план', 'plan', pendingPlan.id, false) : activePlan ? actionFor('Открыть план', 'plan', activePlan.id) : ''}</div>
      </section>` : ''}
      ${decision ? `<article class="panel padded decision">
        <div class="row">${badge(decision.kind === 'acceptance' ? 'На приёмке' : decision.kind === 'question' ? 'Нужно решение' : 'Требуется внимание', 'attention')}<small>${open.length} открыто</small></div>
        <h2>${safe(decision.title)}</h2><p class="clamp">${safe(decision.body)}</p>
        <div>${actionFor('Открыть во входящих', 'inbox', decision.id, false)}</div>
      </article>` : ''}
      <section class="stack compact"><div class="row"><h2>Последний отчёт</h2>${button('Все артефакты', 'data-work-pane="artifacts"', true)}</div>
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
  const activityFor = person => {
    const job = jobFor(person);
    const director = person.id == null;
    if (job?.status !== 'running' && current.scheduleWaiting && (director || job?.status === 'queued')) {
      return ['Ждёт рабочего времени', 'warn'];
    }
    if (job?.status !== 'running' && current.manualPaused && (director || job?.status === 'queued')) {
      return ['На паузе', 'warn'];
    }
    return agentActivity(job, director ? current.lifecycle : undefined);
  };
  const renderAgent = (person, pin = false, props = '') => {
    const key = person.id == null ? '' : String(person.id);
    const chosen = person === agent;
    const currentJob = jobFor(person);
    const [activity, tone] = activityFor(person);
    const director = person.id == null;
    const actor = actorState(currentJob, director ? current.lifecycle : undefined, {
      paused: current.manualPaused && (director || currentJob?.status === 'queued'),
      scheduled: current.scheduleWaiting && (director || currentJob?.status === 'queued'),
    });
    const openJob = pin && currentJob && ['running', 'waiting', 'queued'].includes(currentJob.status) && currentJob.stage !== 'backlog';
    return `<button type="button" class="${pin ? 'map-pin' : 'list-row role-row'}" data-agent="${safe(key)}" data-activity="${tone}" aria-pressed="${chosen}"${person.systemRole === 'coach' ? ' data-system-role="coach"' : ''}${openJob ? ` data-desk-task="${safe(currentJob.id)}" aria-haspopup="dialog"` : ''}>
      <canvas width="40" height="40" data-desk="${props || 'notebook'}" data-actor-key="${safe(`${current.id}:${person.id ?? 'director'}`)}" data-actor-state="${actor}" aria-hidden="true"></canvas>
      <span><strong>${safe(nameFor(person))}</strong><small>${pin ? safe(activity) : safe([secondaryTitle(person), activity].filter(Boolean).join(' · '))}</small>
        ${pin ? '' : roleReadiness(person, currentTasks, { showTask: false })}</span>
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
      <p class="muted">${safe([room.name, secondaryTitle(agent)].filter(Boolean).join(' · '))}</p>
      ${agent.id != null ? `<div class="role-readiness">${roleReadiness(agent, currentTasks)}</div>` : ''}
      ${agent.description ? `<p>${safe(agent.description)}</p>` : ''}
      ${job ? `<div class="inline-result"><strong>${safe(job.title)}</strong>${job.summary ? plain(job.summary, 'muted clamp') : ''}</div>`
        : '<p>У агента пока нет задачи.</p>'}
      <div class="actions">${job ? actionFor('Открыть задачу', 'task', job.id, false) : ''}${agent.systemRole === 'coach' ? '' : actionFor('Поставить задачу', 'new-task', agent.id ?? '', !!job)}</div>
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
      <section class="stack compact"><h2>Модели приложения</h2><div class="panel padded stack compact">
        <div class="row allowed-row"><div><h3>Список для студий по умолчанию</h3>
          <p class="muted">${state.modelPolicy?.configured === false ? 'Список ещё не настроен.' : 'Студии могут использовать этот список или задать свой.'}</p></div>
          ${button('Настроить список', 'data-open="app-model-policy"', true)}</div>
        ${policySummary(state.modelPolicy?.allowed)}
      </div></section>
      ${current ? `<section class="stack compact"><h2>Студия</h2><div class="panel padded stack compact">
        <div class="row"><h3>${safe(current.name)}</h3><div class="actions">${button('Изменить', 'data-open="edit-studio"', true)}${button('Удалить студию', 'data-open="delete-studio"', true)}</div></div>
        ${current.brief ? plain(current.brief) : ''}<dl class="studio-meta"><dt>Рабочая папка</dt><dd>${safe(current.root || 'Не выбрана')}</dd><dt>Язык отчётов</dt><dd>${safe(current.language || 'Не выбран')}</dd>
          ${current.projectLanguage ? `<dt>Язык материалов</dt><dd>${safe(current.projectLanguage)}</dd>` : ''}</dl>
        ${current.root ? `<div>${button('Открыть папку проекта', 'data-open="project-folder"', true)}</div>` : ''}
      </div></section>
      <section class="stack compact" id="autonomy" tabindex="-1"><h2>Автономность</h2><div class="panel padded stack compact">
        <label class="checkbox-field"><input type="checkbox" name="approveSprints"${current.approveSprints !== false ? ' checked' : ''}${workBusy ? ' disabled' : ''}> <span>Согласовывать план спринта</span></label>
        <p class="muted">При инициализации Hearth всегда запрашивает согласование. Настройка применяется к будущим спринтам.</p>
        <div class="row allowed-row"><div><h3>Расписание</h3><p class="muted">${safe(scheduleLabel(current.schedule))}</p></div>
          ${button('Настроить расписание', 'data-open="schedule"', true)}</div>
      </div></section>
      <section class="stack compact"><h2>Модели студии</h2><div class="panel padded stack compact">
        <div class="row"><div><h3>Директор</h3><p class="muted">${safe(configText(current.director) || 'Модель и усилие по умолчанию')}</p></div>${button('Настроить директора', 'data-open="director"', true)}</div>
        <div class="inline-result stack compact"><div class="row allowed-row"><div><h3>Разрешённые модели</h3>
          <p class="muted">${studioPolicyMode(current) === 'studio' ? 'Свой список студии' : 'Список приложения'}</p></div>
          ${button('Настроить список', 'data-open="studio-model-policy"', true)}</div>
          ${policySummary(studioAllowed(current))}</div>
      </div></section>
      <section class="stack compact"><h2>Библиотека</h2><div class="panel padded row">
        <div><h3>Порог поиска на GitHub</h3><p class="muted">Минимум звёзд · ${skillStarLabel(current)}</p></div>
        ${button('Настроить порог', 'data-open="skill-settings"', true)}</div></section>
      <details class="panel padded advanced" id="advanced"${advancedOpen ? ' open' : ''}><summary>Расширенные настройки</summary><div class="stack">
      <section class="stack compact"><div class="row"><h2>Роли</h2>${button('Добавить агента', 'data-open="agent"')}</div>
        <div class="panel work-list">${current.agents?.length ? current.agents.map(agent => `<div class="list-row static-row"${agent.systemRole === 'coach' ? ' data-system-role="coach"' : ''}><span><strong>${safe(nameFor(agent))}</strong>
          <small>${safe([secondaryTitle(agent), modeNames[agent.mode], agent.mode === 'fixed' ? configText(agent) : ''].filter(Boolean).join(' · '))}</small>
          ${agent.description ? `<small>${safe(agent.description)}</small>` : ''}
          ${roleReadiness(agent, tasks(), { showTask: false })}</span>
          ${actionFor('Настроить', 'edit-agent', agent.id)}</div>`).join('')
          : '<p class="padded muted">Роли появятся после согласования плана. Здесь можно добавить агента вручную.</p>'}</div></section></div></details>` : ''}
      <section class="stack compact"><h2>Импорт и экспорт</h2><div class="panel padded stack compact">
        <div class="actions">${button('Импортировать файл Hearth', 'data-open="import-bundle"', true)}${button('Проверить старую студию', 'data-open="import"', true)}</div>
        ${current ? `<div class="actions">${actionFor('Экспортировать шаблон', 'export-mode', 'template')}${actionFor('Экспортировать снимок', 'export-mode', 'snapshot')}</div>` : ''}
      </div></section></div>`;
}

function dialogTo(title, body, submitLabel, submit, { adjustable = false } = {}) {
  opener = dialog.open ? opener : document.activeElement;
  taskDialog = undefined;
  submission = submit;
  $('#dialog-title').textContent = title;
  $('#dialog-body').innerHTML = body;
  $('#dialog-actions').innerHTML = button(submit ? 'Отмена' : 'Закрыть', 'data-close', true) +
    (submit ? `<button type="submit" class="action">${safe(submitLabel)}</button>` : '');
  dialogError();
  configureDialogSize(adjustable);
  $('#dialog-body').scrollTop = 0;
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

const weekdays = [[1, 'Пн'], [2, 'Вт'], [3, 'Ср'], [4, 'Чт'], [5, 'Пт'], [6, 'Сб'], [0, 'Вс']];
const defaultSchedule = { enabled: false, days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' };

function scheduleLabel(schedule) {
  if (!schedule?.enabled) return 'Выключено';
  return [weekdays.filter(([day]) => schedule.days.includes(day)).map(([, label]) => label).join(', '),
    `${schedule.start}–${schedule.end}`, schedule.end < schedule.start ? 'до следующего дня' : ''].filter(Boolean).join(' · ');
}

function scheduleEditor() {
  const current = studio();
  const schedule = current.schedule ?? defaultSchedule;
  const days = weekdays.map(([day, label]) => `<label class="checkbox-field"><input type="checkbox" name="day-${day}"${schedule.days.includes(day) ? ' checked' : ''}> <span>${label}</span></label>`).join('');
  dialogTo('Расписание студии',
    `<label class="checkbox-field"><input type="checkbox" name="schedule-enabled"${schedule.enabled ? ' checked' : ''}> <span>Запускать задачи по расписанию</span></label>
     <fieldset class="export-files"><legend>Дни запуска</legend><div class="schedule-days">${days}</div></fieldset>
     <div class="schedule-times">${input('Начало', 'start', schedule.start, 'type="time" required')}${input('Конец', 'end', schedule.end, 'type="time" required')}</div>
     <p class="muted">Время местное. Если конец раньше начала, окно продолжается на следующий день. Вне окна новые задачи ждут, а запущенные завершаются. Для работы по расписанию Hearth должен быть запущен.</p>`,
    'Сохранить расписание', values => bridge.request('updateStudio', {
      studioId: current.id,
      schedule: {
        enabled: Boolean(values['schedule-enabled']),
        days: weekdays.filter(([day]) => values[`day-${day}`]).map(([day]) => day),
        start: values.start,
        end: values.end,
      },
    }));
}

function deleteStudioEditor() {
  const current = studio();
  dialogTo('Удалить студию',
    `<p>Задачи, планы и история студии «${safe(current.name)}» будут удалены из Hearth. Папка проекта и её файлы сохранятся.</p><p class="muted">Для подтверждения введите название студии.</p>` +
    input('Название студии', 'confirmation', '', 'required autocomplete="off"'),
    'Удалить студию', async ({ confirmation }) => {
      await bridge.request('deleteStudio', { studioId: current.id, confirmation });
      selectStudio(null);
      view = 'overview';
      notice('Студия удалена из Hearth.');
    });
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

function newStudio() {
  const step = (number, fields) => `<section class="form-body" data-wizard-step="${number}"${number ? ' hidden' : ''}>
    <h3>${wizardNames[number]}</h3>${fields}</section>`;
  dialogTo('Новая студия',
    '<ol class="wizard-progress" aria-label="Шаги настройки">' +
    wizardNames.map((name, index) => `<li${index === 0 ? ' aria-current="step"' : ''}>${name}</li>`).join('') + '</ol>' +
    step(0, input('Название студии', 'name', '', 'required maxlength="120"') +
      textarea('Что должно получиться?', 'brief', '', 'required placeholder="Опишите работу своими словами"') +
      input('Для кого?', 'audience', '', 'placeholder="Кому предназначен результат"') +
      input('Какой первый результат хотите увидеть?', 'firstResult', '', 'placeholder="Например, черновик, прототип или первая подборка"')) +
    step(1, pathField() + '<p class="muted">Выберите существующую папку или создайте новую в окне выбора.</p>' +
      languageField('Язык отчётов', 'language', 'Русский') +
      languageField('Язык материалов проекта', 'projectLanguage', '', true)) +
    step(2, select('Подключение директора', 'runtime',
      Object.entries(runtimeNames).map(([id, label]) => option(id, label, 'codex')).join('')) +
      '<div id="wizard-provider" class="stack compact" role="status"></div>' +
      '<p class="muted">Для запуска нужно рабочее подключение. Черновик можно сохранить в любом случае.</p>'),
    'Создать студию', async ({ brief, audience, firstResult, runtime, ...values }) => {
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
  const agents = (current.agents ?? []).filter(agent => agent.systemRole !== 'coach');
  const choices = [option('', 'Директор', agentId), ...agents.map(agent => option(String(agent.id), nameFor(agent), agentId))].join('');
  dialogTo('Новая задача', input('Название', 'title', '', 'required maxlength="160"') +
    textarea('Что нужно сделать', 'prompt', '', 'required') + select('Исполнитель', 'agentId', choices),
    'Создать и запустить', async ({ agentId: raw, ...values }) => {
      const agent = agents.find(item => same(item.id, raw));
      const task = await bridge.request('createTask', { studioId: current.id, ...values, ...(agent ? { agentId: agent.id } : {}) });
      try {
        const queued = await bridge.request('startTask', { taskId: task.id });
        if (pendingDependencies(queued, new Map(tasks().map(item => [item.id, item]))).length) {
          await refresh();
          openTask(queued);
          return false;
        }
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
  const allTasks = tasks();
  const dependencies = pendingDependencies(latest, new Map(allTasks.map(item => [item.id, item])));
  const current = studio();
  const canStartTraining = latest.kind === 'train' && !latest.sprintId && latest.status === 'queued' &&
    !current.manualPaused && !allTasks.some(task => task.status === 'running') && ['draft', 'idle', 'active'].includes(current.lifecycle);
  const canRun = dependencies.every(task => task.kind === 'train') &&
    (canStartTraining || !latest.workflowManaged && ['failed', 'interrupted', 'queued'].includes(latest.status));
  const startLabel = latest.kind === 'train' ? 'Запустить обучение' : dependencies.length ? 'Запустить после обучения'
    : latest.status === 'queued' ? 'Запустить' : 'Запустить снова';
  const needsWorktreeReview = latest.legacyWorktreeReview === true;
  const artifact = typeof latest.artifact === 'object' && latest.artifact
    ? JSON.stringify(latest.artifact, null, 2) : latest.artifact;
  const block = (label, value) => value ? `<section class="inline-result"><h3>${label}</h3>${plain(value)}</section>` : '';
  const isOpen = taskDialog?.id === latest.id;
  const previousScroll = $('#dialog-body').scrollTop;
  const epic = taskEpic(latest);
  const attempts = (state.attempts ?? []).filter(attempt => attempt.taskId === latest.id).slice(-10).reverse();
  const purposes = { task: 'Исполнение', review: 'Ревью', director: 'Решение директора', publish: 'Запись файла', 'training-exercise': 'Упражнение' };
  const previousFocus = dialog.contains(document.activeElement) ? Object.entries(document.activeElement.dataset)[0]?.[0] : '';
  dialogTo(latest.title, `<div class="row">${needsWorktreeReview ? badge('Ждёт сверки рабочего дерева', 'warn') : status(latest)}<span class="muted">${safe(nameFor(taskAgent(latest)))}</span></div>` +
    (epic ? `<div class="actions">${actionFor('К эпику', 'epic-link', epic.id)}<span class="muted">${safe(epic.title)}</span></div>` : '') +
    renderTrainingDetails(latest, studio(), allTasks) +
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
        : actionFor(startLabel, 'start-task', latest.id, false) : ''}
      ${canCancel ? actionFor('Отменить задачу', 'cancel-task', latest.id) : ''}
    </div>`, undefined, undefined, { adjustable: true });
  taskDialog = latest;
  if (isOpen && previousFocus) Array.from(dialog.querySelectorAll('button')).find(node => Object.hasOwn(node.dataset, previousFocus))?.focus();
  if (isOpen) $('#dialog-body').scrollTop = previousScroll;
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
    }) : undefined, { adjustable: question || (item.body?.length ?? 0) > 240 });
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
    pending ? ({ answer }) => send(revise ? 'revise' : 'approve', answer) : undefined, { adjustable: true });
}

const listText = value => Array.isArray(value) ? value.join('\n') : value;

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
      `<li><strong>${safe(nameFor(agent))}</strong>${secondaryTitle(agent) ? `<span class="muted"> · ${safe(secondaryTitle(agent))}</span>` : ''}
        <div>${safe(agent.description || roleDetails[agent.role] || '')}</div>
        ${planAgentModelSummary(agent, plan.kind === 'initial')}</li>`).join('')}</ul></section>` : ''}
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

function planAgentModelSummary(agent, showMode = true) {
  const mode = agent.mode ?? 'dynamic';
  const summary = config => configText({ ...config, effort: config.effort || 'усилие по умолчанию' });
  return (showMode ? `<p class="muted">${safe(modeNames[mode])}${mode === 'fixed' ? ` · ${safe(summary(agent))}` : ''}</p>` : '')
    + (agent.recommendation ? `<p class="muted">Предложение директора на первый спринт: ${safe(summary(agent.recommendation))}</p>` : '');
}

function openPlan(plan, revise = false) {
  const pending = plan.status === 'pending';
  dialogTo(plan.title || (plan.kind === 'initial' ? 'План инициализации' : 'План спринта'),
    planBody(plan) + (pending
      ? (revise ? textarea('Что изменить в плане?', 'feedback', '', 'required') : '') + autonomyHint()
      : ''),
    revise && pending ? 'Отправить на доработку' : undefined, revise && pending ? ({ feedback }) =>
      bridge.request('decidePlan', { planId: plan.id, decision: 'revise', feedback }) : undefined, { adjustable: true });
  if (pending && !revise) $('#dialog-actions').insertAdjacentHTML('beforeend',
    (plan.kind === 'initial' && plan.agents?.length ? actionFor('Изменить состав', 'edit-plan-team', plan.id) : '') +
    actionFor('Вернуть на доработку', 'revise-plan', plan.id) + actionFor('Подтвердить и запустить', 'approve-plan', plan.id, false));
}

function teamEffortOptions(choice, selected) {
  return (choice?.efforts ?? []).map(value => option(value, value || 'По умолчанию', selected)).join('');
}

function updateTeamModel(row, { chooseEffort = false } = {}) {
  const mode = row.querySelector('[data-plan-mode]').value;
  const choices = fixedModelChoices(studioAllowed(studio()));
  const model = row.querySelector('[data-plan-model]');
  const effort = row.querySelector('[data-plan-effort]');
  const choice = choices.find(item => modelKey(item) === model.value);
  if (chooseEffort) {
    const suggested = model.value === row.dataset.recommendedModel ? row.dataset.recommendedEffort : undefined;
    effort.innerHTML = teamEffortOptions(choice, suggested);
  }
  row.querySelector('[data-plan-fixed]').hidden = mode !== 'fixed';
  row.querySelector('[data-plan-dynamic]').hidden = mode !== 'dynamic';
}

function planTeamEditor(plan) {
  if (plan.kind !== 'initial' || plan.status !== 'pending' || !plan.agents?.length) return;
  const choices = fixedModelChoices(studioAllowed(studio()));
  const body = plan.agents.map((agent, index) => {
    const key = agent.key ?? agent.id;
    const mode = agent.mode ?? 'dynamic';
    const recommendation = agent.recommendation;
    const requested = mode === 'fixed' ? agent : recommendation;
    const matching = requested && choices.find(item => modelKey(item) === modelKey(requested));
    const valid = matching?.efforts.includes(requested?.effort ?? '');
    const model = valid ? modelKey(matching) : '';
    return `<fieldset class="inline-result stack compact policy-row" data-plan-agent="${safe(key)}"
      data-recommended-model="${safe(recommendation ? modelKey(recommendation) : '')}"
      data-recommended-effort="${safe(recommendation?.effort)}">
      <legend>${safe(nameFor(agent))}</legend>
      ${agent.description ? `<p>${safe(agent.description)}</p>` : ''}
      ${planAgentModelSummary(agent, false)}
      ${agent.systemRole === 'coach' ? '' : `<div class="policy-controls">
        ${input('Название роли', `plan-title-${index}`, agent.roleTitle, `data-plan-role-title maxlength="120" placeholder="${safe(roleNames[agent.role] ?? '')}"`)}
        ${input('Имя (необязательно)', `plan-name-${index}`, agent.name, 'data-plan-name maxlength="120"')}
      </div>`}
      <label class="field"><span>Выбор модели</span><select name="plan-mode-${index}" data-plan-mode>${Object.entries(modeNames)
        .map(([id, label]) => option(id, label, mode)).join('')}</select></label>
      <p class="muted" data-plan-dynamic${mode === 'dynamic' ? '' : ' hidden'}>${choices.length ? 'Для первого спринта действует предложение директора, пока оно в разрешённом списке. Для остальных задач директор выбирает модель и усилие отдельно.'
        : emptyPolicy}</p>
      <div class="policy-controls" data-plan-fixed${mode === 'fixed' ? '' : ' hidden'}>
        <label class="field"><span>Модель</span><select name="plan-model-${index}" data-plan-model>
          ${option('', choices.length ? 'Выберите модель' : 'Список моделей пуст', model)}
          ${choices.map(item => option(modelKey(item), `${runtimeName(item.runtime)} · ${item.model}`, model)).join('')}</select></label>
        <label class="field"><span>Усилие</span><select name="plan-effort-${index}" data-plan-effort>${teamEffortOptions(valid ? matching : undefined,
          requested?.effort ?? '')}</select></label>
        ${mode === 'fixed' && !valid ? '<p class="muted">Ранее выбранное сочетание больше не разрешено. Выберите другое или измените режим.</p>' : ''}
      </div>
    </fieldset>`;
  }).join('');
  dialogTo('Состав команды', `<div class="policy-team"><p>Изменения сохраняются в плане. Команда начнёт работу после его утверждения.</p>${body}</div>`,
    'Сохранить состав', async () => {
      const currentChoices = fixedModelChoices(studioAllowed(studio()));
      const agents = [...form.querySelectorAll('[data-plan-agent]')].flatMap((row, index) => {
        const current = plan.agents[index];
        const value = selector => row.querySelector(selector).value.trim();
        const key = current.key ?? current.id;
        const mode = value('[data-plan-mode]');
        const edits = {};
        const set = (field, value, previous = '') => { if (value !== (current[field] ?? previous)) edits[field] = value; };
        set('mode', mode, 'dynamic');
        if (current.systemRole !== 'coach') {
          set('roleTitle', value('[data-plan-role-title]'));
          set('name', value('[data-plan-name]'));
        }
        if (mode === 'fixed') {
          const choice = currentChoices.find(item => modelKey(item) === value('[data-plan-model]'));
          const effort = value('[data-plan-effort]');
          if (!choice || !choice.efforts.includes(effort)) {
            row.querySelector('[data-plan-model]').focus();
            throw new Error('Для фиксированного режима выберите разрешённую модель и усилие.');
          }
          set('runtime', choice.runtime);
          set('model', choice.model);
          set('effort', effort);
        }
        return Object.keys(edits).length ? [{ key, ...edits }] : [];
      });
      const updated = agents.length ? await bridge.request('updatePlanAgents', { planId: plan.id, agents }) : planById(String(plan.id));
      openPlan(updated ?? plan);
      return false;
    }, { adjustable: true });
  $('#dialog-actions [data-close]').outerHTML = actionFor('Назад к плану', 'cancel-plan-team', plan.id);
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

function skillSettingsEditor() {
  const current = studio();
  dialogTo('Порог поиска навыков', input('Минимум звёзд на GitHub', 'skillMinStars', skillMinStars(current),
    'type="number" min="0" step="1" required'), 'Сохранить', async values => {
    const threshold = Number(values.skillMinStars);
    if (!Number.isSafeInteger(threshold) || threshold < 0) throw new Error('Введите целое число звёзд от 0.');
    await bridge.request('updateStudio', { studioId: current.id, skillMinStars: threshold });
    if (studio()?.id === current.id) skillSearch = { topics: skillSearch.topics, preview: {} };
  });
}

const studioPolicyMode = current => current.allowedMode ?? (current.allowed?.length ? 'studio' : 'app');
const studioAllowed = current => current.effectiveAllowed ??
  (studioPolicyMode(current) === 'studio' ? current.allowed : state.modelPolicy?.allowed) ?? [];
const emptyPolicy = 'Список пуст. При автоматическом выборе роли используют модель и усилие директора.';

function policySummary(entries) {
  return entries?.length ? `<ul class="policy-list">${entries.map(entry => `<li>${safe([runtimeName(entry.runtime), entry.model,
    entry.efforts?.join(', ') || 'усилие по умолчанию'].filter(Boolean).join(' · '))}</li>`).join('')}</ul>`
    : `<p class="muted">${emptyPolicy}</p>`;
}

function policyRow(entry = { runtime: 'codex', model: '', efforts: [] }) {
  const id = ++policyRowId;
  return `<fieldset class="inline-result stack compact policy-row" data-policy-row>
    <legend>Разрешённая модель</legend>
    <div class="policy-controls">${select('Подключение', `policy-runtime-${id}`,
      Object.entries(runtimeNames).map(([key, label]) => option(key, label, entry.runtime)).join(''))}
      ${input('Модель', `policy-model-${id}`, entry.model, `data-policy-model list="policy-catalog-${id}" autocomplete="off"`)}
      ${datalist(`policy-catalog-${id}`, providerState[entry.runtime]?.models ?? [])}</div>
    <div class="stack compact"><strong>Разрешённые усилия</strong>
      <div class="policy-efforts" data-policy-efforts>${policyEffortOptions(entry.runtime, entry.model, entry.efforts)}</div>
      <p class="muted">Если ничего не выбрать, используется усилие по умолчанию.</p></div>
    <div class="actions">${button('Загрузить подсказки моделей', 'data-policy-inspect', true)}
      ${button('Убрать модель', 'data-policy-remove', true)}</div>
    <p class="muted" data-policy-provider role="status">${safe(policyProviderLabel(entry.runtime))}</p>
  </fieldset>`;
}

function policyEffortOptions(runtime, model, selected = [], preserve = true) {
  const supported = catalogEfforts(runtime, model, providerState[runtime]);
  return [...new Set([...supported, ...(preserve ? selected : [])])].map(effort =>
    `<label class="checkbox-field"><input data-policy-effort type="checkbox" value="${safe(effort)}"${selected.includes(effort) ? ' checked' : ''}> <span>${safe(effort)}</span></label>`).join('');
}

function policyProviderLabel(runtime) {
  const info = providerState[runtime];
  if (inspecting.has(runtime)) return 'Загружаем каталог…';
  if (info?.models?.length) return 'Выберите модель из подсказок поля или введите идентификатор.';
  return info ? info.detail || 'Каталог недоступен. Можно ввести идентификатор модели.'
    : 'Можно загрузить подсказки подключения или ввести идентификатор модели.';
}

function policyRowValues(row) {
  return {
    runtime: row.querySelector('select').value,
    model: row.querySelector('[data-policy-model]').value.trim(),
    efforts: [...row.querySelectorAll('[data-policy-effort]:checked')].map(item => item.value),
  };
}

function updatePolicyRow(row, { preserve = true, updateCatalog = true } = {}) {
  const { runtime, model, efforts } = policyRowValues(row);
  if (updateCatalog) row.querySelector('datalist').innerHTML = (providerState[runtime]?.models ?? [])
    .map(item => option(item.id, item.name)).join('');
  row.querySelector('[data-policy-efforts]').innerHTML = policyEffortOptions(runtime, model, efforts, preserve);
  row.querySelector('[data-policy-provider]').textContent = policyProviderLabel(runtime);
}

function syncPolicyEditor() {
  const editor = $('[data-policy-editor]');
  if (!editor) return;
  const own = !form.elements.allowedMode || form.elements.allowedMode.value === 'studio';
  const hasRows = !!editor.querySelector('[data-policy-row]');
  editor.querySelector('[data-policy-own]').hidden = !own;
  const inherited = editor.querySelector('[data-policy-inherited]');
  if (inherited) inherited.hidden = own;
  editor.querySelector('[data-policy-empty-hint]').hidden = hasRows;
  const emptyButton = $('[data-policy-empty]');
  if (emptyButton) {
    emptyButton.hidden = hasRows;
    $('#dialog-actions button[type="submit"]:not([data-policy-empty])').hidden = !hasRows;
  }
}

function policyEditor(current, first = false) {
  const entries = current ? current.allowed : state.modelPolicy?.allowed;
  const mode = current && studioPolicyMode(current);
  dialogTo(first ? 'Разрешённые модели для студий' : current ? 'Разрешённые модели студии' : 'Разрешённые модели приложения',
    `<div class="policy-editor" data-policy-editor="${current ? 'studio' : 'app'}">
      <p>${current ? 'Выберите, какой список директор будет использовать для ролей с автоматическим выбором.'
        : 'Задайте модели и усилия, из которых директор может выбирать для ролей в студиях.'}</p>
      ${current ? select('Список разрешённых моделей', 'allowedMode',
        option('app', 'Использовать список приложения', mode) + option('studio', 'Использовать свой список студии', mode)) +
        `<div data-policy-inherited>${policySummary(state.modelPolicy?.allowed)}</div>` : ''}
      <div class="policy-editor" data-policy-own>
        <p class="muted" data-policy-empty-hint>${emptyPolicy}</p>
        <div class="policy-editor" data-policy-rows>${(entries ?? []).map(policyRow).join('')}</div>
        <div>${button('Добавить модель', 'data-policy-add', true)}</div>
      </div>
    </div>`, 'Сохранить список', ({ allowedMode }) => {
      const rows = () => readPolicyRows([...form.querySelectorAll('[data-policy-row]')].map(policyRowValues));
      if (current) return bridge.request('updateStudio', { studioId: current.id, allowedMode,
        ...(allowedMode === 'studio' ? { allowed: rows() } : {}) });
      return bridge.request('updateModelPolicy', { allowed: rows() });
    }, { adjustable: true });
  if (first) $('#dialog-actions').insertAdjacentHTML('beforeend',
    '<button type="submit" class="action" data-policy-empty>Оставить список пустым</button>');
  syncPolicyEditor();
}

function maybePromptModelPolicy() {
  if (!ready || dialog.open || dialogBusy || policyPromptShown || state.modelPolicy?.configured !== false) return;
  policyPromptShown = true;
  policyEditor(undefined, true);
}

function agentEditor(agent) {
  const current = studio();
  const isCoach = agent?.systemRole === 'coach';
  const mode = agent?.mode ?? 'dynamic';
  const role = agent?.role === 'director' ? 'other' : agent?.role ?? 'other';
  const restricted = state.modelPolicy?.configured === true || studioPolicyMode(current) === 'studio';
  const choices = restricted ? fixedModelChoices(studioAllowed(current)) : [];
  const currentEffort = agent?.effort ?? '';
  const currentChoice = agent && choices.find(item => item.model === agent.model &&
    item.runtime === (agent.runtime || current.director.runtime) && item.efforts.includes(currentEffort));
  const fixedOptions = restricted
    ? select('Модель', 'agent-model', option('', choices.length ? 'Выберите из разрешённых' : 'Список моделей пуст') +
      choices.map(item => option(modelKey(item), `${runtimeName(item.runtime)} · ${item.model}`, currentChoice && modelKey(currentChoice))).join('')) +
      select('Усилие', 'agent-effort', teamEffortOptions(currentChoice, currentEffort)) +
      (!choices.length ? '<p class="muted">Добавьте модель в список студии или выберите режим «Выбирает директор».</p>' : '')
    : runtimeFields(agent, effortField(agent));
  const roleChoices = Object.entries(roleNames).filter(([id]) => id !== 'director')
    .map(([id, name]) => option(id, name, role)).join('');
  const roleFields = isCoach ? '' : input('Имя (необязательно)', 'name', agent?.name, 'maxlength="120"') +
    input('Название роли (необязательно)', 'roleTitle', agent?.roleTitle, 'maxlength="120"') + select('Категория роли', 'role', roleChoices) +
    `<p id="role-guide" class="muted">${safe(roleDetails[role])}</p>` + textarea('Назначение роли', 'description', agent?.description);
  dialogTo(isCoach ? coachTitle : agent ? 'Настроить агента' : 'Новый агент', roleFields +
    (agent ? '' : input('Темы обучения на GitHub (необязательно)', 'trainingTopics', '', 'placeholder="Через запятую"')) +
    select('Выбор модели', 'mode', Object.entries(modeNames).map(([id, name]) => option(id, name, mode)).join('')) +
    `<div class="form-body" id="fixed-options"${mode === 'fixed' ? '' : ' hidden'}>${fixedOptions}</div>
      <p class="muted" id="dynamic-options"${mode === 'dynamic' ? '' : ' hidden'}>Директор выбирает модель и усилие для задачи из разрешённого списка студии. Если список пуст, действуют настройки директора.</p>`,
    'Сохранить агента', ({ name, roleTitle, role, mode, description, trainingTopics, ...config }) => {
      let fixed = {};
      if (mode === 'fixed' && restricted) {
        const choice = fixedModelChoices(studioAllowed(studio())).find(item => modelKey(item) === config['agent-model']);
        const effort = config['agent-effort'] ?? '';
        if (!choice?.efforts.includes(effort)) throw new Error('Выберите разрешённую модель и усилие для агента.');
        fixed = { runtime: choice.runtime, model: choice.model, effort };
      } else if (mode === 'fixed') {
        if (!config.model) throw new Error('Укажите фиксированную модель.');
        fixed = modelConfig(config);
      }
      const payload = { studioId: current.id, ...(!isCoach && { name, roleTitle, role, description }), mode, ...fixed };
      return bridge.request(agent ? 'updateAgent' : 'addAgent', agent ? { ...payload, agentId: agent.id }
        : { ...payload, trainingTopics: parseSkillTopics(trainingTopics) });
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
  const policyRows = () => [...form.querySelectorAll('[data-policy-row]')]
    .filter(row => policyRowValues(row).runtime === runtime);
  policyRows().forEach(row => { row.querySelector('[data-policy-provider]').textContent = policyProviderLabel(runtime); });
  try {
    providerState[runtime] = await bridge.request('inspect', { runtime });
  } catch (error) {
    providerState[runtime] = { available: false, detail: error.message || 'Проверка подключения не удалась.' };
  } finally {
    inspecting.delete(runtime);
    render();
    updateWizardProvider();
    policyRows().forEach(row => updatePolicyRow(row));
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
  'delete-studio': deleteStudioEditor,
  'project-folder': () => void workCommand('openProject', { studioId: studio().id }),
  schedule: scheduleEditor,
  task: () => taskEditor(),
  director: directorEditor,
  'app-model-policy': () => policyEditor(),
  'studio-model-policy': () => policyEditor(studio()),
  'skill-settings': skillSettingsEditor,
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
  else if (data.policyAdd !== undefined) {
    const rows = $('[data-policy-rows]');
    rows.insertAdjacentHTML('beforeend', policyRow());
    syncPolicyEditor();
    rows.lastElementChild.querySelector('[data-policy-model]').focus();
  } else if (data.policyRemove !== undefined) {
    target.closest('[data-policy-row]').remove();
    syncPolicyEditor();
    $('[data-policy-add]').focus();
  } else if (data.policyInspect !== undefined) {
    void inspect(policyRowValues(target.closest('[data-policy-row]')).runtime);
  } else if (data.wizardNext !== undefined) moveWizard(1);
  else if (data.wizardBack !== undefined) moveWizard(-1);
  else if (data.view) route(data.view);
  else if (data.workPane) {
    workTab = data.workPane;
    route('work');
  }
  else if (data.epicLink !== undefined) showEpic(data.epicLink);
  else if (data.workTab) {
    workTab = data.workTab;
    render();
  } else if (data.open) commands[data.open]?.();
  else if (data.initialize !== undefined) void workCommand('initializeStudio', { studioId: studio().id });
  else if (data.runAction) void workCommand('setStudioRunning', { studioId: studio().id, action: data.runAction });
  else if (data.editPlanTeam !== undefined) {
    const plan = planById(data.editPlanTeam);
    if (plan) planTeamEditor(plan);
  } else if (data.plan !== undefined || data.revisePlan !== undefined || data.cancelPlanTeam !== undefined) {
    const plan = planById(data.plan ?? data.revisePlan ?? data.cancelPlanTeam);
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
    maybePromptModelPolicy();
  }
});

form.addEventListener('change', ({ target }) => {
  if (target.name === 'allowedMode') syncPolicyEditor();
  if (target.name.startsWith('policy-runtime-')) {
    const row = target.closest('[data-policy-row]');
    row.querySelector('[data-policy-model]').value = '';
    row.querySelectorAll('[data-policy-effort]:checked').forEach(option => { option.checked = false; });
    updatePolicyRow(row, { preserve: false });
  }
  const teamRow = target.closest('[data-plan-agent]');
  if (teamRow && (target.matches('[data-plan-mode]') || target.matches('[data-plan-model]'))) {
    updateTeamModel(teamRow, { chooseEffort: target.matches('[data-plan-model]') });
  }
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
  if (target.name === 'agent-model') {
    const choice = fixedModelChoices(studioAllowed(studio())).find(item => modelKey(item) === target.value);
    form.elements['agent-effort'].innerHTML = teamEffortOptions(choice);
  }
  if ((target.name === 'runtime' || target.name === 'model') && $('#model-catalog')) {
    const models = providerState[form.elements.runtime.value]?.models ?? [];
    $('#model-catalog').innerHTML = models.map(item => option(item.id, item.name)).join('');
    if ($('#effort-catalog')) {
      $('#effort-catalog').innerHTML = catalogEfforts(form.elements.runtime.value, form.elements.model.value,
        providerState[form.elements.runtime.value]).map(value => option(value)).join('');
    }
  }
});

form.addEventListener('input', ({ target }) => {
  if (target.matches('[data-policy-model]')) updatePolicyRow(target.closest('[data-policy-row]'), { preserve: false, updateCatalog: false });
});

content.addEventListener('change', ({ target }) => {
  if (target.name === 'approveSprints') void workCommand('updateStudio', { studioId: studio().id, approveSprints: target.checked });
});
content.addEventListener('input', ({ target }) => {
  if (target.matches('[data-skill-search] [name="topics"]')) skillSearch.topics = target.value;
});
content.addEventListener('submit', event => {
  if (!event.target.matches('[data-skill-search]')) return;
  event.preventDefault();
  void searchSkills();
});
content.addEventListener('toggle', ({ target }) => {
  if (target.id === 'advanced' && target.isConnected) advancedOpen = target.open;
  if (target.isConnected && target.dataset.epicSection) {
    if (target.open) expandedEpics.add(target.dataset.epicSection);
    else expandedEpics.delete(target.dataset.epicSection);
  }
}, true);

dialog.addEventListener('cancel', event => { if (dialogBusy) event.preventDefault(); });
dialog.addEventListener('close', () => {
  taskDialog = undefined;
  if (opener?.isConnected) opener.focus();
  else content.focus();
  maybePromptModelPolicy();
  if (notificationTarget && !dialog.open) void goToNotification();
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
