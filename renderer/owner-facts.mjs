import { copy } from './copy.mjs';

const stageLabels = {
  backlog:'Бэклог', ready:'Готова к работе', in_progress:'В работе', review:'На ревью',
  qa:'На проверке', done:'Готово', blocked:'Заблокирована', replaced:'Заменена',
};
const legacyStages = {
  queued:'ready', scheduled:'ready', running:'in_progress', waiting:'blocked',
  completed:'done', failed:'blocked', interrupted:'blocked', cancelled:'blocked',
};

export function taskStage(task) {
  if (Object.hasOwn(stageLabels,task.stage)) return task.stage;
  return Object.hasOwn(legacyStages,task.status) ? legacyStages[task.status] : 'backlog';
}

export function taskOwnerDecision(task, inbox) {
  return inbox.find(item => item.status === 'open' && item.taskId === task.id &&
    (!task.studioId || !item.studioId || item.studioId === task.studioId) &&
    ['acceptance','question','error','reconcile'].includes(item.kind));
}

export function taskOwnerState(task, {inbox=[], tasks=[]}={}) {
  const stage = taskStage(task);
  const entry = taskOwnerDecision(task,inbox);
  let label = stageLabels[stage];
  if (task.status === 'cancelled') label = 'Отменена';
  else if (stage === 'done' || stage === 'replaced') return {stage,label:copy(label)};
  else if (entry?.kind === 'acceptance') return {stage:'qa',label:copy('Ждёт вашей приёмки')};
  else if (entry?.kind === 'question') label = 'Ждёт вашего ответа';
  else if (entry?.kind === 'reconcile') label = 'Нужна сверка прерванного шага';
  else if (task.status === 'failed' || entry?.kind === 'error') label = 'Ошибка выполнения';
  else if (task.status === 'interrupted') label = 'Прервана';
  else if (stage === 'in_progress' && task.status === 'completed') label = 'Передача результата';
  else if (stage === 'blocked' && task.dependencies?.some(id => tasks.find(row=>row.id===id)?.stage !== 'done')) label = 'Ждёт зависимую задачу';
  else if (task.status === 'scheduled') label = 'В очереди на запуск';
  return {stage,label:copy(label)};
}

export function studioActivityStatus(studio, activeAttempts, needsAttention) {
  if (studio.manualPaused || studio.lifecycle === 'paused') return 'paused';
  if (activeAttempts > 0 && ['active', 'idle'].includes(studio.lifecycle)) return 'active';
  if (studio.quotaPause && !activeAttempts && !needsAttention && studio.lifecycle!=='error')return 'paused';
  if (['active', 'idle'].includes(studio.lifecycle)) return needsAttention ? 'error' : 'idle';
  return studio.lifecycle;
}

export function currentStudioTasks(tasks) {
  return tasks.filter(task => task.status !== 'cancelled' && task.stage !== 'replaced' &&
    (task.status !== 'completed' || (task.workflowManaged && task.stage !== 'done')) &&
    !isSavedTask(task));
}

export function isSavedTask(task) {
  return task.status === 'queued' && !task.sprintId && task.kind !== 'train' && !task.workflowManaged;
}

// Derive the inspector from the same published snapshot as the board.
export function taskFacts(snapshot, studioId, taskId) {
  const rows = name => (snapshot[name] ?? []).filter(row => row.studioId === studioId);
  const tasks = rows('tasks');
  const task = tasks.find(row => row.id === taskId);
  if (!task) return null;
  const attempts = rows('attempts').filter(row => row.taskId === taskId);
  const usageEvents = rows('usageEvents');
  let measured = 0;
  let total = 0;
  const runs = attempts.map(attempt => {
    const events = usageEvents.filter(row => row.attemptId === attempt.id);
    const sum = key => events.length && events.every(e => Number.isSafeInteger(e[key]) && e[key] >= 0)
      ? events.reduce((n, e) => n + e[key], 0) : null;
    const input = sum('input');
    const output = sum('output');
    if (input !== null && output !== null) {
      total += input + output;
      measured++;
    }
    const elapsed = Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt);
    return { ...attempt, elapsedMs:Number.isFinite(elapsed) && elapsed>=0 ? elapsed : null,
      usage: { input, output, cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite') } };
  });
  const threads = new Map(rows('conversations').filter(thread => thread.taskId === taskId)
    .map(thread => [thread.id, thread]));
  const messages = rows('conversationMessages').filter(message => threads.has(message.conversationId))
    .map(message => ({ ...message, agentId: threads.get(message.conversationId).agentId }))
    .sort((a,b)=>String(b.createdAt??'').localeCompare(String(a.createdAt??'')) || String(b.id).localeCompare(String(a.id)));
  const history = [];
  const record = (type, at, detail = '', id='') => {
    if (at && Number.isFinite(Date.parse(at))) history.push({ type, at, detail, id:type+':'+id });
  };
  record('created', task.createdAt);
  for (const run of runs) {
    record('attempt-start', run.startedAt, run.purpose, run.id);
    record('attempt-end', run.finishedAt, run.status, run.id);
  }
  for (const message of messages) record('message', message.createdAt,'',message.id);
  for (const item of rows('evidence').filter(row => row.taskId === taskId)) record('evidence', item.recordedAt ?? item.createdAt, item.sourcePath,item.id);
  history.sort((a,b) => Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id));
  return {
    task, messages, history, attempts: runs, usage: { measured, total: measured ? total : null },
    before: tasks.filter(row => task.dependencies?.includes(row.id)),
    after: tasks.filter(row => row.dependencies?.includes(task.id)),
  };
}
