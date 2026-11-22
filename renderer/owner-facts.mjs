export function studioActivityStatus(studio, activeAttempts, needsAttention) {
  if (studio.manualPaused || studio.lifecycle === 'paused') return 'paused';
  if (activeAttempts > 0 && ['active', 'idle'].includes(studio.lifecycle)) return 'active';
  if (['active', 'idle'].includes(studio.lifecycle)) return needsAttention ? 'error' : 'idle';
  return studio.lifecycle;
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
