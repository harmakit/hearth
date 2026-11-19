import { agentActivity, actorState, buildRooms, languageChoices, pendingStudioPlan, roleDetails, roleNames, taskForAgent } from './workshop.mjs';
import { paintRooms } from './room-art.mjs';
import { publishedPaths, renderWork } from './work-view.mjs';
import { installDialogSize } from './dialog-size.mjs';
import { catalogEfforts, fixedModelChoices, modelKey } from './model-policy.mjs';
import { createModelCatalogEditor } from './model-catalog-editor.mjs';
import { renderWorkspaceHome } from './workspace-view.mjs';
import { coachTitle, parseSkillTopics, pendingDependencies, renderSkillLibrary, renderSkillPreview, renderTrainingDetails, roleReadiness, skillMinStars, skillStarLabel } from './coach-view.mjs';
import { debtPolicyFields, debtPolicyFor, debtPolicyHint, improvementsHelp, renderDebtSettings } from './debt-view.mjs';
import { answerPayload, questionOptions, renderDelivery, renderDiagnostic, renderEvidence, renderQuestionDetails, renderUsageReport } from './legacy-view.mjs';

const bridge = window.hearth;
const $ = selector => document.querySelector(selector);
const content = $('#content');
const dialog = $('#dialog');
const form = $('#dialog-form');
const configureDialogSize = installDialogSize(dialog, () => stored('dialog-size'), value => stored('dialog-size', value));
const runtimeNames = { codex: 'Codex', claude: 'Claude Code' };
const modeNames = { inherit: 'Как у директора', fixed: 'Фиксированные модель и усилие', dynamic: 'Выбирает директор' };
const workspaceViews = { workspace: 'Все студии', 'app-settings': 'Настройки приложения' };
const studioViews = { overview: 'Обзор', work: 'Работа', inbox: 'Входящие', workshop: 'Мастерская', skills: 'Библиотека', settings: 'Настройки студии' };
const views = { ...workspaceViews, ...studioViews };
const icons = {
  workspace: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18m-12 0v10"/>',
  'app-settings': '<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/>',
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
let view = 'workspace';
let inboxScope = 'open';
let selectedAgent = '';
let ready = false;
let snapshotVersion = 0;
let submission;
let dialogBusy = false;
let opener;
let taskDialog;
let dialogMeeting;
let dialogConversation;
let notificationTarget;
let openingNotification = false;
let workBusy = false;
let workTab;
const expandedEpics = new Set();
let advancedOpen = false;
let catalogEditor;
let skillSearch = { topics: '', preview: {} };
const debtAssessments = new Map();
const legacyPreviews = new Map();
const studioRows = key => (state[key] ?? []).filter(item => String(item.studioId) === studioId);
const operationId = () => crypto.randomUUID();
const lines = value => String(value ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
const checkbox = (label, name, checked) => `<label class="checkbox-field"><input type="checkbox" name="${safe(name)}"${checked ? ' checked' : ''}> <span>${safe(label)}</span></label>`;
const rowAction = (title, detail, actions) => `<div class="row settings-row legacy-row"><div><h3>${safe(title)}</h3><p class="muted">${safe(detail)}</p></div><div class="actions">${actions}</div></div>`;
const fieldHint = text => `<p class="field-hint">${safe(text)}</p>`;
const studioDate = value => Number.isFinite(new Date(value ?? '').getTime()) ? new Date(value).toLocaleString('ru-RU') : '';

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
const select = (label, name, options) => `<label class="field"><span>${safe(label)}</span><select name="${safe(name)}">${options}</select></label>`;
const input = (label, name, value = '', attrs = '') => `<label class="field"><span>${safe(label)}</span><input name="${safe(name)}" value="${safe(value)}" ${attrs}></label>`;
const textarea = (label, name, value = '', attrs = '') => `<label class="field"><span>${safe(label)}</span><textarea name="${safe(name)}" rows="4" ${attrs}>${safe(value)}</textarea></label>`;
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
    const previousEvidence = taskDialog && JSON.stringify(studioRows('evidence').filter(row => row.taskId === taskDialog.id));
    state = snapshot;
    if (snapshot.providers) Object.assign(providerState, snapshot.providers);
    catalogEditor?.updateProviders(providerState);
    if (!studio()) selectStudio(snapshot.studios[0]?.id);
    ready = true;
    render();
    updateWizardProvider();
    if (dialog.open && !dialogBusy && taskDialog) {
      const latest = snapshot.tasks.find(task => task.id === taskDialog.id);
      if (latest && (JSON.stringify(latest) !== JSON.stringify(taskDialog) ||
          previousTraining !== renderTrainingDetails(latest, studio(), tasks()) ||
          previousEvidence !== JSON.stringify(studioRows('evidence').filter(row => row.taskId === latest.id)))) openTask(latest);
    } else if (dialog.open && !dialogBusy && dialogMeeting) {
      const latest = studioRows('meetings').find(row => row.id === dialogMeeting.id);
      if (latest && JSON.stringify(latest) !== JSON.stringify(dialogMeeting)) {
        const scroll = $('#dialog-body').scrollTop;
        meetingDetail(latest);
        $('#dialog-body').scrollTop = scroll;
      }
    } else if (dialog.open && dialogConversation) {
      const thread = studioRows('conversations').find(row => (row.agentId ?? null) === dialogConversation.agentId &&
        (row.taskId ?? null) === dialogConversation.taskId);
      const agent = studio().agents?.find(row => row.id === dialogConversation.agentId);
      const region = $('[data-message-history]');
      const markup = messageHistoryMarkup(thread, agent);
      if (region && region.innerHTML !== markup) region.innerHTML = markup;
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
  const inStudio = Object.hasOwn(studioViews, view);
  const picker = $('#studio-select');
  const focused = document.activeElement;
  const focusRoot = [content, $('#navigation'), $('#workspace-navigation')].find(container => container.contains(focused) && focused !== container);
  const focusTarget = focusRoot && Object.entries(focused.dataset).find(([key]) => ['view', 'enterStudio', 'workspaceInbox', 'providerEnabled', 'agent', 'task', 'inbox', 'scope', 'open', 'inspect', 'editAgent', 'plan', 'initialize', 'runAction', 'artifact', 'workTab', 'assessDebt', 'message', 'meetingDetail', 'legacyAction', 'evidence'].includes(key));
  const autonomyFocused = focused?.getAttribute('name') === 'approveSprints';
  const skillFieldSelection = focused?.matches('[data-skill-search] [name="topics"]')
    ? [focused.selectionStart, focused.selectionEnd] : null;
  const libraryDetails = view === 'skills'
    ? new Set(Array.from(content.querySelectorAll('[data-library-detail][open]'), node => node.dataset.libraryDetail)) : null;
  picker.disabled = !state.studios.length;
  picker.innerHTML = state.studios.map(item => option(String(item.id), item.name, studioId)).join('') || '<option>Нет студий</option>';
  $('.studio-controls').hidden = !inStudio || !current;
  const openCount = entries().filter(item => item.status === 'open').length;
  const navigation = group => Object.entries(group).map(([key, label]) => `<button type="button" data-view="${key}"${view === key ? ' aria-current="page"' : ''}>${glyph(key)}<span>${label}</span>${key === 'inbox' && openCount ? `<span class="nav-count">${openCount}</span>` : ''}</button>`).join('');
  $('#workspace-navigation').innerHTML = navigation(workspaceViews);
  $('#navigation').hidden = !inStudio || !current;
  if (inStudio && current) $('#navigation').innerHTML = navigation(studioViews);
  $('#breadcrumb').innerHTML = `<span>${safe(inStudio && current ? current.name : 'Hearth Studio')}</span><span aria-hidden="true">›</span><strong>${views[view]}</strong>`;
  content.innerHTML = view === 'workspace' ? renderWorkspaceHome(state) : view === 'app-settings' ? appSettings() : current
    ? ({ overview, work, inbox, workshop, skills, settings })[view]()
    : heading(views[view]) + empty('Создайте студию', 'Опишите проект, выберите рабочую папку и подключение директора.', button('Создать студию', 'data-open="studio"'));
  if (view === 'workshop' && current) paintRooms(content);
  if (libraryDetails?.size) for (const node of content.querySelectorAll('[data-library-detail]')) {
    node.open = libraryDetails.has(node.dataset.libraryDetail);
  }
  if (focusTarget) {
    const [key, value] = focusTarget;
    Array.from(focusRoot.querySelectorAll('button, input')).find(node => node.dataset[key] === value)?.focus();
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
    phases: rows('phases'),
    evidence: rows('evidence').filter(item => item.kind !== 'attachment'),
  });
}

function skills() {
  const current = studio();
  const rows = key => (state[key] ?? []).filter(item => String(item.studioId) === studioId);
  return heading('Библиотека', current.name, button('Добавить запись', 'data-open="publish-library"') +
    button('Версии и история', 'data-open="library-history"', true)) + renderSkillLibrary({
    studio: current, tasks: tasks(), skills: rows('skills'), knowledge: rows('knowledge'), customSkills: rows('customSkills'),
    knowledgeEvents: rows('knowledgeEvents'), ...skillSearch,
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
  if (!Object.hasOwn(views, next)) return;
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
  const rooms = buildRooms({ ...current, agents: activeRoster(current) });
  const workCount = all.filter(task => ['running', 'queued'].includes(task.status)).length;
  const activeAttempts = current.activeAttempts ?? all.filter(task => task.status === 'running').length;
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
  return heading('Обзор студии', current.name, button('Связь с командой', 'data-open="messages"', true) + (canInitialize ? '' : button('Новая задача', 'data-open="task"')) + runButtons) +
    `<div class="split"><div class="stack">
      ${current.lifecycle || activity || pendingPlan ? `<section class="panel padded stack compact">
        <div class="row"><h2>${canInitialize ? 'Начало работы' : 'Студия'}</h2>${current.scheduleWaiting ? badge('Ждёт рабочего времени', 'warn') :
          manuallyPaused ? badge('На паузе', 'warn') :
          studioStatuses[current.lifecycle] ? badge(...studioStatuses[current.lifecycle]) : ''}</div>
        ${intro}${activity ? `<p class="activity" role="status">${safe(activity)}</p>` : ''}
        <p class="muted">Активные попытки: ${safe(activeAttempts)} из ${safe(current.wipLimit ?? 1)}${current.nextScheduleAt ? ` · Следующее окно: ${safe(studioDate(current.nextScheduleAt))}` : ''}</p>
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
  return `<button type="button" class="list-row" data-task="${safe(task.id)}"><span><strong>${safe(task.title)}</strong><small>${safe(nameFor(taskAgent(task)))}${task.kind === 'debt' ? ' · Улучшение' : ''}</small></span>${status(task)}</button>`;
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
  if (item.kind === 'meeting') return `<article class="panel padded stack compact">
    <div>${badge(item.status === 'open' ? 'Решение встречи' : 'Решение сохранено', item.status === 'open' ? 'warn' : 'good')}</div>
    <h2>${safe(item.title)}</h2>${plain(item.body)}<div>${actionFor('Открыть встречу', 'meeting-detail', item.meetingId, false)}</div></article>`;
  return `<article class="panel padded stack compact">
    <div class="row">${badge(isQuestion ? 'Вопрос' : isAcceptance ? 'Приёмка результата' : 'Ошибка', isQuestion || isAcceptance ? 'warn' : 'attention')}
      <small class="muted">${safe(task?.title)}</small></div>
    <h2>${safe(item.title)}</h2><div class="long-text">${safe(item.body)}</div>${isQuestion && item.version ? `<p class="muted">Версия ${safe(item.version)}</p>` : ''}
    ${item.answer ? `<div class="inline-result"><strong>Ответ</strong>${plain(item.answer)}</div>` : ''}
    <div class="actions">
      ${isQuestion ? actionFor(item.status === 'open' ? 'Ответить' : 'История вопроса', 'inbox', item.id, item.status !== 'open') : ''}
      ${task ? actionFor('Открыть задачу', 'task', task.id) : ''}
      ${item.status === 'open' && isAcceptance ? actionFor('Открыть приёмку', 'inbox', item.id, false) : ''}
      ${item.status === 'open' && !isQuestion && !isAcceptance ? actionFor('Просмотреть ошибку', 'inbox', item.id) : ''}
    </div>
  </article>`;
}

function workshop() {
  const current = studio();
  const rooms = buildRooms({ ...current, agents: activeRoster(current) });
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
      <div class="actions">${job ? actionFor('Открыть задачу', 'task', job.id, false) : ''}${agent.systemRole === 'coach' ? '' : actionFor('Поставить задачу', 'new-task', agent.id ?? '', !!job)}
        ${actionFor('Написать', 'message', agent.id ?? '')}${actionFor('История работы', 'agent-history', agent.id ?? '')}</div>
    </article><section class="stack compact"><h2>Роли</h2><div class="panel work-list">${rooms.flatMap(zone => zone.desks.map(({ agent: person, props }) => renderAgent(person, false, props))).join('')}</div></section></div>`;
}

function providerBadge(id) {
  const info = providerState[id];
  if (inspecting.has(id) || info?.loading) return badge('Проверяем…');
  if (!info) return badge('Не проверен');
  if (info.enabled === false) return badge('Отключён');
  if (!info.available) return badge('Недоступен', 'warn');
  if (info.authenticated === false) return badge('CLI найден · Требуется вход', 'warn');
  return badge(info.authenticated ? 'Вход подтверждён' : 'CLI найден', 'good');
}

function appSettings() {
  const providers = Object.entries(runtimeNames).map(([id, label]) => {
    const info = providerState[id];
    const checking = inspecting.has(id);
    const detail = info ? [info.version, info.detail].filter(Boolean).join(' · ') : '';
    return `<article class="panel padded stack compact"><div class="row"><h3>${label}</h3>
      ${providerBadge(id)}</div>
      ${detail ? `<p class="muted">${safe(detail)}</p>` : ''}
      ${info?.models?.length ? `<p class="muted">Моделей в каталоге: ${info.models.length}</p>` : ''}
      ${info?.authenticated && !info?.models?.length ? '<p class="muted">Подключение не передало каталог. Можно использовать модель по умолчанию или указать идентификатор.</p>' : ''}
      <label class="checkbox-field"><input type="checkbox" data-provider-enabled="${id}"${info?.enabled !== false ? ' checked' : ''}${workBusy ? ' disabled' : ''}> <span>Разрешить запуски через ${label}</span></label>
      <div>${button(checking ? 'Проверяем…' : 'Проверить подключение', `data-inspect="${id}"${checking ? ' disabled' : ''}`, true)}</div>
    </article>`;
  }).join('');
  const theme = document.documentElement.dataset.theme ?? 'system';
  return heading('Настройки приложения', 'Общие параметры для всех студий') +
    `<div class="stack settings"><section class="stack compact"><h2>Подключения</h2><div class="columns">${providers}</div></section>
      <section class="stack compact"><h2>Модели приложения</h2><div class="panel padded stack compact">
        ${rowAction('Политика по умолчанию', state.modelPolicy?.configured
          ? (state.modelPolicy.allowed.length ? `Свой список · ${state.modelPolicy.allowed.length} моделей` : 'Модель и усилие берутся у директора')
          : 'Все обнаруженные модели разрешены. Новые модели добавляются автоматически.',
        button('Открыть каталог', 'data-open="app-model-policy"', true))}
        ${state.modelPolicy?.configured && state.modelPolicy.allowed.length ? policySummary(state.modelPolicy.allowed) : ''}
      </div></section>
      <section class="stack compact"><h2>Интерфейс и уведомления</h2><div class="panel padded stack compact">
        <label class="field"><span>Тема оформления</span><select id="theme-select">
          ${option('system','Системная',theme)}${option('light','Светлая',theme)}${option('dark','Тёмная',theme)}</select></label>
        <label class="checkbox-field"><input type="checkbox" name="appNotifications"${state.notificationPreferences?.enabled !== false ? ' checked' : ''}${workBusy ? ' disabled' : ''}> <span>Показывать системные уведомления</span></label>
        ${fieldHint('При выключении macOS не уведомляет о событиях Hearth. Вопросы и решения остаются во «Входящих».')}
      </div></section>
      <section class="stack compact"><h2>Импорт студий</h2><div class="panel padded stack compact">
        <div class="actions">${button('Импортировать файл Hearth', 'data-open="import-bundle"', true)}${button('Проверить старую студию', 'data-open="import"', true)}</div>
      </div></section>
    </div>`;
}

function settings() {
  const current = studio();
  return heading('Настройки студии', current.name) + `<div class="stack settings">
      <section class="stack compact"><h2>Студия</h2><div class="panel padded stack compact">
        <div class="row"><h3>${safe(current.name)}</h3><div class="actions">${button('Изменить', 'data-open="edit-studio"', true)}${button('Удалить студию', 'data-open="delete-studio"', true)}</div></div>
        ${current.brief ? plain(current.brief) : ''}<dl class="studio-meta"><dt>Рабочая папка</dt><dd>${safe(current.root || 'Не выбрана')}</dd><dt>Язык отчётов</dt><dd>${safe(current.language || 'Не выбран')}</dd>
          ${current.projectLanguage ? `<dt>Язык материалов</dt><dd>${safe(current.projectLanguage)}</dd>` : ''}</dl>
        ${current.root ? `<div>${button('Открыть папку проекта', 'data-open="project-folder"', true)}</div>` : ''}
      </div></section>
      <section class="stack compact" id="autonomy" tabindex="-1"><h2>Автономность</h2><div class="panel padded stack compact">
        <label class="checkbox-field"><input type="checkbox" name="approveSprints"${current.approveSprints !== false ? ' checked' : ''}${workBusy ? ' disabled' : ''}> <span>Согласовывать план спринта</span></label>
        <p class="muted">При инициализации Hearth всегда запрашивает согласование. Настройка применяется к будущим спринтам.</p>
        ${rowAction('Расписание', `${scheduleLabel(current.schedule)} · Запуск новых задач по часам студии`, button('Настроить расписание', 'data-open="schedule"', true))}
        ${rowAction('Одновременные запуски', `${current.wipLimit ?? 1} · ${(current.wipLimit ?? 1) === 1 ? 'Задачи идут по очереди' : 'Независимые рабочие шаги могут идти параллельно'}`, button('Настроить', 'data-open="dispatch"', true))}
        ${rowAction('Подготовка задач к спринту', current.groomingPolicy?.enabled
          ? 'Директор уточняет очередь, когда готовых задач мало и в следующем спринте есть место.'
          : 'Автоматическая подготовка выключена. Разбор очереди можно начать из раздела «Работа».', button('Настроить', 'data-open="grooming-settings"', true))}
      </div></section>
      <section class="stack compact"><h2>Доставка проекта</h2><div class="panel padded stack compact">
        ${rowAction('Репозиторий Git', current.projectGit?.enabled ? current.projectGit.targetRef || 'Управляемая целевая ветка' : 'Git-доставка не подключена.', button('Настроить Git и проверки', 'data-open="project-git"', true))}
        ${current.projectGit?.enabled ? rowAction('Рабочие копии', 'Посмотрите, какие управляемые копии доступны для уборки.', button('Проверить уборку', 'data-open="cleanup"', true)) : ''}
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
      <section class="stack compact"><h2>Состояние и уведомления</h2><div class="panel padded stack compact">
        <div class="actions">${button('Расход моделей', 'data-open="usage"', true)}${button('Диагностика', 'data-open="diagnosis"', true)}${button('Уведомления', 'data-open="notifications"', true)}</div>
      </div></section>
      <details class="panel padded advanced" id="advanced"${advancedOpen ? ' open' : ''}><summary>Расширенные настройки</summary><div class="stack">
      ${renderDebtSettings(current, debtAssessments.get(current.id))}
      <section class="stack compact"><div class="row"><h2>Роли</h2><div class="actions">${button('Предложить найм', 'data-open="roster-hire"')}
        ${button('Лимиты состава', 'data-open="staffing"', true)}${button('Предложения и история', 'data-open="roster-history"', true)}</div></div>
        <div class="panel work-list">${current.agents?.length ? current.agents.map(agent => `<div class="list-row static-row"${agent.systemRole === 'coach' ? ' data-system-role="coach"' : ''}><span><strong>${safe(nameFor(agent))}</strong>
          <small>${safe([secondaryTitle(agent), modeNames[agent.mode], agent.mode === 'fixed' ? configText(agent) : ''].filter(Boolean).join(' · '))}</small>
          ${agent.description ? `<small>${safe(agent.description)}</small>` : ''}
          ${agent.rosterStatus === 'retired' ? badge('Роль выведена') : roleReadiness(agent, tasks(), { showTask: false })}</span>
          <div class="actions">${agent.rosterStatus !== 'retired' ? actionFor('Настроить', 'edit-agent', agent.id) : ''}
            ${agent.systemRole ? '' : actionFor(agent.rosterStatus === 'retired' ? 'Предложить возврат' : 'Предложить вывод', 'roster-agent', agent.id)}</div></div>`).join('')
          : '<p class="padded muted">Роли появятся после согласования плана. Предложение можно подготовить вручную.</p>'}</div></section></div></details>
      <section class="stack compact"><h2>Экспорт студии</h2><div class="panel padded stack compact">
        <div class="actions">${actionFor('Экспортировать шаблон', 'export-mode', 'template')}${actionFor('Экспортировать снимок', 'export-mode', 'snapshot')}</div>
      </div></section></div>`;
}

function dialogTo(title, body, submitLabel, submit, { adjustable = false } = {}) {
  dialogLoadVersion++;
  catalogEditor = undefined;
  dialogAttachments = undefined;
  dialogMeeting = undefined;
  dialogConversation = undefined;
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

const powerLabels = {
  normal: 'Сон по настройкам системы',
  active: 'Не засыпать во время активной работы',
  window: 'Не засыпать в рабочее окно',
};

function dispatchEditor() {
  const current = studio();
  dialogTo('Параллельная работа и питание',
    input('Одновременные запуски', 'wipLimit', current.wipLimit ?? 1, 'type="number" min="1" max="8" step="1" required aria-describedby="wip-hint"') +
    '<p id="wip-hint" class="field-hint">Максимум независимых рабочих шагов, которые Hearth выполняет одновременно. При значении 1 они идут по очереди. Задача, которая ждёт твоего ответа, освобождает место.</p>' +
    select('Режим питания', 'powerMode', Object.entries(powerLabels).map(([value, label]) => option(value, label, current.powerMode ?? 'normal')).join('')) +
    fieldHint('Можно удерживать Mac от сна во время выполнения или в часы, указанные в расписании студии.'),
    'Сохранить', ({ wipLimit, powerMode }) => bridge.request('updateStudio', { studioId: current.id, wipLimit: Number(wipLimit), powerMode }));
}

let checkRowId = 0;
function projectCheckFields(check = {}) {
  const key = `check-${++checkRowId}`;
  return `<fieldset class="export-files form-body" data-project-check="${key}">
    <legend>Проверка${check.id ? ` · ${safe(check.id)}` : ''}</legend>
    ${input('Идентификатор проверки', `${key}-id`, check.id, 'maxlength="64" placeholder="test"')}
    ${input('Исполняемая команда', `${key}-command`, check.command, 'placeholder="npm"')}
    ${textarea('Аргументы, по одному на строку', `${key}-args`, check.args?.join('\n'), 'placeholder="test"')}
    ${checkbox('Обязательная проверка', `${key}-required`, check.required ?? true)}
    <details><summary>Пути, доказательства и время</summary><div class="form-body">
      ${textarea('Пути изменений, по одному шаблону на строку', `${key}-paths`, check.paths?.join('\n'), 'placeholder="src/**"')}
      ${textarea('Файлы с доказательствами, по одному шаблону на строку', `${key}-evidence`, check.evidenceGlobs?.join('\n'), 'placeholder="reports/**"')}
      ${input('Лимит времени, мс', `${key}-timeout`, check.timeoutMs ?? 120000, 'type="number" min="1" max="2147483647"')}
    </div></details>
    <div>${actionFor('Убрать проверку', 'remove-project-check', key)}</div>
  </fieldset>`;
}

function projectGitEditor() {
  const current = studio();
  const git = current.projectGit ?? {};
  const checks = git.profile?.checks ?? [];
  dialogTo('Git и проверки проекта',
    checkbox('Разрешить Git-доставку для задач студии', 'enabled', git.enabled) +
    input('Целевая локальная ветка', 'targetRef', git.targetRef, 'placeholder="Автоматически создать управляемую ветку"') +
    input('Идентификатор профиля проверок', 'profileId', git.profile?.id ?? 'default', 'required maxlength="64"') +
    `<p class="muted">Команды запускаются в рабочей копии задачи. Например, для <code>npm test</code> укажите команду <code>npm</code> и аргумент <code>test</code>.</p>
      <div class="form-body" data-project-checks>${checks.map(projectCheckFields).join('')}</div>
      <div>${button('Добавить проверку', 'data-add-project-check', true)}</div>`,
    'Сохранить профиль', ({ enabled, targetRef, profileId, ...values }) => {
      const profile = { id: profileId, checks: [] };
      if (enabled) profile.checks = [...form.querySelectorAll('[data-project-check]')].map(({ dataset: { projectCheck: key } }) => {
        const id = values[`${key}-id`];
        const command = values[`${key}-command`];
        if (!id || !command) throw new Error('Укажите идентификатор и команду для каждой проверки.');
        return { id, command, args: lines(values[`${key}-args`]), paths: lines(values[`${key}-paths`]),
          required: Boolean(values[`${key}-required`]), timeoutMs: Number(values[`${key}-timeout`] || 120000),
          evidenceGlobs: lines(values[`${key}-evidence`]) };
      });
      return bridge.request('configureProject', { studioId: current.id, enabled: Boolean(enabled), targetRef, profile });
    }, { adjustable: true });
}

async function cleanupEditor() {
  const current = studio();
  const op = operationId();
  await loadDialog('Уборка рабочих копий', async isCurrent => {
    const preview = await bridge.request('previewCleanup', { studioId: current.id });
    const rows = Array.isArray(preview) ? preview : preview.candidates ?? preview.worktrees ?? [];
    const allowed = rows.filter(row => row.eligible ?? row.allowed ?? row.removable);
    const rowId = row => row.id ?? row.worktreeId ?? row.candidateId;
    const body = rows.length ? `<ul class="legacy-list">${rows.map(row => `<li>
      ${(row.eligible ?? row.allowed ?? row.removable) ? checkbox(row.branchRef ?? row.path ?? rowId(row), `tree-${rowId(row)}`, false)
        : `<strong>${safe(row.branchRef ?? row.path ?? rowId(row))}</strong>`}
      <p class="muted">${safe(Array.isArray(row.reasons) ? row.reasons.join(' · ') : row.reason ?? '')}</p></li>`).join('')}</ul>`
      : '<p class="muted">Зарегистрированных рабочих копий пока нет.</p>';
    if (isCurrent()) dialogTo('Уборка рабочих копий', `<p>Выберите копии, которые нужно удалить. Сохранённые доказательства останутся в студии.</p>${body}`,
      allowed.length ? 'Удалить выбранные копии' : undefined, allowed.length ? async values => {
        const candidateIds = allowed.filter(row => values[`tree-${rowId(row)}`]).map(rowId);
        if (!candidateIds.length) throw new Error('Выберите хотя бы одну копию.');
        const result = await bridge.request('applyCleanup', { studioId: current.id, candidateIds, operationId: op });
        notice((result.results ?? []).map(row => [row.id, row.status, ...(row.reasons ?? [])].join(' · ')).join(' / ') || 'Уборка рабочих копий завершена.');
      } : undefined, { adjustable: true });
  });
}

async function loadDialog(title, load) {
  dialogTo(title, '<p class="muted" role="status">Загрузка…</p>');
  const version = dialogLoadVersion;
  try { await load(() => dialog.open && version === dialogLoadVersion); }
  catch (error) {
    if (dialog.open && version === dialogLoadVersion) dialogTo(title, `<p class="error" role="alert">${safe(error.message || 'Не удалось загрузить данные.')}</p>`);
  }
}

let dialogLoadVersion = 0;
let dialogAttachments;

function attachmentFields() {
  return `<div class="stack compact"><div class="actions">${button('Приложить файл', 'data-pick-attachment', true)}</div>
    <ul class="legacy-list" data-attachments aria-live="polite"></ul></div>`;
}

function renderAttachmentFields() {
  const list = $('[data-attachments]');
  if (!list || !dialogAttachments) return;
  list.innerHTML = dialogAttachments.map((row, index) => `<li class="legacy-attachment"><span>${safe(row.name ?? row.filename ?? row.sourcePath ?? row.id)}</span>
    ${actionFor('Убрать', 'remove-attachment', index)}</li>`).join('');
}

async function addAttachment(target) {
  const attachments = dialogAttachments;
  if (!attachments || target.disabled) return;
  if (attachments.length >= 8) { dialogError('Можно приложить до восьми файлов.'); return; }
  target.disabled = true;
  try {
    const row = await bridge.request('pickAttachment', { studioId: studio().id,
      ...(dialogConversation?.taskId ? { taskId: dialogConversation.taskId } : {}) });
    if (row && dialogAttachments === attachments && !attachments.some(value => value.id === row.id)) {
      attachments.push(row);
      renderAttachmentFields();
    }
  } catch (error) {
    if (dialogAttachments === attachments) dialogError(error.message || 'Не удалось приложить файл.');
  } finally { target.disabled = false; }
}

const messageStatuses = { queued: 'В очереди', received: 'Получено', processed: 'Обработано' };
function messageHistoryMarkup(thread, agent) {
  const history = thread ? studioRows('conversationMessages').filter(row => row.conversationId === thread.id) : [];
  return history.length ? `<ul class="legacy-list legacy-history">${history.map(row => {
    const sender = row.author === 'owner' ? (row.kind === 'note' ? 'Ваша записка' : 'Вы') : nameFor(agent);
    const files = studioRows('evidence').filter(file => row.attachmentIds?.includes(file.id));
    const priority = row.priorityProposal;
    return `<li><div class="row"><strong>${safe(sender)}</strong><small class="muted">${safe(studioDate(row.createdAt))}</small></div>
      ${row.status && row.author === 'owner' ? badge(messageStatuses[row.status] ?? row.status) : ''}
      ${plain(row.text)}${row.outcome ? plain(row.outcome, 'muted') : ''}${renderEvidence(files)}
      ${priority ? `<p>${safe(priority.taskTitle)} · приоритет ${safe(priority.priority)}</p>
        ${priority.appliedAt ? badge('Применено') : actionFor('Применить приоритет', 'message-priority', row.id)}` : ''}</li>`;
  }).join('')}</ul>` : '';
}

function conversationsDialog() {
  const rows = studioRows('conversations');
  const current = studio();
  const recipient = row => nameFor(current.agents?.find(agent => agent.id === row.agentId));
  const conversationList = rows.length ? `<ul class="legacy-list">${rows.map(row => {
    const task = tasks().find(task => task.id === row.taskId);
    const last = studioRows('conversationMessages').findLast(item => item.conversationId === row.id);
    return `<li><strong>${safe(recipient(row))}${task ? ` · ${safe(task.title)}` : ''}</strong>
      ${last ? `<p class="muted clamp">${safe(last.text)}</p>` : ''}
      ${actionFor('Открыть беседу', 'conversation', row.id)}</li>`;
  }).join('')}</ul>` : '<p class="muted">Здесь появятся сообщения и ответы команды.</p>';
  dialogTo('Связь с командой', `<div class="actions">${actionFor('Написать директору', 'message', '', false)}
    ${actionFor('Оставить записку', 'message-note', '')}</div>${conversationList}`, undefined, undefined, { adjustable: true });
}

function messageEditor({ conversation, agentId = conversation?.agentId, taskId = conversation?.taskId, kind = 'chat' } = {}) {
  const current = studio();
  const agent = current.agents?.find(row => String(row.id) === String(agentId));
  const task = tasks().find(row => String(row.id) === String(taskId));
  const thread = conversation ?? studioRows('conversations').find(row =>
    (row.agentId ?? null) === (agent?.id ?? null) && (row.taskId ?? null) === (task?.id ?? null));
  const op = operationId();
  const selectedAttachments = [];
  const submit = async ({ text }) => {
    if (!text && !selectedAttachments.length) throw new Error('Напишите сообщение или приложите файл.');
    await bridge.request('postStudioMessage', {
      studioId: current.id, ...(thread?.id ? { conversationId: thread.id } : {}),
      ...(agent ? { agentId: agent.id } : {}), ...(task ? { taskId: task.id } : {}),
      kind, text, attachmentIds: selectedAttachments.map(row => row.id), operationId: op,
    });
    await refresh();
    if (studio()?.id === current.id) {
      messageEditor({ agentId: agent?.id, taskId: task?.id });
      return false;
    }
  };
  dialogTo(kind === 'note' ? 'Записка директору' : `Беседа · ${nameFor(agent)}`, (task ? `<p>${safe(task.title)}</p>` : '') +
    `<div data-message-history aria-live="polite">${messageHistoryMarkup(thread, agent)}</div>` +
    textarea(kind === 'note' ? 'Текст записки' : 'Сообщение', 'text') + attachmentFields(),
    kind === 'note' ? 'Передать записку' : 'Отправить', submit, { adjustable: true });
  dialogAttachments = selectedAttachments;
  dialogConversation = { agentId: agent?.id ?? null, taskId: task?.id ?? null };
}

function agentHistory(raw) {
  const current = studio();
  const agent = current.agents?.find(row => same(row.id, raw));
  const own = tasks().filter(task => (task.agentId ?? null) === (agent?.id ?? null));
  const meetings = studioRows('meetings').filter(meeting => meeting.participants?.some(row => (row.agentId ?? row) === agent?.id));
  const attempts = studioRows('attempts').filter(attempt => own.some(task => task.id === attempt.taskId)).slice(-10).reverse();
  const taskList = records => `<ul class="legacy-list">${records.map(task => `<li>${actionFor(task.title, 'task', task.id)} ${status(task)}</li>`).join('')}</ul>`;
  dialogTo(`Работа · ${nameFor(agent)}`, (own.length ? `<section class="stack compact"><h3>Задачи и обучение</h3>${taskList(own.slice(-15).reverse())}</section>` : '<p class="muted">Задач пока нет.</p>') +
    (attempts.length ? `<section class="stack compact"><h3>Последние попытки</h3><ul class="legacy-list">${attempts.map(row =>
      `<li>${safe(own.find(task => task.id === row.taskId)?.title)} ${status(row)} ${safe(studioDate(row.startedAt))}${row.error ? plain(row.error) : ''}</li>`).join('')}</ul></section>` : '') +
    (meetings.length ? `<section class="stack compact"><h3>Встречи</h3><div class="actions">${meetings.map(row => actionFor(row.title ?? 'Встреча', 'meeting-detail', row.id)).join('')}</div></section>` : ''), undefined, undefined, { adjustable: true });
}

async function usageDialog() {
  const current = studio();
  await loadDialog('Расход моделей', async isCurrent => {
    const report = await bridge.request('studioUsage', { studioId: current.id });
    if (isCurrent()) dialogTo('Расход моделей', renderUsageReport(report) +
      `<div class="actions">${button('Задать тариф модели', 'data-open="usage-tariff"', true)}</div>`, undefined, undefined, { adjustable: true });
  });
}

function usageTariffEditor() {
  const current = studio();
  const rate = 'type="number" min="0" step="any"';
  dialogTo('Тариф за миллион токенов',
    select('Подключение', 'runtime', option('codex', 'Codex') + option('claude', 'Claude Code')) +
    input('Модель', 'model', current.director?.model ?? '', 'required') +
    input('Валюта', 'currency', 'USD', 'required maxlength="3"') +
    input('Вход', 'input', '', rate + ' required') + input('Выход', 'output', '', rate + ' required') +
    input('Чтение из кэша', 'cacheRead', '', rate) + input('Запись в кэш', 'cacheWrite', '', rate),
    'Сохранить тариф', values => bridge.request('updateUsageTariff', {
      studioId: current.id, runtime: values.runtime, model: values.model, currency: values.currency.toUpperCase(),
      input: Number(values.input), output: Number(values.output),
      cacheRead: values.cacheRead === '' ? null : Number(values.cacheRead), cacheWrite: values.cacheWrite === '' ? null : Number(values.cacheWrite),
    }));
}

async function diagnosisDialog() {
  const current = studio();
  await loadDialog('Диагностика студии', async isCurrent => {
    const report = await bridge.request('diagnoseStudio', { studioId: current.id });
    const actions = (['resume', 'recover', 'retry'].includes(report.action) ? actionFor('Восстановить работу', 'run-action', 'resume', false) : '') +
      button('Сохранить диагностику', 'data-save-diagnostics', true) +
      button('Перезапустить Hearth', 'data-open="restart-app"', true);
    if (isCurrent()) dialogTo('Диагностика студии', renderDiagnostic(report) + (actions ? `<div class="actions">${actions}</div>` : ''));
  });
}

function restartAppEditor() {
  dialogTo('Перезапустить Hearth', '<p>Приложение завершит работу штатно и откроется снова. Студии восстановят состояние из сохранённых записей.</p>',
    'Перезапустить', () => bridge.request('restartApp'));
}

function notificationsEditor() {
  const current = studio();
  dialogTo('Уведомления студии', checkbox('Показывать события этой студии', 'studio', state.notificationPreferences?.studios?.[current.id] !== false) +
    fieldHint('Системные уведомления также должны быть включены в настройках приложения.'),
    'Сохранить', ({ studio: enabled }) => bridge.request('updateNotifications', { studioId: current.id, enabled: Boolean(enabled) }));
}

const recordOptions = (rows, selected = '', emptyLabel = 'Не выбрано', label = row => row.title ?? row.name) =>
  option('', emptyLabel, selected) + rows.map(row => option(String(row.id), label(row), String(selected))).join('');
const checkedIds = (rows, values, prefix) => rows.filter((_, index) => values[`${prefix}-${index}`]).map(row => row.id);
const checkList = (title, rows, prefix, selected = [], label = row => row.title ?? row.name) => rows.length
  ? `<fieldset class="export-files"><legend>${safe(title)}</legend><div class="legacy-checklist">${rows.map((row, index) =>
    checkbox(label(row), `${prefix}-${index}`, selected.includes(row.id))).join('')}</div></fieldset>` : '';

function groomingEditor() {
  const current = studio();
  const policy = current.groomingPolicy ?? {};
  dialogTo('Подготовка задач к спринту', checkbox('Автоматически разбирать очередь задач', 'enabled', policy.enabled) +
    fieldHint('Директор уточняет критерии и зависимости. Он может разбить большую задачу на меньшие или подготовить новые карточки, если готовых задач мало и в следующем спринте есть место.') +
    input('Минимальный запас готовых задач', 'threshold', policy.threshold, `type="number" min="1" max="200" placeholder="Авто · ${(current.wipLimit ?? 1) * 2}"`) +
    fieldHint('При пустом поле запас равен удвоенному числу одновременных запусков.') +
    input('Сколько задач помещается в следующем спринте', 'nextSprintCapacity', policy.nextSprintCapacity ?? 1, 'type="number" min="0" max="200" required'),
    'Сохранить', values => bridge.request('updateGrooming', { studioId: current.id, enabled: Boolean(values.enabled),
      threshold: values.threshold ? Number(values.threshold) : null, nextSprintCapacity: Number(values.nextSprintCapacity) }));
}

function backlogEditor(task) {
  const current = studio();
  const records = tasks().filter(row => row.id !== task?.id);
  const blockedBy = task?.dependencies ?? [];
  const priorLinks = (task?.links ?? []).filter(row => !['blocks', 'replaces'].includes(row.type));
  const linksOf = kind => priorLinks.filter(row => row.type === kind).map(row => row.taskId);
  dialogTo(task ? 'Изменить задачу бэклога' : 'Добавить в бэклог',
    input('Название', 'title', task?.title, 'required maxlength="200"') +
    textarea('Описание', 'prompt', task?.prompt, 'required') + textarea('Критерии приёмки', 'criteria', listText(task?.criteria)) +
    input('Приоритет (0–100)', 'priority', task?.priority ?? 0, 'type="number" min="0" max="100" required') +
    input('Оценка, баллов', 'points', task?.points, 'type="number" min="1"') +
    (!task ? checkbox('Улучшение проекта', 'debt') : '') +
    (records.length ? `<details class="advanced"><summary>Связи с другими задачами</summary>
      ${checkList('Готовность этой задачи зависит от', records, 'blocks', blockedBy)}
      ${checkList('Источники задачи', records, 'origin', linksOf('origin'))}
      ${checkList('Связанные улучшения', records.filter(row => row.kind === 'debt'), 'debt-link', linksOf('debt'))}</details>` : ''),
    'Сохранить', values => bridge.request('reviseBacklog', {
      studioId: current.id, baseVersion: current.backlogVersion ?? 0,
      edits: [{ type: task ? 'update' : 'create', ...(task ? { taskId: task.id } : {}),
        title: values.title, prompt: values.prompt, criteria: values.criteria || null, priority: Number(values.priority),
        points: values.points ? Number(values.points) : null, ...(values.debt ? { kind: 'debt' } : {}),
        links: [
          ...checkedIds(records, values, 'blocks').map(taskId => ({ taskId, type: 'blocks' })),
          ...checkedIds(records, values, 'origin').map(taskId => ({ taskId, type: 'origin' })),
          ...checkedIds(records.filter(row => row.kind === 'debt'), values, 'debt-link').map(taskId => ({ taskId, type: 'debt' })),
        ],
      }],
    }), { adjustable: true });
}

function replaceBacklogEditor(task) {
  const current = studio();
  const records = tasks().filter(row => row.id !== task.id && !row.sprintId && row.kind !== 'train' && row.status !== 'running' && !['done', 'replaced'].includes(row.stage));
  dialogTo('Заменить задачу', `<p>${safe(task.title)}</p>` +
    select('Задача на замену', 'replacementId', recordOptions(records)) + checkbox('Перенести зависимые задачи на замену', 'redirect', true),
    'Сохранить замену', ({ replacementId, redirect }) => {
      if (!replacementId) throw new Error('Выберите задачу на замену.');
      return bridge.request('reviseBacklog', { studioId: current.id, baseVersion: current.backlogVersion ?? 0,
        edits: [{ type: 'replace', taskId: task.id, replacementId, redirectDependencies: Boolean(redirect) }] });
    });
}

function closeSprintEditor(sprint) {
  const current = studio();
  const members = tasks().filter(task => task.sprintId === sprint.id && sprint.taskIds?.includes(task.id) && !['done', 'replaced'].includes(task.stage));
  const nextSprints = studioRows('sprints').filter(row => row.id !== sprint.id && row.status === 'active');
  const op = operationId();
  dialogTo('Закрыть спринт', `<p>${safe(sprint.title)}. ${members.length ? 'Укажите, куда перенести каждую незавершённую задачу.' : 'Все задачи завершены или заменены.'}</p>` +
    members.map((task, index) => `<fieldset class="export-files"><legend>${safe(task.title)}</legend><div class="form-body">
      ${select('Этап после переноса', `stage-${index}`, option('backlog', 'Бэклог') + option('ready', 'Готова к работе'))}
      ${nextSprints.length ? select('Следующий спринт', `sprint-${index}`, recordOptions(nextSprints, '', 'Оставить вне спринта')) : ''}
      ${input('Причина переноса', `reason-${index}`, '', 'required')}</div></fieldset>`).join(''),
    'Закрыть спринт', values => bridge.request('closeSprint', { studioId: current.id, sprintId: sprint.id, operationId: op,
      carryovers: members.map((task, index) => ({ taskId: task.id, reason: values[`reason-${index}`], stage: values[`stage-${index}`],
        ...(values[`sprint-${index}`] ? { sprintId: values[`sprint-${index}`] } : {}) })) }), { adjustable: true });
}

function phaseEditor(phase) {
  const current = studio();
  const epics = studioRows('epics');
  const sprints = studioRows('sprints');
  dialogTo(phase ? 'Изменить фазу' : 'Добавить фазу',
    input('Название', 'title', phase?.title, 'required maxlength="200"') +
    textarea('Цель', 'goal', phase?.goal, 'required') +
    textarea('Критерии завершения, каждый с новой строки', 'criteria', phase?.criteria?.map(row => row.description).join('\n'), 'required') +
    checkList('Эпики фазы', epics, 'epic', phase?.epicIds) + checkList('Спринты фазы', sprints, 'sprint', phase?.sprintIds),
    'Сохранить', values => bridge.request(phase ? 'updatePhase' : 'createPhase', {
      studioId: current.id, ...(phase ? { phaseId: phase.id } : {}), title: values.title, goal: values.goal,
      criteria: lines(values.criteria).map(description => phase?.criteria.find(row => row.description === description) ?? { description }),
      epicIds: checkedIds(epics, values, 'epic'), sprintIds: checkedIds(sprints, values, 'sprint'),
    }), { adjustable: true });
}

function phaseTransitionEditor(phase) {
  const current = studio();
  const sprints = studioRows('sprints').filter(row => phase.sprintIds.includes(row.id) || phase.epicIds.includes(row.epicId));
  const done = [...tasks().filter(row => row.stage === 'done' && row.kind !== 'train' &&
    (phase.epicIds.includes(row.epicId) || sprints.some(sprint => sprint.id === row.sprintId || sprint.taskIds?.includes(row.id)))),
    ...sprints.filter(row => row.status === 'completed')];
  const pending = phase.transition?.status === 'pending';
  if (pending) {
    dialogTo('Завершение фазы', plain(phase.title) + `<ul class="legacy-list">${(phase.transition.evidenceIds ?? []).map(id =>
      `<li>${safe(done.find(row => row.id === id)?.title ?? id)}</li>`).join('')}</ul>` +
      select('Решение', 'decision', option('approve', 'Подтвердить завершение') + option('reject', 'Вернуть в работу')),
      'Сохранить решение', ({ decision }) => bridge.request('decidePhaseTransition', { studioId: current.id, phaseId: phase.id, decision }));
    return;
  }
  const needsBindings = phase.criteria.length > 1 || phase.criteria.some(row => row.evidenceIds?.length);
  const criterionFields = needsBindings ? phase.criteria.map((criterion, index) =>
    checkList(criterion.description, done, `criterion-${index}`, criterion.evidenceIds)).join('') : checkList('Доказательства', done, 'evidence');
  dialogTo('Предложить завершение фазы', plain(phase.title) + (!done.length ?
    '<p class="muted">Свяжите фазу с эпиком или спринтом, где есть принятые результаты.</p>' : criterionFields),
    done.length ? 'Предложить завершение' : undefined, done.length ? async values => {
      const criteria = needsBindings ? phase.criteria.map((row, index) => ({ ...row, evidenceIds: checkedIds(done, values, `criterion-${index}`) })) : phase.criteria;
      if (needsBindings && criteria.some(row => !row.evidenceIds.length)) throw new Error('Выберите доказательство для каждого критерия.');
      const evidenceIds = needsBindings ? [...new Set(criteria.flatMap(row => row.evidenceIds))] : checkedIds(done, values, 'evidence');
      if (!evidenceIds.length) throw new Error('Выберите хотя бы одно доказательство.');
      if (needsBindings) await bridge.request('updatePhase', { studioId: current.id, phaseId: phase.id, criteria });
      await bridge.request('proposePhaseTransition', { studioId: current.id, phaseId: phase.id, evidenceIds });
    } : undefined, { adjustable: true });
}

const activeRoster = current => (current.agents ?? []).filter(agent => agent.rosterStatus !== 'retired');
const meetingKinds = { planning: 'Планирование', grooming: 'Разбор очереди задач', retrospective: 'Ретроспектива', topic: 'Обсуждение', review: 'Ревью' };
const meetingStages = { positions: 'Позиции участников', facilitation: 'Обсуждение', objections: 'Возражения', owner_review: 'Ждёт решения владельца', resolved: 'Решение сохранено', held: 'Приостановлена' };
const listJson = (raw, label) => {
  try { const result = JSON.parse(raw || '[]'); if (Array.isArray(result)) return result; }
  catch { /* Display a validation message alongside this dialog's fields. */ }
  throw new Error(`«${label}» должен быть массивом JSON.`);
};

function meetingEditor() {
  const current = studio();
  const agents = activeRoster(current);
  const trainings = tasks().filter(task => task.kind === 'train');
  const available = [...tasks().filter(task => task.stage === 'done').map(row => ({ id: row.id, title: row.title, type: 'task' })),
    ...studioRows('evidence').filter(row => row.kind !== 'attachment').map(row => ({ id: row.id, title: row.name ?? row.filename ?? row.kind, type: 'evidence', digest: row.digest, revisionDigest: row.revision?.digest }))];
  const intro = agents.length ? '' : '<p class="muted">Добавьте участника в состав студии, чтобы назначить встречу.</p>';
  dialogTo('Назначить встречу', intro + input('Название', 'title', '', 'required maxlength="150"') +
    select('Вид встречи', 'kind', Object.entries(meetingKinds).map(([value, label]) => option(value, label, 'topic')).join('')) +
    textarea('Повестка', 'agenda', '', 'required') +
    (agents.length ? checkbox('Доверить директору выбор участников', 'chooseParticipants') +
      `<div data-manual-participants>${checkList('Участники', agents, 'participant', [], nameFor)}</div>` : '') +
    select('Ведущий', 'facilitatorId', recordOptions(agents, '', 'Директор', nameFor)) +
    select('Спринт', 'sprintId', recordOptions(studioRows('sprints'))) + select('Фаза', 'phaseId', recordOptions(studioRows('phases'))) +
    checkList('Материалы', available, 'material') +
    (trainings.length ? `<details class="advanced" data-manual-prerequisites><summary>Учебный допуск участника</summary><div class="form-body">
      ${select('Задача обучения', 'trainTaskId', recordOptions(trainings, '', 'Без допуска'))}
      ${input('Требуемый навык или версия', 'skillRef')}${input('Зачем нужен допуск', 'prerequisiteReason')}${input('Критерий допуска', 'prerequisiteCriterion')}</div></details>` : ''),
    agents.length ? 'Назначить' : undefined, agents.length ? async values => {
      const chooseParticipants = Boolean(values.chooseParticipants);
      const participants = chooseParticipants ? [] : checkedIds(agents, values, 'participant');
      if (!chooseParticipants && !participants.length) throw new Error('Выберите хотя бы одного участника.');
      const materialRefs = available.filter((_, index) => values[`material-${index}`]).map(({ type, id, digest, revisionDigest }) => ({
        type, id, ...(typeof digest === 'string' ? { digest } : {}), ...(revisionDigest ? { revisionDigest } : {}),
      }));
      const train = !chooseParticipants && trainings.find(row => row.id === values.trainTaskId);
      const prerequisites = train ? [{ trainTaskId: train.id, agentId: train.training?.targetAgentId,
        skillRef: values.skillRef, reason: values.prerequisiteReason, criterion: values.prerequisiteCriterion }] : [];
      await bridge.request('openMeeting', { studioId: current.id, title: values.title, kind: values.kind, agenda: values.agenda,
        ...(chooseParticipants ? { chooseParticipants: true } : { participants }), materialRefs, prerequisites,
        ...(values.facilitatorId ? { facilitatorId: values.facilitatorId } : {}),
        ...(values.sprintId ? { sprintId: values.sprintId } : {}), ...(values.phaseId ? { phaseId: values.phaseId } : {}) });
    } : undefined, { adjustable: true });
}

function prerequisiteBlock(type, consumerId) {
  const rows = studioRows('prerequisites').filter(row => row.consumerType === type && row.consumerId === consumerId);
  if (!rows.length) return '';
  const show = rows.map(row => {
    const training = tasks().find(task => task.id === row.trainTaskId);
    return `<li><strong>${safe(row.skillRef)}</strong>${plain(row.reason)}${plain(row.criterion, 'muted')}
      <div class="actions">${training ? actionFor('Открыть обучение', 'task', training.id) : ''}
        ${row.retired ? badge('Допуск снят после замены') : row.exception ? badge(`Исключение: ${row.exception.author}`) : training?.stage === 'done' && training.status === 'completed' ? badge('Обучение принято', 'good') : badge('Ждёт обучения', 'warn')}
        ${!row.exception && !row.retired && training?.stage !== 'done' ? actionFor('Оформить исключение', 'waive-prerequisite', row.id) : ''}</div>
      ${row.exception ? plain(row.exception.reason, 'muted') : ''}</li>`;
  });
  return `<section class="inline-result"><h3>Учебные допуски</h3><ul class="legacy-list">${show.join('')}</ul></section>`;
}

function waivePrerequisiteEditor(row) {
  dialogTo('Исключение для учебного допуска', plain(row.skillRef) +
    input('Кто разрешил исключение', 'author', '', 'required') + textarea('Причина', 'reason', '', 'required'),
    'Сохранить исключение', values => bridge.request('waivePrerequisite', { prerequisiteId: row.id, ...values }));
}

const trainingForTask = task => tasks().filter(row => row.kind === 'train' &&
  [task.agentId, task.reviewerId].filter(Boolean).includes(row.training?.targetAgentId));

function taskPrerequisiteEditor(task) {
  const rows = trainingForTask(task);
  dialogTo('Учебный допуск задачи',
    select('Задача обучения', 'trainTaskId', recordOptions(rows)) +
    input('Требуемый навык или версия', 'skillRef', '', 'required') +
    textarea('Зачем нужен допуск', 'reason', '', 'required') +
    textarea('Критерий допуска', 'criterion', '', 'required'), 'Добавить допуск', values => {
      const train = rows.find(row => row.id === values.trainTaskId);
      if (!train) throw new Error('Выберите задачу обучения.');
      return bridge.request('addPrerequisite', { ...values, consumerType: 'task', consumerId: task.id, agentId: train.training.targetAgentId });
    });
}

function meetingDetail(meeting) {
  const current = studio();
  const active = activeRoster(current);
  const participant = id => nameFor(current.agents?.find(agent => agent.id === id));
  const outcome = meeting.resolution?.outcome ?? meeting.proposedOutcome ?? meeting;
  const decisions = outcome.decisions ?? [];
  const actionItems = outcome.actionItems ?? [];
  const present = meeting.participants ?? [];
  const canReplace = meeting.stage === 'positions' && !meeting.activeStep && active.some(agent => !present.includes(agent.id));
  const canResolve = ['facilitation', 'owner_review'].includes(meeting.stage) && !meeting.activeStep;
  const position = row => `<li><strong>${safe(participant(row.agentId))}</strong>
    <p class="muted">${row.purpose === 'meeting-objection' ? 'Возражение' : 'Позиция'}${row.superseded ? ' · Заменена' : ''}</p>${plain(row.text)}</li>`;
  dialogTo(meeting.title ?? meetingKinds[meeting.kind] ?? 'Встреча',
    `<div class="row">${badge(meetingStages[meeting.stage] ?? meetingKinds[meeting.kind] ?? 'Архив', meeting.stage === 'owner_review' ? 'warn' : '')}
      ${meeting.version ? `<span class="muted">Версия ${safe(meeting.version)}</span>` : ''}</div>` +
    (meeting.agenda ? `<section class="inline-result"><h3>Повестка</h3>${plain(meeting.agenda)}</section>` : '') +
    (present.length ? `<p class="muted">Участники: ${present.map(id => safe(participant(id))).join(', ')}</p>` : '') +
    (meeting.materialRefs?.length ? `<section class="inline-result"><h3>Материалы</h3><div class="actions">${meeting.materialRefs.map(ref => ref.type === 'evidence'
      ? actionFor('Открыть доказательство', 'evidence', ref.id)
      : ['task', 'artifact'].includes(ref.type) ? actionFor(tasks().find(task => task.id === ref.id)?.title ?? 'Задача', 'task', ref.id) : '').join('')}</div></section>` : '') +
    prerequisiteBlock('meeting', meeting.id) +
    (meeting.positions?.length ? `<section class="inline-result"><h3>Позиции и возражения</h3><ul class="legacy-list">${meeting.positions.map(position).join('')}</ul></section>` : '') +
    (meeting.objectionRound?.question ? `<section class="inline-result"><h3>Вопрос к участникам</h3>${plain(meeting.objectionRound.question)}</section>` : '') +
    (meeting.error ? plain(meeting.error, 'error') : '') +
    (meeting.ownerReason ? `<section class="inline-result"><h3>Почему нужно ваше решение</h3>${plain(meeting.ownerReason)}</section>` : '') +
    (outcome.summary || meeting.outcome ? `<section class="inline-result"><h3>Итог</h3>${plain(outcome.summary ?? meeting.outcome)}</section>` : '') +
    (decisions.length ? `<section class="inline-result"><h3>Решения</h3><ul class="legacy-list">${decisions.map(row =>
      `<li><strong>${safe(row.text ?? row)}</strong>${row.rationale ? plain(row.rationale) : ''}${row.verification ? plain(`Проверка: ${row.verification}`, 'muted') : ''}</li>`).join('')}</ul></section>` : '') +
    (actionItems.length ? `<section class="inline-result"><h3>Действия</h3><ul class="legacy-list">${actionItems.map(row =>
      `<li><strong>${safe(row.title)}</strong>${plain(row.prompt)}${row.agentId ? plain(participant(row.agentId), 'muted') : ''}</li>`).join('')}</ul></section>` : '') +
    (meeting.taskIds?.length ? `<div class="actions">${meeting.taskIds.map(id => actionFor(tasks().find(row => row.id === id)?.title ?? 'Открыть задачу', 'task', id)).join('')}</div>` : '') +
    `<div class="actions">${canResolve ? actionFor('Сохранить решение', 'meeting-resolve', meeting.id, false) : ''}
      ${meeting.stage === 'held' ? actionFor('Возобновить', 'meeting-resume', meeting.id, false) : ''}
      ${canReplace ? actionFor('Заменить участника', 'meeting-replace', meeting.id) : ''}</div>`, undefined, undefined, { adjustable: true });
  dialogMeeting = meeting;
}

function resolveMeetingEditor(meeting) {
  const outcome = meeting.proposedOutcome ?? {};
  const agents = activeRoster(studio());
  dialogTo('Решение встречи', textarea('Итог', 'summary', outcome.summary, 'required') +
    textarea('Дополнительное решение', 'decisionText') + input('Аргументы', 'rationale') + input('Как проверить решение', 'verification') +
    `<details class="advanced"><summary>Действия по итогам встречи</summary><div class="form-body">
      ${input('Название нового действия', 'actionTitle')}${textarea('Описание действия', 'actionPrompt')}${input('Критерии действия', 'actionCriteria')}
      ${select('Тип действия', 'actionKind', option('work', 'Задача') + option('train', 'Обучение') + option('recommendation', 'Рекомендация'))}
      ${select('Ответственный', 'actionAgentId', recordOptions(agents, '', 'Без назначения', nameFor))}</div></details>` +
    (outcome.decisions?.length || outcome.actionItems?.length ? `<details class="advanced"><summary>Предложения директора</summary>
      ${textarea('Решения (JSON)', 'proposedDecisions', JSON.stringify(outcome.decisions ?? [], null, 2))}
      ${textarea('Действия (JSON)', 'proposedActions', JSON.stringify(outcome.actionItems ?? [], null, 2))}</details>` : ''),
    'Подтвердить итог', values => {
      const decisions = listJson(values.proposedDecisions, 'Решения');
      const actionItems = listJson(values.proposedActions, 'Действия');
      if (values.decisionText) decisions.push({ text: values.decisionText, rationale: values.rationale, verification: values.verification });
      if (values.actionTitle) actionItems.push({ kind: values.actionKind, title: values.actionTitle, prompt: values.actionPrompt, criteria: values.actionCriteria,
        ...(values.actionAgentId ? { agentId: values.actionAgentId } : {}) });
      return bridge.request('resolveMeeting', { meetingId: meeting.id, version: meeting.version, summary: values.summary, decisions, actionItems });
    }, { adjustable: true });
}

function replaceParticipantEditor(meeting) {
  const agents = activeRoster(studio());
  const from = agents.filter(agent => meeting.participants.includes(agent.id));
  const to = agents.filter(agent => !meeting.participants.includes(agent.id));
  dialogTo('Заменить участника', select('Текущий участник', 'agentId', recordOptions(from, from[0]?.id, '', nameFor)) +
    select('Новый участник', 'replacementAgentId', recordOptions(to, to[0]?.id, '', nameFor)), 'Заменить', values => {
      if (!values.agentId || !values.replacementAgentId) throw new Error('Выберите обоих участников.');
      return bridge.request('replaceParticipant', { meetingId: meeting.id, ...values });
    });
}

const rosterKinds = { hire: 'Найм', retire: 'Вывод роли', return: 'Возврат роли', update: 'Изменение роли', rollback: 'Откат роли' };
const rosterStages = { pending: 'Ждёт решения', approved: 'Принято', rejected: 'Отклонено' };
const staffingReasons = { headcount: 'Превышен лимит участников', budget: 'Превышен бюджет', 'budget-unverified': 'Бюджет не подтверждён' };

function staffingEditor() {
  const current = studio();
  const rules = current.staffing ?? {};
  dialogTo('Лимиты состава', input('Число рабочих ролей', 'maxAgents', rules.maxAgents, 'type="number" min="0" placeholder="Без лимита"') +
    input('Бюджет команды', 'maxBudget', rules.maxBudget, 'type="number" min="0" step="any" placeholder="Без лимита"') +
    textarea('Разрешения, по одному на строку', 'permissions', rules.permissions?.join('\n')),
    'Сохранить', values => bridge.request('updateStudio', { studioId: current.id, staffing: {
      maxAgents: values.maxAgents ? Number(values.maxAgents) : null, maxBudget: values.maxBudget ? Number(values.maxBudget) : null,
      permissions: lines(values.permissions),
    } }));
}

function rosterProposalEditor({ agent, kind = 'hire', rollbackProposalId } = {}) {
  const current = studio();
  const op = operationId();
  const firstRequired = ['hire', 'return'].includes(kind);
  dialogTo(rosterKinds[kind], (agent ? plain(nameFor(agent)) : '') +
    (kind === 'hire' ? input('Название роли', 'roleTitle', '', 'required') + input('Имя агента', 'name') +
      textarea('Инструкции для роли', 'description') + input('Темы обучения', 'topics', '', 'placeholder="Через запятую"') : '') +
    textarea('Причина изменения состава', 'reason', '', 'required') +
    (firstRequired ? textarea('Первый результат роли', 'firstResult', '', 'required') +
      input('Оценка бюджета роли', 'estimatedBudget', '', 'type="number" min="0" step="any"') : ''),
    'Создать предложение', async values => {
      const proposal = await bridge.request('proposeRosterChange', { studioId: current.id, kind, reason: values.reason, operationId: op,
        ...(agent ? { agentId: agent.id } : {}), ...(firstRequired ? { firstResult: values.firstResult, ...(values.estimatedBudget ? { estimatedBudget: Number(values.estimatedBudget) } : {}) } : {}),
        ...(kind === 'hire' ? { agent: { name: values.name, roleTitle: values.roleTitle, description: values.description, mode: 'inherit' }, topics: parseSkillTopics(values.topics) } : {}),
        ...(rollbackProposalId ? { rollbackProposalId } : {}),
      });
      await refresh();
      rosterDecisionEditor(proposal);
      return false;
    }, { adjustable: true });
}

function rosterHistory() {
  const current = studio();
  const proposals = studioRows('rosterProposals').toReversed();
  const display = row => row.settings?.roleTitle ?? current.agents?.find(agent => agent.id === row.agentId)?.roleTitle ?? '';
  dialogTo('Предложения и история ролей', proposals.length ? `<ul class="legacy-list">${proposals.map(row =>
    `<li><div class="row"><strong>${safe([rosterKinds[row.kind], display(row)].filter(Boolean).join(' · '))}</strong>${badge(rosterStages[row.status] ?? row.status)}</div>
      ${plain(row.reason)}${row.initiator ? plain(`${row.initiator === 'owner' ? 'Владелец' : 'Директор'} · Версия ${row.version}`, 'muted') : ''}
      ${actionFor(row.status === 'pending' ? 'Рассмотреть' : 'Подробности', 'roster-decision', row.id)}</li>`).join('')}</ul>`
    : '<p class="muted">Здесь появятся предложения директора и владельца.</p>', undefined, undefined, { adjustable: true });
}

function rosterDecisionEditor(row) {
  const current = studio();
  const agent = current.agents?.find(agent => agent.id === row.agentId);
  const limits = row.limitReasons ?? [];
  const pending = row.status === 'pending';
  const destinations = activeRoster(current).filter(agent => agent.id !== row.agentId && agent.systemRole !== 'coach');
  dialogTo(rosterKinds[row.kind] ?? 'Изменение состава',
    `<div>${badge(rosterStages[row.status] ?? row.status, pending ? 'warn' : '')}</div>` +
    plain(row.settings?.roleTitle ?? (agent ? nameFor(agent) : '')) + plain(row.reason) +
    (row.firstResult ? `<section class="inline-result"><h3>Первый результат</h3>${plain(row.firstResult)}</section>` : '') +
    (row.settings ? `<p class="muted">${safe([modeNames[row.settings.mode], configText(row.settings)].filter(Boolean).join(' · '))}</p>` : '') +
    (limits.length ? plain(limits.map(reason => staffingReasons[reason] ?? reason).join(' · '), 'error') : '') +
    (pending ? select('Решение', 'decision', option('approve', 'Принять') + option('reject', 'Отклонить')) +
      (row.kind === 'retire' ? select('Передать незавершённое', 'transferAgentId', recordOptions(destinations, '', 'Без передачи', nameFor)) : '') +
      (limits.length ? checkbox('Подтверждаю превышение лимитов', 'overrideLimits') : '') : '') +
    (!pending && row.status === 'approved' && row.kind === 'update' && agent?.rosterStatus !== 'retired' ? actionFor('Предложить откат', 'roster-rollback', row.id) : ''),
    pending ? 'Сохранить решение' : undefined,
    pending ? values => bridge.request('decideRosterChange', { proposalId: row.id, expectedVersion: row.version,
      decision: values.decision, ...(values.transferAgentId ? { transferAgentId: values.transferAgentId } : {}), ...(values.overrideLimits ? { overrideLimits: true } : {}),
    }) : undefined, { adjustable: true });
}

const libraryLayers = { reference: 'Общая справка', decision: 'Решение студии', memory: 'Рабочая память', role: 'База роли' };
const libraryKey = row => row.key ?? 'role-notes';
const libraryScope = (row, kind) => JSON.stringify([kind, row.layer ?? 'role', row.agentId ?? null, libraryKey(row)]);

function publishLibraryEditor() {
  const current = studio();
  const agents = current.agents ?? [];
  const op = operationId();
  dialogTo('Добавить запись в библиотеку',
    select('Слой', 'layer', ['reference', 'decision', 'memory'].map(layer => option(layer, libraryLayers[layer])).join('')) +
    select('Роль для рабочей памяти', 'agentId', recordOptions(agents, '', 'Общая запись', nameFor)) +
    input('Ключ записи', 'key', '', 'required maxlength="80" placeholder="Например, project-checklist"') +
    textarea('Текст записи', 'notes', '', 'required maxlength="3000"') + input('Причина публикации', 'reason', '', 'required maxlength="500"'),
    'Опубликовать', ({ layer, agentId, key, notes, reason }) => {
      if (layer === 'memory' && !agentId) throw new Error('Выберите роль для рабочей памяти.');
      if (layer !== 'memory' && agentId) throw new Error('Общая запись не привязывается к роли.');
      return bridge.request('publishLibraryEntry', { studioId: current.id, layer, ...(agentId ? { agentId } : {}),
        key, notes, reason, operationId: op });
    }, { adjustable: true });
}

function libraryHistory() {
  const current = studio();
  const notes = studioRows('knowledge');
  const skills = studioRows('customSkills');
  const events = studioRows('knowledgeEvents').toReversed();
  const records = [...notes.map(entry => ({ ...entry, kind: 'knowledge' })), ...skills.map(entry => ({ ...entry, kind: 'customSkill' }))];
  const statuses = { publish: 'Опубликовано', rollback: 'Откат версии', revoke: 'Отозвано' };
  const groups = Map.groupBy(records, row => libraryScope(row, row.kind));
  const body = [...groups.values()].map(group => {
    const ordered = group.toSorted((a, b) => (b.version ?? 1) - (a.version ?? 1));
    const row = ordered[0];
    const history = events.filter(event => libraryScope(event, event.kind) === libraryScope(row, row.kind));
    const active = history.length ? ordered.find(entry => entry.id === history[0].versionId) : row;
    const role = current.agents?.find(agent => agent.id === row.agentId);
    return `<section class="inline-result stack compact"><h3>${safe([libraryLayers[row.layer ?? 'role'], role && nameFor(role), row.title ?? libraryKey(row)].filter(Boolean).join(' · '))}</h3>
      <ul class="legacy-list">${ordered.map(version => `<li><div class="row"><strong>Версия ${safe(version.version ?? 1)}</strong>
        ${active?.id === version.id ? badge('Текущая', 'good') : ''}</div>
        ${plain(version.notes ?? version.content, 'long-text')}
        ${actionFor(active?.id === version.id ? 'Отозвать' : 'Вернуть эту версию', 'change-knowledge', version.id)}</li>`).join('')}</ul>
      ${history.length ? `<details><summary>Изменения</summary><ul class="legacy-list">${history.map(event =>
        `<li>${safe(statuses[event.action] ?? event.action)} · ${safe(studioDate(event.createdAt))}
          ${plain(event.reason, 'muted')}</li>`).join('')}</ul></details>` : ''}</section>`;
  }).join('');
  dialogTo('Версии и история библиотеки', body || '<p class="muted">Записей пока нет.</p>', undefined, undefined, { adjustable: true });
}

function changeKnowledgeEditor(id) {
  const current = studio();
  const note = studioRows('knowledge').find(row => row.id === id);
  const record = note ?? studioRows('customSkills').find(row => row.id === id);
  if (!record) return;
  const kind = note ? 'knowledge' : 'customSkill';
  const group = studioRows(note ? 'knowledge' : 'customSkills').filter(row => libraryScope(row, kind) === libraryScope(record, kind))
    .toSorted((a, b) => (b.version ?? 1) - (a.version ?? 1));
  const event = studioRows('knowledgeEvents').findLast(row => libraryScope(row, row.kind) === libraryScope(record, kind));
  const active = event ? group.find(row => row.id === event.versionId) : group[0];
  const action = active?.id === record.id ? 'revoke' : 'rollback';
  const op = operationId();
  const title = action === 'revoke' ? 'Отозвать запись' : 'Вернуть версию записи';
  dialogTo(title, plain(`${record.title ?? libraryKey(record)} · Версия ${record.version ?? 1}`) +
    textarea('Причина изменения', 'reason', '', 'required maxlength="500"'), title, ({ reason }) =>
    bridge.request('changeKnowledge', { studioId: current.id, ...(record.agentId ? { agentId: record.agentId } : {}),
      layer: record.layer ?? 'role', kind, key: libraryKey(record), action, reason, operationId: op,
      expectedVersion: active ? active.version ?? 1 : 0, ...(action === 'rollback' ? { versionId: record.id } : {}),
    }));
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
      view = 'workspace';
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

function preferredRuntime() {
  const supported = Object.keys(runtimeNames);
  return supported.find(id => providerState[id]?.enabled !== false && providerState[id]?.available && providerState[id]?.authenticated === true) ??
    supported.find(id => providerState[id]?.enabled !== false) ?? 'codex';
}

function newStudio() {
  const firstRuntime = preferredRuntime();
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
      Object.entries(runtimeNames).map(([id, label]) => option(id, providerState[id]?.enabled === false ? `${label} · отключён в приложении` : label, firstRuntime)).join('')) +
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
  const selection = form.elements.runtime;
  if (!selection.dataset.userPicked) selection.value = preferredRuntime();
  const runtime = selection.value;
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
  const agents = activeRoster(current).filter(agent => agent.systemRole !== 'coach');
  const choices = [option('', 'Директор', agentId), ...agents.map(agent => option(String(agent.id), nameFor(agent), agentId))].join('');
  dialogTo('Новая задача', input('Название', 'title', '', 'required maxlength="160"') +
    textarea('Что нужно сделать', 'prompt', '', 'required') + select('Исполнитель', 'agentId', choices) +
    checkbox('Улучшение проекта', 'debt') + checkbox('Запустить задачу после создания', 'startImmediately', true) +
    (current.projectGit?.enabled ? select('Доставка результата', 'deliveryMode', option('', 'Текстовый результат или файл') + option('git', 'Изменения в Git')) +
      select('Независимое ревью для Git', 'reviewerId', option('', 'Выбирает студия') + agents.map(agent => option(String(agent.id), nameFor(agent))).join('')) : ''),
    'Создать задачу', async ({ agentId: raw, debt, deliveryMode, reviewerId, startImmediately, ...values }) => {
      const agent = agents.find(item => same(item.id, raw));
      const reviewer = deliveryMode === 'git' && agents.find(item => same(item.id, reviewerId));
      if (deliveryMode === 'git' && !agent) throw new Error('Выберите исполнителя из команды для задачи Git.');
      if (reviewer && reviewer.id === agent?.id) throw new Error('Выберите рецензента, который не выполняет задачу.');
      const task = await bridge.request('createTask', {
        studioId: current.id, ...values, ...(agent ? { agentId: agent.id } : {}), ...(debt ? { kind: 'debt' } : {}),
        ...(deliveryMode === 'git' ? { deliveryMode, ...(reviewer ? { reviewerId: reviewer.id } : {}) } : {}),
      });
      if (!startImmediately) return;
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
  const allTasks = tasks();
  const dependencies = pendingDependencies(latest, new Map(allTasks.map(item => [item.id, item])));
  const current = studio();
  const parallelManaged = latest.workflowManaged && current.wipLimit > 1;
  const canCancel = !latest.legacyWorktreeReview && (parallelManaged && latest.status === 'running' ||
    !latest.workflowManaged && ['running', 'waiting', 'queued'].includes(latest.status));
  const canEditBacklog = !latest.sprintId && latest.kind !== 'train' && latest.status !== 'running' &&
    ['backlog', 'ready'].includes(latest.stage);
  const canStartTraining = latest.kind === 'train' && !latest.sprintId && latest.status === 'queued' &&
    !current.manualPaused && !allTasks.some(task => task.status === 'running') && ['draft', 'idle', 'active'].includes(current.lifecycle);
  const canRun = dependencies.every(task => task.kind === 'train') &&
    (canStartTraining || parallelManaged && latest.status === 'failed' ||
      !latest.workflowManaged && ['failed', 'interrupted', 'queued'].includes(latest.status));
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
  const git = latest.gitDelivery;
  const importedGitCheck = latest.importedGitCheck;
  const links = (latest.links ?? []).filter(row => row.type !== 'blocks');
  const related = (id, label) => {
    const record = allTasks.find(row => row.id === id);
    return record ? `<li><span>${label}</span>${actionFor(record.title, 'task', id)}</li>` : '';
  };
  const purposes = { task: 'Исполнение', review: 'Ревью', director: 'Решение директора', publish: 'Запись файла', 'training-exercise': 'Упражнение' };
  const previousFocus = dialog.contains(document.activeElement) ? Object.entries(document.activeElement.dataset)[0]?.[0] : '';
  dialogTo(latest.title, `<div class="row"><div class="actions">${needsWorktreeReview ? badge('Ждёт сверки рабочего дерева', 'warn') : status(latest)}
    ${latest.kind === 'debt' ? badge('Улучшение') : ''}</div><span class="muted">${safe(nameFor(taskAgent(latest)))}</span></div>` +
    (epic ? `<div class="actions">${actionFor('К эпику', 'epic-link', epic.id)}<span class="muted">${safe(epic.title)}</span></div>` : '') +
    renderTrainingDetails(latest, studio(), allTasks) +
    prerequisiteBlock('task', latest.id) +
    (latest.replacedBy || links.length ? `<section class="inline-result"><h3>Связанные задачи</h3><ul class="legacy-list">
      ${latest.replacedBy ? related(latest.replacedBy, 'Заменена задачей') : ''}
      ${links.map(row => related(row.taskId, { origin: 'Источник', debt: 'Связанное улучшение', replaces: 'Заменяет' }[row.type] ?? 'Связь')).join('')}</ul></section>` : '') +
    (latest.carryoverHistory?.length ? `<details class="advanced"><summary>История переноса</summary><ul class="legacy-list">${latest.carryoverHistory.map(row =>
      `<li>${safe(studioRows('sprints').find(sprint => sprint.id === row.fromSprintId)?.title ?? row.fromSprintId)} · ${safe(row.reason)}</li>`).join('')}</ul></details>` : '') +
    (importedGitCheck ? `<section class="inline-result"><h3>Сверка импортированной истории Git</h3>
      <p class="muted">${safe(studioDate(importedGitCheck.checkedAt))}</p>
      <p>${importedGitCheck.targetStillMatches ? 'Версия целевой ветки совпадает.' : 'Целевая ветка изменилась или недоступна.'}</p>
      ${importedGitCheck.missing?.length ? `<p>В репозитории недостаёт версий:</p><ul class="legacy-list">${importedGitCheck.missing.map(row =>
        `<li>${safe(row.oid ?? row.id ?? row)}</li>`).join('')}</ul>` : '<p>Версии результата найдены.</p>'}</section>` : '') +
    block('Постановка задачи', latest.prompt) + block('Критерии', listText(latest.criteria)) + block('Ошибка', latest.error) +
    (latest.summary && latest.summary !== artifact ? block('Краткий отчёт', latest.summary) : '') +
    (latest.improvements?.length ? `<section class="inline-result"><h3>Найденные улучшения</h3><ul class="plan-list">
      ${latest.improvements.map(item => `<li><strong>${safe(item.title)}</strong>${plain(item.reason)}</li>`).join('')}</ul></section>` : '') +
    block('Ревью', latest.review) + block('Решение директора', latest.directorDecision) +
    block('Результат', artifact) +
    renderDelivery({
      checks: git?.checks ?? [],
      worktree: studioRows('worktrees').find(row => row.id === git?.worktreeId) ?? (git?.worktreeId ? { branchRef: git.branchRef ?? git.worktreeId, revision: git.revision } : null),
      delivery: git,
      receipts: git?.receipt ? [git.receipt] : [],
      evidence: studioRows('evidence').filter(item => item.taskId === latest.id && item.kind !== 'attachment'),
    }) +
    (attempts.length ? `<details class="advanced"><summary>Попытки запуска</summary><ul class="plan-list">${attempts.map(attempt => `<li>
      <div class="row"><strong>${safe(purposes[attempt.purpose] || 'Запуск')}</strong>${status(attempt)}</div>
      ${attempt.startedAt ? `<small class="muted">${safe(new Date(attempt.startedAt).toLocaleString('ru-RU'))}</small>` : ''}
      ${attempt.error ? plain(attempt.error) : ''}</li>`).join('')}</ul></details>` : '') +
    `<div class="actions">
      ${actionFor('Связь по задаче', 'message-task', latest.id)}
      ${canEditBacklog ? actionFor('Изменить в бэклоге', 'backlog-edit', latest.id) : ''}
      ${latest.kind !== 'train' && latest.status === 'queued' && trainingForTask(latest).length ? actionFor('Добавить учебный допуск', 'task-prerequisite', latest.id) : ''}
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
  if (item.kind === 'meeting') {
    const meeting = studioRows('meetings').find(entry => entry.id === item.meetingId);
    if (meeting) meetingDetail(meeting);
    return;
  }
  if (item.kind === 'reconcile' && item.attemptId) {
    const attempt = studioRows('attempts').find(row => row.id === item.attemptId);
    dialogTo(item.title, plain(item.body) + (item.status === 'open'
      ? select('Результат сверки', 'decision', option('retry', 'Повторить шаг') + option('complete', 'Подтвердить выполненный шаг') + option('discard', 'Отказаться от шага')) +
        textarea('Что подтверждает решение', 'reason', '', 'required')
      : item.answer ? plain(item.answer) : ''), item.status === 'open' && !attempt?.processActive ? 'Сохранить сверку' : undefined,
      item.status === 'open' && !attempt?.processActive ? values => bridge.request('resolveReconciliation', { attemptId: item.attemptId, ...values }) : undefined,
      { adjustable: true });
    return;
  }
  if (item.kind === 'plan') {
    const plan = planById(String(item.planId));
    if (plan) openPlan(plan);
    return;
  }
  const question = item.kind === 'question';
  const open = item.status === 'open';
  const op = operationId();
  const selectedAttachments = [];
  const choices = questionOptions(item);
  const body = `<div>${badge(question ? 'Вопрос' : 'Ошибка', question ? 'warn' : 'attention')}</div>` + plain(item.body) +
    (question ? renderQuestionDetails(item) + renderEvidence(studioRows('evidence').filter(row => (item.attachmentIds ?? item.answerAttachmentIds ?? []).includes(row.id))) : '') +
    (item.answer ? `<section class="inline-result"><h3>Ответ</h3>${plain(item.answer)}</section>` : '');
  inboxScope = open ? 'open' : 'resolved';
  if (view !== 'inbox') route('inbox');
  if (item.kind === 'acceptance') {
    openAcceptance(item);
    return;
  }
  dialogTo(item.title, body + (open && question
    ? (choices.length ? select('Выберите вариант', 'choiceId', option('', 'Свой ответ') + choices.map(choice => option(String(choice.id), choice.label ?? choice.title ?? choice.text ?? choice.id)).join('')) : '') +
      textarea('Ваш ответ', 'answer') + attachmentFields()
    : item.taskId ? actionFor('Открыть задачу', 'task', item.taskId) : ''),
    question ? 'Отправить ответ' : 'Отметить просмотренной', open ? ({ answer, choiceId }) => {
      if (question && !answer && !choiceId && !selectedAttachments.length) throw new Error('Выберите вариант, напишите ответ или приложите файл.');
      return bridge.request('answerInbox', answerPayload(item, {
        answer, choiceId, attachmentIds: selectedAttachments.map(row => row.id), operationId: op,
      }));
    } : undefined, { adjustable: question || (item.body?.length ?? 0) > 240 });
  if (open && question) dialogAttachments = selectedAttachments;
}

function openAcceptance(item, revise = false) {
  const task = tasks().find(entry => entry.id === item.taskId);
  const pending = item.status === 'open';
  const send = (decision, answer) => bridge.request('answerInbox', { inboxId: item.id, decision, answer });
  dialogTo(item.title, `<div>${badge(pending ? 'Приёмка результата' : 'Решение сохранено', pending ? 'warn' : 'good')}</div>` +
    plain(item.body) + (task?.artifactPath ? actionFor('Открыть файл', 'artifact', task.id) : '') +
    (task?.gitDelivery ? renderDelivery({ checks: task.gitDelivery.checks, delivery: task.gitDelivery, receipts: task.gitDelivery.receipt ? [task.gitDelivery.receipt] : [],
      evidence: studioRows('evidence').filter(row => row.taskId === task.id && row.kind !== 'attachment') }) : '') +
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
  return `<div class="actions">${badge(...({
    draft: ['Готовится', ''], pending: ['Ждёт согласования', 'warn'],
    approved: ['Подтверждён', 'good'], returned: ['Возвращён', 'warn'],
  }[plan.status] ?? [plan.status, '']))}${plan.debtSprint ? badge('Спринт улучшений') : ''}</div>
    ${plan.goal ? `<p>${safe(plan.goal)}</p>` : ''}
    ${entity('Эпик', plan.epic)}${entity('Первая история', plan.story)}
    ${agents.length ? `<section class="stack compact"><h3>Команда</h3><ul class="plan-list">${agents.map(agent =>
      `<li><strong>${safe(nameFor(agent))}</strong>${secondaryTitle(agent) ? `<span class="muted"> · ${safe(secondaryTitle(agent))}</span>` : ''}
        <div>${safe(agent.description || roleDetails[agent.role] || '')}</div>
        ${planAgentModelSummary(agent, plan.kind === 'initial')}</li>`).join('')}</ul></section>` : ''}
    ${plan.tasks?.length ? `<section class="stack compact"><h3>Задачи</h3><ol class="plan-list">${plan.tasks.map(task => `<li>
      <strong>${safe(task.title)}</strong>${task.kind === 'debt' ? ' ' + badge('Улучшение') : ''}
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

function debtPolicyEditor() {
  const current = studio();
  const policy = debtPolicyFor(current);
  const fields = debtPolicyFields.map(({ name, label, min, max }) =>
    input(label, name, policy[name], `type="number" min="${min}" max="${max}" step="1" required`)).join('');
  dialogTo('Спринты улучшений',
    `<p class="muted">${improvementsHelp}</p><label class="checkbox-field"><input type="checkbox" name="enabled"${policy.enabled ? ' checked' : ''}> <span>Планировать спринты улучшений</span></label>
      <p class="muted">${debtPolicyHint}</p>${select('Единица измерения доли', 'measure', option('taskCount', 'Число задач', policy.measure) + option('points', 'Баллы', policy.measure))}${fields}`,
    'Сохранить', values => {
      const debtPolicy = { enabled: Boolean(values.enabled), measure: values.measure };
      for (const { name, label, min, max } of debtPolicyFields) {
        const value = Number(values[name]);
        if (!Number.isInteger(value) || value < min || value > max) {
          throw new Error(`«${label}» требует целого числа от ${min} до ${max}.`);
        }
        debtPolicy[name] = value;
      }
      return bridge.request('updateStudio', { studioId: current.id, debtPolicy });
    });
}

async function assessDebt() {
  const id = studio()?.id;
  if (id == null || debtAssessments.get(id)?.pending) return;
  debtAssessments.set(id, { pending: true });
  render();
  try {
    await bridge.request('assessDebtPolicy', { studioId: id });
    debtAssessments.delete(id);
    await refresh();
  } catch (error) {
    debtAssessments.set(id, { error: error.message || 'Не удалось оценить очередь улучшений.' });
    if (view === 'settings' && studio()?.id === id) render();
  }
}

const studioPolicyMode = current => current.allowedMode ?? (current.allowed?.length ? 'studio' : 'app');
const studioSavedChoices = current => fixedModelChoices(studioPolicyMode(current) === 'studio'
  ? current.allowed : state.modelPolicy?.allowed);
const studioAllowed = current => current.effectiveAllowed ??
  (studioPolicyMode(current) === 'studio' ? current.allowed : state.modelPolicy?.allowed) ?? [];
const emptyPolicy = 'Список пуст. При автоматическом выборе роли используют модель и усилие директора.';

function policySummary(entries) {
  return entries?.length ? `<ul class="policy-list">${entries.map(entry => `<li>${safe([runtimeName(entry.runtime), entry.model,
    entry.efforts?.join(', ') || 'усилие по умолчанию'].filter(Boolean).join(' · '))}</li>`).join('')}</ul>`
    : `<p class="muted">${emptyPolicy}</p>`;
}

function policyEditor(current) {
  const editor = createModelCatalogEditor({ providers: providerState, policy: state.modelPolicy, appPolicy: state.modelPolicy, studio: current });
  dialogTo(current ? 'Модели студии' : 'Модели приложения', editor.markup, 'Сохранить',
    () => current ? bridge.request('updateStudio', { studioId: current.id, ...editor.value() })
      : bridge.request('updateModelPolicy', editor.value()), { adjustable: true });
  catalogEditor = editor;
  editor.mount($('[data-model-catalog-editor]'));
}

function agentEditor(agent) {
  const current = studio();
  const isCoach = agent?.systemRole === 'coach';
  const proposalRequired = agent && !agent.systemRole;
  const op = operationId();
  const mode = agent?.mode ?? 'dynamic';
  const role = agent?.role === 'director' ? 'other' : agent?.role ?? 'other';
  const restricted = state.modelPolicy?.configured === true || studioPolicyMode(current) === 'studio';
  const choices = restricted ? studioSavedChoices(current) : [];
  const currentEffort = agent?.effort ?? '';
  const currentChoice = agent && choices.find(item => item.model === agent.model &&
    item.runtime === (agent.runtime || current.director.runtime) && item.efforts.includes(currentEffort));
  const fixedOptions = restricted
    ? select('Модель', 'agent-model', option('', choices.length ? 'Выберите из разрешённых' : 'Список моделей пуст') +
      choices.map(item => option(modelKey(item), `${runtimeName(item.runtime)} · ${item.model}${providerState[item.runtime]?.enabled === false ? ' · провайдер отключён' : ''}`,
        currentChoice && modelKey(currentChoice))).join('')) +
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
    (proposalRequired ? textarea('Причина изменения роли', 'changeReason', '', 'required') : '') +
    select('Выбор модели', 'mode', Object.entries(modeNames).map(([id, name]) => option(id, name, mode)).join('')) +
    `<div class="form-body" id="fixed-options"${mode === 'fixed' ? '' : ' hidden'}>${fixedOptions}</div>
      <p class="muted" id="dynamic-options"${mode === 'dynamic' ? '' : ' hidden'}>Директор выбирает модель и усилие для задачи из разрешённого списка студии. Если список пуст, действуют настройки директора.</p>`,
    proposalRequired ? 'Предложить изменение' : 'Сохранить агента', async ({ name, roleTitle, role, mode, description, trainingTopics, changeReason, ...config }) => {
      let fixed = {};
      if (mode === 'fixed' && restricted) {
        const choice = studioSavedChoices(studio()).find(item => modelKey(item) === config['agent-model']);
        const effort = config['agent-effort'] ?? '';
        if (!choice?.efforts.includes(effort)) throw new Error('Выберите разрешённую модель и усилие для агента.');
        fixed = { runtime: choice.runtime, model: choice.model, effort };
      } else if (mode === 'fixed') {
        if (!config.model) throw new Error('Укажите фиксированную модель.');
        fixed = modelConfig(config);
      }
      const payload = { studioId: current.id, ...(!isCoach && { name, roleTitle, role, description }), mode, ...fixed };
      if (proposalRequired) {
        const { studioId, ...settings } = payload;
        const proposal = await bridge.request('proposeRosterChange', { studioId, agentId: agent.id, kind: 'update', reason: changeReason, agent: settings, operationId: op });
        await refresh();
        rosterDecisionEditor(proposal);
        return false;
      }
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
    legacyPreviews.set(root, result);
    const fields = { tasks: 'Задачи', archivedTasks: 'Архивные задачи', roles: 'Роли', openQuestions: 'Открытые вопросы', worktrees: 'Рабочие деревья', artifacts: 'Артефакты' };
    const items = values => `<ul>${values.map(value => `<li>${safe(value)}</li>`).join('')}</ul>`;
    const size = result.artifactBytes == null ? '' : new Intl.NumberFormat('ru', { style: 'unit', unit: 'byte' }).format(result.artifactBytes);
    dialogTo('Предварительный импорт', `<div>${badge(result.valid ? 'Структура распознана' : 'Структура требует проверки', result.valid ? 'good' : 'warn')}</div>` +
      plain(result.root || root) + `<dl class="studio-meta">${Object.entries(fields).filter(([key]) => result.counts?.[key] != null)
        .map(([key, name]) => `<dt>${name}</dt><dd>${safe(result.counts[key])}</dd>`).join('')}${size ? `<dt>Объём артефактов</dt><dd>${safe(size)}</dd>` : ''}</dl>` +
      (result.ownerLanguage ? `<p>Язык отчётов: <strong>${safe(result.ownerLanguage)}</strong>
        ${result.ownerLanguageSource === 'fallback' ? '· запасной вариант' : '· из настроек старой студии'}</p>` : '') +
      (result.projectCandidates?.length ? `<section><h3>Папки проектов</h3>${items(result.projectCandidates)}</section>` : '') +
      (result.unresolvedReferences?.length ? `<section><h3>Ссылки, которые требуют проверки</h3>${items(result.unresolvedReferences.map(row =>
        `${row.sourceId} → ${row.targetId} (${row.kind})`))}</section>` : '') +
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
    providerState[runtime] = { ...providerState[runtime], ...await bridge.request('inspect', { runtime }) };
  } catch (error) {
    providerState[runtime] = { enabled: providerState[runtime]?.enabled, available: false, detail: error.message || 'Проверка подключения не удалась.' };
  } finally {
    inspecting.delete(runtime);
    render();
    updateWizardProvider();
    catalogEditor?.updateProviders(providerState);
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
  const preview = legacyPreviews.get(source);
  dialogTo(legacy ? 'Импорт старой студии' : 'Импорт файла Hearth',
    (legacy ? `<div class="muted">Источник${plain(source)}</div>` : '<p class="muted">После выбора рабочей папки откроется окно выбора файла экспорта.</p>') +
    input('Название новой студии (необязательно)', 'name', '', 'maxlength="120"') +
    pathField('', { label: 'Рабочая папка новой студии' }) +
    (legacy ? languageField('Язык отчётов', 'language', preview?.ownerLanguage ?? 'Русский') : '') +
    (legacy ? textarea('Артефакты для копирования (необязательно)', 'artifactPaths', '', 'placeholder="studio/artifacts/имя-файла.md"') +
      '<p class="muted">Укажите по одному относительному пути на строку.</p>' : ''),
    'Импортировать', async ({ root, name, language, artifactPaths = '' }) => {
      if (!root) throw new Error('Выберите рабочую папку для новой студии.');
      const paths = [...new Set(artifactPaths.split('\n').map(path => path.trim()).filter(Boolean))];
      const imported = await bridge.request(legacy ? 'importLegacy' : 'importBundle', {
        root, ...(name && { name }), ...(legacy && { source, artifactPaths: paths, language }),
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
  const evidence = studioRows('evidence');
  const evidenceFiles = checkList('Сохранённые доказательства и вложения', evidence, 'evidence-export', [],
    row => row.name ?? row.filename ?? row.sourcePath ?? row.id);
  dialogTo(snapshot ? 'Экспорт снимка' : 'Экспорт шаблона',
    snapshot ? '<p>Снимок включает состав студии, планы, задачи и решения. Отметьте файлы, которые нужно включить.</p>' + files + evidenceFiles
      : '<p>Шаблон сохраняет настройки и роли студии для нового проекта.</p>',
    'Сохранить файл', async values => {
      const artifactPaths = snapshot ? paths.filter((_, index) => values[`artifact-${index}`]) : [];
      const evidenceIds = snapshot ? checkedIds(evidence, values, 'evidence-export') : [];
      const result = await bridge.request('exportStudio', { studioId: current.id, mode, includeArtifacts: artifactPaths.length > 0, artifactPaths, evidenceIds });
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
  'debt-policy': debtPolicyEditor,
  agent: () => agentEditor(),
  import: importPreview,
  'import-bundle': () => importEditor(),
  dispatch: dispatchEditor,
  'grooming-settings': groomingEditor,
  'request-grooming': () => void workCommand('requestGrooming', { studioId: studio().id }, 'Разбор очереди начат.'),
  'next-sprint': () => void workCommand('startNextSprint', { studioId: studio().id }, 'Директор готовит план следующего спринта.'),
  'project-git': projectGitEditor,
  cleanup: cleanupEditor,
  usage: usageDialog,
  'usage-tariff': usageTariffEditor,
  diagnosis: diagnosisDialog,
  'restart-app': restartAppEditor,
  notifications: notificationsEditor,
  messages: conversationsDialog,
  'backlog-task': () => backlogEditor(),
  phase: () => phaseEditor(),
  meeting: meetingEditor,
  'roster-hire': () => rosterProposalEditor(),
  'roster-history': rosterHistory,
  staffing: staffingEditor,
  'publish-library': publishLibraryEditor,
  'library-history': libraryHistory,
};

function legacyAction(data, target) {
  const withRow = (rows, id, handle) => {
    const row = rows.find(value => same(value.id, id));
    if (row) handle(row);
  };
  const showMeeting = (id, handle) => withRow(studioRows('meetings'), id, handle);
  const showRoster = (id, handle) => withRow(studioRows('rosterProposals'), id, handle);
  if (data.saveDiagnostics !== undefined) {
    target.disabled = true;
    void bridge.request('saveDiagnostics', { studioId: studio().id })
      .then(saved => { if (saved) { dialog.close(); notice('Диагностика сохранена.'); } })
      .catch(error => dialogError(error.message || 'Не удалось сохранить диагностику.'))
      .finally(() => { target.disabled = false; });
  } else if (data.addProjectCheck !== undefined) {
    const rows = $('[data-project-checks]');
    rows.insertAdjacentHTML('beforeend', projectCheckFields());
    rows.lastElementChild.querySelector('input')?.focus();
  } else if (data.removeProjectCheck !== undefined) {
    target.closest('[data-project-check]')?.remove();
    $('[data-add-project-check]')?.focus();
  } else if (data.pickAttachment !== undefined) void addAttachment(target);
  else if (data.removeAttachment !== undefined) {
    dialogAttachments?.splice(Number(data.removeAttachment), 1);
    renderAttachmentFields();
  } else if (data.evidence !== undefined || data.saveEvidence !== undefined) {
    const evidenceId = data.evidence ?? data.saveEvidence;
    if (studioRows('evidence').some(row => same(row.id, evidenceId))) void openLegacyFile(data.saveEvidence !== undefined ? 'saveEvidence' : 'openEvidence', evidenceId);
  } else if (data.conversation !== undefined) withRow(studioRows('conversations'), data.conversation, conversation => messageEditor({ conversation }));
  else if (data.message !== undefined) messageEditor({ agentId: data.message });
  else if (data.messageNote !== undefined) messageEditor({ kind: 'note' });
  else if (data.messagePriority !== undefined) void workCommand('applyConversationProposal', { studioId: studio().id, messageId: data.messagePriority }, 'Приоритет изменён.');
  else if (data.messageTask !== undefined) withRow(tasks(), data.messageTask, task => messageEditor({ taskId: task.id, agentId: task.agentId }));
  else if (data.agentHistory !== undefined) agentHistory(data.agentHistory);
  else if (data.backlogEdit !== undefined) withRow(tasks(), data.backlogEdit, backlogEditor);
  else if (data.backlogReplace !== undefined) withRow(tasks(), data.backlogReplace, replaceBacklogEditor);
  else if (data.epicPriority !== undefined) withRow(studioRows('epics'), data.epicPriority, epic =>
    dialogTo('Приоритет эпика', input('Приоритет от 0 до 100', 'priority', epic.priority ?? 0, 'type="number" min="0" max="100" required'),
      'Сохранить', values => bridge.request('setEpicPriority', { studioId: studio().id, epicId: epic.id, priority: Number(values.priority) })));
  else if (data.closeSprint !== undefined) withRow(studioRows('sprints'), data.closeSprint, closeSprintEditor);
  else if (data.phaseEdit !== undefined) withRow(studioRows('phases'), data.phaseEdit, phaseEditor);
  else if (data.phaseTransition !== undefined) withRow(studioRows('phases'), data.phaseTransition, phaseTransitionEditor);
  else if (data.resolveGrooming !== undefined) void workCommand('resolveGrooming', { studioId: studio().id, groomingId: data.resolveGrooming }, 'Разбор очереди завершён.');
  else if (data.meetingDetail !== undefined) showMeeting(data.meetingDetail, meetingDetail);
  else if (data.meetingResume !== undefined) {
    dialog.close();
    void workCommand('resumeMeeting', { meetingId: data.meetingResume }, 'Встреча возобновлена.');
  } else if (data.meetingResolve !== undefined) showMeeting(data.meetingResolve, resolveMeetingEditor);
  else if (data.meetingReplace !== undefined) showMeeting(data.meetingReplace, replaceParticipantEditor);
  else if (data.waivePrerequisite !== undefined) withRow(studioRows('prerequisites'), data.waivePrerequisite, waivePrerequisiteEditor);
  else if (data.taskPrerequisite !== undefined) withRow(tasks(), data.taskPrerequisite, taskPrerequisiteEditor);
  else if (data.rosterAgent !== undefined) withRow(studio().agents, data.rosterAgent, agent =>
    rosterProposalEditor({ agent, kind: agent.rosterStatus === 'retired' ? 'return' : 'retire' }));
  else if (data.rosterDecision !== undefined) showRoster(data.rosterDecision, rosterDecisionEditor);
  else if (data.rosterRollback !== undefined) showRoster(data.rosterRollback, row =>
    withRow(studio().agents, String(row.agentId), agent => rosterProposalEditor({ agent, kind: 'rollback', rollbackProposalId: row.id })));
  else if (data.changeKnowledge !== undefined) changeKnowledgeEditor(data.changeKnowledge);
  else return false;
  return true;
}

async function openLegacyFile(command, evidenceId) {
  try {
    await bridge.request(command, { studioId: studio().id, evidenceId });
  } catch (error) {
    const message = error.message || 'Не удалось открыть файл.';
    if (dialog.open) dialogError(message);
    else notice(message, true);
  }
}

document.addEventListener('click', event => {
  const target = event.target.closest('button');
  if (!target) return;
  const data = target.dataset;
  if (data.close !== undefined) dialog.close();
  else if (!bridge || dialogBusy) return;
  else if (legacyAction(data, target)) return;
  else if (data.reload !== undefined) void refresh();
  else if (data.folder !== undefined) void pickFolder(form.elements[data.folder || 'root']);
  else if (data.enterStudio !== undefined || data.workspaceInbox !== undefined) {
    selectStudio(data.enterStudio ?? data.workspaceInbox);
    route(data.workspaceInbox === undefined ? 'overview' : 'inbox');
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
  else if (data.assessDebt !== undefined) void assessDebt();
  else if (data.initialize !== undefined) void workCommand('initializeStudio', { studioId: studio().id });
  else if (data.runAction) {
    if (dialog.open) dialog.close();
    void workCommand('setStudioRunning', { studioId: studio().id, action: data.runAction });
  }
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
  }
});

form.addEventListener('change', ({ target }) => {
  if (target.name === 'chooseParticipants') {
    for (const region of form.querySelectorAll('[data-manual-participants], [data-manual-prerequisites]')) {
      region.hidden = target.checked;
    }
  }
  const teamRow = target.closest('[data-plan-agent]');
  if (teamRow && (target.matches('[data-plan-mode]') || target.matches('[data-plan-model]'))) {
    updateTeamModel(teamRow, { chooseEffort: target.matches('[data-plan-model]') });
  }
  if (target.name === 'role') $('#role-guide').textContent = roleDetails[target.value] || '';
  if (target.name === 'runtime' && $('#wizard-provider')) {
    target.dataset.userPicked = 'true';
    updateWizardProvider();
    if (!providerState[target.value]) void inspect(target.value);
    return;
  }
  if (target.name === 'mode') {
    $('#fixed-options').hidden = target.value !== 'fixed';
    $('#dynamic-options').hidden = target.value !== 'dynamic';
  }
  if (target.name === 'agent-model') {
    const choice = studioSavedChoices(studio()).find(item => modelKey(item) === target.value);
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

content.addEventListener('change', ({ target }) => {
  if (target.name === 'approveSprints') void workCommand('updateStudio', { studioId: studio().id, approveSprints: target.checked });
  else if (target.name === 'appNotifications') void workCommand('updateNotifications', { enabled: target.checked });
  else if (target.dataset.providerEnabled) void workCommand('updateProviderPreference', { runtime: target.dataset.providerEnabled, enabled: target.checked });
  else if (target.id === 'theme-select') {
    stored('theme', target.value);
    applyTheme(target.value);
  }
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
  catalogEditor = undefined;
  if (opener?.isConnected) opener.focus();
  else content.focus();
  if (notificationTarget && !dialog.open) void goToNotification();
});

$('#studio-select').addEventListener('change', ({ target }) => {
  selectStudio(target.value);
  route('overview');
});

function applyTheme(value) {
  document.documentElement.dataset.theme = ['light', 'dark'].includes(value) ? value : 'system';
}
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
