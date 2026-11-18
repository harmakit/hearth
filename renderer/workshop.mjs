const roomNames = {
  director: 'Кабинет директора', library: 'Библиотека', workshop: 'Разработка',
  atelier: 'Ателье', common: 'Общая комната',
};

export const roleNames = {
  director: 'Директор', library: 'Библиотекарь', engineer: 'Инженер',
  editor: 'Редактор', artist: 'Художник', other: 'Другая роль',
};

export const roleDetails = {
  director: 'Планирует работу, распределяет задачи и принимает результаты команды.',
  library: 'Подбирает утверждённые источники и навыки для задач, ведёт справочные материалы.',
  engineer: 'Работает с кодом, техническими документами и проверками.',
  editor: 'Готовит и проверяет тексты, ведёт редактуру материалов.',
  artist: 'Разрабатывает визуальные идеи и готовит материалы для проекта.',
  other: 'Выполняет задачи по назначению, указанному в описании роли.',
};

const languages = ['Русский', 'English', 'Español', 'Deutsch', 'Français', 'Português', 'Українська', '中文', '日本語'];

export function languageChoices(current) {
  return current && !languages.includes(current) ? [...languages, current] : languages;
}

export function pendingStudioPlan(plans, studioId) {
  return plans?.find(plan => plan.studioId === studioId && plan.status === 'pending');
}

export function agentActivity(task, directorLifecycle) {
  if (directorLifecycle === 'planning') return ['Готовит план', 'good'];
  if (directorLifecycle === 'awaiting-approval') return ['Ждёт согласования', 'warn'];
  if (task?.status === 'running') {
    if (task.stage === 'director') return ['Выбирает следующий шаг', 'good'];
    if (task.stage === 'review') return ['На ревью', 'good'];
    if (task.stage === 'qa') return ['На проверке', 'good'];
    return ['Работает', 'good'];
  }
  if (task?.status === 'waiting') return ['Ждёт ответа', 'warn'];
  if (task?.status === 'queued' && task.stage !== 'backlog') return ['Ждёт запуска', 'warn'];
  if (task?.stage === 'blocked') return ['Работа заблокирована', 'attention'];
  return ['Свободен', ''];
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
  rooms[0].desks.push({ agent: { id: null, name: 'Директор', role: 'director', description: roleDetails.director, ...studio.director }, props: 'plan' });

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
