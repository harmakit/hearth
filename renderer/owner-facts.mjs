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
    return { ...attempt, usage: { input, output, cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite') } };
  });
  const threads = new Map(rows('conversations').filter(thread => thread.taskId === taskId)
    .map(thread => [thread.id, thread]));
  const messages = rows('conversationMessages').filter(message => threads.has(message.conversationId))
    .map(message => ({ ...message, agentId: threads.get(message.conversationId).agentId }));
  const history = [];
  const record = (type, at, detail = '') => {
    if (at && Number.isFinite(Date.parse(at))) history.push({ type, at, detail });
  };
  record('created', task.createdAt);
  for (const run of runs) {
    record('attempt-start', run.startedAt, run.purpose);
    record('attempt-end', run.finishedAt, run.status);
  }
  for (const message of messages) record('message', message.createdAt);
  for (const item of rows('evidence').filter(row => row.taskId === taskId)) record('evidence', item.recordedAt ?? item.createdAt, item.sourcePath);
  history.sort((a,b) => Date.parse(b.at) - Date.parse(a.at));
  return {
    task, messages, history, attempts: runs, usage: { measured, total: measured ? total : null },
    before: tasks.filter(row => task.dependencies?.includes(row.id)),
    after: tasks.filter(row => row.dependencies?.includes(task.id)),
  };
}
