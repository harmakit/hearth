import {copy as uiCopy, onCopyLocale} from './copy.mjs';
const makeRoomNames = () => ({
  director: uiCopy('Кабинет директора'), library: uiCopy('Библиотека'), workshop: uiCopy('Разработка'),
  atelier: uiCopy('Ателье'), common: uiCopy('Общая комната'),
});
let roomNames = makeRoomNames();
onCopyLocale(() => { roomNames = makeRoomNames(); });

const makeRoleNames = () => ({
  director: uiCopy('Директор'), library: uiCopy('Библиотекарь'), engineer: uiCopy('Инженер'),
  editor: uiCopy('Редактор'), artist: uiCopy('Художник'), other: uiCopy('Другая роль'),
});
export let roleNames = makeRoleNames();
onCopyLocale(() => { roleNames = makeRoleNames(); });

const makeRoleDetails = () => ({
  director: uiCopy('Планирует работу, распределяет задачи и принимает результаты команды.'),
  library: uiCopy('Подбирает утверждённые источники и навыки для задач, ведёт справочные материалы.'),
  engineer: uiCopy('Работает с кодом, техническими документами и проверками.'),
  editor: uiCopy('Готовит и проверяет тексты, ведёт редактуру материалов.'),
  artist: uiCopy('Разрабатывает визуальные идеи и готовит материалы для проекта.'),
  other: uiCopy('Выполняет задачи по назначению, указанному в описании роли.'),
});
export let roleDetails = makeRoleDetails();
onCopyLocale(() => { roleDetails = makeRoleDetails(); });

const languages = ['Русский', 'English', 'Español', 'Deutsch', 'Français', 'Português', 'Українська', '中文', '日本語'];

export function languageChoices(current) {
  return current && !languages.includes(current) ? [...languages, current] : languages;
}

export function pendingStudioPlan(plans, studioId) {
  return plans?.find(plan => plan.studioId === studioId && plan.status === 'pending');
}

export function agentActivity(task, directorLifecycle) {
  if (directorLifecycle === 'planning') return [uiCopy('Готовит план'), 'good'];
  if (directorLifecycle === 'awaiting-approval') return [uiCopy('Ждёт согласования'), 'warn'];
  if (task?.status === 'running') {
    if (task.stage === 'director') return [uiCopy('Выбирает следующий шаг'), 'good'];
    if (task.stage === 'review') return [uiCopy('На ревью'), 'good'];
    if (task.stage === 'qa') return [uiCopy('На проверке'), 'good'];
    return [uiCopy('Работает'), 'good'];
  }
  if (task?.status === 'waiting') return [uiCopy('Ждёт ответа'), 'warn'];
  if (task?.status === 'queued' && task.stage !== 'backlog') return [uiCopy('Ждёт запуска'), 'warn'];
  if (task?.stage === 'blocked') return [uiCopy('Работа заблокирована'), 'attention'];
  return [uiCopy('Свободен'), ''];
}

export function actorState(task, directorLifecycle, { paused, scheduled } = {}) {
  if (task?.status !== 'running' && (paused || scheduled)) return paused ? 'paused' : 'queued';
  if (directorLifecycle === 'planning' || (task?.status === 'running' && task.stage === 'director')) return 'planning';
  if (directorLifecycle === 'awaiting-approval' || task?.status === 'waiting') return 'waiting';
  if (task?.status === 'running') return ['review', 'qa'].includes(task.stage) ? 'review' : 'working';
  if (task?.status === 'queued' && task.stage !== 'backlog') return 'queued';
  return 'idle';
}

const workspaces = {
  director: ['director', 'plan'], library: ['library', 'books'],
  editor: ['library', 'paper'], engineer: ['workshop', 'terminal'],
  artist: ['atelier', 'easel'], other: ['common', 'notebook'],
};

const taskPriority = { running: 3, waiting: 2, queued: 1 };

export function buildRooms(studio) {
  const rooms = Object.entries(roomNames).map(([id, name]) => ({ id, name, desks: [] }));
  rooms[0].desks.push({ agent: { id: null, name: uiCopy('Директор'), role: 'director', description: roleDetails.director, ...studio.director }, props: 'plan' });

  for (const agent of studio.agents ?? []) {
    const [roomId, props] = Object.hasOwn(workspaces, agent.role) ? workspaces[agent.role] : workspaces.other;
    rooms.find(room => room.id === roomId).desks.push({ agent, props });
  }

  return rooms.filter(room => room.desks.length > 0);
}

export function taskForAgent(tasks, studioId, agentId) {
  return tasks.filter(task => {
    const responsible = task.activeAgentId === undefined ? task.agentId ?? null : task.activeAgentId;
    return task.studioId === studioId && responsible === agentId;
  })
    .sort((a, b) => (taskPriority[b.status] ?? 0) - (taskPriority[a.status] ?? 0)
      || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))[0];
}
