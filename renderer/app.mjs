import {copySystem,inboxLabel} from './copy.mjs';
import {copy, onCopyLocale, setCopyLocale , getCopyLocale} from './copy.mjs';
import { agentActivity, actorState, buildRooms, languageChoices, pendingStudioPlan, roleDetails, roleNames, taskForAgent } from './workshop.mjs';
import { paintRooms } from './room-art.mjs';
import {localeNames, textFor,tokenCount} from './locale.mjs';
import {createInspectorHistory, membersOfEpic} from './inspector.mjs';
import { studioActivityStatus, taskFacts } from './owner-facts.mjs';
import { publishedPaths, renderWork, registerRows } from './work-view.mjs';
import { installDialogSize } from './dialog-size.mjs';
import { installInspectorResize } from './inspector-size.mjs';
import { catalogEfforts, fixedModelChoices, modelKey } from './model-policy.mjs';
import { createModelCatalogEditor } from './model-catalog-editor.mjs';
import { renderWorkspaceHome } from './workspace-view.mjs';
import { initialWorkspaceView,renderToday,todayItems } from './today-view.mjs';
import { progressMark,stageMark } from './presentation.mjs';
import { taskRecovery } from './task-recovery.mjs';
import { readStudioDraft,writeStudioDraft,clearStudioDraft } from './studio-draft.mjs';
import { coachTitle, parseSkillTopics, pendingDependencies, renderSkillLibrary, renderSkillPreview, renderTrainingDetails, roleReadiness, skillMinStars, skillStarLabel } from './coach-view.mjs';
import { debtPolicyFields, debtPolicyFor, debtPolicyHint, improvementsHelp, renderDebtSettings } from './debt-view.mjs';
import { answerPayload, questionOptions, renderDelivery, renderDiagnostic, renderEvidence, renderQuestionDetails, renderUsageReport } from './legacy-view.mjs';

const bridge = window.hearth;
const $ = selector => document.querySelector(selector);
const content = $('#content');
const dialog = $('#dialog');
const ownerPanel = $('#owner-inspector');
const ownerTrail = createInspectorHistory();
let ownerOrigin;
let ownerMarkup;
const historyLimits=new Map();
let renderedViewKey;
const folderProbes = new Map();
function refreshFolderAvailability(){
  for(const studio of state.studios.filter(s=>!s.archivedAt && !s.projectDetached)){
    const prior=folderProbes.get(studio.id);
    if(prior?.root===studio.root && (prior.pending || Date.now()-prior.time<30000))continue;
    const entry={root:studio.root,time:Date.now(),pending:true,available:prior?.available};
    folderProbes.set(studio.id,entry);
    bridge.request('projectAvailability',{studioId:studio.id}).then(result=>{
      if(folderProbes.get(studio.id)!==entry)return;
      entry.available=result.available;entry.pending=false;entry.time=Date.now();
      if(['workspace','today'].includes(view) && entry.available!==prior?.available)render();
    }).catch(()=>{entry.pending=false;});
  }
}
const commentDrafts=new Map();
const commentKey=(s,t)=>JSON.stringify([s,t]);
const form = $('#dialog-form');
const configureDialogSize = installDialogSize(dialog, () => stored('dialog-size'), value => stored('dialog-size', value));
const runtimeNames = { codex: 'Codex', claude: 'Claude Code' };
const makeModeNames = () => ({ inherit: copy('Как у директора'), fixed: copy('Фиксированные модель и усилие'), dynamic: copy('Выбирает директор') });
let modeNames = makeModeNames();
onCopyLocale(() => { modeNames = makeModeNames(); });
const makeWorkspaceViews = () => ({ today: copy('Сегодня'), workspace: copy('Все студии'), 'app-settings': copy('Настройки приложения') });
let workspaceViews = makeWorkspaceViews();
onCopyLocale(() => { workspaceViews = makeWorkspaceViews(); });
const makeStudioViews = () => ({ overview: copy('Обзор'), work: copy('Работа'), inbox: copy('Входящие'), workshop: copy('Мастерская'), skills: copy('Библиотека'), settings: copy('Настройки студии') });
let studioViews = makeStudioViews();
onCopyLocale(() => { studioViews = makeStudioViews(); });
const views = { ...workspaceViews, ...studioViews };
const icons = {
  today: '<circle cx="12" cy="12" r="5"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/>',
  workspace: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18m-12 0v10"/>',
  'app-settings': '<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/>',
  skills: '<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="8" y="4" width="5" height="16" rx="1"/><path d="m16 5 4-1 3 15-4 1zM5 8h1m4 0h1"/>',
  overview: '<rect x="3" y="3" width="7" height="8" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="3" y="15" width="7" height="6" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/>',
  work: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16m6-16v16M5.5 8h1m5 0h1m5 0h1"/>',
  inbox: '<path d="M5 4h14l3 9v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6zM2 13h6l2 3h4l2-3h6"/>',
  workshop: '<path d="M5 13V8a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v5M6 19v2m12-2v2M4 19h16a1 1 0 0 0 1-1v-5a2 2 0 0 0-4 0v2H7v-2a2 2 0 0 0-4 0v5a1 1 0 0 0 1 1Z"/>',
  settings: '<path d="M3 6h6m4 0h8M3 12h12m4 0h2M3 18h2m4 0h12M9 4v4m6 2v4M5 16v4"/>',
};
const makeStatuses = () => ({
  queued: [copy('В очереди'), ''], running: [copy('В работе'), 'good'], waiting: [copy('Ждёт ответа'), 'warn'],
  completed: [copy('Готово'), 'good'], failed: [copy('Ошибка'), 'attention'],
  interrupted: [copy('Прервана'), 'attention'], cancelled: [copy('Отменена'), ''],
});
let statuses = makeStatuses();
onCopyLocale(() => { statuses = makeStatuses(); });
const makeStudioStatuses = () => ({
  draft: [copy('Черновик'), ''], planning: [copy('Подготовка плана'), 'good'],
  'awaiting-approval': [copy('Ждёт согласования'), 'warn'], active: [copy('В работе'), 'good'],
  paused: [copy('На паузе'), 'warn'], idle: [copy('Нет активной работы'), ''], error: [copy('Требуется внимание'), 'attention'],
});
let studioStatuses = makeStudioStatuses();
onCopyLocale(() => { studioStatuses = makeStudioStatuses(); });
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
const busyControls = new Set();
let opener;
let taskDialog;
let dialogMeeting;
let dialogConversation;
let dialogReconciliation;
let notificationTarget;
let openingNotification = false;
let todayFilter = '';
let todayContext;
let todayOutcome;
let workBusy = false;
let workTab;
let registryQuery = '';
let registryStage = '';
let registryOwner = '';
let registrySprint = '';
const expandedEpics = new Set();
const expandedRecords = new Set();
let boardShowEmpty=false;
let boardAllSprints=false;
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
const ui = key => textFor(state.appLocale ?? 'en', key);
const studioDate = value => Number.isFinite(new Date(value ?? '').getTime()) ? new Date(value).toLocaleString(state.appLocale ?? 'en') : '';

function stored(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(`hearth:${key}`);
    localStorage.setItem(`hearth:${key}`, value);
  } catch { /* The app can run without saved UI preferences. */ }
}

const studio = () => state.studios.find(item => !item.archivedAt && String(item.id) === studioId);
const tasks = () => state.tasks.filter(item => String(item.studioId) === studioId);
const entries = () => state.inbox.filter(item => String(item.studioId) === studioId);
const plans = () => (state.plans ?? []).filter(item => String(item.studioId) === studioId);
const planById = raw => plans().find(plan => same(plan.id, raw));
const same = (id, raw) => String(id) === raw;
const withRow = (rows, id, handle) => {
  const row = rows.find(value => same(value.id, id));
  if (row) handle(row);
};
const escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const safe = value => String(value ?? '').replace(/[&<>"']/g, character => escapeMap[character]);
const glyph = key => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[key]}</svg>`;
const button = (label, attributes, secondary = false) => `<button class="action${secondary ? ' secondary' : ''}" type="button" ${attributes}>${safe(label)}</button>`;
const actionFor = (label, target, id, secondary = true) => button(label, `data-${target}="${safe(id)}"`, secondary);
const heading = (title, detail = '', actions = '') => `<header class="page-heading"><div><h1>${safe(title)}</h1>${detail ? `<p class="muted">${safe(detail)}</p>` : ''}</div>${actions && `<div class="actions">${actions}</div>`}</header>`;
const empty = (title, detail, action = '') => `<div class="panel empty"><h2>${safe(title)}</h2><p class="muted">${safe(detail)}</p>${action}</div>`;
const badge = (label, tone = '') => `<span class="status ${tone}"><span aria-hidden="true"></span>${safe(label)}</span>`;
const status = task => {
  if (task.status==='completed' && task.workflowManaged && task.stage && task.stage!=='done') return badge(copy('На ревью'),'warn');
  if (task.stage==='blocked' && task.status==='queued') return badge(copy('Ждёт зависимостей'),'warn');
  return badge(...(statuses[task.status] ?? [task.status, '']));
};
const titleFor = agent => agent?.systemRole === 'coach' ? coachTitle : agent?.roleTitle || roleNames[agent?.role] || agent?.role || copy('Директор');
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
  todayContext = undefined;
  dismissInspector(false);
  studioId = id == null ? '' : String(id);
  selectedAgent = '';
  inboxScope = 'open';
  workTab = undefined;
  registryQuery = '';
  registryStage = '';
  registryOwner = '';
  registrySprint = '';
  expandedEpics.clear();
  expandedRecords.clear();
  boardShowEmpty=false;
  boardAllSprints=false;
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
    const previousFacts = taskDialog && JSON.stringify(taskFacts(state, taskDialog.studioId, taskDialog.id));
    const previousEvidence = taskDialog && JSON.stringify(studioRows('evidence').filter(row => row.taskId === taskDialog.id));
    state = snapshot;
    if(todayContext&&!snapshot.studios.some(s=>s.id===todayContext.row.studioId&&!s.archivedAt)){
      closeTodayContext();
      if(dialog.open)dialog.close();
      notice(copy('Студия больше недоступна для этого действия.'),true);
    }
    if (snapshot.providers) Object.assign(providerState, snapshot.providers);
    catalogEditor?.updateProviders(providerState);
    if (!studio()) selectStudio(snapshot.studios.find(s=>!s.archivedAt)?.id);
    if (!ready && view==='workspace' && !notificationTarget) view=initialWorkspaceView(snapshot);
    ready = true;
    render();
    if (ownerTrail.current) paintInspector(false);
    updateWizardProvider();
    if (dialog.open && !dialogBusy && taskDialog) {
      const latest = tasks().find(task => task.id === taskDialog.id && task.studioId === taskDialog.studioId);
    if (latest && (JSON.stringify(latest) !== JSON.stringify(taskDialog) ||
          previousFacts !== JSON.stringify(taskFacts(snapshot, latest.studioId, latest.id)) ||
          previousTraining !== renderTrainingDetails(latest, studio(), tasks()) ||
          previousEvidence !== JSON.stringify(studioRows('evidence').filter(row => row.taskId === latest.id)))) openTask(latest);
    } else if (dialog.open && !dialogBusy && dialogMeeting) {
      const latest = studioRows('meetings').find(row => row.id === dialogMeeting.id);
      if (latest && JSON.stringify(latest) !== JSON.stringify(dialogMeeting)) {
        const scroll = $('#dialog-body').scrollTop;
        meetingDetail(latest);
        $('#dialog-body').scrollTop = scroll;
      }
    } else if (dialog.open && !dialogBusy && dialogReconciliation) {
      const item = entries().find(row => row.id === dialogReconciliation.id);
      if (item && (item.status !== dialogReconciliation.status ||
          reconciliationPending(item) !== dialogReconciliation.pending)) openInbox(item);
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
      notice(error.message || copy('Не удалось загрузить студии.'), true);
      if (!ready) content.innerHTML = empty(copy('Студии недоступны'), copy('Проверьте подключение к локальному хранилищу.'), button(copy('Повторить загрузку'), 'data-reload'));
    }
  }
}

function render() {
  const nextKey=JSON.stringify([studioId,view]), sameView=nextKey===renderedViewKey;
  const savedFields=sameView ? ['[data-file-query]','[data-file-from]','[data-file-to]','[data-local-library]','[data-registry-sprint]','[data-registry-owner]']
    .flatMap(selector=>{const el=content.querySelector(selector);return el?[{selector,value:el.value,focus:el===document.activeElement,caret:el.selectionStart}]:[];}) : [];
  const savedTop=sameView ? content.scrollTop : 0;
  renderedViewKey=nextKey;
  const current = studio();
  const inStudio = Object.hasOwn(studioViews, view);
  const draft=readStudioDraft(localStorage);
  const hasDraft=Boolean(draft?.pending||draft?.fields?.name||draft?.fields?.brief||draft?.fields?.root);
  const picker = $('#studio-select');
  setCopyLocale(state.appLocale ?? 'en');
  document.documentElement.lang = state.appLocale ?? 'en';
  for(const [selector,attribute,source] of [
    ['.rail','aria-label','Навигация студии'],['#workspace-navigation','aria-label','Приложение'],
    ['#navigation','aria-label','Разделы'],['#owner-resize','aria-label','Ширина панели'],
    ['[data-dialog-width]','aria-label','Ширина окна'],
    ['.dialog-heading [data-close]','aria-label','Закрыть'],['[data-dialog-resize]','aria-label','Изменить размер окна стрелками'],
    ['[data-dialog-resize]','title','Потяните угол или используйте стрелки']]) {
    const node=$(selector);
    if(node)node.setAttribute(attribute,copy(source));
  }
  $('.studio-controls .picker span').textContent = ui('studio');
  $('.studio-controls [data-open="studio"]').textContent = '＋ '+ui('newStudio');
  const focused = document.activeElement;
  const registryControl = focused?.matches('[data-registry-query]') ? '[data-registry-query]'
    : focused?.matches('[data-registry-stage]') ? '[data-registry-stage]' : '';
  const registryCaret = registryControl === '[data-registry-query]' ? [focused.selectionStart, focused.selectionEnd] : null;
  const focusRoot = [content, $('#navigation'), $('#workspace-navigation')].find(container => container.contains(focused) && focused !== container);
  const focusTarget = focusRoot && Object.entries(focused.dataset).find(([key]) => ['view', 'enterStudio', 'workspaceInbox', 'providerEnabled', 'agent', 'task', 'inbox', 'scope', 'open', 'inspect', 'editAgent', 'plan', 'initialize', 'runAction', 'artifact', 'workTab', 'assessDebt', 'message', 'meetingDetail', 'legacyAction', 'evidence','todayId'].includes(key));
  const autonomyFocused = focused?.getAttribute('name') === 'approveSprints';
  const skillFieldSelection = focused?.matches('[data-skill-search] [name="topics"]')
    ? [focused.selectionStart, focused.selectionEnd] : null;
  const libraryDetails = view === 'skills'
    ? new Set(Array.from(content.querySelectorAll('[data-library-detail][open]'), node => node.dataset.libraryDetail)) : null;
  picker.disabled = !state.studios.length;
  picker.innerHTML = state.studios.filter(s=>!s.archivedAt).map(item => option(String(item.id), item.name, studioId)).join('') || copy('<option>Нет студий</option>');
  $('.studio-controls').hidden = !inStudio || !current;
  const openCount = entries().filter(item => item.status === 'open').length;
  const navigation = group => Object.keys(group).filter(key => key !== 'skills').map(key => `<button type="button" data-view="${key}"${view === key ? ' aria-current="page"' : ''}>${glyph(key)}<span>${ui(key==='workshop'?'team':key)}</span>${key === 'inbox' && openCount ? `<span class="nav-count">${openCount}</span>` : ''}</button>`).join('');
  $('#workspace-navigation').innerHTML = navigation(workspaceViews);
  $('#navigation').hidden = !inStudio || !current;
  if (inStudio && current) $('#navigation').innerHTML = navigation(studioViews);
  $('#breadcrumb').innerHTML = `<span>${safe(inStudio && current ? current.name : 'Hearth Studio')}</span><span aria-hidden="true">›</span><strong>${ui(view==='workshop'?'team':view)}</strong>`;
  content.innerHTML = view === 'today' ? renderToday(state,{studioFilter:todayFilter,projectAvailability:Object.fromEntries(folderProbes),outcome:todayOutcomeDetails(),hasDraft}) :
    view === 'workspace' ? renderWorkspaceHome({...state,projectAvailability:Object.fromEntries(folderProbes),hasDraft}) : view === 'app-settings' ? appSettings() : current
    ? ({ overview, work, inbox, workshop, skills, settings })[view]()
    : heading(views[view]) + empty(copy('Создайте студию'), copy('Опишите проект, выберите рабочую папку и подключение директора.'), button(copy('Создать студию'), 'data-open="studio"'));
  if(['workspace','today'].includes(view) && bridge)refreshFolderAvailability();
  if (view === 'workshop' && current) paintRooms(content);
  for(const saved of savedFields){
    const el=content.querySelector(saved.selector);
    if(!el)continue;
    el.value=saved.value;
    if(!saved.selector.includes('registry') && saved.value)el.dispatchEvent(new Event('input',{bubbles:true}));
    if(saved.focus){el.focus({preventScroll:true});if(saved.caret!=null && el.setSelectionRange)el.setSelectionRange(saved.caret,saved.caret);}
  }
  content.scrollTop=savedTop;
  if (registryControl) {
    const control = content.querySelector(registryControl);
    control?.focus({ preventScroll: true });
    if (registryCaret) control?.setSelectionRange(...registryCaret);
  }
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
  return heading(copy('Работа'), studio().name, button(copy('Новая задача'), 'data-open="task"')) + renderWork({
    studio: studio(), tasks: tasks(), epics: rows('epics'), stories: rows('stories'),
    sprints: rows('sprints'), meetings: rows('meetings'), plans: plans(), tab: workTab ?? 'registry', expandedEpics,expandedRecords,boardShowEmpty,boardAllSprints, registryQuery, registryStage, registryOwner, registrySprint,
    phases: rows('phases'),
    evidence: rows('evidence').filter(item => item.kind !== 'attachment'),
  });
}

function skills() {
  const current = studio();
  const rows = key => (state[key] ?? []).filter(item => String(item.studioId) === studioId);
  const materials=['skills','knowledge','customSkills'].flatMap(kind=>rows(kind).map(item=>{
    const owner=current.agents.find(a=>a.id===item.agentId);
    const label=item.title || item.key || item.path || item.id;
    const metadata=[owner && nameFor(owner),item.version ?? item.commit,studioDate(item.createdAt)].filter(Boolean).join(' · ');
    const search=[label,metadata,item.repo,item.notes,item.content,item.createdAt,item.trainingTaskId].filter(Boolean).join(' ');
    return `<li data-material-search="${safe(search)}"><button type="button" class="text-button" data-used-material="${safe(item.id)}" data-kind="${kind}">${safe(label)}</button> · ${safe(metadata)}</li>`;
  }));
  return heading(copy('Библиотека'), current.name, button(copy('Добавить запись'), 'data-open="publish-library"') +
    button(copy('Версии и история'), 'data-open="library-history"', true)) +
    (materials.length ? `<label class="field"><span>${ui('findMaterial')}</span><input type="search" data-local-library></label><ul class="legacy-list" data-local-results hidden>${materials.join('')}</ul>` : '') + renderSkillLibrary({
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
    updateSkillPreview(search, { status: 'error', error: copy('Введите хотя бы одну тему.') });
    return;
  }
  updateSkillPreview(search, { status: 'pending' });
  try {
    const { candidates, warnings } = await bridge.request('searchSkillRepositories', { studioId: studio().id, topics });
    updateSkillPreview(search, { status: 'done', candidates, warnings });
  } catch (error) {
    updateSkillPreview(search, { status: 'error', error: error.message || copy('Поиск на GitHub недоступен. Попробуйте ещё раз.') });
  }
}

function route(next) {
  if (!Object.hasOwn(views, next)) return;
  if (next!=='today' && todayContext) closeTodayContext();
  if (next !== view) dismissInspector(false);
  view = next;
  notice();
  content.focus();
  render();
}

function closeTodayContext() {
  if (!todayContext) return;
  studioId=todayContext.previousStudioId;
  todayContext=undefined;
}

function openTodayDecision(row) {
  if (!row || dialog.open) return;
  const owner=state.studios.find(s=>s.id===row.studioId&&!s.archivedAt);
  if (!owner) return;
  closeTodayContext();
  const entry=state.inbox.find(i=>i.studioId===row.studioId&&i.id===row.inboxId);
  todayContext={row, previousStudioId:studioId, taskId:entry?.taskId};
  todayOutcome=undefined;
  studioId=String(row.studioId);
  if (row.target.kind==='phase') withRow(studioRows('phases'),row.target.id,phaseTransitionEditor);
  else if (row.target.kind==='roster') withRow(studioRows('rosterProposals'),row.target.id,rosterDecisionEditor);
  else if (row.target.kind==='meeting') withRow(studioRows('meetings'),row.target.id,meetingDetail);
  else if (row.target.kind==='priority') withRow(studioRows('conversationMessages'),row.target.id,message=>{
    const proposal=message.priorityProposal;
    dialogTo(copy('Предложение по приоритету'),plain(message.text)+
      plain(copy`${proposal.taskTitle} · Приоритет ${proposal.priority}`)+actionFor(copy('Открыть задачу'),'task',proposal.taskId),
      copy('Применить приоритет'),()=>bridge.request('applyConversationProposal',{studioId:row.studioId,messageId:message.id}));
  });
  else if (entry) openInbox(entry);
  if (!dialog.open) closeTodayContext();
}

function todayOutcomeDetails() {
  if(!todayOutcome)return undefined;
  const {taskId,studioId:owner,action,row}=todayOutcome;
  const task=state.tasks.find(t=>t.id===taskId&&t.studioId===owner);
  const studio=state.studios.find(s=>s.id===owner);
  const active=state.attempts?.findLast(a=>a.taskId===taskId&&a.studioId===owner&&a.status==='running');
  const item=state.inbox.find(i=>i.studioId===owner&&i.id===row.inboxId);
  let label=copy('Решение сохранено'), detail=studio?.name??'';
  if(task?.gitDelivery?.status==='merged')label=copy('Изменения слиты');
  else if((action==='retry'||action==='resume')&&task?.status==='failed'){
    label=copy('Требуется внимание');
    detail=task.error||state.inbox.findLast(i=>i.studioId===owner&&i.taskId===taskId&&i.kind==='error'&&i.status==='open')?.body||detail;
  }
  else if(active)detail=copy`В работе · ${active.id}`;
  else if(studio?.scheduleWaiting)detail=copy`Ближайшее рабочее окно · ${studioDate(studio.nextScheduleAt)}`;
  else if(action==='retry'&&task?.status==='queued')detail=copy('В очереди');
  else if(task?.stage==='done')detail=copy('Готово');
  else if(item?.status==='open')label=copy('Требуется внимание');
  return {taskId,studioId:owner,label,detail};
}

function finishTodayDecision(taskId,action,context=todayContext) {
  if(!context||todayContext!==context||view!=='today')return false;
  const {row}=context;
  todayOutcome={row,studioId:row.studioId,taskId:taskId??context.taskId,action:action??row.action};
  closeTodayContext();
  if(dialog.open)dialog.close();
  render();
  return true;
}

function taskEpic(task) {
  const story = state.stories?.find(row => String(row.studioId) === studioId && row.id === task.storyId);
  return (state.epics ?? []).find(row => String(row.studioId) === studioId && row.id === (task.epicId || story?.epicId));
}

function showEpic(id) {
  if (ownerTrail.current && !dialog.open) { inspectObject('epic',id); return; }
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
  const blocking = item=>Boolean(item.blockedTaskIds?.length || item.taskId || item.kind==='plan');
  const decision = open.toSorted((a,b)=>Number(blocking(b))-Number(blocking(a)) || String(a.createdAt??'9999').localeCompare(String(b.createdAt??'9999')))[0];
  const currentWork = all.filter(task => task.status !== 'cancelled' &&
    (task.status !== 'completed' || (task.workflowManaged && task.stage !== 'done')));
  const failedTask=(decision?.kind==='error'&&all.find(task=>task.id===decision.taskId&&task.status==='failed'))
    ||(!decision&&all.find(task=>task.status==='failed'));
  const failure=failedTask?taskRecoveryBlock(failedTask):'';
  const last = all.find(task => task.status === 'completed' && (!task.stage || task.stage === 'done'));
  const rooms = buildRooms({ ...current, agents: activeRoster(current) });
  const workCount = all.filter(task => ['running', 'queued'].includes(task.status)).length;
  const activeAttempts = current.activeAttempts ?? all.filter(task => task.status === 'running').length;
  const needsAttention = all.some(task => task.status === 'failed') || open.some(item => item.kind === 'error' || item.kind === 'reconcile');
  const displayStatus = studioActivityStatus(current, activeAttempts, needsAttention);
  const waitingForSchedule = current.scheduleWaiting && displayStatus !== 'error';
  const pendingPlan = pendingStudioPlan(plans(), current.id);
  const activePlan = plans().findLast(plan => plan.status === 'approved');
  const sprint = studioRows('sprints').findLast(s=>s.status==='active');
  const sprintTasks = sprint ? all.filter(t=>t.stage!=='replaced'&&(t.sprintId===sprint.id||sprint.taskIds?.includes(t.id))) : [];
  const initial = plans().some(plan => plan.kind === 'initial' && plan.status === 'approved');
  const canInitialize = current.lifecycle === 'draft';
  const provider=providerState[current.director?.runtime];
  const unavailable=canInitialize&&provider&&(provider.enabled===false||provider.available===false||provider.authenticated===false);
  const running = !canInitialize && !current.projectDetached && (['active', 'planning'].includes(current.lifecycle) || (current.lifecycle === 'idle' && initial) || workCount > 0 || current.scheduleWaiting);
  const manuallyPaused = current.manualPaused || current.lifecycle === 'paused';
  const stop = (activeAttempts > 0 || workCount > 0) && current.activity !== 'Студия остановлена' ? button(copy('Прервать работу'),
    `data-run-action="stop" title="${safe(copy('Прервать текущие шаги и приостановить очередь.'))}"`, true) : '';
  const runButtons = manuallyPaused || current.lifecycle === 'error'
    ? actionFor(current.lifecycle === 'error' ? copy('Повторить шаг') : copy('Возобновить'), 'run-action', 'resume', false) + stop
    : running ? button(copy('Поставить на паузу'),
      `data-run-action="pause" title="${safe(copy('Дать текущим шагам закончиться. Новые пока не запускать.'))}"`, true) + stop : '';
  const intro = canInitialize ? copy('<p class="muted">Нажмите кнопку ниже. Директор подготовит команду и план по вашей первой задаче. Работа по плану начнётся после вашего согласования.</p>')
    : current.lifecycle === 'planning' ? copy('<p class="muted">Когда план будет готов, он появится здесь и во входящих.</p>') : '';
  const activity = waitingForSchedule ? copy('Новые задачи запустятся в рабочее время студии.') :
    displayStatus === 'error' && current.lifecycle !== 'error' ? copy('Продолжение ждёт решения по задаче.') :
    displayStatus === 'idle' && current.lifecycle === 'active' ? '' :
    copySystem(current.activity) || (current.lifecycle === 'planning' ? copy('Директор готовит предложение по проекту.') : '');
  return heading(copy('Обзор студии'), current.name, button(copy('Связь с командой'), 'data-open="messages"', true) + (canInitialize ? '' : button(copy('Новая задача'), 'data-open="task"')) + runButtons) +
    copy`<div class="split"><div class="stack">
      ${current.lifecycle || activity || pendingPlan ? copy`<section class="panel padded stack compact">
        <div class="row"><h2>${canInitialize ? copy('Начало работы') : copy('Студия')}</h2>${waitingForSchedule ? badge(copy('Ждёт рабочего времени'), 'warn') :
          studioStatuses[displayStatus] ? badge(...studioStatuses[displayStatus]) : ''}</div>
        ${intro}${activity ? `<p class="activity" role="status">${safe(activity)}</p>` : ''}
        ${sprint ? progressMark(sprintTasks.filter(t=>t.stage==='done').length,sprintTasks.length) : ''}
        <p class="muted">Активные попытки: ${safe(activeAttempts)} из ${safe(current.wipLimit ?? 1)}${current.nextScheduleAt ? copy` · Следующее окно: ${safe(studioDate(current.nextScheduleAt))}` : ''}</p>
        ${unavailable ? fieldHint(copy('Подключите провайдера директора, чтобы подготовить план.')):''}
        <div class="actions">${canInitialize ? button(copy('Подготовить план первого спринта'), 'data-initialize' + (workBusy||unavailable ? ' disabled' : '')) : ''}
          ${unavailable?button(copy('Настройки приложения'),'data-view="app-settings"',true):''}
          ${pendingPlan ? actionFor(copy('Посмотреть план'), 'plan', pendingPlan.id, false) : activePlan ? actionFor(copy('Открыть план'), 'plan', activePlan.id) : ''}</div>
      </section>` : ''}
      ${failure || (decision ? copy`<article class="panel padded decision stack compact">
        <div class="row">${badge(decision.kind === 'acceptance' ? copy('На приёмке') : decision.kind === 'question' ? copy('Нужно решение') : copy('Требуется внимание'), 'attention')}<small>${open.length} открыто</small></div>
        <h2>${safe(inboxHeading(decision))}</h2><p class="clamp">${safe(inboxDetail(decision))}</p>
        <div>${actionFor(decision.kind === 'reconcile' ? copy('Посмотреть прерванный шаг') : copy('Открыть во входящих'), 'inbox', decision.id, false)}</div>
      </article>` : '')}
      <section class="stack compact"><div class="row"><h2>Последний отчёт</h2>${button(copy('Все артефакты'), 'data-work-pane="artifacts"', true)}</div>
        ${last ? `<article class="panel report">
          <div class="excerpt">${safe(last.summary || copy('Результат сохранён в задаче.'))}</div>
          <div class="padded stack compact"><div class="row"><h3>${safe(last.title)}</h3>${status(last)}</div>
          <div class="actions">${actionFor(copy('Читать отчёт'), 'task', last.id)}${last.artifactPath ? actionFor(copy('Открыть файл'), 'artifact', last.id, false) : ''}</div></div></article>`
          : empty(copy('Отчётов пока нет'), copy('Здесь появится результат первой завершённой задачи.'))}</section>
    </div><aside class="stack">
      <section class="panel padded stack compact"><div class="row"><h2>Мастерская</h2>${glyph('workshop')}</div>
        <p class="muted">Комнат: ${rooms.length} · В работе и очереди: ${workCount}</p>
        <div>${button(copy('Открыть карту'), 'data-view="workshop"', true)}</div></section>
      <section class="stack compact"><div class="row"><h2>Текущие задачи</h2>${button(copy('Все задачи'), 'data-work-pane="registry"', true)}</div>
        ${currentWork.length ? `<div class="panel work-list">${currentWork.slice(0,8).map(taskRow).join('')}</div>` :
          empty(copy('Нет текущих задач'), canInitialize ? copy('Первые задачи появятся после согласования плана.') : copy('Поставьте задачу директору или участнику студии.'))}</section>
    </aside></div>`;
}

function taskRow(task) {
  const mark=task.status==='running'?stageMark('in_progress',copy('В работе')):status(task);
  return `<button type="button" class="list-row" data-task="${safe(task.id)}"><span><strong>${safe(task.title)}</strong><small>${safe(nameFor(taskAgent(task)))}${task.kind === 'debt' ? copy(' · Улучшение') : ''}</small></span>${mark}</button>`;
}

function taskRecoveryBlock(task) {
  const current=studio();
  const recovery=taskRecovery(task,current,studioRows('attempts'),entries());
  if(!recovery)return '';
  const {kind,action}=recovery;
  const reason=copySystem(recovery.reason);
  const next = {
    resume: task.training?.bootstrap ? copy('Возобновите студию, затем повторите подготовку коуча из задачи.')
      : copy('Возобновите студию, чтобы продолжить работу.'),
    retry: kind==='training' ? copy('Повтор запустит упражнение и проверку. Зависимые задачи ждут успешной подготовки.')
      : copy('Повтор запустит задачу снова. Результат появится в истории запусков.'),
    checks: copy('Откройте результаты проверок. По ним видно, какую проверку нужно исправить.'),
    connection: copy('Проверьте вход в используемый провайдер, затем повторите запуск.'),
    project: copy('Подключите папку проекта в настройках студии.'),
    worktree: copy('Перед повторным запуском проверьте ветку и изменения в рабочей копии.'),
    message: copy('Передайте причину директору, чтобы он определил, как продолжить задачу.'),
  };
  const buttons={
    resume:()=>actionFor(copy(current.lifecycle==='error'?'Повторить шаг':'Возобновить студию'),'run-action','resume',false),
    retry:()=>actionFor(kind==='training'&&task.training?.bootstrap?copy('Повторить подготовку коуча'):copy('Повторить запуск'),'retry-from-inbox',task.id,false),
    checks:()=>actionFor(copy('Открыть результаты проверок'),'task-check-results',task.id,false),
    connection:()=>button(copy('Настройки приложения'),'data-error-settings',true),
    project:()=>actionFor(copy('Настройки студии'),'project-settings',current.id,false),
    worktree:()=>actionFor(copy('Сверить рабочее дерево'),'review-worktree',task.id,false),
    message:()=>actionFor(copy('Написать директору'),'message-note','',false),
  };
  const summary=kind==='training'&&task.training?.bootstrap&&task.failedReviews>=3 ?
    copy('Директор вернул подготовку коуча на доработку.') : reason;
  return copy`<section class="task-recovery stack compact" aria-label="Следующий шаг">
    <h3>Следующий шаг</h3>${summary?plain(summary):''}
    ${reason&&summary!==reason?copy`<details class="advanced" data-section="failure-reason"><summary>Замечания директора</summary>${plain(reason)}</details>`:''}
    ${action?`<p>${safe(next[action])}</p><div class="actions">${buttons[action]()}</div>`:''}
  </section>`;
}

function archiveDetails(id) {
  const archived=state.studios.find(row=>row.id===id&&row.archivedAt);
  if(!archived)return;
  const records=state.tasks.filter(task=>task.studioId===id);
  dialogTo(archived.name,badge(ui('archived'))+plain(archived.brief)+
    progressMark(records.filter(t=>t.stage==='done'||(!t.stage&&t.status==='completed')).length,records.length)+
    `<div class="archived-tasks">${records.map(task=>copy`<details class="work-fold"><summary>${safe(task.title)} · ${status(task)}</summary>
      ${plain(task.prompt)}${task.criteria?plain(listText(task.criteria)):''}${task.summary?plain(task.summary):''}</details>`).join('')}</div>`);
}

function inbox() {
  const all = entries();
  const open = all.filter(item => item.status === 'open');
  const resolved = all.filter(item => item.status === 'resolved');
  const actions=actionableInboxIds();
  const waiting=open.filter(item=>!actions.has(item.id)), actionable=open.filter(item=>actions.has(item.id));
  const shown = inboxScope==='waiting'?waiting:inboxScope==='open'?actionable:resolved;
  const scope = (value, label, count) => `<button type="button" data-scope="${value}" aria-pressed="${inboxScope === value}">${label} <span>${count}</span></button>`;
  return heading(copy('Входящие'), studio().name) +
    copy`<div class="segmented" role="group" aria-label="Состояние входящих">${scope('open', copy('Нужны решения'), actionable.length)}${scope('waiting',copy('Ждём'),waiting.length)}${scope('resolved', copy('Решённые'), resolved.length)}</div>
      ${shown.length ? `<div class="stack">${shown.map(inboxCard).join('')}</div>`
        : empty(inboxScope === 'resolved' ? copy('Нет решённых входящих') : copy('Нет открытых входящих'), inboxScope !== 'resolved'
          ? copy('Здесь появятся вопросы агентов и ошибки запуска.') : copy('Здесь сохраняются данные по принятым решениям.'))}`;
}

function actionableInboxIds() {
  return new Set(todayItems(state,Object.fromEntries(folderProbes)).filter(row=>row.studioId===studioId&&row.inboxId).map(row=>row.inboxId));
}

function inboxCard(item) {
  if (item.kind === 'plan') {
    const plan = planById(String(item.planId));
    return `<article class="panel padded stack compact">
      <div>${badge(item.status === 'open' ? copy('Нужно согласовать') : copy('Решение сохранено'), item.status === 'open' ? 'warn' : 'good')}</div>
      <h2>${safe(item.title)}</h2><p>${safe(item.body)}</p>
      <div>${plan ? actionFor(copy('Посмотреть план'), 'plan', plan.id, false) : ''}</div>
    </article>`;
  }
  const task = tasks().find(entry => entry.id === item.taskId);
  const isQuestion = item.kind === 'question';
  const isAcceptance = item.kind === 'acceptance';
  const isReconciliation = item.kind === 'reconcile';
  const blockedCoach = coachBlocked(item, task);
  if (item.kind === 'meeting') return `<article class="panel padded stack compact">
    <div>${badge(item.status === 'open' ? copy('Решение встречи') : copy('Решение сохранено'), item.status === 'open' ? 'warn' : 'good')}</div>
    <h2>${safe(item.title)}</h2>${plain(item.body)}<div>${actionFor(copy('Открыть встречу'), 'meeting-detail', item.meetingId, false)}</div></article>`;
  return `<article class="panel padded stack compact">
    <div class="row">${badge(isQuestion ? copy('Вопрос') : isAcceptance ? copy('Приёмка результата') : isReconciliation ? copy('Работа прервана') : blockedCoach ? copy('Нужна доработка') : copy('Ошибка'), isQuestion || isAcceptance ? 'warn' : 'attention')}
      <small class="muted">${safe(task?.title)}</small></div>
    <h2>${safe(inboxHeading(item))}</h2><div class="long-text">${safe(inboxDetail(item))}</div>${isQuestion && item.version ? copy`<p class="muted">Версия ${safe(item.version)}</p>` : ''}
    ${item.answer ? copy`<div class="inline-result"><strong>Ответ</strong>${plain(item.answer)}</div>` : ''}
    <div class="actions">
      ${isQuestion ? actionFor(item.status === 'open' ? copy('Ответить') : copy('История вопроса'), 'inbox', item.id, item.status !== 'open') : ''}
      ${task ? actionFor(copy('Открыть задачу'), 'task', task.id) : ''}
      ${isAcceptance ? actionFor(copy('Открыть приёмку'), 'inbox', item.id, false) : ''}
      ${isReconciliation ? actionFor(copy('Посмотреть прерванный шаг'), 'inbox', item.id) : ''}
      ${item.status === 'open' && !isQuestion && !isAcceptance && !isReconciliation ? actionFor(blockedCoach ? copy('Посмотреть замечания директора') : copy('Просмотреть ошибку'), 'inbox', item.id) : ''}
      ${blockedCoach ? coachRetryActions(task) : ''}
    </div>
  </article>`;
}

function teamContext(current) {
  const direction = state.attempts?.find(attempt => attempt.studioId === current.id && attempt.purpose === 'director' && attempt.status === 'running');
  const currentTasks = tasks();
  const directionTask = direction && currentTasks.find(task => task.id === direction.taskId);
  const jobFor = person => {
    if (!person.id && directionTask) return { ...directionTask, stage: 'director', status: 'running' };
    return taskForAgent(currentTasks, current.id, person.id || null);
  };
  const activityFor = person => {
    const job = jobFor(person);
    const director = !person.id;
    if (job?.status !== 'running' && current.scheduleWaiting && (director || job?.status === 'queued')) {
      return [copy('Ждёт рабочего времени'), 'warn'];
    }
    if (job?.status !== 'running' && current.manualPaused && (director || job?.status === 'queued')) {
      return [copy('На паузе'), 'warn'];
    }
    return agentActivity(job, director ? current.lifecycle : undefined);
  };
  return {jobFor,activityFor,currentTasks};
}

function workshop() {
  const current = studio();
  const rooms = buildRooms({ ...current, agents: activeRoster(current) });
  const roster = rooms.flatMap(room => room.desks.map(({ agent }) => ({ room, agent })));
  const selection = roster.find(({ agent }) => (agent.id == null ? '' : String(agent.id)) === selectedAgent) ?? roster[0];
  const { agent } = selection;
  const {jobFor,activityFor,currentTasks} = teamContext(current);
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
    return `<button type="button" class="${pin ? 'map-pin' : 'list-row role-row'}" data-agent="${safe(key)}" data-activity="${tone}" aria-pressed="${chosen}"${person.systemRole === 'coach' ? ' data-system-role="coach"' : ''}>
      <canvas width="40" height="40" data-desk="${props || 'notebook'}" data-actor-key="${safe(`${current.id}:${person.id ?? 'director'}`)}" data-actor-state="${actor}" aria-hidden="true"></canvas>
      <span><strong>${safe(nameFor(person))}</strong><small>${pin ? safe(activity) : safe([secondaryTitle(person), activity].filter(Boolean).join(' · '))}</small>
        ${pin ? '' : roleReadiness(person, currentTasks, { showTask: false })}</span>
    </button>`;
  };
  const table = stored('team-view') !== 'map';
  return heading(ui('team'), current.name, button(table ? ui('map') : ui('team'),'data-team-toggle',true)) +
    (table ? `<div class="registry-scroll"><table class="owner-table"><thead><tr>${['team','role','state','model','training','running','accepted'].map(k=>'<th>'+ui(k)+'</th>').join('')}</tr></thead><tbody>${roster.map(({agent:person})=>{
      const work=jobFor(person);
      const past=currentTasks.filter(t=>!['train'].includes(t.kind) && (t.agentId ?? null)===(person.id??null) && t.stage==='done');
      return `<tr><td>${actionFor(nameFor(person),'owner-agent',person.id??'')}</td><td>${safe(titleFor(person))}</td><td>${badge(...activityFor(person))}</td><td>${safe(configText(person) || modeNames[person.mode] || '—')}</td><td>${person.id ? roleReadiness(person,currentTasks) : '—'}</td><td>${work ? actionFor(work.title,'task',work.id) : '—'}</td><td>${past.length}</td></tr>`;
    }).join('')}</tbody></table></div>` :
copy`<div class="work-map" role="group" aria-label="Карта мастерской">
      ${rooms.map(zone => copy`<section class="work-room" data-zone="${safe(zone.id)}"><div class="room-header"><h2>${zone.name}</h2><span aria-label="Участников в комнате: ${zone.desks.length}">${zone.desks.length}</span></div>
        <div class="room-floor"><canvas class="room-art" width="200" height="126" data-room="${zone.id}" aria-hidden="true"></canvas>
          <div class="room-occupants">${zone.desks.map(({ agent: person, props }) => renderAgent(person, true, props)).join('')}</div>
        </div></section>`).join('')}
    </div>`);
}

function providerBadge(id) {
  const info = providerState[id];
  if (inspecting.has(id) || info?.loading) return badge(copy('Проверяем…'));
  if (!info) return badge(copy('Не проверен'));
  if (info.enabled === false) return badge(copy('Отключён'));
  if (!info.available) return badge(copy('Недоступен'), 'warn');
  if (info.authenticated === false) return badge(copy('CLI найден · Требуется вход'), 'warn');
  return badge(info.authenticated ? copy('Вход подтверждён') : copy('CLI найден'), 'good');
}

function appSettings() {
  const providers = Object.entries(runtimeNames).map(([id, label]) => {
    const info = providerState[id];
    const checking = inspecting.has(id);
    const detail = info ? [info.version, info.detail].filter(Boolean).join(' · ') : '';
    return copy`<article class="panel provider-card"><div class="row"><h3>${label}</h3>
      ${providerBadge(id)}</div>
      <div class="stack compact provider-card-body">
      ${detail ? `<p class="muted">${safe(detail)}</p>` : ''}
      ${info?.models?.length ? copy`<p class="muted">Моделей в каталоге: ${info.models.length}</p>` : ''}
      ${info?.authenticated && !info?.models?.length ? copy('<p class="muted">Подключение не передало каталог. Можно использовать модель по умолчанию или указать идентификатор.</p>') : ''}
      </div><div class="stack compact provider-card-actions">
      <label class="checkbox-field"><input type="checkbox" data-provider-enabled="${id}"${info?.enabled !== false ? ' checked' : ''}${workBusy ? ' disabled' : ''}> <span>Разрешить запуски через ${label}</span></label>
      <div>${button(checking ? copy('Проверяем…') : copy('Проверить подключение'), `data-inspect="${id}"${checking ? ' disabled' : ''}`, true)}</div>
      </div>
    </article>`;
  }).join('');
  const theme = document.documentElement.dataset.theme ?? 'system';
  return heading(ui('app-settings'), ui('general')) +
    `<label class="field app-settings-locale"><span>${ui('language')}</span><select data-settings-locale>${Object.entries(localeNames).map(([id,label])=>option(id,label,state.appLocale ?? 'en')).join('')}</select></label>` +
    copy`<div class="stack settings"><section class="stack compact"><h2>Подключения</h2><div class="columns">${providers}</div></section>
      <section class="stack compact"><h2>Модели приложения</h2><div class="panel padded stack compact">
        ${rowAction(copy('Политика по умолчанию'), state.modelPolicy?.configured
          ? (state.modelPolicy.allowed.length ? copy`Свой список · ${state.modelPolicy.allowed.length} моделей` : copy('Модель и усилие берутся у директора'))
          : copy('Все обнаруженные модели разрешены. Новые модели добавляются автоматически.'),
        button(copy('Открыть каталог'), 'data-open="app-model-policy"', true))}
        ${state.modelPolicy?.configured && state.modelPolicy.allowed.length ? policySummary(state.modelPolicy.allowed) : ''}
      </div></section>
      <section class="stack compact"><h2>Интерфейс и уведомления</h2><div class="panel padded stack compact">
        <label class="field"><span>Тема оформления</span><select id="theme-select">
          ${option('system',copy('Системная'),theme)}${option('light',copy('Светлая'),theme)}${option('dark',copy('Тёмная'),theme)}</select></label>
        ${select(copy('Плотность строк'),'density',option('compact',copy('Компактно'),document.documentElement.dataset.density)+
          option('roomy',copy('Свободно'),document.documentElement.dataset.density))}
        <label class="checkbox-field"><input type="checkbox" name="appNotifications"${state.notificationPreferences?.enabled !== false ? ' checked' : ''}${workBusy ? ' disabled' : ''}> <span>Показывать системные уведомления</span></label>
        ${fieldHint(copy('При выключении macOS не уведомляет о событиях Hearth. Вопросы и решения остаются во «Входящих».'))}
      </div></section>
      <section class="stack compact"><h2>Импорт студий</h2><div class="panel padded stack compact">
        <div class="actions">${button(copy('Импортировать файл Hearth'), 'data-open="import-bundle"', true)}${button(copy('Проверить старую студию'), 'data-open="import"', true)}</div>
      </div></section>
    </div>`;
}

function settings() {
  const current = studio();
  return heading(copy('Настройки студии'), current.name) + copy`<div class="stack settings">
      <section class="stack compact"><h2>Студия</h2><div class="panel padded stack compact">
        <div class="row"><h3>${safe(current.name)}</h3><div class="actions">${button(copy('Изменить'), 'data-open="edit-studio"', true)}${current.projectDetached ? safe(ui('detached')) : actionFor(ui('detach'),'detach-folder',current.id)}${actionFor(ui('archive'),'archive-studio',current.id)}${button(copy('Удалить студию'), 'data-open="delete-studio"', true)}</div></div>
        ${current.brief ? plain(current.brief) : ''}<dl class="studio-meta"><dt>Рабочая папка</dt><dd>${safe(current.root || copy('Не выбрана'))}</dd><dt>Язык отчётов</dt><dd>${safe(current.language || copy('Не выбран'))}</dd>
          ${current.projectLanguage ? copy`<dt>Язык материалов</dt><dd>${safe(current.projectLanguage)}</dd>` : ''}</dl>
        ${current.root ? `<div>${button(copy('Открыть папку проекта'), 'data-open="project-folder"', true)}</div>` : ''}
      </div></section>
      <section class="stack compact" id="autonomy" tabindex="-1"><h2>Автономность</h2><div class="panel padded stack compact">
        <label class="checkbox-field"><input type="checkbox" name="approveSprints"${current.approveSprints !== false ? ' checked' : ''}${workBusy ? ' disabled' : ''}> <span>Согласовывать план спринта</span></label>
        <p class="muted">При инициализации Hearth всегда запрашивает согласование. Настройка применяется к будущим спринтам.</p>
        ${rowAction(copy('Расписание'), copy`${scheduleLabel(current.schedule)} · Запуск новых задач по часам студии`, button(copy('Настроить расписание'), 'data-open="schedule"', true))}
        ${rowAction(copy('Одновременные запуски'), `${current.wipLimit ?? 1} · ${(current.wipLimit ?? 1) === 1 ? copy('Задачи идут по очереди') : copy('Независимые рабочие шаги могут идти параллельно')}`, button(copy('Настроить'), 'data-open="dispatch"', true))}
        ${rowAction(copy('Подготовка задач к спринту'), current.groomingPolicy?.enabled
          ? copy('Директор уточняет очередь, когда готовых задач мало и в следующем спринте есть место.')
          : copy('Автоматическая подготовка выключена. Разбор очереди можно начать из раздела «Работа».'), button(copy('Настроить'), 'data-open="grooming-settings"', true))}
      </div></section>
      <section class="stack compact"><h2>Доставка проекта</h2><div class="panel padded stack compact">
        ${rowAction(copy('Репозиторий Git'), current.projectGit?.enabled ? current.projectGit.targetRef || copy('Управляемая целевая ветка') : copy('Git-доставка не подключена.'), button(copy('Настроить Git и проверки'), 'data-open="project-git"', true))}
        ${current.projectGit?.enabled ? rowAction(copy('Рабочие копии'), copy('Посмотрите, какие управляемые копии доступны для уборки.'), button(copy('Проверить уборку'), 'data-open="cleanup"', true)) : ''}
      </div></section>
      <section class="stack compact"><h2>Модели студии</h2><div class="panel padded stack compact">
        <div class="row"><div><h3>Директор</h3><p class="muted">${safe(configText(current.director) || copy('Модель и усилие по умолчанию'))}</p></div>${button(copy('Настроить директора'), 'data-open="director"', true)}</div>
        <div class="inline-result stack compact"><div class="row allowed-row"><div><h3>Разрешённые модели</h3>
          <p class="muted">${studioPolicyMode(current) === 'studio' ? copy('Свой список студии') : copy('Список приложения')}</p></div>
          ${button(copy('Настроить список'), 'data-open="studio-model-policy"', true)}</div>
          ${policySummary(studioAllowed(current))}</div>
      </div></section>
      <section class="stack compact"><h2>Состояние и уведомления</h2><div class="panel padded stack compact">
        <div class="actions">${button(copy('Расход моделей'), 'data-open="usage"', true)}${button(copy('Диагностика'), 'data-open="diagnosis"', true)}${button(copy('Уведомления'), 'data-open="notifications"', true)}</div>
      </div></section>
      <details class="panel padded advanced" id="advanced"${advancedOpen ? ' open' : ''}><summary>Расширенные настройки</summary><div class="stack">
      <section class="stack compact"><h2>Библиотека</h2><div class="panel padded stack compact">
        ${rowAction(copy('Навыки и материалы'), copy('Материалы, которые агенты используют в работе.'), button(copy('Открыть библиотеку'), 'data-view="skills"', true))}
        ${rowAction(copy('Порог поиска на GitHub'), copy`Минимум звёзд · ${skillStarLabel(current)}`, button(copy('Настроить порог'), 'data-open="skill-settings"', true))}
      </div></section>
      ${renderDebtSettings(current, debtAssessments.get(current.id))}
      <section class="stack compact"><div class="row"><h2>Роли</h2><div class="actions">${button(copy('Предложить найм'), 'data-open="roster-hire"')}
        ${button(copy('Лимиты состава'), 'data-open="staffing"', true)}${button(copy('Предложения и история'), 'data-open="roster-history"', true)}</div></div>
        <div class="panel work-list">${current.agents?.length ? current.agents.map(agent => `<div class="list-row static-row"${agent.systemRole === 'coach' ? ' data-system-role="coach"' : ''}><span><strong>${safe(nameFor(agent))}</strong>
          <small>${safe([secondaryTitle(agent), modeNames[agent.mode], agent.mode === 'fixed' ? configText(agent) : ''].filter(Boolean).join(' · '))}</small>
          ${agent.description ? `<small>${safe(agent.description)}</small>` : ''}
          ${agent.rosterStatus === 'retired' ? badge(copy('Роль выведена')) : roleReadiness(agent, tasks(), { showTask: false })}</span>
          <div class="actions">${agent.rosterStatus !== 'retired' ? actionFor(copy('Настроить'), 'edit-agent', agent.id) : ''}
            ${agent.systemRole ? '' : actionFor(agent.rosterStatus === 'retired' ? copy('Предложить возврат') : copy('Предложить вывод'), 'roster-agent', agent.id)}</div></div>`).join('')
          : copy('<p class="padded muted">Роли появятся после согласования плана. Предложение можно подготовить вручную.</p>')}</div></section></div></details>
      <section class="stack compact"><h2>Экспорт студии</h2><div class="panel padded stack compact">
        <div class="actions">${actionFor(copy('Экспортировать шаблон'), 'export-mode', 'template')}${actionFor(copy('Экспортировать снимок'), 'export-mode', 'snapshot')}</div>
      </div></section></div>`;
}

function dialogTo(title, body, submitLabel, submit, { adjustable = false, focusSummary = false } = {}) {
  delete dialog.dataset.reviewPlan;
  dialogLoadVersion++;
  catalogEditor = undefined;
  dialogAttachments = undefined;
  dialogMeeting = undefined;
  dialogConversation = undefined;
  dialogReconciliation = undefined;
  opener = dialog.open ? opener : document.activeElement;
  taskDialog = undefined;
  submission = submit;
  $('#dialog-title').textContent = title;
  const context=todayContext?.row;
  const linked=context ? tasks().filter(task=>context.affectedTaskIds.includes(task.id)) : [];
  $('#dialog-body').innerHTML = (linked.length?copy`<details class="advanced today-linked"><summary>Связанных задач: ${linked.length}</summary>
    <ul class="legacy-list">${linked.map(task=>`<li>${actionFor(task.title,'task',task.id)} ${status(task)}</li>`).join('')}</ul></details>`:'')+body;
  $('#dialog-actions').innerHTML = button(submit ? copy('Отмена') : copy('Закрыть'), 'data-close', true) +
    (submit ? `<button type="submit" class="action">${safe(submitLabel)}</button>` : '');
  dialogError();
  configureDialogSize(adjustable);
  $('#dialog-body').scrollTop = 0;
  if (!dialog.open) dialog.showModal();
  const initialFocus = focusSummary ? $('#dialog-title') : dialogBodyFocus();
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
  if(message && dialog.dataset.reviewPlan) {
    const reload=document.createElement('button');
    reload.type='button';reload.className='text-button';reload.dataset.refreshPlan=dialog.dataset.reviewPlan;
    reload.textContent=ui('currentPlan');node.append(' ',reload);
  }
}

function setDialogBusy(value) {
  dialogBusy = value;
  form.toggleAttribute('aria-busy', value);
  if(value){
    for(const element of form.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')){
      busyControls.add(element);
      element.disabled=true;
    }
  }else{
    for(const element of busyControls)element.disabled=false;
    busyControls.clear();
  }
}

function pathField(root = '', { label = copy('Рабочая папка'), name = 'root' } = {}) {
  return `<div class="folder-field">${input(label, name, root, 'readonly')}
    ${button(copy('Выбрать папку'), `data-folder="${name}"`, true)}</div>`;
}

function reportLanguageField(current) {
  const value = !current || current.languageMode === 'app' ? '' : current.language;
  const choices = [...new Set([...Object.values(localeNames), ...languageChoices(value)])].filter(Boolean);
  return select(copy('Язык отчётов'), 'language', option('',ui('inherited'),value)+choices.map(name=>option(name,name,value)).join(''));
}

function languageField(label, name, value, inherit = false) {
  const choices = languageChoices(value).map(language => option(language, language, value));
  if (inherit) choices.unshift(option('', copy('Как в отчётах'), value));
  return select(label, name, choices.join(''));
}

const makeWeekdays = () => ([[1, copy('Пн')], [2, copy('Вт')], [3, copy('Ср')], [4, copy('Чт')], [5, copy('Пт')], [6, copy('Сб')], [0, copy('Вс')]]);
let weekdays = makeWeekdays();
onCopyLocale(() => { weekdays = makeWeekdays(); });
const defaultSchedule = { enabled: false, days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' };

function scheduleLabel(schedule) {
  if (!schedule?.enabled) return copy('Выключено');
  return [weekdays.filter(([day]) => schedule.days.includes(day)).map(([, label]) => label).join(', '),
    `${schedule.start}–${schedule.end}`, schedule.end < schedule.start ? copy('до следующего дня') : ''].filter(Boolean).join(' · ');
}

const makePowerLabels = () => ({
  normal: copy('Сон по настройкам системы'),
  active: copy('Не засыпать во время активной работы'),
  window: copy('Не засыпать в рабочее окно'),
});
let powerLabels = makePowerLabels();
onCopyLocale(() => { powerLabels = makePowerLabels(); });

function dispatchEditor() {
  const current = studio();
  dialogTo(copy('Параллельная работа и питание'),
    input(copy('Одновременные запуски'), 'wipLimit', current.wipLimit ?? 1, 'type="number" min="1" max="8" step="1" required aria-describedby="wip-hint"') +
    copy('<p id="wip-hint" class="field-hint">Максимум независимых рабочих шагов, которые Hearth выполняет одновременно. При значении 1 они идут по очереди. Задача, которая ждёт твоего ответа, освобождает место.</p>') +
    select(copy('Режим питания'), 'powerMode', Object.entries(powerLabels).map(([value, label]) => option(value, label, current.powerMode ?? 'normal')).join('')) +
    fieldHint(copy('Можно удерживать Mac от сна во время выполнения или в часы, указанные в расписании студии.')),
    copy('Сохранить'), ({ wipLimit, powerMode }) => bridge.request('updateStudio', { studioId: current.id, wipLimit: Number(wipLimit), powerMode }));
}

let checkRowId = 0;
function projectCheckFields(check = {}) {
  const key = `check-${++checkRowId}`;
  return copy`<fieldset class="export-files form-body" data-project-check="${key}">
    <legend>Проверка${check.id ? ` · ${safe(check.id)}` : ''}</legend>
    ${input(copy('Идентификатор проверки'), `${key}-id`, check.id, 'maxlength="64" placeholder="test"')}
    ${input(copy('Исполняемая команда'), `${key}-command`, check.command, 'placeholder="npm"')}
    ${textarea(copy('Аргументы, по одному на строку'), `${key}-args`, check.args?.join('\n'), 'placeholder="test"')}
    ${checkbox(copy('Обязательная проверка'), `${key}-required`, check.required ?? true)}
    <details><summary>Пути, доказательства и время</summary><div class="form-body">
      ${textarea(copy('Пути изменений, по одному шаблону на строку'), `${key}-paths`, check.paths?.join('\n'), 'placeholder="src/**"')}
      ${textarea(copy('Файлы с доказательствами, по одному шаблону на строку'), `${key}-evidence`, check.evidenceGlobs?.join('\n'), 'placeholder="reports/**"')}
      ${input(copy('Лимит времени, мс'), `${key}-timeout`, check.timeoutMs ?? 120000, 'type="number" min="1" max="2147483647"')}
    </div></details>
    <div>${actionFor(copy('Убрать проверку'), 'remove-project-check', key)}</div>
  </fieldset>`;
}

function projectGitEditor() {
  const current = studio();
  const git = current.projectGit ?? {};
  const checks = git.profile?.checks ?? [];
  dialogTo(copy('Git и проверки проекта'),
    checkbox(copy('Разрешить Git-доставку для задач студии'), 'enabled', git.enabled) +
    input(copy('Целевая локальная ветка'), 'targetRef', git.targetRef, copy('placeholder="Автоматически создать управляемую ветку"')) +
    copy`<p>Проверки проекта — необязательные команды, например тесты или сборка. Hearth запускает их на изменениях задачи перед слиянием. Если обязательная проверка не проходит, Hearth ждёт исправления.</p>
      <p class="muted">Команды запускаются в рабочей копии задачи. Например, для <code>npm test</code> укажите команду <code>npm</code> и аргумент <code>test</code>.</p>
      <div class="form-body" data-project-checks>${checks.map(projectCheckFields).join('')}</div>
      <div>${button(copy('Добавить проверку'), 'data-add-project-check', true)}</div>`,
    copy('Сохранить настройки Git'), ({ enabled, targetRef, ...values }) => {
      const profile = { id: git.profile?.id ?? 'default', checks: [] };
      if (enabled) profile.checks = [...form.querySelectorAll('[data-project-check]')].map(({ dataset: { projectCheck: key } }) => {
        const id = values[`${key}-id`];
        const command = values[`${key}-command`];
        if (!id || !command) throw new Error(copy('Укажите идентификатор и команду для каждой проверки.'));
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
  await loadDialog(copy('Уборка рабочих копий'), async isCurrent => {
    const preview = await bridge.request('previewCleanup', { studioId: current.id });
    const rows = Array.isArray(preview) ? preview : preview.candidates ?? preview.worktrees ?? [];
    const allowed = rows.filter(row => row.eligible ?? row.allowed ?? row.removable);
    const rowId = row => row.id ?? row.worktreeId ?? row.candidateId;
    const body = rows.length ? `<ul class="legacy-list">${rows.map(row => `<li>
      ${(row.eligible ?? row.allowed ?? row.removable) ? checkbox(row.branchRef ?? row.path ?? rowId(row), `tree-${rowId(row)}`, false)
        : `<strong>${safe(row.branchRef ?? row.path ?? rowId(row))}</strong>`}
      <p class="muted">${safe(Array.isArray(row.reasons) ? row.reasons.join(' · ') : row.reason ?? '')}</p></li>`).join('')}</ul>`
      : copy('<p class="muted">Зарегистрированных рабочих копий пока нет.</p>');
    if (isCurrent()) dialogTo(copy('Уборка рабочих копий'), copy`<p>Выберите копии, которые нужно удалить. Сохранённые доказательства останутся в студии.</p>${body}`,
      allowed.length ? copy('Удалить выбранные копии') : undefined, allowed.length ? async values => {
        const candidateIds = allowed.filter(row => values[`tree-${rowId(row)}`]).map(rowId);
        if (!candidateIds.length) throw new Error(copy('Выберите хотя бы одну копию.'));
        const result = await bridge.request('applyCleanup', { studioId: current.id, candidateIds, operationId: op });
        notice((result.results ?? []).map(row => [row.id, row.status, ...(row.reasons ?? [])].join(' · ')).join(' / ') || copy('Уборка рабочих копий завершена.'));
      } : undefined, { adjustable: true });
  });
}

async function loadDialog(title, load) {
  dialogTo(title, copy('<p class="muted" role="status">Загрузка…</p>'));
  const version = dialogLoadVersion;
  try { await load(() => dialog.open && version === dialogLoadVersion); }
  catch (error) {
    if (dialog.open && version === dialogLoadVersion) dialogTo(title, `<p class="error" role="alert">${safe(error.message || copy('Не удалось загрузить данные.'))}</p>`);
  }
}

let dialogLoadVersion = 0;
let dialogAttachments;

function attachmentFields() {
  return `<div class="stack compact"><div class="actions">${button(copy('Приложить файл'), 'data-pick-attachment', true)}</div>
    <ul class="legacy-list" data-attachments aria-live="polite"></ul></div>`;
}

function renderAttachmentFields() {
  const list = $('[data-attachments]');
  if (!list || !dialogAttachments) return;
  list.innerHTML = dialogAttachments.map((row, index) => `<li class="legacy-attachment"><span>${safe(row.name ?? row.filename ?? row.sourcePath ?? row.id)}</span>
    ${actionFor(copy('Убрать'), 'remove-attachment', index)}</li>`).join('');
}

async function addAttachment(target) {
  const attachments = dialogAttachments;
  if (!attachments || target.disabled) return;
  if (attachments.length >= 8) { dialogError(copy('Можно приложить до восьми файлов.')); return; }
  target.disabled = true;
  try {
    const row = await bridge.request('pickAttachment', { studioId: studio().id,
      ...(dialogConversation?.taskId ? { taskId: dialogConversation.taskId } : {}) });
    if (row && dialogAttachments === attachments && !attachments.some(value => value.id === row.id)) {
      attachments.push(row);
      renderAttachmentFields();
    }
  } catch (error) {
    if (dialogAttachments === attachments) dialogError(error.message || copy('Не удалось приложить файл.'));
  } finally { target.disabled = false; }
}

const makeMessageStatuses = () => ({ queued: copy('В очереди'), received: copy('Получено'), processed: copy('Обработано') });
let messageStatuses = makeMessageStatuses();
onCopyLocale(() => { messageStatuses = makeMessageStatuses(); });
function messageHistoryMarkup(thread, agent) {
  const history = thread ? studioRows('conversationMessages').filter(row => row.conversationId === thread.id) : [];
  return history.length ? `<ul class="legacy-list legacy-history">${history.map(row => {
    const sender = row.author === 'owner' ? (row.kind === 'note' ? copy('Ваша записка') : copy('Вы')) : nameFor(agent);
    const files = studioRows('evidence').filter(file => row.attachmentIds?.includes(file.id));
    const priority = row.priorityProposal;
    return `<li><div class="row"><strong>${safe(sender)}</strong><small class="muted">${safe(studioDate(row.createdAt))}</small></div>
      ${row.status && row.author === 'owner' ? badge(messageStatuses[row.status] ?? row.status) : ''}
      ${plain(row.text)}${row.outcome ? plain(row.outcome, 'muted') : ''}${renderEvidence(files)}
      ${priority ? copy`<p>${safe(priority.taskTitle)} · приоритет ${safe(priority.priority)}</p>
        ${priority.appliedAt ? badge(copy('Применено')) : actionFor(copy('Применить приоритет'), 'message-priority', row.id)}` : ''}</li>`;
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
      ${actionFor(copy('Открыть беседу'), 'conversation', row.id)}</li>`;
  }).join('')}</ul>` : copy('<p class="muted">Здесь появятся сообщения и ответы команды.</p>');
  dialogTo(copy('Связь с командой'), `<div class="actions">${actionFor(copy('Написать директору'), 'message', '', false)}
    ${actionFor(copy('Оставить записку'), 'message-note', '')}</div>${conversationList}`, undefined, undefined, { adjustable: true });
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
    if (!text && !selectedAttachments.length) throw new Error(copy('Напишите сообщение или приложите файл.'));
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
  dialogTo(kind === 'note' ? copy('Записка директору') : copy`Беседа · ${nameFor(agent)}`, (task ? `<p>${safe(task.title)}</p>` : '') +
    `<div data-message-history aria-live="polite">${messageHistoryMarkup(thread, agent)}</div>` +
    textarea(kind === 'note' ? copy('Текст записки') : copy('Сообщение'), 'text') + attachmentFields(),
    kind === 'note' ? copy('Передать записку') : copy('Отправить'), submit, { adjustable: true });
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
  dialogTo(copy`Работа · ${nameFor(agent)}`, (own.length ? copy`<section class="stack compact"><h3>Задачи и обучение</h3>${taskList(own.slice(-15).reverse())}</section>` : copy('<p class="muted">Задач пока нет.</p>')) +
    (attempts.length ? copy`<section class="stack compact"><h3>Последние попытки</h3><ul class="legacy-list">${attempts.map(row =>
      `<li>${safe(own.find(task => task.id === row.taskId)?.title)} ${status(row)} ${safe(studioDate(row.startedAt))}${row.error ? plain(row.error) : ''}</li>`).join('')}</ul></section>` : '') +
    (meetings.length ? copy`<section class="stack compact"><h3>Встречи</h3><div class="actions">${meetings.map(row => actionFor(row.title ?? copy('Встреча'), 'meeting-detail', row.id)).join('')}</div></section>` : ''), undefined, undefined, { adjustable: true });
}

async function usageDialog() {
  const current = studio();
  await loadDialog(copy('Расход моделей'), async isCurrent => {
    const report = await bridge.request('studioUsage', { studioId: current.id });
    if (isCurrent()) dialogTo(copy('Расход моделей'), renderUsageReport(report) +
      `<div class="actions">${button(copy('Задать тариф модели'), 'data-open="usage-tariff"', true)}</div>`, undefined, undefined, { adjustable: true });
  });
}

function usageTariffEditor() {
  const current = studio();
  const rate = 'type="number" min="0" step="any"';
  dialogTo(copy('Тариф за миллион токенов'),
    select(copy('Подключение'), 'runtime', option('codex', 'Codex') + option('claude', 'Claude Code')) +
    input(copy('Модель'), 'model', current.director?.model ?? '', 'required') +
    input(copy('Валюта'), 'currency', 'USD', 'required maxlength="3"') +
    input(copy('Вход'), 'input', '', rate + ' required') + input(copy('Выход'), 'output', '', rate + ' required') +
    input(copy('Чтение из кэша'), 'cacheRead', '', rate) + input(copy('Запись в кэш'), 'cacheWrite', '', rate),
    copy('Сохранить тариф'), values => bridge.request('updateUsageTariff', {
      studioId: current.id, runtime: values.runtime, model: values.model, currency: values.currency.toUpperCase(),
      input: Number(values.input), output: Number(values.output),
      cacheRead: values.cacheRead === '' ? null : Number(values.cacheRead), cacheWrite: values.cacheWrite === '' ? null : Number(values.cacheWrite),
    }));
}

async function diagnosisDialog() {
  const current = studio();
  await loadDialog(copy('Диагностика студии'), async isCurrent => {
    const report = await bridge.request('diagnoseStudio', { studioId: current.id });
    const actions = (['resume', 'recover', 'retry'].includes(report.action) ? actionFor(copy('Восстановить работу'), 'run-action', 'resume', false) : '') +
      button(copy('Сохранить диагностику'), 'data-save-diagnostics', true) +
      button(copy('Перезапустить Hearth'), 'data-open="restart-app"', true);
    if (isCurrent()) dialogTo(copy('Диагностика студии'), renderDiagnostic(report) + (actions ? `<div class="actions">${actions}</div>` : ''));
  });
}

function restartAppEditor() {
  dialogTo(copy('Перезапустить Hearth'), copy('<p>Приложение завершит работу штатно и откроется снова. Студии восстановят состояние из сохранённых записей.</p>'),
    copy('Перезапустить'), () => bridge.request('restartApp'));
}

function notificationsEditor() {
  const current = studio();
  dialogTo(copy('Уведомления студии'), checkbox(copy('Показывать события этой студии'), 'studio', state.notificationPreferences?.studios?.[current.id] !== false) +
    fieldHint(copy('Системные уведомления также должны быть включены в настройках приложения.')),
    copy('Сохранить'), ({ studio: enabled }) => bridge.request('updateNotifications', { studioId: current.id, enabled: Boolean(enabled) }));
}

const recordOptions = (rows, selected = '', emptyLabel = copy('Не выбрано'), label = row => row.title ?? row.name) =>
  option('', emptyLabel, selected) + rows.map(row => option(String(row.id), label(row), String(selected))).join('');
const checkedIds = (rows, values, prefix) => rows.filter((_, index) => values[`${prefix}-${index}`]).map(row => row.id);
const checkList = (title, rows, prefix, selected = [], label = row => row.title ?? row.name) => rows.length
  ? `<fieldset class="export-files"><legend>${safe(title)}</legend><div class="legacy-checklist">${rows.map((row, index) =>
    checkbox(label(row), `${prefix}-${index}`, selected.includes(row.id))).join('')}</div></fieldset>` : '';

function groomingEditor() {
  const current = studio();
  const policy = current.groomingPolicy ?? {};
  dialogTo(copy('Подготовка задач к спринту'), checkbox(copy('Автоматически разбирать очередь задач'), 'enabled', policy.enabled) +
    fieldHint(copy('Директор уточняет критерии и зависимости. Он может разбить большую задачу на меньшие или подготовить новые карточки, если готовых задач мало и в следующем спринте есть место.')) +
    input(copy('Минимальный запас готовых задач'), 'threshold', policy.threshold, copy`type="number" min="1" max="200" placeholder="Авто · ${(current.wipLimit ?? 1) * 2}"`) +
    fieldHint(copy('При пустом поле запас равен удвоенному числу одновременных запусков.')) +
    input(copy('Сколько задач помещается в следующем спринте'), 'nextSprintCapacity', policy.nextSprintCapacity ?? 1, 'type="number" min="0" max="200" required'),
    copy('Сохранить'), values => bridge.request('updateGrooming', { studioId: current.id, enabled: Boolean(values.enabled),
      threshold: values.threshold ? Number(values.threshold) : null, nextSprintCapacity: Number(values.nextSprintCapacity) }));
}

function backlogEditor(task) {
  const current = studio();
  const records = tasks().filter(row => row.id !== task?.id);
  const blockedBy = task?.dependencies ?? [];
  const priorLinks = (task?.links ?? []).filter(row => !['blocks', 'replaces'].includes(row.type));
  const linksOf = kind => priorLinks.filter(row => row.type === kind).map(row => row.taskId);
  dialogTo(task ? copy('Изменить задачу бэклога') : copy('Добавить в бэклог'),
    input(copy('Название'), 'title', task?.title, 'required maxlength="200"') +
    textarea(copy('Описание'), 'prompt', task?.prompt, 'required') + textarea(copy('Критерии приёмки'), 'criteria', listText(task?.criteria)) +
    input(copy('Приоритет (0–100)'), 'priority', task?.priority ?? 0, 'type="number" min="0" max="100" required') +
    input(copy('Оценка, баллов'), 'points', task?.points, 'type="number" min="1"') +
    (!task ? checkbox(copy('Улучшение проекта'), 'debt') : '') +
    (records.length ? copy`<details class="advanced"><summary>Связи с другими задачами</summary>
      ${checkList(copy('Готовность этой задачи зависит от'), records, 'blocks', blockedBy)}
      ${checkList(copy('Источники задачи'), records, 'origin', linksOf('origin'))}
      ${checkList(copy('Связанные улучшения'), records.filter(row => row.kind === 'debt'), 'debt-link', linksOf('debt'))}</details>` : ''),
    copy('Сохранить'), values => bridge.request('reviseBacklog', {
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
  dialogTo(copy('Заменить задачу'), `<p>${safe(task.title)}</p>` +
    select(copy('Задача на замену'), 'replacementId', recordOptions(records)) + checkbox(copy('Перенести зависимые задачи на замену'), 'redirect', true),
    copy('Сохранить замену'), ({ replacementId, redirect }) => {
      if (!replacementId) throw new Error(copy('Выберите задачу на замену.'));
      return bridge.request('reviseBacklog', { studioId: current.id, baseVersion: current.backlogVersion ?? 0,
        edits: [{ type: 'replace', taskId: task.id, replacementId, redirectDependencies: Boolean(redirect) }] });
    });
}

function closeSprintEditor(sprint) {
  const current = studio();
  const members = tasks().filter(task => task.sprintId === sprint.id && sprint.taskIds?.includes(task.id) && !['done', 'replaced'].includes(task.stage));
  const nextSprints = studioRows('sprints').filter(row => row.id !== sprint.id && row.status === 'active');
  const op = operationId();
  dialogTo(copy('Закрыть спринт'), `<p>${safe(sprint.title)}. ${members.length ? copy('Укажите, куда перенести каждую незавершённую задачу.') : copy('Все задачи завершены или заменены.')}</p>` +
    members.map((task, index) => `<fieldset class="export-files"><legend>${safe(task.title)}</legend><div class="form-body">
      ${select(copy('Этап после переноса'), `stage-${index}`, option('backlog', copy('Бэклог')) + option('ready', copy('Готова к работе')))}
      ${nextSprints.length ? select(copy('Следующий спринт'), `sprint-${index}`, recordOptions(nextSprints, '', copy('Оставить вне спринта'))) : ''}
      ${input(copy('Причина переноса'), `reason-${index}`, '', 'required')}</div></fieldset>`).join(''),
    copy('Закрыть спринт'), values => bridge.request('closeSprint', { studioId: current.id, sprintId: sprint.id, operationId: op,
      carryovers: members.map((task, index) => ({ taskId: task.id, reason: values[`reason-${index}`], stage: values[`stage-${index}`],
        ...(values[`sprint-${index}`] ? { sprintId: values[`sprint-${index}`] } : {}) })) }), { adjustable: true });
}

function phaseEditor(phase) {
  const current = studio();
  const epics = studioRows('epics');
  const sprints = studioRows('sprints');
  dialogTo(phase ? copy('Изменить фазу') : copy('Добавить фазу'),
    input(copy('Название'), 'title', phase?.title, 'required maxlength="200"') +
    textarea(copy('Цель'), 'goal', phase?.goal, 'required') +
    textarea(copy('Критерии завершения, каждый с новой строки'), 'criteria', phase?.criteria?.map(row => row.description).join('\n'), 'required') +
    checkList(copy('Эпики фазы'), epics, 'epic', phase?.epicIds) + checkList(copy('Спринты фазы'), sprints, 'sprint', phase?.sprintIds),
    copy('Сохранить'), values => bridge.request(phase ? 'updatePhase' : 'createPhase', {
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
    dialogTo(copy('Завершение фазы'), plain(phase.title) + `<ul class="legacy-list">${(phase.transition.evidenceIds ?? []).map(id =>
      `<li>${safe(done.find(row => row.id === id)?.title ?? id)}</li>`).join('')}</ul>` +
      select(copy('Решение'), 'decision', option('approve', copy('Подтвердить завершение')) + option('reject', copy('Вернуть в работу'))),
      copy('Сохранить решение'), ({ decision }) => bridge.request('decidePhaseTransition', { studioId: current.id, phaseId: phase.id, decision }));
    return;
  }
  const needsBindings = phase.criteria.length > 1 || phase.criteria.some(row => row.evidenceIds?.length);
  const criterionFields = needsBindings ? phase.criteria.map((criterion, index) =>
    checkList(criterion.description, done, `criterion-${index}`, criterion.evidenceIds)).join('') : checkList(copy('Доказательства'), done, 'evidence');
  dialogTo(copy('Предложить завершение фазы'), plain(phase.title) + (!done.length ?
    copy('<p class="muted">Свяжите фазу с эпиком или спринтом, где есть принятые результаты.</p>') : criterionFields),
    done.length ? copy('Предложить завершение') : undefined, done.length ? async values => {
      const criteria = needsBindings ? phase.criteria.map((row, index) => ({ ...row, evidenceIds: checkedIds(done, values, `criterion-${index}`) })) : phase.criteria;
      if (needsBindings && criteria.some(row => !row.evidenceIds.length)) throw new Error(copy('Выберите доказательство для каждого критерия.'));
      const evidenceIds = needsBindings ? [...new Set(criteria.flatMap(row => row.evidenceIds))] : checkedIds(done, values, 'evidence');
      if (!evidenceIds.length) throw new Error(copy('Выберите хотя бы одно доказательство.'));
      if (needsBindings) await bridge.request('updatePhase', { studioId: current.id, phaseId: phase.id, criteria });
      await bridge.request('proposePhaseTransition', { studioId: current.id, phaseId: phase.id, evidenceIds });
    } : undefined, { adjustable: true });
}

const activeRoster = current => (current.agents ?? []).filter(agent => agent.rosterStatus !== 'retired');
const makeMeetingKinds = () => ({ planning: copy('Планирование'), grooming: copy('Разбор очереди задач'), retrospective: copy('Ретроспектива'), topic: copy('Обсуждение'), review: copy('Ревью') });
let meetingKinds = makeMeetingKinds();
onCopyLocale(() => { meetingKinds = makeMeetingKinds(); });
const makeMeetingStages = () => ({ positions: copy('Позиции участников'), facilitation: copy('Обсуждение'), objections: copy('Возражения'), owner_review: copy('Ждёт решения владельца'), resolved: copy('Решение сохранено'), held: copy('Приостановлена') });
let meetingStages = makeMeetingStages();
onCopyLocale(() => { meetingStages = makeMeetingStages(); });
const listJson = (raw, label) => {
  try { const result = JSON.parse(raw || '[]'); if (Array.isArray(result)) return result; }
  catch { /* Display a validation message alongside this dialog's fields. */ }
  throw new Error(copy`«${label}» должен быть массивом JSON.`);
};

function meetingEditor() {
  const current = studio();
  const agents = activeRoster(current);
  const trainings = tasks().filter(task => task.kind === 'train');
  const available = [...tasks().filter(task => task.stage === 'done').map(row => ({ id: row.id, title: row.title, type: 'task' })),
    ...studioRows('evidence').filter(row => row.kind !== 'attachment').map(row => ({ id: row.id, title: row.name ?? row.filename ?? row.kind, type: 'evidence', digest: row.digest, revisionDigest: row.revision?.digest }))];
  const intro = agents.length ? '' : copy('<p class="muted">Добавьте участника в состав студии, чтобы назначить встречу.</p>');
  dialogTo(copy('Назначить встречу'), intro + input(copy('Название'), 'title', '', 'required maxlength="150"') +
    select(copy('Вид встречи'), 'kind', Object.entries(meetingKinds).map(([value, label]) => option(value, label, 'topic')).join('')) +
    textarea(copy('Повестка'), 'agenda', '', 'required') +
    (agents.length ? checkbox(copy('Доверить директору выбор участников'), 'chooseParticipants') +
      `<div data-manual-participants>${checkList(copy('Участники'), agents, 'participant', [], nameFor)}</div>` : '') +
    select(copy('Ведущий'), 'facilitatorId', recordOptions(agents, '', copy('Директор'), nameFor)) +
    select(copy('Спринт'), 'sprintId', recordOptions(studioRows('sprints'))) + select(copy('Фаза'), 'phaseId', recordOptions(studioRows('phases'))) +
    checkList(copy('Материалы'), available, 'material') +
    (trainings.length ? copy`<details class="advanced" data-manual-prerequisites><summary>Учебный допуск участника</summary><div class="form-body">
      ${select(copy('Задача обучения'), 'trainTaskId', recordOptions(trainings, '', copy('Без допуска')))}
      ${input(copy('Требуемый навык или версия'), 'skillRef')}${input(copy('Зачем нужен допуск'), 'prerequisiteReason')}${input(copy('Критерий допуска'), 'prerequisiteCriterion')}</div></details>` : ''),
    agents.length ? copy('Назначить') : undefined, agents.length ? async values => {
      const chooseParticipants = Boolean(values.chooseParticipants);
      const participants = chooseParticipants ? [] : checkedIds(agents, values, 'participant');
      if (!chooseParticipants && !participants.length) throw new Error(copy('Выберите хотя бы одного участника.'));
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
      <div class="actions">${training ? actionFor(copy('Открыть обучение'), 'task', training.id) : ''}
        ${row.retired ? badge(copy('Допуск снят после замены')) : row.exception ? badge(copy`Исключение: ${row.exception.author}`) : training?.stage === 'done' && training.status === 'completed' ? badge(copy('Обучение принято'), 'good') : badge(copy('Ждёт обучения'), 'warn')}
        ${!row.exception && !row.retired && training?.stage !== 'done' ? actionFor(copy('Оформить исключение'), 'waive-prerequisite', row.id) : ''}</div>
      ${row.exception ? plain(row.exception.reason, 'muted') : ''}</li>`;
  });
  return copy`<section class="inline-result"><h3>Учебные допуски</h3><ul class="legacy-list">${show.join('')}</ul></section>`;
}

function waivePrerequisiteEditor(row) {
  dialogTo(copy('Исключение для учебного допуска'), plain(row.skillRef) +
    input(copy('Кто разрешил исключение'), 'author', '', 'required') + textarea(copy('Причина'), 'reason', '', 'required'),
    copy('Сохранить исключение'), values => bridge.request('waivePrerequisite', { prerequisiteId: row.id, ...values }));
}

const trainingForTask = task => tasks().filter(row => row.kind === 'train' &&
  [task.agentId, task.reviewerId].filter(Boolean).includes(row.training?.targetAgentId));

function taskPrerequisiteEditor(task) {
  const rows = trainingForTask(task);
  dialogTo(copy('Учебный допуск задачи'),
    select(copy('Задача обучения'), 'trainTaskId', recordOptions(rows)) +
    input(copy('Требуемый навык или версия'), 'skillRef', '', 'required') +
    textarea(copy('Зачем нужен допуск'), 'reason', '', 'required') +
    textarea(copy('Критерий допуска'), 'criterion', '', 'required'), copy('Добавить допуск'), values => {
      const train = rows.find(row => row.id === values.trainTaskId);
      if (!train) throw new Error(copy('Выберите задачу обучения.'));
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
  const position = row => `<li><strong>${actionFor(participant(row.agentId),'owner-agent',row.agentId)}</strong> <time>${safe(studioDate(row.createdAt))}</time>
    <p class="muted">${row.purpose === 'meeting-objection' ? copy('Возражение') : copy('Позиция')}${row.superseded ? copy(' · Заменена') : ''}</p>${plain(row.text)}</li>`;
  dialogTo(meeting.title ?? meetingKinds[meeting.kind] ?? copy('Встреча'),
    `<div class="row">${badge(meetingStages[meeting.stage] ?? meetingKinds[meeting.kind] ?? copy('Архив'), meeting.stage === 'owner_review' ? 'warn' : '')}
      ${meeting.version ? copy`<span class="muted">Версия ${safe(meeting.version)}</span>` : ''}</div>` +
    (meeting.agenda ? copy`<section class="inline-result"><h3>Повестка</h3>${plain(meeting.agenda)}</section>` : '') +
    (present.length ? copy`<p class="muted">Участники: ${present.map(id => actionFor(participant(id),'owner-agent',id)).join(' ')}</p>` : '') +
    (meeting.materialRefs?.length ? copy`<section class="inline-result"><h3>Материалы</h3><div class="actions">${meeting.materialRefs.map(ref => ref.type === 'evidence'
      ? actionFor(copy('Открыть доказательство'), 'evidence', ref.id)
      : ['task', 'artifact'].includes(ref.type) ? actionFor(tasks().find(task => task.id === ref.id)?.title ?? copy('Задача'), 'task', ref.id) : '').join('')}</div></section>` : '') +
    prerequisiteBlock('meeting', meeting.id) +
    (meeting.positions?.length ? copy`<section class="inline-result"><h3>Позиции и возражения</h3><ul class="legacy-list">${meeting.positions.map(position).join('')}</ul></section>` : '') +
    (meeting.objectionRound?.question ? copy`<section class="inline-result"><h3>Вопрос к участникам</h3>${plain(meeting.objectionRound.question)}</section>` : '') +
    (meeting.error ? plain(meeting.error, 'error') : '') +
    (meeting.ownerReason ? copy`<section class="inline-result"><h3>Почему нужно ваше решение</h3>${plain(meeting.ownerReason)}</section>` : '') +
    (outcome.summary || meeting.outcome ? copy`<section class="inline-result"><h3>Итог</h3>${plain(outcome.summary ?? meeting.outcome)}</section>` : '') +
    (decisions.length ? copy`<section class="inline-result"><h3>Решения</h3><ul class="legacy-list">${decisions.map(row =>
      `<li><strong>${safe(row.text ?? row)}</strong>${row.rationale ? plain(row.rationale) : ''}${row.verification ? plain(copy`Проверка: ${row.verification}`, 'muted') : ''}</li>`).join('')}</ul></section>` : '') +
    (actionItems.length ? copy`<section class="inline-result"><h3>Действия</h3><ul class="legacy-list">${actionItems.map(row =>
      `<li><strong>${safe(row.title)}</strong>${plain(row.prompt)}${row.agentId ? plain(participant(row.agentId), 'muted') : ''}</li>`).join('')}</ul></section>` : '') +
    (meeting.taskIds?.length ? `<div class="actions">${meeting.taskIds.map(id => actionFor(tasks().find(row => row.id === id)?.title ?? copy('Открыть задачу'), 'task', id)).join('')}</div>` : '') +
    `<div class="actions">${canResolve ? actionFor(copy('Сохранить решение'), 'meeting-resolve', meeting.id, false) : ''}
      ${meeting.stage === 'held' ? actionFor(copy('Возобновить'), 'meeting-resume', meeting.id, false) : ''}
      ${canReplace ? actionFor(copy('Заменить участника'), 'meeting-replace', meeting.id) : ''}</div>`, undefined, undefined, { adjustable: true });
  dialogMeeting = meeting;
}

function resolveMeetingEditor(meeting) {
  const outcome = meeting.proposedOutcome ?? {};
  const agents = activeRoster(studio());
  dialogTo(copy('Решение встречи'), textarea(copy('Итог'), 'summary', outcome.summary, 'required') +
    textarea(copy('Дополнительное решение'), 'decisionText') + input(copy('Аргументы'), 'rationale') + input(copy('Как проверить решение'), 'verification') +
    copy`<details class="advanced"><summary>Действия по итогам встречи</summary><div class="form-body">
      ${input(copy('Название нового действия'), 'actionTitle')}${textarea(copy('Описание действия'), 'actionPrompt')}${input(copy('Критерии действия'), 'actionCriteria')}
      ${select(copy('Тип действия'), 'actionKind', option('work', copy('Задача')) + option('train', copy('Обучение')) + option('recommendation', copy('Рекомендация')))}
      ${select(copy('Ответственный'), 'actionAgentId', recordOptions(agents, '', copy('Без назначения'), nameFor))}</div></details>` +
    (outcome.decisions?.length || outcome.actionItems?.length ? copy`<details class="advanced"><summary>Предложения директора</summary>
      ${textarea(copy('Решения (JSON)'), 'proposedDecisions', JSON.stringify(outcome.decisions ?? [], null, 2))}
      ${textarea(copy('Действия (JSON)'), 'proposedActions', JSON.stringify(outcome.actionItems ?? [], null, 2))}</details>` : ''),
    copy('Подтвердить итог'), values => {
      const decisions = listJson(values.proposedDecisions, copy('Решения'));
      const actionItems = listJson(values.proposedActions, copy('Действия'));
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
  dialogTo(copy('Заменить участника'), select(copy('Текущий участник'), 'agentId', recordOptions(from, from[0]?.id, '', nameFor)) +
    select(copy('Новый участник'), 'replacementAgentId', recordOptions(to, to[0]?.id, '', nameFor)), copy('Заменить'), values => {
      if (!values.agentId || !values.replacementAgentId) throw new Error(copy('Выберите обоих участников.'));
      return bridge.request('replaceParticipant', { meetingId: meeting.id, ...values });
    });
}

const makeRosterKinds = () => ({ hire: copy('Найм'), retire: copy('Вывод роли'), return: copy('Возврат роли'), update: copy('Изменение роли'), rollback: copy('Откат роли') });
let rosterKinds = makeRosterKinds();
onCopyLocale(() => { rosterKinds = makeRosterKinds(); });
const makeRosterStages = () => ({ pending: copy('Ждёт решения'), approved: copy('Принято'), rejected: copy('Отклонено') });
let rosterStages = makeRosterStages();
onCopyLocale(() => { rosterStages = makeRosterStages(); });
const makeStaffingReasons = () => ({ headcount: copy('Превышен лимит участников'), budget: copy('Превышен бюджет'), 'budget-unverified': copy('Бюджет не подтверждён') });
let staffingReasons = makeStaffingReasons();
onCopyLocale(() => { staffingReasons = makeStaffingReasons(); });

function staffingEditor() {
  const current = studio();
  const rules = current.staffing ?? {};
  dialogTo(copy('Лимиты состава'), input(copy('Число рабочих ролей'), 'maxAgents', rules.maxAgents, copy('type="number" min="0" placeholder="Без лимита"')) +
    input(copy('Бюджет команды'), 'maxBudget', rules.maxBudget, copy('type="number" min="0" step="any" placeholder="Без лимита"')) +
    textarea(copy('Разрешения, по одному на строку'), 'permissions', rules.permissions?.join('\n')),
    copy('Сохранить'), values => bridge.request('updateStudio', { studioId: current.id, staffing: {
      maxAgents: values.maxAgents ? Number(values.maxAgents) : null, maxBudget: values.maxBudget ? Number(values.maxBudget) : null,
      permissions: lines(values.permissions),
    } }));
}

function rosterProposalEditor({ agent, kind = 'hire', rollbackProposalId } = {}) {
  const current = studio();
  const op = operationId();
  const firstRequired = ['hire', 'return'].includes(kind);
  dialogTo(rosterKinds[kind], (agent ? plain(nameFor(agent)) : '') +
    (kind === 'hire' ? input(copy('Название роли'), 'roleTitle', '', 'required') + input(copy('Имя агента'), 'name') +
      textarea(copy('Инструкции для роли'), 'description') + input(copy('Темы обучения'), 'topics', '', copy('placeholder="Через запятую"')) : '') +
    textarea(copy('Причина изменения состава'), 'reason', '', 'required') +
    (firstRequired ? textarea(copy('Первый результат роли'), 'firstResult', '', 'required') +
      input(copy('Оценка бюджета роли'), 'estimatedBudget', '', 'type="number" min="0" step="any"') : ''),
    copy('Создать предложение'), async values => {
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
  dialogTo(copy('Предложения и история ролей'), proposals.length ? `<ul class="legacy-list">${proposals.map(row =>
    `<li><div class="row"><strong>${safe([rosterKinds[row.kind], display(row)].filter(Boolean).join(' · '))}</strong>${badge(rosterStages[row.status] ?? row.status)}</div>
      ${plain(row.reason)}${row.initiator ? plain(copy`${row.initiator === 'owner' ? copy('Владелец') : copy('Директор')} · Версия ${row.version}`, 'muted') : ''}
      ${actionFor(row.status === 'pending' ? copy('Рассмотреть') : copy('Подробности'), 'roster-decision', row.id)}</li>`).join('')}</ul>`
    : copy('<p class="muted">Здесь появятся предложения директора и владельца.</p>'), undefined, undefined, { adjustable: true });
}

function rosterDecisionEditor(row) {
  const current = studio();
  const agent = current.agents?.find(agent => agent.id === row.agentId);
  const limits = row.limitReasons ?? [];
  const pending = row.status === 'pending';
  const destinations = activeRoster(current).filter(agent => agent.id !== row.agentId && agent.systemRole !== 'coach');
  dialogTo(rosterKinds[row.kind] ?? copy('Изменение состава'),
    `<div>${badge(rosterStages[row.status] ?? row.status, pending ? 'warn' : '')}</div>` +
    plain(row.settings?.roleTitle ?? (agent ? nameFor(agent) : '')) + plain(row.reason) +
    (row.firstResult ? copy`<section class="inline-result"><h3>Первый результат</h3>${plain(row.firstResult)}</section>` : '') +
    (row.settings ? `<p class="muted">${safe([modeNames[row.settings.mode], configText(row.settings)].filter(Boolean).join(' · '))}</p>` : '') +
    (limits.length ? plain(limits.map(reason => staffingReasons[reason] ?? reason).join(' · '), 'error') : '') +
    (pending ? select(copy('Решение'), 'decision', option('approve', copy('Принять')) + option('reject', copy('Отклонить'))) +
      (row.kind === 'retire' ? select(copy('Передать незавершённое'), 'transferAgentId', recordOptions(destinations, '', copy('Без передачи'), nameFor)) : '') +
      (limits.length ? checkbox(copy('Подтверждаю превышение лимитов'), 'overrideLimits') : '') : '') +
    (!pending && row.status === 'approved' && row.kind === 'update' && agent?.rosterStatus !== 'retired' ? actionFor(copy('Предложить откат'), 'roster-rollback', row.id) : ''),
    pending ? copy('Сохранить решение') : undefined,
    pending ? values => bridge.request('decideRosterChange', { proposalId: row.id, expectedVersion: row.version,
      decision: values.decision, ...(values.transferAgentId ? { transferAgentId: values.transferAgentId } : {}), ...(values.overrideLimits ? { overrideLimits: true } : {}),
    }) : undefined, { adjustable: true });
}

const makeLibraryLayers = () => ({ reference: copy('Общая справка'), decision: copy('Решение студии'), memory: copy('Рабочая память'), role: copy('База роли') });
let libraryLayers = makeLibraryLayers();
onCopyLocale(() => { libraryLayers = makeLibraryLayers(); });
const libraryKey = row => row.key ?? 'role-notes';
const libraryScope = (row, kind) => JSON.stringify([kind, row.layer ?? 'role', row.agentId ?? null, libraryKey(row)]);

function publishLibraryEditor() {
  const current = studio();
  const agents = current.agents ?? [];
  const op = operationId();
  dialogTo(copy('Добавить запись в библиотеку'),
    select(copy('Слой'), 'layer', ['reference', 'decision', 'memory'].map(layer => option(layer, libraryLayers[layer])).join('')) +
    select(copy('Роль для рабочей памяти'), 'agentId', recordOptions(agents, '', copy('Общая запись'), nameFor)) +
    input(copy('Ключ записи'), 'key', '', copy('required maxlength="80" placeholder="Например, project-checklist"')) +
    textarea(copy('Текст записи'), 'notes', '', 'required maxlength="3000"') + input(copy('Причина публикации'), 'reason', '', 'required maxlength="500"'),
    copy('Опубликовать'), ({ layer, agentId, key, notes, reason }) => {
      if (layer === 'memory' && !agentId) throw new Error(copy('Выберите роль для рабочей памяти.'));
      if (layer !== 'memory' && agentId) throw new Error(copy('Общая запись не привязывается к роли.'));
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
  const statuses = { publish: copy('Опубликовано'), rollback: copy('Откат версии'), revoke: copy('Отозвано') };
  const groups = Map.groupBy(records, row => libraryScope(row, row.kind));
  const body = [...groups.values()].map(group => {
    const ordered = group.toSorted((a, b) => (b.version ?? 1) - (a.version ?? 1));
    const row = ordered[0];
    const history = events.filter(event => libraryScope(event, event.kind) === libraryScope(row, row.kind));
    const active = history.length ? ordered.find(entry => entry.id === history[0].versionId) : row;
    const role = current.agents?.find(agent => agent.id === row.agentId);
    return `<section class="inline-result stack compact"><h3>${safe([libraryLayers[row.layer ?? 'role'], role && nameFor(role), row.title ?? libraryKey(row)].filter(Boolean).join(' · '))}</h3>
      <ul class="legacy-list">${ordered.map(version => copy`<li><div class="row"><strong>Версия ${safe(version.version ?? 1)}</strong>
        ${active?.id === version.id ? badge(copy('Текущая'), 'good') : ''}</div>
        ${plain(version.notes ?? version.content, 'long-text')}
        ${actionFor(active?.id === version.id ? copy('Отозвать') : copy('Вернуть эту версию'), 'change-knowledge', version.id)}</li>`).join('')}</ul>
      ${history.length ? copy`<details><summary>Изменения</summary><ul class="legacy-list">${history.map(event =>
        `<li>${safe(statuses[event.action] ?? event.action)} · ${safe(studioDate(event.createdAt))}
          ${plain(event.reason, 'muted')}</li>`).join('')}</ul></details>` : ''}</section>`;
  }).join('');
  dialogTo(copy('Версии и история библиотеки'), body || copy('<p class="muted">Записей пока нет.</p>'), undefined, undefined, { adjustable: true });
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
  const title = action === 'revoke' ? copy('Отозвать запись') : copy('Вернуть версию записи');
  dialogTo(title, plain(copy`${record.title ?? libraryKey(record)} · Версия ${record.version ?? 1}`) +
    textarea(copy('Причина изменения'), 'reason', '', 'required maxlength="500"'), title, ({ reason }) =>
    bridge.request('changeKnowledge', { studioId: current.id, ...(record.agentId ? { agentId: record.agentId } : {}),
      layer: record.layer ?? 'role', kind, key: libraryKey(record), action, reason, operationId: op,
      expectedVersion: active ? active.version ?? 1 : 0, ...(action === 'rollback' ? { versionId: record.id } : {}),
    }));
}

function scheduleEditor() {
  const current = studio();
  const schedule = current.schedule ?? defaultSchedule;
  const days = weekdays.map(([day, label]) => `<label class="checkbox-field"><input type="checkbox" name="day-${day}"${schedule.days.includes(day) ? ' checked' : ''}> <span>${label}</span></label>`).join('');
  dialogTo(copy('Расписание студии'),
    copy`<label class="checkbox-field"><input type="checkbox" name="schedule-enabled"${schedule.enabled ? ' checked' : ''}> <span>Запускать задачи по расписанию</span></label>
     <fieldset class="export-files"><legend>Дни запуска</legend><div class="schedule-days">${days}</div></fieldset>
     <div class="schedule-times">${input(copy('Начало'), 'start', schedule.start, 'type="time" required')}${input(copy('Конец'), 'end', schedule.end, 'type="time" required')}</div>
     <p class="muted">Время местное. Если конец раньше начала, окно продолжается на следующий день. Вне окна новые задачи ждут, а запущенные завершаются. Для работы по расписанию Hearth должен быть запущен.</p>`,
    copy('Сохранить расписание'), values => bridge.request('updateStudio', {
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
  dialogTo(copy('Удалить студию'),
    copy`<p>Задачи, планы и история студии «${safe(current.name)}» будут удалены из Hearth. Папка проекта и её файлы сохранятся.</p><p class="muted">Для подтверждения введите название студии.</p>` +
    input(copy('Название студии'), 'confirmation', '', 'required autocomplete="off"'),
    copy('Удалить студию'), async ({ confirmation }) => {
      await bridge.request('deleteStudio', { studioId: current.id, confirmation });
      selectStudio(null);
      view = 'workspace';
      notice(copy('Студия удалена из Hearth.'));
    });
}

function studioEditor(current) {
  if (!current) {
    newStudio();
    return;
  }
  dialogTo(copy('Параметры студии'),
    input(copy('Название'), 'name', current.name, 'required maxlength="120"') +
    pathField(current.projectDetached ? '' : current.root) + textarea(copy('Чем будет заниматься студия?'), 'brief', current.brief) +
    reportLanguageField(current) +
    languageField(copy('Язык материалов проекта'), 'projectLanguage', current.projectLanguage || '', true),
    copy('Сохранить студию'), async values => {
      if (!values.root) throw new Error(copy('Выберите рабочую папку.'));
      await bridge.request('updateStudio', { studioId: current.id, ...values, languageMode:values.language ? 'studio' : 'app' });
    });
}

const makeWizardNames = () => ([copy('Что создаём'), copy('Папка и язык'), copy('Подключение директора')]);
let wizardNames = makeWizardNames();
onCopyLocale(() => { wizardNames = makeWizardNames(); });

function preferredRuntime() {
  const supported = Object.keys(runtimeNames);
  return supported.find(id => providerState[id]?.enabled !== false && providerState[id]?.available && providerState[id]?.authenticated === true) ??
    supported.find(id => providerState[id]?.enabled !== false) ?? 'codex';
}

const wizardOpen = () => form.querySelector('[data-wizard-step]:not([hidden])');
function saveWizardDraft(pending=false) {
  const step=wizardOpen();
  if(!step)return;
  const fields=Object.fromEntries([...form.elements].filter(element=>element.name).map(element=>
    [element.name,element.type==='checkbox'?element.checked:element.value]));
  writeStudioDraft(localStorage,{step:Number(step.dataset.wizardStep),fields,pending,
    existingIds:pending?state.studios.map(row=>row.id):[]});
}

function recoverStudioDraft(draft) {
  const normalized=path=>String(path??'').replaceAll('\\','/').replace(/\/+$/,'');
  const root=normalized(draft.fields.root);
  const expected=draft.fields.folderMode==='new'?root+'/'+draft.fields.newFolderName?.trim():root;
  const studio=state.studios.find(row=>!row.archivedAt&&!draft.existingIds.includes(row.id)&&
    row.name===draft.fields.name?.trim()&&normalized(row.root)===expected);
  if(studio){
    dialogTo(copy('Студия уже создана'),plain(studio.name),copy('Открыть студию'),()=>{
      clearStudioDraft(localStorage);selectStudio(studio.id);route('overview');
    });
    return;
  }
  dialogTo(copy('Проверьте результат создания'),
    plain(copy('Проверьте список студий и папку. Если папка уже создана, выберите её как существующую.')),
    copy('Продолжить после сверки'),()=>{
      writeStudioDraft(localStorage,{...draft,step:1,pending:false},{afterReview:true});
      newStudio();
      return false;
    });
}

function newStudio() {
  const draft=readStudioDraft(localStorage);
  if(draft?.pending){recoverStudioDraft(draft);return;}
  const saved=draft?.fields??{};
  const firstRuntime = saved.runtime??preferredRuntime();
  const existing=saved.folderMode==='existing';
  const step = (number, fields) => `<section class="form-body" data-wizard-step="${number}"${number ? ' hidden' : ''}>
    <h3>${wizardNames[number]}</h3>${fields}</section>`;
  dialogTo(copy('Новая студия'),
    copy('<ol class="wizard-progress" aria-label="Шаги настройки">') +
    wizardNames.map((name, index) => `<li${index === 0 ? ' aria-current="step"' : ''}>${name}</li>`).join('') + '</ol>' +
    step(0, input(copy('Название студии'), 'name', saved.name, 'required maxlength="120"') +
      textarea(copy('Чем будет заниматься студия?'), 'brief', saved.brief, copy('required placeholder="Опишите работу своими словами"')) +
      textarea(copy('Какую первую задачу ставим студии?'), 'firstResult', saved.firstResult, copy('placeholder="Например, придумать пять персонажей и написать их биографии"'))) +
    step(1, select(copy('Где хранить проект?'), 'folderMode', option('new',copy('Создать новую папку с историей Git'),saved.folderMode) + option('existing',copy('Использовать существующую папку'),saved.folderMode)) +
      pathField(saved.root, {label:copy(existing?'Папка проекта':'Родительская папка')}) +
      copy`<div data-new-folder${existing?' hidden':''}>${input(copy('Имя новой папки'), 'newFolderName', saved.newFolderName, copy('maxlength="120" placeholder="Например, Рассказы"'))}
      <p class="muted">Hearth создаст пустой проект с локальной историей и отдельной веткой доставки. Аккаунт GitHub не требуется.</p></div>
      <div data-existing-folder${existing?'':' hidden'}>${checkbox(copy('После создания студии предложить подключить Git'), 'offerGit', saved.offerGit!==false)}
      <p class="muted">Подключение предложим, если в папке уже есть репозиторий. Существующие файлы и коммиты сохранятся.</p></div>` +
      reportLanguageField(saved.language?{language:saved.language,languageMode:'studio'}:undefined) +
      languageField(copy('Язык материалов проекта'), 'projectLanguage', saved.projectLanguage||'', true)) +
    step(2, select(copy('Подключение директора'), 'runtime',
      Object.entries(runtimeNames).map(([id, label]) => option(id, providerState[id]?.enabled === false ? copy`${label} · отключён в приложении` : label, firstRuntime)).join('')) +
      input(copy('Модель директора'), 'model', saved.model, copy('placeholder="По умолчанию"')+' list="wizard-models"') +
      '<datalist id="wizard-models"></datalist>' +
      input(copy('Усилие'), 'effort', saved.effort, copy('placeholder="По умолчанию"')) +
      '<div id="wizard-provider" class="stack compact" role="status"></div>' +
      copy('<p class="muted">Для запуска нужно рабочее подключение. Черновик можно сохранить в любом случае.</p>')),
    copy('Создать студию'), async ({ brief, firstResult, runtime, model, effort, folderMode, newFolderName, offerGit, ...values }) => {
      if (!values.root) throw new Error(copy('Выберите рабочую папку.'));
      const completeBrief = [brief, firstResult && copy`Первая задача — ${firstResult}`].filter(Boolean).join('\n\n');
      saveWizardDraft(true);
      let created;
      try {
        created = await bridge.request('createStudio', { ...values, sprintReview:'summary',
          ...(folderMode === 'new' ? {newFolderName} : {offerGit: Boolean(offerGit)}), brief: completeBrief, director: { runtime, model, effort } });
      } catch (error) {
        await refresh();
        const pending=readStudioDraft(localStorage);
        if(pending?.pending){recoverStudioDraft(pending);dialogError(error.message);return false;}
        throw error;
      }
      clearStudioDraft(localStorage);
      selectStudio(created.id);
      view = 'overview';
      if (created.gitOfferAvailable) {
        await refresh();
        projectGitEditor();
        return false;
      }
      notice(copy('Студия создана. Подготовьте план первого спринта в обзоре.'));
    });
  $('#dialog-actions').insertAdjacentHTML('afterbegin', button(copy('Назад'), 'data-wizard-back hidden', true));
  $('#dialog-actions').insertAdjacentHTML('beforeend', button(copy('Сохранить черновик'), 'data-save-studio-draft', true));
  $('#dialog-actions').insertAdjacentHTML('beforeend', button(copy('Далее'), 'data-wizard-next'));
  if(saved.runtime)form.elements.runtime.dataset.userPicked='true';
  showWizardStep(draft?.step??0);
}

function updateWizardProvider() {
  const node = $('#wizard-provider');
  if (!node) return;
  const selection = form.elements.runtime;
  if (!selection.dataset.userPicked) selection.value = preferredRuntime();
  const runtime = selection.value;
  const info = providerState[runtime];
  $('#wizard-models').innerHTML=(info?.models??[]).map(model=>option(model.id,model.name)).join('');
  node.innerHTML = `<div class="row">${providerBadge(runtime)}
    ${button(copy('Проверить подключение'), `data-inspect="${safe(runtime)}"${inspecting.has(runtime) ? ' disabled' : ''}`, true)}</div>
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
  saveWizardDraft();
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
      dialogError(copy('Заполните обязательное поле.'));
      missing.focus();
      return;
    }
  }
  if (direction > 0 && index === 1 && !form.elements.root.value) {
    dialogError(copy('Выберите рабочую папку.'));
    form.querySelector('[data-folder]').focus();
    return;
  }
  if (direction > 0 && index === 1 && form.elements.folderMode.value === 'new' && !form.elements.newFolderName.value.trim()) {
    dialogError(copy('Укажите имя новой папки.'));
    form.elements.newFolderName.focus();
    return;
  }
  showWizardStep(index + direction);
}

function taskEditor(agentId = '', backlog = false) {
  const current = studio();
  const agents = activeRoster(current).filter(agent => agent.systemRole !== 'coach');
  const choices = [option('', copy('Директор'), agentId), ...agents.map(agent => option(String(agent.id), nameFor(agent), agentId))].join('');
  const selectedAttachments = [];
  const records = tasks();
  dialogTo(copy('Новая задача'), input(copy('Название'), 'title', '', 'required maxlength="160"') +
    textarea(copy('Что нужно сделать'), 'prompt', '', 'required') + select(copy('Исполнитель'), 'agentId', choices) +
    textarea(copy('Критерии приёмки'),'criteria','') +
    select(copy('Эпик'),'epicId',option('',copy('Без эпика'))+studioRows('epics').map(e=>option(e.id,e.title,ownerTrail.current?.kind==='epic'?ownerTrail.current.id:'')).join(''))+
    input(copy('Приоритет (0–100)'),'priority',0,'type="number" min="0" max="100"')+
    input(copy('Оценка, баллов'),'points','','type="number" min="1" max="100"')+
    (records.length ? copy`<details class="advanced"><summary>Зависимости</summary>${checkList(copy('Должны завершиться раньше'),records,'dependency',[])}</details>` : '')+
    attachmentFields() + checkbox(copy('Улучшение проекта'), 'debt') + checkbox(copy('Запустить задачу после создания'), 'startImmediately', !backlog) +
    (current.projectGit?.enabled ? select(copy('Доставка результата'), 'deliveryMode', option('', copy('Текстовый результат или файл')) + option('git', copy('Изменения в Git'))) +
      select(copy('Независимое ревью для Git'), 'reviewerId', option('', copy('Выбирает студия')) + agents.map(agent => option(String(agent.id), nameFor(agent))).join('')) : ''),
    copy('Создать задачу'), async ({ agentId: raw, debt, deliveryMode, reviewerId, startImmediately, ...values }) => {
      const agent = agents.find(item => same(item.id, raw));
      const reviewer = deliveryMode === 'git' && agents.find(item => same(item.id, reviewerId));
      if (deliveryMode === 'git' && !agent) throw new Error(copy('Выберите исполнителя из команды для задачи Git.'));
      if (reviewer && reviewer.id === agent?.id) throw new Error(copy('Выберите рецензента, который не выполняет задачу.'));
      const task = await bridge.request('createTask', {
        studioId: current.id, title:values.title,prompt:values.prompt,criteria:values.criteria,epicId:values.epicId,
        points:values.points ? Number(values.points) : undefined, priority:Number(values.priority),backlog:backlog && !startImmediately,
        dependencies:checkedIds(records,values,'dependency'),attachmentIds:selectedAttachments.map(row=>row.id),
        ...(agent ? { agentId: agent.id } : {}), ...(debt ? { kind: 'debt' } : {}),
        ...(deliveryMode === 'git' ? { deliveryMode, ...(reviewer ? { reviewerId: reviewer.id } : {}) } : {}),
      });
      try {
        if (startImmediately) await bridge.request('startTask', { taskId: task.id });
        await refresh();
        dialog.close();
        inspectObject('task',task.id);
        return false;
      } catch (error) {
        await refresh();
        openTask(tasks().find(entry => entry.id === task.id) ?? task);
        dialogError(error.message || copy('Задача сохранена. Повторите запуск.'));
        return false;
      }
    }, {adjustable:true});
  dialogAttachments = selectedAttachments;
}

async function loadTransitions(button, task) {
  const region = button.parentElement;
  button.disabled = true;
  try {
    const page = await bridge.request('taskHistory', {studioId:task.studioId, taskId:task.id,
      ...(button.dataset.before ? {before:Number(button.dataset.before)} : {})});
    if (!region.isConnected) return;
    const stageLabels = {backlog:copy('Бэклог'), ready:copy('Готова'), in_progress:copy('В работе'), review:copy('Ревью'), qa:copy('Проверка'), done:copy('Готово'), blocked:copy('Заблокирована')};
    const label = (dict, key) => Object.hasOwn(dict, key) ? dict[key] : key ?? '—';
    const stateLabel = key => statuses[key]?.[0] ?? key ?? '—';
    const assignee = id => nameFor(studio().agents?.find(a => a.id === id)) + (id ? ' · '+id : '');
    const events = page.rows.map(row => {
      const changes = [];
      if (row.fromStatus !== row.toStatus) changes.push(stateLabel(row.fromStatus)+' → '+stateLabel(row.toStatus));
      if (row.fromStage !== row.toStage) changes.push(label(stageLabels,row.fromStage)+' → '+label(stageLabels,row.toStage));
      if (row.fromAgent !== row.toAgent) changes.push(assignee(row.fromAgent)+' → '+assignee(row.toAgent));
      const actor=row.actor?.source==='owner' ? copy('Владелец') : row.actor?.role || row.actor?.purpose;
      return `<li><time>${safe(studioDate(row.at))}</time> · ${safe(changes.join(' · '))} ${actor ? '· '+safe(actor) : ''}${row.actor?.attemptId ? ' · '+safe(row.actor.attemptId.slice(0,8)) : ''}</li>`;
    }).join('');
    region.querySelector('ul').insertAdjacentHTML('beforeend', events || copy('<li>Нет записанных переходов.</li>'));
    if (page.nextBefore) {
      button.dataset.before = page.nextBefore;
      button.textContent = copy('Ещё переходы');
    } else button.remove();
  } catch (error) {
    if (region.isConnected) dialogError(error.message);
  } finally { button.disabled = false; }
}

function dismissInspector(restore = true) {
  if (!ownerTrail.current) return;
  ownerTrail.close();
  ownerPanel.hidden = true;
  $('#owner-body').replaceChildren();
  ownerMarkup = undefined;
  if (restore && ownerOrigin) {
    const target = Array.from(content.querySelectorAll('button')).find(b=>b.dataset[ownerOrigin.key]===ownerOrigin.id);
    (target ?? content).focus({preventScroll:true});
    window.scrollTo(0,ownerOrigin.scroll); content.scrollTop=ownerOrigin.listScroll;
  }
  ownerOrigin = undefined;
  for (const row of content.querySelectorAll('.registry tr[aria-current]')) row.removeAttribute('aria-current');
}

function inspectObject(kind,id) {
  if (!ownerTrail.current) {
    const key = Object.keys(document.activeElement?.dataset ?? {})[0] ?? 'task';
    ownerOrigin = {key,id:document.activeElement?.dataset[key] ?? id,scroll:window.scrollY,listScroll:content.scrollTop};
  } else ownerTrail.savePosition(ownerPanel.scrollTop);
  ownerTrail.visit(studioId,kind,id);
  paintInspector(true);
}

function paintInspector(focus) {
  const record = ownerTrail.current;
  if (!record || record.studioId !== studioId) return dismissInspector(false);
  const lists = {task:tasks(),epic:studioRows('epics'),story:studioRows('stories'),sprint:studioRows('sprints'),meeting:studioRows('meetings'),agent:[{...studio().director,id:'',role:'director'},...studio().agents]};
  for (const kind of ['skills','knowledge','customSkills']) lists[kind]=studioRows(kind);
  const obj = lists[record.kind]?.find(row=>row.id===record.id);
  if (!obj) return dismissInspector();
  const show = (title,body) => {
    const pos = focus ? record.scroll : ownerPanel.scrollTop;
    ownerPanel.hidden = false;
    ownerPanel.querySelector('[data-owner-back]').hidden = ownerTrail.depth < 2;
    ownerPanel.querySelector('[data-owner-back]').textContent = ui('back');
    ownerPanel.querySelector('[data-owner-close]').textContent = ui('close');
    $('#owner-title').textContent = title;
    const commentBox=$('#owner-comment');
    commentBox.hidden=record.kind!=='task';
    if(!commentBox.hidden) {
      const key=commentKey(record.studioId,record.id);
      if(commentBox.dataset.key!==key) {
        commentBox.elements.comment.value=commentDrafts.get(key)?.text ?? '';
        commentBox.querySelector('[role=status]').textContent='';
        commentBox.dataset.key=key;
      }
      commentBox.querySelector('label span').textContent=ui('comment');
      commentBox.querySelector('button').textContent=ui('postComment');
    }
    const container = $('#owner-body');
    if (ownerMarkup !== body || focus) {
      const expanded = focus ? [] : [...container.querySelectorAll('details[open][data-section]')].map(n=>n.dataset.section);
      const prev = container.contains(document.activeElement) ? Object.entries(document.activeElement.dataset)[0] : undefined;
      container.innerHTML = body;
      for (const detail of container.querySelectorAll('details[data-section]')) detail.open = expanded.includes(detail.dataset.section);
      if (!focus && prev) [...container.querySelectorAll('button')].find(b=>b.dataset[prev[0]]===prev[1])?.focus({preventScroll:true});
      ownerMarkup = body;
    }
    for (const btn of content.querySelectorAll('.registry .work-task-link[data-task]')) {
      const tr = btn.closest('tr');
      if (record.kind==='task' && btn.dataset.task===record.id) tr.setAttribute('aria-current','true'); else tr.removeAttribute('aria-current');
    }
    if (focus) $('#owner-title').focus({preventScroll:true});
    ownerPanel.scrollTop = pos;
  };
  if (record.kind==='task') { openTask(obj,show); return; }
  if (['skills','knowledge','customSkills'].includes(record.kind)) {
    const uses=studioRows('attempts').filter(attempt=>attempt.calls?.some(c=>c.materials?.some(m=>m.id===obj.id && m.kind===record.kind)));
    show(obj.title || obj.key || obj.path || obj.id,plain(obj.notes || obj.content || obj.description || '')+
      plain([obj.repo,obj.commit,obj.version,obj.createdAt].filter(Boolean).join(' · '))+
      [...new Set(uses.map(a=>a.taskId))].flatMap(id=>tasks().filter(t=>t.id===id).map(t=>actionFor(t.title,'task',t.id))).join(''));
    return;
  }
  const all = tasks();
  let members;
  if (record.kind==='epic') members = membersOfEpic(obj,studioRows('stories'),all);
  if (record.kind==='sprint') members = all.filter(t=>t.sprintId===obj.id || obj.taskIds?.includes(t.id));
  if (record.kind==='story') members = all.filter(t=>t.storyId===obj.id);
  if (record.kind==='agent') members = all.filter(t=>(t.agentId ?? '')===obj.id || [t.reviewerId,t.activeAgentId].includes(obj.id));
  if (record.kind==='meeting') members = all.filter(t=>t.fromMeetingId===obj.id || obj.taskIds?.includes(t.id));
  const done = rows=>rows.filter(t=>t.stage==='done' || (!t.stage && t.status==='completed'));
  const points = rows=>rows.every(t=>Number.isFinite(t.points)) ? rows.reduce((s,t)=>s+t.points,0) : '—';
  const parent = obj.epicId && studioRows('epics').find(e=>e.id===obj.epicId);
  const summary = obj.goal || obj.agenda || obj.description || obj.summary || '';
  const roleMaterials=record.kind==='agent'&&obj.id
    ? ['knowledge','customSkills','skills'].flatMap(kind=>studioRows(kind)
      .filter(row=>row.agentId===obj.id||obj.skillIds?.includes(row.id))
      .map(row=>`<button type="button" class="text-button" data-used-material="${safe(row.id)}" data-kind="${kind}">${safe(row.title||row.key||row.path)}${row.version?' · '+safe(row.version):''}</button>`)) : [];
  const breaks = record.kind==='epic' ? studioRows('sprints').map(s=>{
    const group = members.filter(t=>t.sprintId===s.id || s.taskIds?.includes(t.id));
    return group.length ? `<tr><td>${actionFor(s.title,'owner-sprint',s.id)}</td><td>${done(group).length} / ${group.length}</td><td>${points(done(group))} / ${points(group)}</td></tr>` : '';
  }).join('') : '';
  show(record.kind==='agent' ? nameFor(obj) : obj.title || obj.id,
    `<small>${safe(obj.id)}</small>`+(parent ? actionFor(parent.title,'owner-epic',parent.id) : '')+
    (summary ? plain(summary) : '')+
    (record.kind==='story' && (obj.acceptance??obj.criteria??obj.acceptanceCriteria) ?
      copy`<section class="inline-result"><h3>Критерии приёмки</h3>${plain(listText(obj.acceptance??obj.criteria??obj.acceptanceCriteria))}</section>` : '')+
    (record.kind==='agent' ? badge(...teamContext(studio()).activityFor(obj))+(obj.id ? roleReadiness(obj,all) : '')+
      `<div class="actions">${actionFor(copy('Написать'),'message',obj.id)} ${actionFor(copy('История работы'),'agent-history',obj.id)} ${obj.systemRole==='coach' ? '' : actionFor(copy('Поставить задачу'),'new-task',obj.id)}</div>` : '')+
    (record.kind==='agent' ? `<p>${safe(titleFor(obj))} · ${safe(configText(obj) || '—')}</p>` : '')+
    (roleMaterials.length?copy`<details class="advanced" data-section="role-materials"><summary>Материалы роли · ${roleMaterials.length}</summary><div class="actions">${roleMaterials.join('')}</div></details>`:'')+
    (record.kind==='meeting' ? actionFor(copy('Открыть протокол'),'meeting-detail',obj.id) : '')+
    copy`<p>Готово ${done(members).length} / ${members.length} · Баллы ${points(done(members))} / ${points(members)}</p>`+
    (breaks ? copy`<table class="owner-table"><thead><tr><th>Спринт</th><th>Задачи</th><th>Баллы</th></tr></thead><tbody>${breaks}</tbody></table>` : '')+
    members.map(t=>`<div class="row">${actionFor(t.title,'task',t.id)} ${status(t)}</div>`).join(''));
}

function openTask(task, present) {
  if (!present && !dialog.open) { inspectObject('task',task.id); return; }
  const latest = tasks().find(entry => entry.id === task.id && entry.studioId === task.studioId);
  if (!latest) return;
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
  const startLabel = latest.kind === 'train' ? copy('Запустить обучение') : dependencies.length ? copy('Запустить после обучения')
    : latest.status === 'queued' ? copy('Запустить') : copy('Запустить снова');
  const needsWorktreeReview = latest.legacyWorktreeReview === true;
  const artifact = typeof latest.artifact === 'object' && latest.artifact
    ? JSON.stringify(latest.artifact, null, 2) : latest.artifact;
  const block = (label, value) => value ? `<section class="inline-result"><h3>${label}</h3>${plain(value)}</section>` : '';
  const isOpen = taskDialog?.id === latest.id;
  const expanded = isOpen ? Array.from($('#dialog-body').querySelectorAll('details[data-section][open]'), el => el.dataset.section) : [];
  const previousScroll = $('#dialog-body').scrollTop;
  const epic = taskEpic(latest);
  const facts = taskFacts(state, latest.studioId, latest.id);
  const attempts = facts.attempts.toSorted((a,b)=>String(b.startedAt??'').localeCompare(String(a.startedAt??'')) || b.id.localeCompare(a.id));
  const pageKey=JSON.stringify([latest.studioId,latest.id]);
  const limit=historyLimits.get(pageKey) ?? 20;
  const more = count=>count>limit ? actionFor(ui('more')+' · '+(count-limit),'history-more',latest.id) : '';
  const eventNames = { created: copy('Создана задача'), 'attempt-start': copy('Начат запуск'), 'attempt-end': copy('Запуск завершён'), message: copy('Сообщение'), evidence: copy('Сохранено доказательство') };
  const git = latest.gitDelivery;
  const recovery=taskRecoveryBlock(latest);
  const importedGitCheck = latest.importedGitCheck;
  const links = (latest.links ?? []).filter(row => row.type !== 'blocks');
  const related = (id, label) => {
    const record = allTasks.find(row => row.id === id);
    return record ? `<li><span>${label}</span>${actionFor(record.title, 'task', id)}</li>` : '';
  };
  const purposes = { task: copy('Исполнение'), review: copy('Ревью'), director: copy('Решение директора'), publish: copy('Запись файла'), 'training-exercise': copy('Упражнение') };
  const previousFocus = dialog.contains(document.activeElement) ? Object.entries(document.activeElement.dataset)[0]?.[0] : '';
  (present ?? dialogTo)(latest.title, `<div class="row"><div class="actions">${needsWorktreeReview ? badge(copy('Ждёт сверки рабочего дерева'), 'warn') : status(latest)}
    ${latest.kind === 'debt' ? badge(copy('Улучшение')) : ''}</div><span class="muted">${safe(nameFor(taskAgent(latest)))}</span></div>` +
    (epic ? `<div class="actions">${actionFor(copy('К эпику'), 'epic-link', epic.id)}<span class="muted">${safe(epic.title)}</span></div>` : '') +
    copy`<div class="owner-meta"><button type="button" class="text-button" aria-label="Скопировать ID задачи" title="${safe(latest.id)}" data-copy-id="${safe(latest.id)}">${safe(latest.legacyId || latest.id.slice(0,8))}</button> · ${safe(latest.priority ?? '—')} · ${safe(latest.points ?? '—')} б.</div>`+recovery+'<div class="actions owner-links">'+
    ['story','sprint','meeting','agent'].flatMap(kind=>{
      const objects=kind==='agent' ? current.agents : studioRows({story:'stories',sprint:'sprints',meeting:'meetings'}[kind]);
      return objects.filter(o=>kind==='meeting' ? o.id===latest.fromMeetingId || o.taskIds?.includes(latest.id) :
        kind==='agent' ? [latest.agentId,latest.reviewerId].includes(o.id) : latest[kind+'Id']===o.id)
        .map(o=>actionFor(kind==='agent' ? nameFor(o) : o.title,'owner-'+kind,o.id));
    }).join('')+'</div>'+
    block(copy('Постановка задачи'), latest.prompt) + block(copy('Критерии'), listText(latest.criteria)) + (recovery?'':block(copy('Ошибка'), latest.error)) +
    renderEvidence(studioRows('evidence').filter(row=>latest.attachmentIds?.includes(row.id)))+
    renderTrainingDetails(latest, studio(), allTasks) +
    prerequisiteBlock('task', latest.id) +
    (facts.before.length || facts.after.length ? copy('<section class="inline-result"><h3>Зависимости</h3><ul class="legacy-list">') +
      facts.before.map(row => related(row.id, copy('Зависит от'))).join('') +
      facts.after.map(row => related(row.id, copy('Ожидает эту задачу'))).join('') + '</ul></section>' : '') +
    (latest.replacedBy || links.length ? copy`<section class="inline-result"><h3>Связанные задачи</h3><ul class="legacy-list">
      ${latest.replacedBy ? related(latest.replacedBy, copy('Заменена задачей')) : ''}
      ${links.map(row => related(row.taskId, { origin: copy('Источник'), debt: copy('Связанное улучшение'), replaces: copy('Заменяет') }[row.type] ?? copy('Связь'))).join('')}</ul></section>` : '') +
    (latest.carryoverHistory?.length ? copy`<details class="advanced"><summary>История переноса</summary><ul class="legacy-list">${latest.carryoverHistory.map(row =>
      `<li>${safe(studioRows('sprints').find(sprint => sprint.id === row.fromSprintId)?.title ?? row.fromSprintId)} · ${safe(row.reason)}</li>`).join('')}</ul></details>` : '') +
    (importedGitCheck ? copy`<section class="inline-result"><h3>Сверка импортированной истории Git</h3>
      <p class="muted">${safe(studioDate(importedGitCheck.checkedAt))}</p>
      <p>${importedGitCheck.targetStillMatches ? copy('Версия целевой ветки совпадает.') : copy('Целевая ветка изменилась или недоступна.')}</p>
      ${importedGitCheck.missing?.length ? copy`<p>В репозитории недостаёт версий:</p><ul class="legacy-list">${importedGitCheck.missing.map(row =>
        `<li>${safe(row.oid ?? row.id ?? row)}</li>`).join('')}</ul>` : copy('<p>Версии результата найдены.</p>')}</section>` : '') +
    (latest.summary && latest.summary !== artifact ? block(copy('Краткий отчёт'), latest.summary) : '') +
    (latest.improvements?.length ? copy`<section class="inline-result"><h3>Найденные улучшения</h3><ul class="plan-list">
      ${latest.improvements.map(item => `<li><strong>${safe(item.title)}</strong>${plain(item.reason)}</li>`).join('')}</ul></section>` : '') +
    block(copy('Ревью'), latest.review) + block(copy('Решение директора'), latest.directorDecision) +
    block(copy('Результат'), artifact) +
    entries().filter(i=>i.taskId===latest.id && i.kind==='acceptance').map(i=>actionFor(inboxLabel(i)+' · '+studioDate(i.createdAt),'inbox',i.id)).join('')+
    copy`<details class="advanced"><summary>Переходы задачи</summary><div><ul class="legacy-list"></ul>${actionFor(copy('Загрузить историю переходов'), 'task-transitions', latest.id)}</div></details>` +
    (facts.messages.length ? copy`<details class="advanced" data-section="discussion"><summary>Обсуждение · ${facts.messages.length}</summary><ul class="legacy-list">${facts.messages.slice(0,limit).map(row =>
      `<li><strong>${safe(row.author === 'owner' ? copy('Владелец') : nameFor(current.agents.find(a => a.id === row.agentId)))}</strong> · ${safe(studioDate(row.createdAt))}${plain(row.text)}</li>`).join('')}</ul>${more(facts.messages.length)}</details>` : '') +
    (facts.history.length ? copy`<details class="advanced" data-section="history"><summary>Журнал · ${facts.history.length}</summary><ul class="legacy-list">${facts.history.slice(0,limit).map(row =>
      `<li>${safe(studioDate(row.at))} · ${eventNames[row.type]}${row.detail ? ' · ' + safe(purposes[row.detail] || statuses[row.detail]?.[0] || row.detail) : ''}</li>`).join('')}</ul>${more(facts.history.length)}</details>` : '') +
    '<div data-task-delivery tabindex="-1">'+renderDelivery({
      checks: git?.checks ?? [],
      worktree: studioRows('worktrees').find(row => row.id === git?.worktreeId) ?? (git?.worktreeId ? { branchRef: git.branchRef ?? git.worktreeId, revision: git.revision } : null),
      delivery: git,
      receipts: git?.receipt ? [git.receipt] : [],
      evidence: studioRows('evidence').filter(item => item.taskId === latest.id && item.kind !== 'attachment'),
    })+'</div>' +
    (attempts.length ? copy`<details class="advanced" data-section="runs"><summary>Запуски · ${attempts.length} · ${facts.usage.total === null ? copy('нет данных о расходе') : copy`${tokenCount(getCopyLocale(),facts.usage.total)} · измерено ${facts.usage.measured} из ${attempts.length}`}</summary><ul class="plan-list">${attempts.slice(0,limit).map(attempt => copy`<li>
      <div class="row"><strong>${safe(purposes[attempt.purpose] || copy('Запуск'))}</strong>${status(attempt)}</div>
      ${attempt.startedAt ? `<small class="muted">${safe(new Date(attempt.startedAt).toLocaleString(getCopyLocale()))}</small>` : ''}
      <p class="muted">Вход · ${attempt.usage.input ?? '—'}　Выход · ${attempt.usage.output ?? '—'}　Чтение кэша · ${attempt.usage.cacheRead ?? '—'}</p>
      <p class="muted">${attempt.elapsedMs===null ? '—' : new Intl.NumberFormat(getCopyLocale(),{style:'unit',unit:'second'}).format(Math.round(attempt.elapsedMs/1000))}</p>
      ${(attempt.calls ?? []).map(call=>`<small>${safe([call.role,call.runtime,call.model ?? '—',call.effort ?? '—'].join(' · '))}</small>${(call.materials??[]).map(m=>
        m.id ? `<button class="text-button" type="button" data-used-material="${safe(m.id)}" data-kind="${safe(m.kind)}">${safe(m.title || m.key || m.id)} · ${safe(m.version ?? '—')}</button>` : '').join(' ')}`).join('<br>')}
      ${attempt.error ? plain(attempt.error) : ''}</li>`).join('')}</ul>${more(attempts.length)}</details>` : '') +
    `<div class="actions">
      ${actionFor(copy('Связь по задаче'), 'message-task', latest.id)}
      ${canEditBacklog ? actionFor(copy('Изменить в бэклоге'), 'backlog-edit', latest.id) : ''}
      ${latest.kind !== 'train' && latest.status === 'queued' && trainingForTask(latest).length ? actionFor(copy('Добавить учебный допуск'), 'task-prerequisite', latest.id) : ''}
      ${latest.artifactPath ? actionFor(copy('Открыть файл'), 'artifact', latest.id, false) +
        actionFor(copy('Показать в папке'), 'reveal-artifact', latest.id) + actionFor(copy('Копировать путь'), 'copy-artifact-path', latest.id) : ''}
      ${entry ? actionFor(entry.kind === 'acceptance' ? copy('Открыть приёмку') : copy('Ответить на вопрос'), 'inbox', entry.id, false) : ''}
      ${canRun&&!recovery ? needsWorktreeReview ? actionFor(copy('Сверить рабочее дерево'), 'review-worktree', latest.id, false)
        : actionFor(startLabel, 'start-task', latest.id, false) : ''}
      ${canCancel ? actionFor(copy('Отменить задачу'), 'cancel-task', latest.id) : ''}
    </div>`, undefined, undefined, { adjustable: true });
  if (present) return;
  taskDialog = latest;
  for (const detail of $('#dialog-body').querySelectorAll('details[data-section]')) detail.open = expanded.includes(detail.dataset.section);
  if (isOpen && previousFocus) Array.from(dialog.querySelectorAll('button')).find(node => Object.hasOwn(node.dataset, previousFocus))?.focus();
  if (isOpen) $('#dialog-body').scrollTop = previousScroll;
}

function confirmWorktreeReview(task) {
  dialogTo(copy('Сверка рабочего дерева'),
    copy('<p>Перед запуском проверьте рабочую папку новой студии, ветку и локальные изменения.</p>') +
    copy`<dl class="studio-meta"><dt>Рабочая папка</dt><dd>${safe(studio().root)}</dd>
    ${task.legacyBranch ? copy`<dt>Ветка в старой студии</dt><dd>${safe(task.legacyBranch)}</dd>` : ''}</dl>`,
    copy('Подтвердить сверку и запустить'), async () => {
      await bridge.request('startTask', { taskId: task.id, confirmLegacy: true });
      await refresh();
      openTask(task);
      return false;
    });
}

function openInbox(item) {
  if(item.kind==='roster'&&item.proposalId){
    withRow(studioRows('rosterProposals'),item.proposalId,rosterDecisionEditor);
    return;
  }
  if (item.kind === 'meeting') {
    const meeting = studioRows('meetings').find(entry => entry.id === item.meetingId);
    if (meeting) meetingDetail(meeting);
    return;
  }
  if (item.kind === 'reconcile' && item.attemptId) {
    openReconciliation(item);
    return;
  }
  if (item.kind === 'plan') {
    const plan = planById(String(item.planId));
    if (plan) openPlan(plan);
    return;
  }
  const task = tasks().find(row => row.id === item.taskId);
  if (coachBlocked(item, task)) {
    dialogTo(inboxHeading(item), plain(inboxDetail(item)) +
      copy`<details class="advanced"><summary>Замечания директора</summary>${plain(item.body)}</details>` +
      `<div class="actions">${coachRetryActions(task)}${actionFor(copy('Открыть задачу'), 'task', task.id)}</div>`,
      undefined, undefined, { adjustable: true, focusSummary: true });
    return;
  }
  const question = item.kind === 'question';
  const origin=todayContext;
  const open = item.status === 'open';
  const op = operationId();
  const selectedAttachments = [];
  const choices = questionOptions(item);
  const body = `<div>${badge(question ? copy('Вопрос') : copy('Ошибка'), question ? 'warn' : 'attention')}</div>` + plain(item.body) +
    (item.kind === 'error' && open && item.readAt ? copy('<p>Ошибка просмотрена и всё ещё требует решения.</p>') : '') +
    (question ? renderQuestionDetails(item) + renderEvidence(studioRows('evidence').filter(row => (item.attachmentIds ?? item.answerAttachmentIds ?? []).includes(row.id))) : '') +
    (item.answer ? copy`<section class="inline-result"><h3>Ответ</h3>${plain(item.answer)}</section>` : '');
  inboxScope = open ? actionableInboxIds().has(item.id)?'open':'waiting' : 'resolved';
  if (view !== 'inbox' && !ownerTrail.current && !todayContext) route('inbox');
  if (item.kind === 'acceptance') {
    openAcceptance(item);
    return;
  }
  dialogTo(inboxLabel(item), body + (open && question
    ? (choices.length ? select(copy('Выберите вариант'), 'choiceId', option('', copy('Свой ответ')) + choices.map(choice => option(String(choice.id), choice.label ?? choice.title ?? choice.text ?? choice.id)).join('')) : '') +
      textarea(copy('Ваш ответ'), 'answer') + attachmentFields()
    : item.taskId ? actionFor(copy('Открыть задачу'), 'task', item.taskId) +
      (open && item.kind==='error' && tasks().some(t=>t.id===item.taskId && t.status==='failed' && (!t.workflowManaged || studio().wipLimit>1)) ? actionFor(copy('Повторить запуск'),'retry-from-inbox',item.taskId) : '')
      + button(copy('Настройки приложения'),'data-error-settings',true) : '')+
      (todayContext?.row.action==='resume'?actionFor(copy('Возобновить'),'run-action','resume',false):'')+
      (todayContext?.row.action==='settings'&&!item.taskId?button(copy('Настройки приложения'),'data-error-settings',true):'')+
      (todayContext?.row.action==='project'?actionFor(copy('Настройки студии'),'project-settings',item.studioId):''),
    question ? copy('Отправить ответ') : copy('Отметить просмотренной'), open && (question || !item.readAt) ? async ({ answer, choiceId }) => {
      if (question && !answer && !choiceId && !selectedAttachments.length) throw new Error(copy('Выберите вариант, напишите ответ или приложите файл.'));
      await bridge.request('answerInbox', answerPayload(item, {
        answer, choiceId, attachmentIds: selectedAttachments.map(row => row.id), operationId: op,
      }));
      if(question && item.taskId) return showDecisionOutcome(item.taskId,origin);
    } : undefined, { adjustable: question || (item.body?.length ?? 0) > 240 });
  if (open && question) dialogAttachments = selectedAttachments;
}

const reconciliationAttempt = item => studioRows('attempts').find(row => row.id === item.attemptId);
const reconciliationPending = item => Boolean(reconciliationAttempt(item)?.processActive);
const isPlanReconciliation = item => item.kind === 'reconcile' && reconciliationAttempt(item)?.purpose === 'plan';
const coachBlocked = (item, task = tasks().find(row => row.id === item.taskId)) =>
  item.status === 'open' && item.kind === 'error' && task?.training?.bootstrap && task.status === 'failed' && task.failedReviews >= 3;
const coachRetryActions = task => studio().manualPaused
  ? actionFor(copy('Возобновить'), 'run-action', 'resume', false)
  : actionFor(copy('Повторить подготовку коуча'), 'retry-from-inbox', task.id, false);
const inboxHeading = item => isPlanReconciliation(item) ? copy('Подготовка плана прервана')
  : coachBlocked(item) ? copy('Подготовка коуча не прошла проверку') : inboxLabel(item);
const inboxDetail = item => isPlanReconciliation(item)
  ? copy('Директор не успел подготовить план. Вы можете запустить подготовку заново.')
  : coachBlocked(item) ? copy('Директор трижды вернул подготовку на доработку. Остальные агенты ждут готового коуча. Повторите подготовку, чтобы Hearth заново провёл упражнение и проверку.')
  : item.kind === 'reconcile' ? copy('Рабочий шаг прервался. Перед повтором проверьте файлы, если шаг мог их изменить.') : item.body;

function openReconciliation(item) {
  const attempt = reconciliationAttempt(item);
  const pending = reconciliationPending(item);
  const plan = isPlanReconciliation(item);
  const open = item.status === 'open';
  const canResolve = open && !pending && Boolean(attempt);
  const canComplete = ['artifact', 'publish'].includes(attempt?.purpose);
  const fields = !canResolve || plan ? '' :
    select(copy('Что сделать с прерванным шагом?'), 'decision', option('retry', copy('Повторить шаг')) +
      (canComplete ? option('complete', copy('Подтвердить выполненный шаг')) : '') + option('discard', copy('Отказаться от шага'))) +
    textarea(copy('Что вы проверили?'), 'reason', '', 'required');
  const detail = pending ? copy('<p role="status">Hearth завершает прежний запуск. Действия появятся здесь, когда он остановится.</p>') :
    !attempt && open ? plain(copy('Запись прерванного запуска недоступна. Подробности можно проверить в диагностике студии.')) :
      canResolve && studio().manualPaused ? plain(copy('Повтор добавит шаг в очередь. Чтобы запустить его, нажмите «Возобновить» в обзоре.')) : '';
  dialogTo(inboxHeading(item), plain(inboxDetail(item)) + detail + fields + (item.answer ? plain(item.answer) : ''),
    plan ? copy('Повторить подготовку плана') : copy('Сохранить решение'),
    canResolve ? values => bridge.request('resolveReconciliation', { attemptId: item.attemptId,
      ...(plan ? { decision: 'retry', reason: copy('Подготовка плана поставлена в очередь повторно.') } : values),
    }) : undefined, { focusSummary: true });
  dialogReconciliation = { id: item.id, status: item.status, pending };
}

function openAcceptance(item, revise = false) {
  const task = tasks().find(entry => entry.id === item.taskId);
  const pending = item.status === 'open';
  const review = item.review;
  const git = review ? review.delivery : task?.gitDelivery;
  const targetRef = review?.targetRef ?? studio().projectGit?.targetRef;
  const operation = operationId();
  const origin=todayContext;
  const send = async (decision, answer,reworkTaskId) => {
    await bridge.request('answerInbox', { studioId:item.studioId, inboxId: item.id, expectedResult:review?.key, operationId:operation, decision, answer,reworkTaskId });
    return showDecisionOutcome(item.taskId,origin);
  };
  dialogTo(inboxLabel(item), `<div>${badge(pending ? copy('Приёмка результата') : copy('Решение сохранено'), pending ? 'warn' : 'good')}</div>` +
    plain(item.body) + (review ? `<p>${safe(review.summary)}</p>${review.criteria ? plain(listText(review.criteria)) : ''}<small>${safe(review.key.slice(0,12))}</small>` : '') +
    (review?.members ? `<section><h3>${ui('members')}</h3>${review.members.map(m=>`<div>${actionFor(m.title,'task',m.taskId)} · ${safe(m.revision)}${plain(m.summary)}</div>`).join('')}</section>` : '') +
    (review?.artifactPath ? `<div class="actions">${actionFor(copy('Открыть файл этой версии'),'review-file',item.id)}${actionFor(copy('Показать в папке'),'reveal-review-file',item.id)}${actionFor(copy('Копировать путь'),'copy-review-file',item.id)}</div>` :
      !review && task?.artifactPath ? actionFor(copy('Открыть файл'),'artifact',task.id) : '') +
    (git ? renderDelivery({ checks:git.checks, delivery:git, receipts:git.receipt ? [git.receipt] : [],
      evidence: studioRows('evidence').filter(row => (review ? review.evidenceIds.includes(row.id) : row.taskId === task.id) && row.kind !== 'attachment') }) : '') +
    (item.answer ? copy`<section class="inline-result"><h3>Решение</h3>${plain(item.answer)}</section>` : '') +
    (pending ? revise ? (review?.members ? select(copy('Задача'),'reworkTaskId',review.members.map(m=>option(m.taskId,m.title)).join('')) : '')+textarea(copy('Что нужно исправить?'), 'answer', '', 'required')
      : actionFor(copy('Вернуть на доработку'), 'revise-result', item.id) : ''),
    revise ? copy('Отправить на доработку') : git && targetRef ? copy('Принять и слить в ')+targetRef.replace(/^refs\/heads\//,'') : copy('Принять результат'),
    pending ? ({ answer,reworkTaskId }) => send(revise ? 'revise' : 'approve', answer,reworkTaskId) : undefined, { adjustable: true, focusSummary: !revise });
}

const listText = value => Array.isArray(value) ? value.join('\n') : value;
async function showDecisionOutcome(taskId,origin=todayContext) {
  await refresh();
  if (origin) {
    finishTodayDecision(taskId,undefined,origin);
    return false;
  }
  if(dialog.open)dialog.close();
  if(!ownerTrail.current) route('work');
  if(tasks().some(t=>t.id===taskId))inspectObject('task',taskId);
  const run=studioRows('attempts').filter(r=>r.taskId===taskId && r.status==='running').at(-1);
  notice(run ? ui('running')+' · '+run.id : (studio().scheduleWaiting ? ui('window')+' · '+studioDate(studio().nextScheduleAt) : ui('saved')));
  return false;
}

function autonomyHint() {
  return copy('<p class="muted">Сверку плана можно отключить в <button type="button" class="text-button" data-autonomy>Настройки → Автономность</button>. Настройка действует для будущих спринтов.</p>');
}

function planBody(plan, compare=true) {
  const previous = compare && plan.previousPlanId && planById(plan.previousPlanId);
  const oldTasks = new Map((previous?.tasks ?? []).map(t=>[t.key,t]));
  const differences = (plan.tasks ?? []).filter(t=>!oldTasks.has(t.key) || JSON.stringify(oldTasks.get(t.key))!==JSON.stringify(t)).map(t=>t.title);
  for (const [key,t] of oldTasks) if (!plan.tasks.some(row=>row.key===key)) differences.push(t.title);
  const agents = plan.agents ?? [];
  const published = new Set(publishedPaths(plan));
  const agentByKey = key => agents.find(agent => (agent.key ?? agent.id) === key) ?? studio().agents.find(agent=>(agent.key ?? agent.id)===key);
  const assignedModel = task=>{
    const agent=agentByKey(task.agentKey);
    if(task.modelOverride)return ui('override')+' · '+configText(task.modelOverride);
    if(agent?.mode==='inherit')return modeNames.inherit+' · '+configText(studio().director);
    if(agent?.mode==='fixed')return ui('roleModel')+' · '+configText(agent);
    return modeNames.dynamic+(agent?.recommendation?' · '+configText(agent.recommendation):'');
  };
  const titles = new Map((plan.tasks ?? []).map(task => [task.key ?? task.id, task.title]));
  const entity = (label, value) => value ? `<section class="inline-result"><h3>${label}</h3><p>${safe(value.title ?? value)}</p>
    ${value.description ? plain(value.description) : ''}${value.acceptance ? plain(listText(value.acceptance)) : ''}</section>` : '';
  return `<div class="actions">${badge(...({
    draft: [copy('Готовится'), ''], pending: [copy('Ждёт согласования'), 'warn'],
    approved: [copy('Подтверждён'), 'good'], returned: [copy('Возвращён'), 'warn'],
  }[plan.status] ?? [plan.status, '']))}${plan.debtSprint ? badge(copy('Спринт улучшений')) : ''}</div>
    ${plan.goal ? `<p>${safe(plan.goal)}</p>` : ''}
    ${plan.status==='pending' ? `<p class="muted">${ui('firstWork')} · ${safe((plan.tasks??[]).filter(t=>!t.dependsOn?.length).map(t=>t.title).join(', ') || '—')}</p>
      <p class="muted">${ui('newRoles')} · ${safe(agents.filter(a=>!studio().agents.some(r=>(r.key??r.id)===a.key)).map(nameFor).join(', ') || '—')}</p>` : ''}
    <p>${ui('release')} · ${ui(({off:'releaseOff',summary:'releaseSummary',hold:'releaseHold'})[plan.sprintReview ?? studio().sprintReview ?? 'off'])}</p>
    ${previous ? `<section>${plain(previous.feedback)}<p>${ui('changedTasks')} · ${safe(differences.join(', ') || '—')}</p><details><summary>${ui('previousPlan')}</summary>${planBody(previous,false)}</details></section>` : ''}
    ${entity(copy('Эпик'), plan.epic)}${entity(copy('Первая история'), plan.story)}
    ${agents.length ? copy`<section class="stack compact"><h3>Команда</h3><ul class="plan-list">${agents.map(agent =>
      `<li><strong>${safe(nameFor(agent))}</strong>${secondaryTitle(agent) ? `<span class="muted"> · ${safe(secondaryTitle(agent))}</span>` : ''}
        <div>${safe(agent.description || roleDetails[agent.role] || '')}</div>
        ${planAgentModelSummary(agent, plan.kind === 'initial')}</li>`).join('')}</ul></section>` : ''}
    ${plan.tasks?.length ? copy`<section class="stack compact"><h3>Задачи</h3><ol class="plan-list">${plan.tasks.map(task => copy`<li>
      <strong>${safe(task.title)}</strong>${task.kind === 'debt' ? ' ' + badge(copy('Улучшение')) : ''}
      ${task.agentKey ? copy`<p class="muted">Исполнитель — ${safe(nameFor(agentByKey(task.agentKey)))}</p>` : ''}
      <small>${safe(assignedModel(task))}</small>
      ${task.reviewerKey ? copy`<p class="muted">Проверяет — ${safe(nameFor(agentByKey(task.reviewerKey)))}</p>` : ''}
      <p class="muted">Принимает результат — ${task.requiresAcceptance ? copy('владелец') : copy('студия')}</p>
      ${task.criteria ? `<div>${plain(listText(task.criteria))}</div>` : ''}
      ${task.dependsOn?.length ? copy`<small>После задач ${safe(task.dependsOn.map(key => titles.get(key) ?? key).join(', '))}</small>` : ''}
    </li>`).join('')}</ol></section>` : ''}
    ${plan.files?.length ? copy`<section class="stack compact"><h3>Файлы плана</h3><ul class="plan-list">${plan.files.map(file =>
      `<li>${published.has(file.path) ? `<button type="button" class="text-button" data-plan-file="${safe(file.path)}" data-plan-id="${safe(plan.id)}">${safe(file.path)}</button>`
        : safe(file.path)}</li>`).join('')}</ul></section>` : ''}
    ${plan.feedback ? copy`<section class="inline-result"><h3>Комментарий владельца</h3>${plain(plan.feedback)}</section>` : ''}`;
}

function planAgentModelSummary(agent, showMode = true) {
  const mode = agent.mode ?? 'dynamic';
  const summary = config => configText({ ...config, effort: config.effort || copy('усилие по умолчанию') });
  return (showMode ? `<p class="muted">${safe(modeNames[mode])}${mode === 'fixed' ? ` · ${safe(summary(agent))}` : ''}</p>` : '')
    + (agent.recommendation ? copy`<p class="muted">Предложение директора на первый спринт: ${safe(summary(agent.recommendation))}</p>` : '');
}

function openPlan(plan, revise = false, feedbackDraft = '') {
  const pending = plan.status === 'pending';
  dialogTo(plan.title || (plan.kind === 'initial' ? copy('План инициализации') : copy('План спринта')),
    planBody(plan) + (pending
      ? (revise ? textarea(copy('Что изменить в плане?'), 'feedback', feedbackDraft, 'required') : '') + autonomyHint()
      : ''),
    revise && pending ? copy('Отправить на доработку') : undefined, revise && pending ? ({ feedback }) =>
      bridge.request('decidePlan', { planId: plan.id, expectedEditVersion: plan.editVersion ?? 0, decision: 'revise', feedback }) : undefined, { adjustable: true, focusSummary: !revise });
  dialog.dataset.reviewPlan=plan.id;
  if (pending && !revise) $('#dialog-actions').insertAdjacentHTML('beforeend',
    actionFor(copy('Изменить задачи и приёмку'), 'edit-plan-tasks', plan.id) +
    (plan.kind === 'initial' && plan.agents?.length ? actionFor(copy('Изменить состав'), 'edit-plan-team', plan.id) : '') +
    actionFor(copy('Вернуть на доработку'), 'revise-plan', plan.id) + button(copy('Подтвердить и запустить'), `data-approve-plan="${safe(plan.id)}" data-edit-version="${safe(plan.editVersion ?? 0)}"`, false));
}

function planTasksEditor(plan) {
  const roles = new Map([...studio().agents,...plan.agents].map(a => [a.key ?? a.id, a]));
  const tuples = fixedModelChoices(studioAllowed(studio())).flatMap(c=>(c.efforts?.length ? c.efforts : ['']).map(effort=>({runtime:c.runtime,model:c.model,effort})));
  const mode = plan.sprintReview ?? studio().sprintReview ?? 'off';
  const choices = selected => [...roles].filter(([, a]) => a.systemRole !== 'coach' && a.rosterStatus !== 'retired')
    .map(([key, a]) => option(key, nameFor(a), selected)).join('');
  const body = plan.tasks.map((t, i) => `<fieldset class="stack compact"><legend>${safe(t.title)}</legend>
    ${input(copy('Название задачи'), 'title'+i, t.title, 'required maxlength="200"')}
    ${select(copy('Исполнитель'), 'worker'+i, choices(t.agentKey))}
    ${select(copy('Проверяющий'), 'reviewer'+i, choices(t.reviewerKey))}
    ${select(ui('override'),'override'+i, option('',ui('roleModel'))+tuples.map((v,index)=>option(String(index),configText(v),
        t.modelOverride && v.runtime===t.modelOverride.runtime && v.model===t.modelOverride.model && v.effort===t.modelOverride.effort ? String(index) : '')).join(''))}
    ${checkbox(copy('Показать мне результат перед доставкой'), 'accept'+i, t.requiresAcceptance)}</fieldset>`).join('');
  const reviewChoices=[['off','releaseOff'],['summary','releaseSummary'],...(studio().projectGit?.enabled ? [['hold','releaseHold']] : [])];
  dialogTo(copy('Задачи и приёмка'), select(ui('release'),'sprintReview',reviewChoices.map(([key,label])=>option(key,ui(label),mode)).join(''))+body, copy('Сохранить план'), async values => {
    const tasks = plan.tasks.map((t, i) => ({ key:t.key, title:values['title'+i],
      agentKey:values['worker'+i], reviewerKey:values['reviewer'+i], modelOverride: values['override'+i] ? tuples[Number(values['override'+i])] : null, requiresAcceptance:form.elements.namedItem('accept'+i).checked }));
    const updated = await bridge.request('updatePlanTasks', {planId:plan.id, expectedEditVersion:plan.editVersion ?? 0, sprintReview:values.sprintReview, tasks});
    openPlan(updated);
    return false;
  }, {adjustable:true});
  dialog.dataset.reviewPlan=plan.id;
}

function teamEffortOptions(choice, selected) {
  return (choice?.efforts ?? []).map(value => option(value, value || copy('По умолчанию'), selected)).join('');
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
    return copy`<fieldset class="inline-result stack compact policy-row" data-plan-agent="${safe(key)}"
      data-recommended-model="${safe(recommendation ? modelKey(recommendation) : '')}"
      data-recommended-effort="${safe(recommendation?.effort)}">
      <legend>${safe(nameFor(agent))}</legend>
      ${agent.description ? `<p>${safe(agent.description)}</p>` : ''}
      ${planAgentModelSummary(agent, false)}
      ${agent.systemRole === 'coach' ? '' : `<div class="policy-controls">
        ${input(copy('Название роли'), `plan-title-${index}`, agent.roleTitle, `data-plan-role-title maxlength="120" placeholder="${safe(roleNames[agent.role] ?? '')}"`)}
        ${input(copy('Имя (необязательно)'), `plan-name-${index}`, agent.name, 'data-plan-name maxlength="120"')}
      </div>`}
      <label class="field"><span>Выбор модели</span><select name="plan-mode-${index}" data-plan-mode>${Object.entries(modeNames)
        .map(([id, label]) => option(id, label, mode)).join('')}</select></label>
      <p class="muted" data-plan-dynamic${mode === 'dynamic' ? '' : ' hidden'}>${choices.length ? copy('Для первого спринта действует предложение директора, пока оно в разрешённом списке. Для остальных задач директор выбирает модель и усилие отдельно.')
        : emptyPolicy}</p>
      <div class="policy-controls" data-plan-fixed${mode === 'fixed' ? '' : ' hidden'}>
        <label class="field"><span>Модель</span><select name="plan-model-${index}" data-plan-model>
          ${option('', choices.length ? copy('Выберите модель') : copy('Список моделей пуст'), model)}
          ${choices.map(item => option(modelKey(item), `${runtimeName(item.runtime)} · ${item.model}`, model)).join('')}</select></label>
        <label class="field"><span>Усилие</span><select name="plan-effort-${index}" data-plan-effort>${teamEffortOptions(valid ? matching : undefined,
          requested?.effort ?? '')}</select></label>
        ${mode === 'fixed' && !valid ? copy('<p class="muted">Ранее выбранное сочетание больше не разрешено. Выберите другое или измените режим.</p>') : ''}
      </div>
    </fieldset>`;
  }).join('');
  dialogTo(copy('Состав команды'), copy`<div class="policy-team"><p>Изменения сохраняются в плане. Команда начнёт работу после его утверждения.</p>${body}</div>`,
    copy('Сохранить состав'), async () => {
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
            throw new Error(copy('Для фиксированного режима выберите разрешённую модель и усилие.'));
          }
          set('runtime', choice.runtime);
          set('model', choice.model);
          set('effort', effort);
        }
        return Object.keys(edits).length ? [{ key, ...edits }] : [];
      });
      const updated = agents.length ? await bridge.request('updatePlanAgents', { planId: plan.id, expectedEditVersion: plan.editVersion ?? 0, agents }) : planById(String(plan.id));
      openPlan(updated ?? plan);
      return false;
    }, { adjustable: true });
  $('#dialog-actions [data-close]').outerHTML = actionFor(copy('Назад к плану'), 'cancel-plan-team', plan.id);
}

async function approvePlan(raw, expectedEditVersion) {
  const plan = planById(raw);
  if (!plan || plan.status !== 'pending') return;
  dialogError();
  setDialogBusy(true);
  const origin=todayContext;
  try {
    await bridge.request('decidePlan', { planId: plan.id, expectedEditVersion, decision: 'approve' });
    if (origin) {
      await refresh();
      finishTodayDecision(undefined,undefined,origin);
      return;
    }
    dialog.close();
    await refresh();
  } catch (error) {
    dialogError(error.message || copy('Не удалось согласовать план.'));
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
  return select(copy('Подключение'), 'runtime', Object.entries(runtimeNames).map(([id, label]) => option(id, label, runtime)).join('')) +
    input(copy('Модель'), 'model', config?.model, copy('list="model-catalog" placeholder="По умолчанию"')) +
    datalist('model-catalog', models) + append;
}

function effortField(config) {
  const model = providerState[config?.runtime || 'codex']?.models?.find(item => item.id === config?.model);
  return input(copy('Усилие'), 'effort', config?.effort, copy('list="effort-catalog" placeholder="По умолчанию"')) +
    datalist('effort-catalog', model?.efforts?.length ? model.efforts : effortPresets);
}

function modelConfig(values) {
  return { runtime: values.runtime, model: values.model, effort: values.effort };
}

function directorEditor() {
  const current = studio();
  dialogTo(copy('Модель директора'), runtimeFields(current.director, effortField(current.director)), copy('Сохранить директора'),
    values => bridge.request('updateStudio', { studioId: current.id, director: modelConfig(values) }));
}

function skillSettingsEditor() {
  const current = studio();
  dialogTo(copy('Порог поиска навыков'), input(copy('Минимум звёзд на GitHub'), 'skillMinStars', skillMinStars(current),
    'type="number" min="0" step="1" required'), copy('Сохранить'), async values => {
    const threshold = Number(values.skillMinStars);
    if (!Number.isSafeInteger(threshold) || threshold < 0) throw new Error(copy('Введите целое число звёзд от 0.'));
    await bridge.request('updateStudio', { studioId: current.id, skillMinStars: threshold });
    if (studio()?.id === current.id) skillSearch = { topics: skillSearch.topics, preview: {} };
  });
}

function debtPolicyEditor() {
  const current = studio();
  const policy = debtPolicyFor(current);
  const fields = debtPolicyFields.map(({ name, label, min, max }) =>
    input(label, name, policy[name], `type="number" min="${min}" max="${max}" step="1" required`)).join('');
  dialogTo(copy('Спринты улучшений'),
    copy`<p class="muted">${improvementsHelp}</p><label class="checkbox-field"><input type="checkbox" name="enabled"${policy.enabled ? ' checked' : ''}> <span>Планировать спринты улучшений</span></label>
      <p class="muted">${debtPolicyHint}</p>${select(copy('Единица измерения доли'), 'measure', option('taskCount', copy('Число задач'), policy.measure) + option('points', copy('Баллы'), policy.measure))}${fields}`,
    copy('Сохранить'), values => {
      const debtPolicy = { enabled: Boolean(values.enabled), measure: values.measure };
      for (const { name, label, min, max } of debtPolicyFields) {
        const value = Number(values[name]);
        if (!Number.isInteger(value) || value < min || value > max) {
          throw new Error(copy`«${label}» требует целого числа от ${min} до ${max}.`);
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
    debtAssessments.set(id, { error: error.message || copy('Не удалось оценить очередь улучшений.') });
    if (view === 'settings' && studio()?.id === id) render();
  }
}

const studioPolicyMode = current => current.allowedMode ?? (current.allowed?.length ? 'studio' : 'app');
const studioSavedChoices = current => fixedModelChoices(studioPolicyMode(current) === 'studio'
  ? current.allowed : state.modelPolicy?.allowed);
const studioAllowed = current => current.effectiveAllowed ??
  (studioPolicyMode(current) === 'studio' ? current.allowed : state.modelPolicy?.allowed) ?? [];
const makeEmptyPolicy = () => (copy('Список пуст. При автоматическом выборе роли используют модель и усилие директора.'));
let emptyPolicy = makeEmptyPolicy();
onCopyLocale(() => { emptyPolicy = makeEmptyPolicy(); });

function policySummary(entries) {
  return entries?.length ? `<ul class="policy-list">${entries.map(entry => `<li>${safe([runtimeName(entry.runtime), entry.model,
    entry.efforts?.join(', ') || copy('усилие по умолчанию')].filter(Boolean).join(' · '))}</li>`).join('')}</ul>`
    : `<p class="muted">${emptyPolicy}</p>`;
}

function policyEditor(current) {
  const editor = createModelCatalogEditor({ providers: providerState, policy: state.modelPolicy, appPolicy: state.modelPolicy, studio: current });
  dialogTo(current ? copy('Модели студии') : copy('Модели приложения'), editor.markup, copy('Сохранить'),
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
    ? select(copy('Модель'), 'agent-model', option('', choices.length ? copy('Выберите из разрешённых') : copy('Список моделей пуст')) +
      choices.map(item => option(modelKey(item), `${runtimeName(item.runtime)} · ${item.model}${providerState[item.runtime]?.enabled === false ? copy(' · провайдер отключён') : ''}`,
        currentChoice && modelKey(currentChoice))).join('')) +
      select(copy('Усилие'), 'agent-effort', teamEffortOptions(currentChoice, currentEffort)) +
      (!choices.length ? copy('<p class="muted">Добавьте модель в список студии или выберите режим «Выбирает директор».</p>') : '')
    : runtimeFields(agent, effortField(agent));
  const roleChoices = Object.entries(roleNames).filter(([id]) => id !== 'director')
    .map(([id, name]) => option(id, name, role)).join('');
  const roleFields = isCoach ? '' : input(copy('Имя (необязательно)'), 'name', agent?.name, 'maxlength="120"') +
    input(copy('Название роли (необязательно)'), 'roleTitle', agent?.roleTitle, 'maxlength="120"') + select(copy('Категория роли'), 'role', roleChoices) +
    `<p id="role-guide" class="muted">${safe(roleDetails[role])}</p>` + textarea(copy('Назначение роли'), 'description', agent?.description);
  dialogTo(isCoach ? coachTitle : agent ? copy('Настроить агента') : copy('Новый агент'), roleFields +
    (agent ? '' : input(copy('Темы обучения на GitHub (необязательно)'), 'trainingTopics', '', copy('placeholder="Через запятую"'))) +
    (proposalRequired ? textarea(copy('Причина изменения роли'), 'changeReason', '', 'required') : '') +
    select(copy('Выбор модели'), 'mode', Object.entries(modeNames).map(([id, name]) => option(id, name, mode)).join('')) +
    copy`<div class="form-body" id="fixed-options"${mode === 'fixed' ? '' : ' hidden'}>${fixedOptions}</div>
      <p class="muted" id="dynamic-options"${mode === 'dynamic' ? '' : ' hidden'}>Директор выбирает модель и усилие для задачи из разрешённого списка студии. Если список пуст, действуют настройки директора.</p>`,
    proposalRequired ? copy('Предложить изменение') : copy('Сохранить агента'), async ({ name, roleTitle, role, mode, description, trainingTopics, changeReason, ...config }) => {
      let fixed = {};
      if (mode === 'fixed' && restricted) {
        const choice = studioSavedChoices(studio()).find(item => modelKey(item) === config['agent-model']);
        const effort = config['agent-effort'] ?? '';
        if (!choice?.efforts.includes(effort)) throw new Error(copy('Выберите разрешённую модель и усилие для агента.'));
        fixed = { runtime: choice.runtime, model: choice.model, effort };
      } else if (mode === 'fixed') {
        if (!config.model) throw new Error(copy('Укажите фиксированную модель.'));
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
    dialogTo(copy('Предварительный импорт'), copy('<p role="status">Проверяем структуру папки…</p>'));
    setDialogBusy(true);
    const result = await bridge.request('previewImport', { root });
    legacyPreviews.set(root, result);
    const fields = { tasks: copy('Задачи'), archivedTasks: copy('Архивные задачи'), roles: copy('Роли'), openQuestions: copy('Открытые вопросы'), worktrees: copy('Рабочие деревья'), artifacts: copy('Артефакты') };
    const items = values => `<ul>${values.map(value => `<li>${safe(value)}</li>`).join('')}</ul>`;
    const size = result.artifactBytes == null ? '' : new Intl.NumberFormat(getCopyLocale(), { style: 'unit', unit: 'byte' }).format(result.artifactBytes);
    dialogTo(copy('Предварительный импорт'), `<div>${badge(result.valid ? copy('Структура распознана') : copy('Структура требует проверки'), result.valid ? 'good' : 'warn')}</div>` +
      plain(result.root || root) + `<dl class="studio-meta">${Object.entries(fields).filter(([key]) => result.counts?.[key] != null)
        .map(([key, name]) => `<dt>${name}</dt><dd>${safe(result.counts[key])}</dd>`).join('')}${size ? copy`<dt>Объём артефактов</dt><dd>${safe(size)}</dd>` : ''}</dl>` +
      (result.ownerLanguage ? copy`<p>Язык отчётов: <strong>${safe(result.ownerLanguage)}</strong>
        ${result.ownerLanguageSource === 'fallback' ? copy('· запасной вариант') : copy('· из настроек старой студии')}</p>` : '') +
      (result.projectCandidates?.length ? copy`<section><h3>Папки проектов</h3>${items(result.projectCandidates)}</section>` : '') +
      (result.unresolvedReferences?.length ? copy`<section><h3>Ссылки, которые требуют проверки</h3>${items(result.unresolvedReferences.map(row =>
        `${row.sourceId} → ${row.targetId} (${row.kind})`))}</section>` : '') +
      (result.warnings?.length ? copy`<section><h3>Замечания</h3>${items(result.warnings)}</section>` : '') +
      (result.valid ? actionFor(copy('Импортировать в отдельную студию'), 'import-legacy', root, false) : ''));
  } catch (error) {
    if (dialog.open) dialogError(error.message || copy('Не удалось проверить папку.'));
    else notice(error.message || copy('Не удалось открыть папку.'), true);
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
    providerState[runtime] = { enabled: providerState[runtime]?.enabled, available: false, detail: error.message || copy('Проверка подключения не удалась.') };
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
    dialogError(error.message || copy('Не удалось обновить задачу.'));
  } finally {
    setDialogBusy(false);
  }
}

async function pickFolder(target) {
  dialogError();
  setDialogBusy(true);
  try {
    const root = await bridge.request('pickFolder');
    if (root) { target.value = root; if (wizardOpen())saveWizardDraft(); }
  } catch (error) {
    dialogError(error.message || copy('Не удалось выбрать папку.'));
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
    notice(error.message || copy('Действие не выполнено.'), true);
  } finally {
    workBusy = false;
    render();
  }
}

async function openArtifact(payload, command = 'openArtifact') {
  if(command==='revealArtifact'){
    try {const result=await bridge.request(command,payload);if(result?.parentOpened)notice(result.name);}
    catch(error){if(dialog.open)dialogError(error.message);else notice(error.message,true);}
    return;
  }
  if (!dialog.open) {
    await workCommand(command, payload);
    return;
  }
  dialogError();
  setDialogBusy(true);
  try {
    await bridge.request(command, payload);
  } catch (error) {
    dialogError(error.message || copy('Не удалось открыть файл.'));
  } finally {
    setDialogBusy(false);
  }
}

function importEditor(source) {
  const legacy = Boolean(source);
  const preview = legacyPreviews.get(source);
  dialogTo(legacy ? copy('Импорт старой студии') : copy('Импорт файла Hearth'),
    (legacy ? copy`<div class="muted">Источник${plain(source)}</div>` : copy('<p class="muted">После выбора рабочей папки откроется окно выбора файла экспорта.</p>')) +
    input(copy('Название новой студии (необязательно)'), 'name', '', 'maxlength="120"') +
    pathField('', { label: copy('Рабочая папка новой студии') }) +
    (legacy ? languageField(copy('Язык отчётов'), 'language', preview?.ownerLanguage ?? 'Русский') : '') +
    (legacy ? textarea(copy('Артефакты для копирования (необязательно)'), 'artifactPaths', '', copy('placeholder="studio/artifacts/имя-файла.md"')) +
      copy('<p class="muted">Укажите по одному относительному пути на строку.</p>') : ''),
    copy('Импортировать'), async ({ root, name, language, artifactPaths = '' }) => {
      if (!root) throw new Error(copy('Выберите рабочую папку для новой студии.'));
      const paths = [...new Set(artifactPaths.split('\n').map(path => path.trim()).filter(Boolean))];
      const imported = await bridge.request(legacy ? 'importLegacy' : 'importBundle', {
        root, ...(name && { name }), ...(legacy && { source, artifactPaths: paths, language }),
      });
      const id = imported?.studio?.id ?? imported?.id;
      if (id) {
        selectStudio(id);
        view = 'overview';
        notice(copy('Студия импортирована.'));
      }
      if (imported?.warnings?.length) {
        dialogTo(copy('Студия импортирована'), '<ul>' + imported.warnings.map(warning => `<li>${safe(warning)}</li>`).join('') + '</ul>');
        return false;
      }
    });
}

function exportEditor(mode) {
  if (!['template', 'snapshot'].includes(mode)) return;
  const current = studio();
  const snapshot = mode === 'snapshot';
  const paths = [...new Set([...tasks().map(task => task.artifactPath).filter(Boolean), ...plans().flatMap(publishedPaths)])];
  const files = paths.length ? copy`<fieldset class="stack compact export-files"><legend>Файлы для экспорта</legend>
    ${paths.map((path, index) => `<label class="checkbox-field"><input type="checkbox" name="artifact-${index}"><span>${safe(path)}</span></label>`).join('')}
  </fieldset>` : '';
  const evidence = studioRows('evidence');
  const evidenceFiles = checkList(copy('Сохранённые доказательства и вложения'), evidence, 'evidence-export', [],
    row => row.name ?? row.filename ?? row.sourcePath ?? row.id);
  dialogTo(snapshot ? copy('Экспорт снимка') : copy('Экспорт шаблона'),
    snapshot ? copy('<p>Снимок включает состав студии, планы, задачи и решения. Отметьте файлы, которые нужно включить.</p>') + files + evidenceFiles
      : copy('<p>Шаблон сохраняет настройки и роли студии для нового проекта.</p>'),
    copy('Сохранить файл'), async values => {
      const artifactPaths = snapshot ? paths.filter((_, index) => values[`artifact-${index}`]) : [];
      const evidenceIds = snapshot ? checkedIds(evidence, values, 'evidence-export') : [];
      const result = await bridge.request('exportStudio', { studioId: current.id, mode, includeArtifacts: artifactPaths.length > 0, artifactPaths, evidenceIds });
      if (result) notice(copy('Файл экспорта сохранён.'));
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
  'request-grooming': () => void workCommand('requestGrooming', { studioId: studio().id }, copy('Разбор очереди начат.')),
  'next-sprint': () => void workCommand('startNextSprint', { studioId: studio().id }, copy('Директор готовит план следующего спринта.')),
  'project-git': projectGitEditor,
  cleanup: cleanupEditor,
  usage: usageDialog,
  'usage-tariff': usageTariffEditor,
  diagnosis: diagnosisDialog,
  'restart-app': restartAppEditor,
  notifications: notificationsEditor,
  messages: conversationsDialog,
  'backlog-task': () => taskEditor('',true),
  phase: () => phaseEditor(),
  meeting: meetingEditor,
  'roster-hire': () => rosterProposalEditor(),
  'roster-history': rosterHistory,
  staffing: staffingEditor,
  'publish-library': publishLibraryEditor,
  'library-history': libraryHistory,
};

function legacyAction(data, target) {
  const showMeeting = (id, handle) => withRow(studioRows('meetings'), id, handle);
  const showRoster = (id, handle) => withRow(studioRows('rosterProposals'), id, handle);
  if (data.saveDiagnostics !== undefined) {
    target.disabled = true;
    void bridge.request('saveDiagnostics', { studioId: studio().id })
      .then(saved => { if (saved) { dialog.close(); notice(copy('Диагностика сохранена.')); } })
      .catch(error => dialogError(error.message || copy('Не удалось сохранить диагностику.')))
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
  } else if (['evidence', 'saveEvidence', 'revealEvidence', 'copyEvidencePath'].some(key => Object.hasOwn(data, key))) {
    const key = ['evidence', 'saveEvidence', 'revealEvidence', 'copyEvidencePath'].find(key => Object.hasOwn(data, key));
    if (studioRows('evidence').some(row => same(row.id, data[key]))) void openLegacyFile(key === 'evidence' ? 'openEvidence' : key, data[key]);
  } else if (data.conversation !== undefined) withRow(studioRows('conversations'), data.conversation, conversation => messageEditor({ conversation }));
  else if (data.message !== undefined) messageEditor({ agentId: data.message });
  else if (data.messageNote !== undefined) messageEditor({ kind: 'note' });
  else if (data.messagePriority !== undefined) void workCommand('applyConversationProposal', { studioId: studio().id, messageId: data.messagePriority }, copy('Приоритет изменён.'));
  else if (data.messageTask !== undefined) withRow(tasks(), data.messageTask, task => messageEditor({ taskId: task.id, agentId: task.agentId }));
  else if (data.agentHistory !== undefined) agentHistory(data.agentHistory);
  else if (data.backlogEdit !== undefined) withRow(tasks(), data.backlogEdit, backlogEditor);
  else if (data.backlogReplace !== undefined) withRow(tasks(), data.backlogReplace, replaceBacklogEditor);
  else if (data.epicPriority !== undefined) withRow(studioRows('epics'), data.epicPriority, epic =>
    dialogTo(copy('Приоритет эпика'), input(copy('Приоритет от 0 до 100'), 'priority', epic.priority ?? 0, 'type="number" min="0" max="100" required'),
      copy('Сохранить'), values => bridge.request('setEpicPriority', { studioId: studio().id, epicId: epic.id, priority: Number(values.priority) })));
  else if (data.closeSprint !== undefined) withRow(studioRows('sprints'), data.closeSprint, closeSprintEditor);
  else if (data.phaseEdit !== undefined) withRow(studioRows('phases'), data.phaseEdit, phaseEditor);
  else if (data.phaseTransition !== undefined) withRow(studioRows('phases'), data.phaseTransition, phaseTransitionEditor);
  else if (data.resolveGrooming !== undefined) void workCommand('resolveGrooming', { studioId: studio().id, groomingId: data.resolveGrooming }, copy('Разбор очереди завершён.'));
  else if (data.meetingDetail !== undefined) showMeeting(data.meetingDetail, meetingDetail);
  else if (data.meetingResume !== undefined) {
    dialog.close();
    void workCommand('resumeMeeting', { meetingId: data.meetingResume }, copy('Встреча возобновлена.'));
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
    const result=await bridge.request(command, { studioId: studio().id, evidenceId });
    if(result?.parentOpened)notice(result.name);
  } catch (error) {
    const message = error.message || copy('Не удалось открыть файл.');
    if (dialog.open) dialogError(message);
    else notice(message, true);
  }
}

content.addEventListener('input', event => {
  if(event.target.matches('[data-local-library]')) {
    const query=event.target.value.trim().toLocaleLowerCase();
    content.querySelector('[data-local-results]').hidden=!query;
    for(const row of content.querySelectorAll('[data-material-search]')) row.hidden=query && !row.dataset.materialSearch.toLocaleLowerCase().includes(query);
    return;
  }
  if (event.target.matches('[data-file-query],[data-file-from],[data-file-to]')) {
    const query=content.querySelector('[data-file-query]').value.trim().toLocaleLowerCase();
    const from=content.querySelector('[data-file-from]').value, to=content.querySelector('[data-file-to]').value;
    for(const row of content.querySelectorAll('[data-file-key]')) {
      const date=row.dataset.fileDate;
      row.hidden=!row.dataset.fileKey.toLocaleLowerCase().includes(query) || Boolean(from && (!date || date<from)) || Boolean(to && (!date || date>to));
    }
    return;
  }
  if (!event.target.matches('[data-registry-query], [data-registry-stage], [data-registry-owner], [data-registry-sprint]')) return;
  registryQuery = content.querySelector('[data-registry-query]').value;
  registryStage = content.querySelector('[data-registry-stage]').value;
  registryOwner = content.querySelector('[data-registry-owner]').value;
  registrySprint = content.querySelector('[data-registry-sprint]').value;
  content.querySelector('[data-registry-rows]').innerHTML = registerRows(tasks(), studio(), studioRows('sprints'), registryQuery, registryStage,registrySprint,registryOwner);
});

document.addEventListener('click', event => {
  const target = event.target.closest('button');
  if (!target) return;
  const data = target.dataset;
  if(data.historyMore) {
    const key=JSON.stringify([studioId,data.historyMore]);
    historyLimits.set(key,(historyLimits.get(key) ?? 20)+30);
    if(dialog.open && taskDialog)openTask(taskDialog);else if(ownerTrail.current)paintInspector(false);
  } else if(data.refreshPlan) {
    const draft=form.elements.feedback?.value;
    const original=planById(data.refreshPlan);
    const latest=original?.status==='pending' ? original : plans().findLast(p=>p.status==='pending');
    if(latest)openPlan(latest,draft!==undefined,draft);
  } else if(data.usedMaterial && ['skills','knowledge','customSkills'].includes(data.kind))inspectObject(data.kind,data.usedMaterial);
  else if (data.copyId!==undefined) void bridge.request('copyTaskId',{studioId,taskId:data.copyId})
    .then(()=>notice(copy('ID задачи скопирован.'))).catch(e=>notice(e.message,true));
  else if(data.taskCheckResults!==undefined) {
    if(!dialog.open&&ownerTrail.current?.id!==data.taskCheckResults)inspectObject('task',data.taskCheckResults);
    const region=(dialog.open?$('#dialog-body'):$('#owner-body')).querySelector('[data-task-delivery]');
    region?.focus({preventScroll:true});
    region?.scrollIntoView({block:'start'});
  }
  else if (data.detachFolder!==undefined) dialogTo(ui('detach'),plain(ui('detachHint')),ui('detach'),()=>bridge.request('detachProject',{studioId:data.detachFolder}));
  else if (data.restoreStudio!==undefined) void workCommand('setStudioArchived',{studioId:data.restoreStudio,archived:false});
  else if(data.archiveDetails!==undefined)archiveDetails(data.archiveDetails);
  else if (data.archiveStudio!==undefined) {
    dialogTo(ui('archive'),plain(ui('archiveHint')),ui('archive'),async()=>{
      await bridge.request('setStudioArchived',{studioId:data.archiveStudio,archived:true});
      route('workspace');});
  } else if (data.ownerClose !== undefined) dismissInspector();
  else if (data.ownerBack !== undefined) {
    if (ownerTrail.depth > 1) { ownerTrail.back(); paintInspector(true); } else dismissInspector();
  } else if (['epic','story','sprint','meeting','agent'].some(kind=>Object.hasOwn(data,'owner'+kind[0].toUpperCase()+kind.slice(1)))) {
    const key = Object.keys(data).find(k=>/^owner(Epic|Story|Sprint|Meeting|Agent)$/.test(k));
    if (dialog.open) dialog.close();
    inspectObject(key.slice(5).toLowerCase(),data[key]);
  } else if (data.retryFromInbox!==undefined) {
    if(dialogBusy)return;
    setDialogBusy(true);
    const origin=todayContext;
    void bridge.request('startTask',{taskId:data.retryFromInbox}).then(()=>showDecisionOutcome(data.retryFromInbox,origin))
      .catch(e=>dialog.open ? dialogError(e.message) : notice(e.message,true)).finally(()=>setDialogBusy(false));
  } else if (data.errorSettings!==undefined) {
    dialog.close();route('app-settings');
  } else if (data.close !== undefined) dialog.close();
  else if (!bridge || dialogBusy) return;
  else if (legacyAction(data, target)) return;
  else if (data.reload !== undefined) void refresh();
  else if(data.todayId!==undefined) openTodayDecision(todayItems(state,Object.fromEntries(folderProbes)).find(row=>
    row.id===data.todayId&&row.kind===data.todayKind&&row.studioId===data.todayStudio));
  else if(data.todayNext!==undefined) {
    const next=todayItems(state,Object.fromEntries(folderProbes)).find(row=>!todayFilter||row.studioId===todayFilter);
    if(next)openTodayDecision(next);else route('workspace');
  }
  else if (data.folder !== undefined) void pickFolder(form.elements[data.folder || 'root']);
  else if(data.projectSettings!==undefined){if(dialog.open)dialog.close();selectStudio(data.projectSettings);route('settings');}
  else if (data.portfolioTask !== undefined) {
    selectStudio(data.studio); route('work');
    if(tasks().some(t=>t.id===data.portfolioTask)) inspectObject('task',data.portfolioTask);
  } else if (data.enterStudio !== undefined || data.workspaceInbox !== undefined) {
    selectStudio(data.enterStudio ?? data.workspaceInbox);
    route(data.workspaceInbox === undefined ? 'overview' : 'inbox');
    if (data.decision) {
      const decision = entries().find(item => same(item.id, data.decision));
      if (decision) openInbox(decision);
    }
  } else if (data.wizardNext !== undefined) moveWizard(1);
  else if (data.wizardBack !== undefined) moveWizard(-1);
  else if (data.saveStudioDraft!==undefined) {saveWizardDraft();dialog.close();render();notice(copy('Черновик сохранён'));}
  else if (data.view) route(data.view);
  else if (data.workPane) {
    workTab = data.workPane;
    route('work');
  }
  else if (data.epicLink !== undefined) showEpic(data.epicLink);
  else if (data.workTab) {
    workTab = data.workTab;
    render();
  } else if(data.boardEmpty!==undefined||data.boardScope!==undefined) {
    if(data.boardEmpty!==undefined)boardShowEmpty=!boardShowEmpty;
    else boardAllSprints=!boardAllSprints;
    render();
    content.querySelector(data.boardEmpty!==undefined?'[data-board-empty]':'[data-board-scope]')?.focus();
  } else if (data.open) commands[data.open]?.();
  else if (data.assessDebt !== undefined) void assessDebt();
  else if (data.initialize !== undefined) void workCommand('initializeStudio', { studioId: studio().id });
  else if (data.runAction) {
    if(todayContext&&data.runAction==='resume'){
      const id=studio().id;
      const origin=todayContext;
      setDialogBusy(true);
      void bridge.request('setStudioRunning',{studioId:id,action:'resume'})
        .then(async()=>{await refresh();finishTodayDecision(undefined,'resume',origin);})
        .catch(e=>{if(todayContext===origin)dialogError(e.message);}).finally(()=>setDialogBusy(false));
      return;
    }
    if (dialog.open) dialog.close();
    void workCommand('setStudioRunning', { studioId: studio().id, action: data.runAction });
  }
  else if (data.editPlanTasks !== undefined) {
    const plan = planById(data.editPlanTasks);
    if (plan?.status === 'pending') planTasksEditor(plan);
  } else if (data.editPlanTeam !== undefined) {
    const plan = planById(data.editPlanTeam);
    if (plan) planTeamEditor(plan);
  } else if (data.plan !== undefined || data.revisePlan !== undefined || data.cancelPlanTeam !== undefined) {
    const plan = planById(data.plan ?? data.revisePlan ?? data.cancelPlanTeam);
    if (plan) openPlan(plan, data.revisePlan !== undefined);
  } else if (data.approvePlan !== undefined) void approvePlan(data.approvePlan, Number(data.editVersion));
  else if (data.reviseResult !== undefined) {
    const item = entries().find(entry => same(entry.id, data.reviseResult) && entry.kind === 'acceptance');
    if (item) openAcceptance(item, true);
  }
  else if (data.fileAction && ['openArtifact','revealArtifact','copyArtifactPath'].includes(data.fileAction)) {
    const payload = data.fileSource==='plan' ? {planId:data.fileId,path:data.filePath} : {taskId:data.fileId,versionPath:data.filePath};
    void openArtifact(payload,data.fileAction);
  } else if (data.reviewFile!==undefined||data.revealReviewFile!==undefined||data.copyReviewFile!==undefined) {
    void openArtifact({studioId,inboxId:data.reviewFile??data.revealReviewFile??data.copyReviewFile},
      data.revealReviewFile!==undefined?'revealArtifact':data.copyReviewFile!==undefined?'copyArtifactPath':'openArtifact');
  }
  else if (data.artifact !== undefined || data.revealArtifact !== undefined || data.copyArtifactPath !== undefined) {
    const task = tasks().find(item => same(item.id, data.artifact ?? data.revealArtifact ?? data.copyArtifactPath));
    if (task) void openArtifact({ taskId: task.id }, data.revealArtifact !== undefined ? 'revealArtifact' : data.copyArtifactPath !== undefined ? 'copyArtifactPath' : 'openArtifact');
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
  } else if (data.taskTransitions !== undefined) {
    const row = tasks().find(t=>t.id===data.taskTransitions);
    if (row) void loadTransitions(target, row);
  } else if (data.inbox !== undefined) {
    const item = entries().find(entry => same(entry.id, data.inbox));
    if (item) openInbox(item);
  } else if (data.scope) {
    inboxScope = data.scope;
    render();
  } else if (data.teamToggle!==undefined) {
    stored('team-view',stored('team-view')==='map' ? 'table' : 'map'); render();
  } else if (data.agent !== undefined) {
    selectedAgent = data.agent;
    render();
    inspectObject('agent',data.agent);
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
    dialogError(copy('Заполните обязательное поле.'));
    control.focus();
    return;
  }
  setDialogBusy(true);
  const origin=todayContext;
  try {
    const close = await submission(values);
    if(origin&&todayContext!==origin)return;
    if (close !== false && origin) {
      const {row}=origin;
      await refresh();
      if (!todayItems(state,Object.fromEntries(folderProbes)).some(next=>next.id===row.id&&next.kind===row.kind&&next.studioId===row.studioId)) {
        finishTodayDecision(undefined,undefined,origin);
        return;
      }
    }
    if (close !== false && dialog.open) dialog.close();
    await refresh();
  } catch (error) {
    dialogError(error.message || copy('Не удалось сохранить изменения.'));
  } finally {
    setDialogBusy(false);
  }
});

form.addEventListener('change', ({ target }) => {
  if (target.name === 'folderMode') {
    const isNew = target.value === 'new';
    form.querySelector('[data-new-folder]').hidden = !isNew;
    form.querySelector('[data-existing-folder]').hidden = isNew;
    form.querySelector('.folder-field label span').textContent = isNew ? copy('Родительская папка') : copy('Папка проекта');
    form.elements.root.value = '';
  }
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
    saveWizardDraft();
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
  if(wizardOpen())saveWizardDraft();
});
form.addEventListener('input',()=>{if(wizardOpen())saveWizardDraft();});

content.addEventListener('change', ({ target }) => {
  if (target.matches('[data-today-filter]')) {todayFilter=target.value;render();content.querySelector('[data-today-filter]')?.focus();}
  else if(target.name==='density'){stored('density',target.value);document.documentElement.dataset.density=target.value;}
  else if (target.name === 'approveSprints') void workCommand('updateStudio', { studioId: studio().id, approveSprints: target.checked });
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
  if(target.isConnected&&target.dataset.workRecord) {
    if(target.open)expandedRecords.add(target.dataset.workRecord);else expandedRecords.delete(target.dataset.workRecord);
  }
}, true);

dialog.addEventListener('cancel', event => { if (dialogBusy) event.preventDefault(); });
document.addEventListener('keydown', event=>{
  if(event.key==='/'&&studio()&&Object.hasOwn(studioViews,view)&&!dialog.open&&!event.altKey&&!event.metaKey&&!event.ctrlKey&&
      !document.activeElement?.matches('input, textarea, select, [contenteditable="true"]')){
    event.preventDefault();workTab='registry';route('work');content.querySelector('[data-registry-query]')?.focus();return;
  }
  if (event.key==='Escape' && !dialog.open && ownerTrail.current) {
    event.preventDefault();
    if (ownerTrail.depth>1) { ownerTrail.back(); paintInspector(true); } else dismissInspector();
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase()==='f' && !dialog.open && view==='work') {
    const search = content.querySelector('[data-registry-query]');
    if (search) { event.preventDefault(); search.focus(); search.select(); }
  }
});
$('#owner-comment').addEventListener('input',({currentTarget:box})=>{
  commentDrafts.set(box.dataset.key,{text:box.elements.comment.value,operation:operationId()});
});
$('#owner-comment').addEventListener('submit',async event=>{
  event.preventDefault();
  const record=ownerTrail.current, box=event.currentTarget;
  if(record?.kind!=='task')return;
  const key=commentKey(record.studioId,record.id), draft=commentDrafts.get(key);
  if(!draft?.text.trim())return;
  const submit=box.querySelector('button');
  submit.disabled=true;
  try {
    await bridge.request('postStudioMessage',{studioId:record.studioId,taskId:record.id,kind:'comment',text:draft.text,operationId:draft.operation});
    if(commentDrafts.get(key)===draft) {
      commentDrafts.delete(key);
      if(box.dataset.key===key) {box.elements.comment.value='';box.querySelector('[role=status]').textContent=ui('saved');}
    }
    await refresh();
  } catch(error) { if(box.dataset.key===key)box.querySelector('[role=status]').textContent=error.message; }
  finally {submit.disabled=false;}
});
installInspectorResize($('.owner-layout'), $('#owner-resize'), () => stored('owner-width'), value => stored('owner-width',value));
dialog.addEventListener('close', () => {
  if(dialog.open)return;
  closeTodayContext();
  taskDialog = undefined;
  dialogReconciliation = undefined;
  catalogEditor = undefined;
  if (opener?.isConnected) opener.focus();
  else content.focus();
  if (notificationTarget && !dialog.open) void goToNotification();
});

async function changeAppLocale(target) {
  target.disabled = true;
  try {
    await bridge.request('setAppLocale',{locale:target.value});
    await refresh();
  } catch (error) {
    target.value = state.appLocale ?? 'en';
    notice(error.message,true);
  } finally { target.disabled = false; }
}

content.addEventListener('change', ({target})=>{
  if (target.matches('[data-settings-locale]')) void changeAppLocale(target);
});

$('#studio-select').addEventListener('change', ({ target }) => {
  selectStudio(target.value);
  route('overview');
});

function applyTheme(value) {
  document.documentElement.dataset.theme = ['light', 'dark'].includes(value) ? value : 'system';
}
applyTheme(stored('theme'));
document.documentElement.dataset.density=stored('density')==='roomy'?'roomy':'compact';

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
    inboxScope = item?.status === 'resolved' ? 'resolved' : item&&!actionableInboxIds().has(item.id)?'waiting':'open';
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
  $('#studio-select').innerHTML = copy('<option>Нет студий</option>');
  $('[data-open="studio"]').disabled = true;
  content.innerHTML = empty(copy('Откройте Hearth Studio'), copy('Для работы со студиями запустите настольное приложение.'));
}
