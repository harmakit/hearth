// Work from the task and its recorded attempt. The notification may have been closed by an older build.
export function taskRecovery(task, studio, attempts = [], inbox = []) {
  if (task.status !== 'failed') return null;
  const attempt = attempts.findLast(a=>a.studioId===task.studioId&&a.taskId===task.id&&a.status==='failed');
  const notice = inbox.findLast(i=>i.studioId===task.studioId&&i.taskId===task.id&&i.kind==='error');
  const reason = task.error || attempt?.error || notice?.body || '';
  const training = task.kind==='train'||task.training?.bootstrap;
  const kind = training ? 'training' : 'task';
  if (studio.archivedAt) return {kind,reason,action:null};
  if (studio.projectDetached) return {kind,reason,action:'project'};
  if (task.legacyWorktreeReview) return {kind,reason,action:'worktree'};
  if (attempt?.action==='authenticate') return {kind:'connection',reason,action:'connection'};
  if (task.gitDelivery?.status==='checks-blocked') return {kind:'checks',reason,action:'checks'};
  if (studio.manualPaused||studio.lifecycle==='paused') return {kind,reason,action:'resume'};
  if (!task.workflowManaged||studio.wipLimit>1||task.training?.bootstrap) return {kind,reason,action:'retry'};
  if (studio.lifecycle==='error') return {kind,reason,action:'resume'};
  return {kind,reason,action:'message'};
}
