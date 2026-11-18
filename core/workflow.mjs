import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { completeInitialRoster, directorPrompt, field, newDirectorHire, object, parseResponse, planPrompt, publishableArtifactPath, reviewPrompt, roleTitle, trainingTopics, validatePlan } from './protocol.mjs';
import { coachFor } from './training.mjs';
import { debtPlanContext, eligibleDebt, validateDebtPlan } from './debt.mjs';
import { buildTaskContext } from './checkpoints.mjs';

const now = () => new Date().toISOString();

function artifactPathFor(task, proposedPath) {
  const path = proposedPath ?? task.artifactTarget ?? task.artifactPath;
  if (!task.artifactPath || !task.revision || (proposedPath && !task.artifactVersions?.includes(proposedPath))) return path;
  const base = task.artifactTarget ?? task.artifactVersions?.[0] ?? task.artifactPath;
  const { dir, name, ext } = posix.parse(base);
  const suffix = `-v${task.revision + 1}${ext}`;
  const maxName = 480 - suffix.length - (dir ? dir.length + 1 : 0);
  if (maxName < 1) throw new Error(`Невозможно создать имя новой версии для «${base}».`);
  return posix.join(dir, name.slice(0, maxName) + suffix);
}

export function createWorkflow({
  read, list, insert, update, transaction, changed, notifyInbox, addStudioInbox, addInbox, taskInbox,
  run, writeArtifact, taskControls, recommendedTaskControls, confirmTaskControls, effectiveAllowed, validateFixed,
  runPrompt, report, isClosed, active, availableStudio, onAvailable, training, hasHeldWorkflow,
  projectPipeline, afterGitMerge, dispatcher, checkpoints, planning: planningService, prerequisites, roster, trackedRun, describeAttachments,
  nonWorkflowActiveCount = () => 0,
}) {
  const controllers = new Map();
  const pumping = new Set();
  const retryTimers = new Map();
  const wip = (studio) => studio.wipLimit ?? 1;
  const activeWork = (studioId) => [...controllers.values()].filter((run) => !studioId || run.studioId === studioId);
  const hasDispatchWork = (studioId) => dispatcher.jobs(studioId).some(({ status }) => ['queued', 'running'].includes(status));
  const hasTaskWork = (studio, taskId) => dispatcher.jobs(studio.id).some((job) => job.taskId === taskId && ['queued', 'running', 'waiting', 'reconcile'].includes(job.status));

  function state(studio, lifecycle, activity, job = null) {
    return update('studios', { ...studio, lifecycle, activity, workflowJob: job });
  }

  function queue(studioId) {
    if (pumping.has(studioId) || isClosed()) return;
    pumping.add(studioId);
    queueMicrotask(() => {
      pumping.delete(studioId);
      void drain(studioId);
    });
  }

  function clearRetry(studioId) {
    clearTimeout(retryTimers.get(studioId));
    retryTimers.delete(studioId);
  }

  function scheduleRetry(studioId) {
    clearRetry(studioId);
    const next = dispatcher.delayUntil(studioId);
    if (!next) return;
    const delay = Math.max(1, Math.min(2_147_483_647, Date.parse(next) - Date.now()));
    const timer = setTimeout(() => {
      retryTimers.delete(studioId);
      queue(studioId);
    }, delay);
    timer.unref();
    retryTimers.set(studioId, timer);
  }

  function checkoutKey(studio) {
    try { return realpathSync(studio.root); } catch { return resolve(studio.root); }
  }

  function putJob(studio, job) {
    const task = job.taskId ? read('tasks', job.taskId, 'Задача') : undefined;
    const writesProject = ['publish', 'artifact', 'git-merge'].includes(job.purpose);
    const writesWorktree = task?.deliveryMode === 'git' && ['task', 'git-check'].includes(job.purpose);
    const worktree = writesProject ? checkoutKey(studio) : writesWorktree ? `git-task:${studio.id}:${task.id}` : undefined;
    const operationId = job.purpose === 'publish' ? `${job.planId}:file:${job.fileIndex}` : job.operationId;
    return dispatcher.enqueue({
      ...job, studioId: studio.id, sprintId: task?.sprintId, writes: writesProject || writesWorktree,
      worktree, operationId,
    });
  }

  function planning(studio, kind, feedback, previousPlanId) {
    const job = { purpose: 'plan', kind, feedback, previousPlanId };
    putJob(studio, job);
    if (studio.manualPaused) return state(studio, 'paused', 'Студия на паузе', job);
    return state(studio, 'planning', 'Директор готовит план', job);
  }

  function initializeStudio({ studioId }) {
    const studio = read('studios', studioId, 'Студия');
    if (studio.lifecycle === 'planning' || studio.lifecycle === 'awaiting-approval') return studio;
    if (studio.workflowJob || studio.lifecycle !== 'draft') throw new Error('Инициализация этой студии уже началась.');
    const result = transaction(() => planning(studio, 'initial'));
    queue(studioId);
    return changed(result);
  }

  function startNextSprint({ studioId }) {
    const studio = read('studios', studioId, 'Студия');
    if (studio.lifecycle === 'awaiting-approval' || studio.lifecycle === 'planning') return studio;
    if (studio.lifecycle === 'draft' || hasDispatchWork(studioId) || list('sprints').some(sprint => sprint.studioId === studioId && sprint.status === 'active')) {
      throw new Error('Сначала завершите текущий спринт или инициализацию.');
    }
    const previous = list('sprints').findLast(sprint => sprint.studioId === studioId && sprint.status === 'completed');
    if (!previous) throw new Error('Сначала запустите первый спринт.');
    const result = transaction(() => planning(studio, 'sprint', undefined, previous.planId));
    queue(studioId);
    return changed(result);
  }

  function schedule(studio, job, activity) {
    putJob(studio, job);
    if (studio.lifecycle === 'paused' || studio.manualPaused) return state(studio, 'paused', 'Студия на паузе', job);
    return state(studio, 'active', activity, job);
  }

  function nextTask(studio, task, continuation = {}) {
    update('tasks', { ...task, stage: 'ready', status: 'queued', activeAgentId: undefined, error: '', updatedAt: now() });
    return schedule(studio, { ...continuation, purpose: 'task', taskId: task.id }, `Готовится задача «${task.title}»`);
  }

  function routeTask(studio, task, continuation = {}, visited = new Set()) {
    if (visited.has(task.id)) throw new Error('Обнаружена циклическая зависимость обучения.');
    visited.add(task.id);
    const gated = training.withDependencies(studio, task);
    if (gated !== task) task = update('tasks', { ...gated, updatedAt: now() });
    const pending = task.dependencies.map((id) => read('tasks', id, 'Зависимость')).find(({ stage }) => stage !== 'done');
    if (pending && pending.kind !== 'train') throw new Error('Зависимости задачи ещё не завершены.');
    if (pending) return routeTask(studio, pending, { ...continuation, resumeTaskId: continuation.resumeTaskId ?? task.id }, visited);
    if (prerequisites?.pendingPrerequisites('task', task.id).length || pendingRosterChange(task)) return;
    return nextTask(studio, task, continuation);
  }

  function readyTask(task, includeDone) {
    return task.status === 'queued' && ['ready', 'backlog'].includes(task.stage)
      && (task.dependencies ?? []).every((id) => id === includeDone || read('tasks', id, 'Зависимость').stage === 'done')
      && !prerequisites?.pendingPrerequisites('task', task.id).length && !pendingRosterChange(task);
  }

  function pendingRosterChange(task) {
    return task.rosterProposalId && read('rosterProposals', task.rosterProposalId, 'Предложение роли').status === 'pending';
  }

  function routeParallelSprint(studio, task) {
    const candidates = new Map(sprintTasks(task).map((candidate) => [candidate.id, candidate]));
    for (const candidate of candidates.values()) {
      if (candidate.status !== 'queued' || hasTaskWork(studio, candidate.id)) continue;
      const gated = training.withDependencies(studio, candidate);
      if (gated !== candidate) update('tasks', { ...gated, updatedAt: now() });
      if (readyTask(gated)) {
        nextTask(studio, gated, gated.sprintId === task.sprintId ? {} : { resumeTaskId: task.id, resumeSprint: true });
      } else {
        for (const id of gated.dependencies ?? []) {
          if (candidates.has(id)) continue;
          const dependency = read('tasks', id, 'Зависимость');
          if (dependency.kind === 'train') candidates.set(id, dependency);
        }
      }
    }
  }

  function routeSprint(studio, task) {
    if (wip(studio) > 1) return routeParallelSprint(studio, task);
    const outstanding = sprintTasks(task).find((candidate) => candidate.kind === 'train' && candidate.stage !== 'done');
    return outstanding ? routeTask(studio, outstanding, { resumeTaskId: task.id, resumeSprint: true }) : routeTask(studio, task);
  }

  function activateQueuedSprint(studio) {
    if (studio.lifecycle !== 'active') return;
    const sprint = list('sprints').findLast((record) => record.studioId === studio.id && record.status === 'active');
    if (!sprint) return;
    const candidates = sprintTasks({ sprintId: sprint.id });
    if (wip(studio) > 1) routeParallelSprint(studio, { sprintId: sprint.id, id: candidates[0]?.id });
    else {
      const task = candidates.find((candidate) => readyTask(candidate) || (candidate.rosterProposalId && !pendingRosterChange(candidate)
        && candidate.status === 'queued' && candidate.dependencies.every((id) => {
          const dependency = read('tasks', id, 'Зависимость');
          return dependency.stage === 'done' || dependency.kind === 'train';
        })));
      if (task && !hasHeldWorkflow(studio.id)) routeTask(studio, task);
    }
  }

  function startStandaloneTraining(studio, task) {
    if (hasHeldWorkflow(studio.id) && !task.training?.scoped) throw new Error('Сначала ответьте на вопрос Директора или завершите приёмку текущей задачи.');
    if (hasTaskWork(studio, task.id) || (studio.workflowJob && wip(studio) === 1) || !['draft', 'idle', 'active'].includes(studio.lifecycle)) {
      throw new Error('Студия уже выполняет другой этап.');
    }
    const result = transaction(() => routeTask(studio, task, {
      returnLifecycle: studio.lifecycle, returnActivity: studio.activity, resumeTaskId: task.id,
    }));
    queue(studio.id);
    return changed(result);
  }

  function approve(studio, draft) {
    const plan = completeInitialRoster(draft, studio.agents);
    const { id, studioId } = plan;
    if (plan.tasks.some(task => task.deliveryMode === 'git') && !studio.projectGit?.enabled) throw new Error('Разрешите работу с Git в настройках студии.');
    const linkedDebt = new Map();
    const linkedBacklog = new Map();
    for (const { debtTaskId } of plan.tasks) {
      if (!debtTaskId) continue;
      const task = read('tasks', debtTaskId, 'Задача техдолга');
      if (!eligibleDebt(task, studioId) || linkedDebt.has(debtTaskId)) {
        throw new Error('Задача техдолга больше недоступна. Верните план на доработку.');
      }
      linkedDebt.set(debtTaskId, task);
    }
    for (const { backlogTaskId } of plan.tasks) {
      if (!backlogTaskId) continue;
      const task = read('tasks', backlogTaskId, 'Карточка бэклога');
      if (task.studioId !== studioId || task.kind === 'train' || task.sprintId || task.status !== 'queued' ||
          (task.dependencies ?? []).some(id => read('tasks', id, 'Зависимость').stage !== 'done') ||
          linkedBacklog.has(backlogTaskId) || linkedDebt.has(backlogTaskId) || hasTaskWork(studio, task.id)) {
        throw new Error('Карточка бэклога больше недоступна. Верните план на доработку.');
      }
      linkedBacklog.set(backlogTaskId, task);
    }
    const agents = [...studio.agents];
    const byKey = new Map(agents.map((agent) => [agent.key ?? agent.id, agent]));
    const agentEdits = new Map(Object.entries(plan.agentEdits ?? {}));
    const hires = [];
    for (const candidate of plan.agents) {
      const existing = byKey.get(candidate.key);
      const ownerFields = agentEdits.get(candidate.key) ?? [];
      if (existing) {
        if (ownerFields.length) {
          const edited = { ...existing };
          for (const name of ownerFields) edited[name] = candidate[name];
          if (edited.mode === 'fixed') validateFixed(studio, edited);
          Object.assign(existing, edited);
        }
        continue;
      }
      const { key, role, roleTitle, name, description, mode = 'dynamic', runtime = '', model = '', effort = '' } = candidate;
      const agent = { id: randomUUID(), key, role, roleTitle, name, description, mode, runtime, model, effort };
      if (mode === 'fixed') validateFixed(studio, agent);
      agents.push(agent);
      byKey.set(agent.key, agent);
      hires.push({ agent, topics: candidate.trainingTopics });
    }
    const limit = studio.staffing?.maxAgents;
    if (limit != null && agents.filter(agent => !agent.systemRole && agent.rosterStatus !== 'retired').length > limit) {
      throw new Error('План превышает штатный лимит студии. Измените состав плана или настройку лимита.');
    }
    const { epic, story } = planningService.selectPlanStructure(studio, plan);
    const debtEpic = linkedDebt.size || plan.tasks.some(({ kind }) => kind === 'debt') ? planningService.getDebtEpic(studioId) : undefined;
    if (plan.tasks.some(task => task.debtTaskId && task.backlogTaskId)) throw new Error('Укажите один источник карточки спринта.');
    const taskIds = new Map(plan.tasks.map(({ key, debtTaskId, backlogTaskId }) => [key, debtTaskId || backlogTaskId || randomUUID()]));
    const sprint = { id: randomUUID(), studioId, planId: id, title: plan.title, goal: plan.goal, status: 'active', taskIds: [...taskIds.values()],
      createdAt: now(), epicId: epic.id, storyId: story.id, ...(plan.phaseId ? { phaseId: plan.phaseId } : {}),
      ...(plan.debtSprint ? { debtSprint: true } : {}),
    };
    const roster = { ...studio, agents };
    const coach = coachFor(roster);
    for (const { agent, topics } of hires) {
      const assignments = plan.tasks.filter(({ agentKey, reviewerKey }) => [agentKey, reviewerKey].includes(agent.key));
      const objective = assignments.map(({ title, prompt, criteria }) => `${title}\n${prompt}\n${criteria}`).join('\n\n').slice(0, 8_000) || agent.description;
      const lesson = training.add(roster, agent, { topics, objective, sprintId: sprint.id, epicId: epic.id, storyId: story.id });
      sprint.taskIds.push(lesson.id);
    }
    insert('sprints', sprint);
    planningService.attachPlanStructure({ epic, story, sprint, phaseId: plan.phaseId, debtEpic });
    const createdAt = now();
    const recommendations = new Map();
    if (plan.kind === 'initial') {
      for (const { key, recommendation } of plan.agents) {
        if (recommendation && byKey.get(key).mode === 'dynamic') recommendations.set(key, recommendation);
      }
    }
    const tasks = plan.tasks.map(({ agentKey, reviewerKey, dependsOn, artifactPath, debtTaskId, backlogTaskId, ...task }) => {
      const taskRecommendation = recommendations.get(agentKey);
      const reviewRecommendation = recommendations.get(reviewerKey);
      const agentId = byKey.get(agentKey).id;
      const reviewerId = byKey.get(reviewerKey).id;
      const dependencies = [...dependsOn.map((key) => taskIds.get(key)), ...training.pendingIds(roster, [agentId, reviewerId, coach.id])];
      const carried = linkedDebt.get(debtTaskId) ?? linkedBacklog.get(backlogTaskId);
      const record = {
        ...carried,
        ...task, id: taskIds.get(task.key), studioId, agentId, reviewerId,
        epicId: task.kind === 'debt' ? debtEpic.id : epic.id,
        storyId: story.id, sprintId: sprint.id, dependencies: [...new Set([...dependencies, ...(carried?.dependencies ?? [])])],
        stage: dependencies.length ? 'backlog' : 'ready', status: 'queued', summary: carried?.summary ?? '', artifact: carried?.artifact ?? '', error: '',
        artifactTarget: artifactPath, workflowManaged: true, createdAt, updatedAt: createdAt,
        ...(taskRecommendation || reviewRecommendation ? { modelRecommendations: { task: taskRecommendation, review: reviewRecommendation } } : {}),
      };
      if (!carried) return insert('tasks', record);
      return update('tasks', { ...record, title: carried.title, prompt: carried.prompt, createdAt: carried.createdAt, lifecycle: undefined });
    });
    insert('meetings', {
      id: randomUUID(), studioId, sprintId: sprint.id, kind: 'planning', title: 'Планирование спринта',
      summary: plan.goal, taskIds: sprint.taskIds, createdAt,
    });
    const result = update('plans', { ...plan, status: 'approved', sprintId: sprint.id, decidedAt: createdAt });
    const entry = tasks.find(({ key }) => plan.tasks.find((candidate) => candidate.key === key).dependsOn.length === 0);
    const staffed = state(roster, roster.manualPaused ? 'paused' : 'active', 'План согласован');
    if (plan.files.length) {
      schedule(staffed, { purpose: 'publish', planId: id, fileIndex: 0, taskId: entry.id }, 'Подготовка стартовых файлов');
    } else {
      routeSprint(staffed, entry);
    }
    return result;
  }

  function updatePlanAgents({ planId, agents }) {
    const result = transaction(() => {
      const draft = read('plans', planId, 'План');
      if (draft.kind !== 'initial' || draft.status !== 'pending') throw new Error('Изменить команду можно только в первоначальном плане, который ожидает согласования.');
      const studio = read('studios', draft.studioId, 'Студия');
      const plan = completeInitialRoster(draft, studio.agents);
      if (!Array.isArray(agents) || agents.length > plan.agents.length) throw new Error('Некорректный список ключей команды.');
      const byKey = new Map(plan.agents.map((agent) => [agent.key, agent]));
      const agentEdits = new Map(Object.entries(plan.agentEdits ?? {}));
      const seen = new Set();
      for (const input of agents) {
        const patch = object(input, 'роль в плане');
        const current = byKey.get(patch.key);
        if (!current || seen.has(patch.key)) throw new Error('Неизвестный или повторяющийся ключ роли в плане.');
        seen.add(patch.key);
        const updated = { ...current, mode: current.mode ?? 'dynamic' };
        const editedFields = new Set(agentEdits.get(patch.key));
        if (patch.mode !== undefined && !['inherit', 'dynamic', 'fixed'].includes(patch.mode)) throw new Error('Неизвестная политика модели.');
        if (patch.runtime !== undefined && !['codex', 'claude', ''].includes(patch.runtime)) throw new Error('Неизвестное подключение агента.');
        for (const name of ['name', 'roleTitle', 'mode', 'runtime', 'model', 'effort']) {
          if (patch[name] === undefined) continue;
          updated[name] = name === 'roleTitle' ? roleTitle(patch[name]) : patch[name] === '' ? '' : field(patch[name], name === 'name' ? 'имя' : name, 120);
          editedFields.add(name);
        }
        if (updated.mode === 'fixed') {
          const settings = validateFixed(studio, updated);
          Object.assign(updated, settings);
          for (const name of Object.keys(settings)) editedFields.add(name);
        }
        byKey.set(patch.key, updated);
        agentEdits.set(patch.key, [...editedFields]);
      }
      return update('plans', { ...plan, agents: [...byKey.values()], agentEdits: Object.fromEntries(agentEdits) });
    });
    return changed(result);
  }

  function decidePlan({ studioId, planId, decision, feedback, comment }) {
    const plan = read('plans', planId, 'План');
    if (studioId && studioId !== plan.studioId) throw new Error('План принадлежит другой студии.');
    if (!['approve', 'revise'].includes(decision)) throw new Error('Неизвестное решение по плану.');
    const target = decision === 'approve' ? 'approved' : 'returned';
    if (plan.status === target) return plan;
    if (plan.status !== 'pending') throw new Error('Эта версия плана уже закрыта.');
    const studio = read('studios', plan.studioId, 'Студия');
    const note = decision === 'revise' ? field(feedback ?? comment, 'комментарий к плану') : '';
    const result = transaction(() => {
      for (const item of list('studio_inbox')) {
        if (item.planId === planId && item.status === 'open') {
          update('studio_inbox', { ...item, status: 'resolved', answer: note || 'Одобрено' });
        }
      }
      if (decision === 'approve') return approve(studio, plan);
      const returned = update('plans', { ...plan, status: 'returned', feedback: note, decidedAt: now() });
      planning(studio, plan.kind, note, plan.id);
      return returned;
    });
    queue(studio.id);
    return changed(result);
  }

  function setStudioRunning({ studioId, action, running }) {
    action ??= running === true ? 'resume' : running === false ? 'pause' : undefined;
    let studio = read('studios', studioId, 'Студия');
    if (!['pause', 'resume', 'stop'].includes(action)) throw new Error('Неизвестная команда студии.');
    if (studio.lifecycle === 'awaiting-approval' || studio.lifecycle === 'draft') return studio;
    if (action === 'resume') {
      if (!['paused', 'error'].includes(studio.lifecycle)) return studio;
      studio = transaction(() => {
        const job = studio.workflowJob;
        if (studio.lifecycle === 'error' && job) putJob(studio, job);
        const next = dispatcher.jobs(studioId).find(({ status }) => status === 'queued');
        if (job?.taskId && !hasTaskHold(studioId, job.taskId)) {
          for (const item of taskInbox(job.taskId)) {
            if (item.kind === 'error' && item.status === 'open') update('inbox', { ...item, status: 'resolved' });
          }
        }
        for (const item of list('studio_inbox')) {
          if (item.studioId === studioId && item.kind === 'error' && item.status === 'open') update('studio_inbox', { ...item, status: 'resolved' });
        }
        const continuing = next || hasDispatchWork(studioId) || hasHeldWorkflow(studioId) || dispatcher.jobs(studioId).some(({ status }) => status === 'reconcile');
        return state(studio, next?.purpose === 'plan' ? 'planning' : continuing ? 'active' : 'idle',
          continuing ? 'Студия продолжает работу' : 'Ожидает нового плана', job);
      });
      queue(studioId);
      return changed(studio);
    }
    const result = transaction(() => state({ ...studio, manualPaused: true }, 'paused', action === 'stop' ? 'Студия остановлена' : 'Студия на паузе', studio.workflowJob));
    clearRetry(studioId);
    if (action === 'stop') reconcileWork(studioId, { stop: true });
    return changed(result);
  }

  function hasTaskHold(studioId, taskId) {
    return dispatcher.jobs(studioId).some((job) => job.taskId === taskId && job.status === 'reconcile');
  }

  async function publishArtifact(studio, path, content, operationId) {
    if (!writeArtifact) throw new Error('Запись файлов проекта недоступна.');
    let saved;
    try {
      saved = await writeArtifact({ root: studio.root, path, content, operationId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure = new Error(`Файл «${path}»: ${message}`, { cause: error });
      if (error?.code === 'EEXIST' || message === 'File exists' || /^Файл «.+» уже существует\.$/u.test(message)) failure.effect = 'none';
      throw failure;
    }
    if (publishableArtifactPath(saved?.path) !== path) throw new Error('Не удалось подтвердить путь записанного файла.');
    return saved.path;
  }

  async function execute(studio, job, task, signal) {
    const { purpose } = job;
    if (purpose === 'git-check') return projectPipeline.evaluate({ studio, task, worktreeId: task.gitDelivery.worktreeId, attemptId: job.runAttemptId, signal });
    if (purpose === 'git-merge') return projectPipeline.merge({ studio, task, operationId: job.operationId, signal });
    if (purpose === 'publish') {
      const { files } = read('plans', job.planId, 'План');
      const file = files[job.fileIndex];
      return publishArtifact(studio, file.path, file.content, job.operationId);
    }
    if (purpose === 'artifact') return publishArtifact(studio, job.path, task.artifact, job.operationId);
    const lesson = task?.kind === 'train';
    const agentId = purpose === 'task' ? task.agentId : purpose === 'review' ? task.reviewerId : purpose === 'training-exercise' ? task.training.targetAgentId : undefined;
    const agent = studio.agents.find(({ id }) => id === agentId);
    const runTracked = (request) => {
      const input = { ...request, onEvent: job.onEvent };
      return trackedRun ? trackedRun({ studio, task, agent, attemptId: job.runAttemptId, request: input }) : run(input);
    };
    const selected = recommendedTaskControls(studio, agent, task?.modelRecommendations?.[purpose])
      ?? await taskControls(studio, agent, task, { run: runTracked, signal, purpose });
    signal.throwIfAborted();
    const { runtime, model, effort } = confirmTaskControls(studio, agent, selected);
    let allowed = [];
    let prompt;
    let sources;
    let debt;
    switch (purpose) {
      case 'plan': {
        const previous = job.previousPlanId ? read('plans', job.previousPlanId, 'План') : undefined;
        allowed = effectiveAllowed(read('studios', studio.id, 'Студия'));
        if (job.kind === 'sprint') {
          const initialPlanIds = new Set(list('plans').filter(({ kind }) => kind === 'initial').map(({ id }) => id));
          debt = debtPlanContext(studio, list('tasks'), list('sprints'), initialPlanIds);
        }
        const sameStudio = table => list(table).filter(record => record.studioId === studio.id);
        const planningContext = {
          epics: sameStudio('epics').slice(-20).map(({ id, title, priority, status }) => ({ id, title, priority, status })),
          stories: sameStudio('stories').slice(-30).map(({ id, epicId, title }) => ({ id, epicId, title })),
          phases: sameStudio('phases').filter(({ status }) => status === 'active').slice(-10).map(({ id, title, goal, criteria }) => ({ id, title, goal, criteria })),
          backlog: sameStudio('tasks').filter(task => !task.sprintId && task.kind !== 'train' && task.status === 'queued' &&
            (task.dependencies ?? []).every(id => read('tasks', id, 'Зависимость').stage === 'done'))
            .slice(0, 40).map(({ id, title, criteria, points, priority, kind }) => ({ id, title, criteria, points, priority, kind })),
        };
        prompt = planPrompt(studio, job, previous, allowed, debt, planningContext);
        break;
      }
      case 'task': {
        if (lesson) {
          sources = await training.source(studio, task, signal);
          prompt = training.selectionPrompt(studio, task, sources);
          break;
        }
        const decisions = taskInbox(task.id).filter(({ kind, answer }) => kind === 'question' && answer);
        const context = taskContext(studio, task, job.runAttemptId, decisions);
        prompt = runPrompt(studio, agent, task, decisions, {
          ...context, criteria: task.criteria, artifactPath: task.artifactTarget, previousArtifactPath: task.artifactPath,
          training: training.context(studio, agent, task),
          dependencies: task.dependencies.slice(0, 16).map((id) => {
            const { title, summary, artifactPath } = read('tasks', id, 'Задача');
            return { title, summary: summary?.slice(0, 1_000), artifactPath };
          }),
        });
        const attachmentIds = [...new Set(decisions.flatMap(({ attachmentIds }) => attachmentIds ?? []))].slice(-8);
        if (attachmentIds.length && describeAttachments) {
          prompt += '\n\nAttached owner materials (reference data):\n' + JSON.stringify(await describeAttachments(studio.id, attachmentIds));
        }
        break;
      }
      case 'review':
        prompt = lesson ? training.reviewPrompt(studio, task) : reviewPrompt(studio, {
          ...task, artifact: task.artifact?.slice(0, task.artifactPath ? 1_000 : 16_000),
        }, agent, training.context(studio, agent, task));
        break;
      case 'training-exercise':
        prompt = training.exercisePrompt(studio, task);
        break;
      case 'director':
        prompt = directorPrompt(studio, task, readyAfter(task).map(({ key, title, agentId, targetedTrainingId }) => {
          const performer = studio.agents.find(({ id }) => id === agentId);
          return { key, title, trainingAvailable: Boolean(performer && !performer.systemRole && performer.trainingStatus !== 'pending' && !targetedTrainingId) };
        }));
        break;
    }
    let scoped;
    let result;
    try {
      if (task?.deliveryMode === 'git' && purpose === 'task') {
        scoped = await projectPipeline.workScope({ studio, task });
        prompt = 'Implement the approved assignment in this managed worktree. You may edit project files only here. Return JSON with summary and an optional question.\n\n' + prompt.replace('Read the project as needed and leave its files unchanged.', 'Read the project as needed.');
      } else if (task?.deliveryMode === 'git' && purpose === 'review') {
        scoped = await projectPipeline.reviewScope({ studio, task, signal });
        const checkout = scoped.context ? `\n\nCandidate details (reference data):\n${JSON.stringify(scoped.context)}` : '';
        prompt = `Review the exact detached candidate version ${task.gitDelivery.revision.candidateOid}. Inspect files and check results.${checkout}\n\n${prompt}`;
      }
      result = await runTracked({ runtime, model: model || undefined, effort: effort || undefined, projectRoot: studio.root, purpose, prompt, signal, scope: scoped?.scope });
    } finally {
      if (scoped) await scoped.release();
    }
    const data = parseResponse(result);
    if (purpose === 'plan') {
      const plan = validatePlan(data, read('studios', studio.id, 'Студия').agents, job.kind === 'initial' ? allowed : []);
      if (plan.tasks.some(task => task.deliveryMode === 'git') && !studio.projectGit?.enabled) throw new Error('План запрашивает недоступную запись в Git.');
      validateDebtPlan(plan.tasks, debt);
      return { ...plan, ...(debt?.active ? { debtSprint: true } : {}) };
    }
    if (purpose === 'training-exercise') return field(data.summary, 'результат упражнения');
    if (purpose === 'task') {
      if (lesson) return training.selection(task, data, sources);
      const parsed = report(result);
      if (task.deliveryMode === 'git') {
        if (!parsed.question && !parsed.summary) throw new Error('Исполнитель не вернул отчёт о работе в Git.');
        return { ...parsed, worktreeId: scoped.worktreeId };
      }
      if (!parsed.question && !['summary', 'artifact'].some((key) => typeof data[key] === 'string' && data[key].trim())) throw new Error('Исполнитель не вернул отчёт.');
      const path = artifactPathFor(task, data.artifactPath);
      if (!parsed.question && path && typeof data.artifact !== 'string') throw new Error('Исполнитель не вернул содержимое файла.');
      if (!parsed.question && task.artifactTarget && !task.artifactPath && path !== task.artifactTarget) {
        throw new Error(`Исполнитель вернул другой путь. План ожидает «${task.artifactTarget}».`);
      }
      // Keep the provider's whitespace when the result is intended for a file.
      return { ...parsed, artifact: typeof data.artifact === 'string' ? data.artifact : '', path: !parsed.question && path != null ? publishableArtifactPath(path) : undefined };
    }
    if (purpose === 'review') {
      if (typeof data.pass !== 'boolean') throw new Error('Проверяющий не указал результат ревью.');
      return { pass: data.pass, summary: field(data.summary, 'итог ревью') };
    }
    return data;
  }

  function sprintTasks(task) {
    return list('tasks').filter(({ sprintId }) => sprintId === task.sprintId);
  }

  function readyAfter(task) {
    return sprintTasks(task).filter((candidate) => candidate.kind !== 'train' && candidate.id !== task.id && readyTask(candidate, task.id));
  }

  function checkpointInput(studio, task, attemptId, decisions) {
    const previous = checkpoints?.get(studio.id, task.id);
    const operations = dispatcher.jobs(studio.id).filter((job) => job.taskId === task.id && job.operationId && job.status === 'completed');
    return {
      studioId: studio.id, taskId: task.id, attemptId, task,
      decisions: decisions ?? taskInbox(task.id).filter(({ kind, answer }) => kind === 'question' && answer),
      materials: task.materials ?? previous?.context.materials, operations,
      activeAttempts: dispatcher.activeAttempts(studio.id),
    };
  }

  function taskContext(studio, task, attemptId, decisions) {
    return buildTaskContext(checkpointInput(studio, task, attemptId, decisions));
  }

  function toReview(studio, task, patch = {}, continuation = {}) {
    update('tasks', { ...task, ...patch, stage: 'review', status: 'completed', activeAgentId: undefined, error: '', updatedAt: now() });
    schedule(studio, { ...continuation, purpose: 'review', taskId: task.id }, 'Результат передан на ревью');
  }

  function toDirector(studio, task, patch = {}) {
    update('tasks', { ...task, ...patch, status: 'completed', stage: 'review', activeAgentId: undefined, updatedAt: now() });
    schedule(studio, { purpose: 'director', taskId: task.id }, 'Директор выбирает следующий шаг');
  }

  function finishTraining(studio, job, task, review) {
    const result = training.approve(studio, task);
    update('tasks', { ...task, training: result, review, stage: 'done', status: 'completed', activeAgentId: undefined, updatedAt: now() });
    for (const dependent of list('tasks')) {
      if (dependent.studioId === studio.id && dependent.stage === 'backlog' && dependent.dependencies?.includes(task.id)
        && dependent.dependencies.every((id) => read('tasks', id, 'Зависимость').stage === 'done')) {
        update('tasks', { ...dependent, stage: 'ready', updatedAt: now() });
      }
    }
    if (task.sprintId && wip(studio) > 1 && !job.resumeTaskId) return routeParallelSprint(studio, task);
    const next = job.resumeTaskId && read('tasks', job.resumeTaskId, 'Задача');
    if (next && next.id !== task.id) {
      if (job.resumeSprint) return routeSprint(studio, next);
      return routeTask(studio, next, job.returnLifecycle ? { returnLifecycle: job.returnLifecycle, returnActivity: job.returnActivity } : {});
    }
    const paused = studio.lifecycle === 'paused' || studio.manualPaused;
    const resultStudio = paused && job.returnLifecycle === 'draft' ? { ...studio, resumeDraft: true } : studio;
    return state(resultStudio, paused ? 'paused' : job.returnLifecycle ?? 'idle', paused ? 'Студия на паузе' : job.returnActivity ?? 'Обучение завершено');
  }

  function retrain(studio, next, decision) {
    if (!next?.agentId || next.targetedTrainingId || next.status !== 'queued') throw new Error('Директор выбрал недоступную для обучения задачу.');
    const objective = field(decision.objective, 'цель обучения');
    const topics = trainingTopics(decision.topics);
    let agent = studio.agents.find(({ id }) => id === next.agentId);
    if (!agent || agent.systemRole || agent.trainingStatus === 'pending') throw new Error('Директор выбрал недоступную для обучения роль.');
    if (decision.action === 'hire') {
      const hire = newDirectorHire(decision.agent);
      if (studio.agents.some(({ id, key }) => hire.key === (key ?? id))) throw new Error('Ключ новой роли уже используется.');
      if (roster && (studio.staffing?.maxAgents != null || studio.staffing?.maxBudget != null)) {
        const proposal = roster.proposeDirectorChangeWithinTransaction({
          studioId: studio.id, kind: 'hire', firstTaskId: next.id, firstResult: next.title, agent: hire, reason: objective, topics,
          estimatedBudget: decision.estimatedBudget, operationId: `hire:${next.id}`,
        });
        update('tasks', { ...next, rosterProposalId: proposal.id, updatedAt: now() });
        return addStudioInbox(studio.id, 'roster', { title: `Предложение роли · ${hire.name || hire.roleTitle}`, body: objective, proposalId: proposal.id });
      }
      agent = { id: randomUUID(), ...hire };
      studio.agents.push(agent);
    }
    const { sprintId, epicId, storyId } = next;
    const lesson = training.add(studio, agent, { topics, objective, sprintId, epicId, storyId, scoped: decision.action === 'train' });
    const updated = update('tasks', {
      ...next, agentId: agent.id, dependencies: [...next.dependencies, lesson.id], stage: 'backlog', targetedTrainingId: lesson.id,
      ...(decision.action === 'hire' ? { modelRecommendations: { ...next.modelRecommendations, task: undefined } } : {}), updatedAt: now(),
    });
    for (const queued of list('tasks')) {
      if (queued.id === next.id || queued.studioId !== studio.id || !['queued', 'scheduled'].includes(queued.status)) continue;
      const gated = training.withDependencies(studio, queued);
      if (gated !== queued) update('tasks', { ...gated, updatedAt: now() });
    }
    const sprint = read('sprints', sprintId, 'Спринт');
    update('sprints', { ...sprint, taskIds: [...sprint.taskIds, lesson.id] });
    routeTask(studio, updated);
  }

  function finishStep(studio, job, task, result, attemptId) {
    switch (job.purpose) {
      case 'plan': {
        const draft = { id: randomUUID(), studioId: studio.id, kind: job.kind, status: 'pending', ...result, createdAt: now() };
        const plan = insert('plans', completeInitialRoster(draft, studio.agents));
        if (job.kind === 'sprint' && !studio.approveSprints) {
          approve(studio, plan);
          return;
        }
        state(studio, 'awaiting-approval', 'План ждёт подтверждения');
        return addStudioInbox(studio.id, 'plan', { planId: plan.id, title: plan.title, body: plan.goal });
      }
      case 'publish': {
        const plan = read('plans', job.planId, 'План');
        const publishedFiles = [...(plan.publishedFiles ?? []), result];
        update('plans', { ...plan, publishedFiles });
        if (job.fileIndex + 1 < plan.files.length) {
          schedule(studio, { ...job, fileIndex: job.fileIndex + 1 }, 'Подготовка стартовых файлов');
        } else {
          routeSprint(studio, task);
        }
        return;
      }
      case 'task': {
        if (task.kind === 'train') {
          if (task.training.bootstrap) return toReview(studio, task, result, job);
          update('tasks', { ...task, ...result, status: 'queued', activeAgentId: undefined, updatedAt: now() });
          return schedule(studio, { ...job, purpose: 'training-exercise' }, 'Агент выполняет учебное задание');
        }
        const patch = { summary: result.summary, artifact: result.artifact,
          ...(task.deliveryMode === 'git' ? { gitDelivery: { worktreeId: result.worktreeId, status: 'work' } } : {}),
        };
        if (result.question) {
          update('tasks', { ...task, ...patch, status: 'waiting', stage: 'blocked', activeAgentId: undefined, updatedAt: now() });
          state(studio, studio.lifecycle === 'paused' ? 'paused' : 'active', 'Задача ждёт решения');
          return addInbox(task, 'question', result.question);
        }
        if (task.deliveryMode === 'git') {
          update('tasks', { ...task, ...patch, status: 'queued', stage: 'qa', activeAgentId: undefined, updatedAt: now() });
          return schedule(studio, { purpose: 'git-check', taskId: task.id }, 'Проверка изменений проекта');
        }
        if (result.path && (result.path !== task.artifactPath || result.artifact !== task.artifact)) {
          update('tasks', { ...task, ...patch, status: 'completed', stage: 'in_progress', updatedAt: now() });
          schedule(studio, {
            purpose: 'artifact', taskId: task.id, path: result.path, operationId: `${task.id}:artifact:${attemptId}`,
          }, 'Запись рабочего файла');
        } else {
          toReview(studio, task, patch);
        }
        return;
      }
      case 'git-check': {
        const { evidence, ...gitDelivery } = result;
        for (const entry of evidence) insert('evidence', entry);
        if (result.status === 'checks-blocked') {
          const body = 'Обязательная проверка проекта не пройдена. Откройте результаты проверки.';
          update('tasks', { ...task, gitDelivery, status: 'failed', stage: 'blocked', error: body, activeAgentId: undefined });
          if (wip(studio) === 1) state(studio, 'error', body, { purpose: 'task', taskId: task.id });
          return addInbox(task, 'error', { title: `Проверки · ${task.title}`, body });
        }
        return toReview(studio, task, { gitDelivery });
      }
      case 'git-merge': {
        const gitDelivery = { ...task.gitDelivery, ...result, status: 'merged' };
        if (!task.sprintId) {
          update('tasks', { ...task, gitDelivery, status: 'completed', stage: 'done', updatedAt: now() });
          return state(studio, 'idle', 'Изменения слиты');
        }
        return toDirector(studio, task, { gitDelivery });
      }
      case 'artifact':
        return toReview(studio, task, {
          artifactPath: result, previousArtifactPath: task.artifactPath,
          artifactVersions: [...(task.artifactVersions ?? []), result],
        });
      case 'training-exercise':
        return toReview(studio, task, { training: { ...task.training, exercise: result } }, job);
      case 'review': {
        if (!result.pass) {
          const failedReviews = (task.failedReviews ?? 0) + 1;
          const updated = update('tasks', { ...task, failedReviews, revision: (task.revision ?? 0) + 1, review: result.summary });
          if (failedReviews >= 3) {
            update('tasks', { ...updated, stage: 'blocked', error: result.summary, status: 'failed', updatedAt: now() });
            if (wip(studio) === 1) state(studio, 'error', 'Задача трижды возвращена на доработку', { ...job, purpose: 'task', taskId: task.id });
            return addInbox(task, 'error', { title: `Задача заблокирована · ${task.title}`, body: result.summary });
          }
          nextTask(studio, updated, job);
          return;
        }
        if (task.kind === 'train') return finishTraining(studio, job, task, result.summary);
        if (task.deliveryMode === 'git') {
          const { revision, checks } = task.gitDelivery;
          const receipt = { id: randomUUID(), taskId: task.id, revision, reviewerId: task.reviewerId, checkIds: checks.map(({ checkId }) => checkId), result: 'PASS' };
          task = update('tasks', { ...task, gitDelivery: { ...task.gitDelivery, receipt, status: 'approved-review' } });
        }
        if (task.requiresAcceptance) {
          update('tasks', { ...task, review: result.summary, status: 'waiting', stage: 'qa', updatedAt: now() });
          state(studio, studio.lifecycle === 'paused' ? 'paused' : 'active', 'Результат ждёт приёмки');
          return addInbox(task, 'acceptance', { title: `Принять результат · ${task.title}`, body: result.summary });
        }
        if (task.deliveryMode === 'git') return readyToMerge(studio, { ...task, review: result.summary });
        return toDirector(studio, task, { review: result.summary });
      }
      case 'director': {
        const remaining = sprintTasks(task).filter(({ id, stage }) => id !== task.id && stage !== 'done');
        const ready = readyAfter(task);
        const summary = result.summary === undefined ? '' : field(result.summary, 'решение директора');
        update('tasks', { ...task, stage: 'done', status: 'completed', activeAgentId: undefined, directorDecision: summary, updatedAt: now() });
        for (const candidate of ready) {
          if (candidate.stage === 'backlog') update('tasks', { ...candidate, stage: 'ready', updatedAt: now() });
        }
        if (wip(studio) > 1 && remaining.length) {
          if (['train', 'hire'].includes(result.action) && result.taskKey) {
            const candidate = ready.find(({ key }) => key === result.taskKey);
            const notice = candidate && !hasTaskWork(studio, candidate.id) ? retrain(studio, candidate, result) : undefined;
            routeParallelSprint(studio, task);
            return notice;
          }
          return routeParallelSprint(studio, task);
        }
        if (['next', 'train', 'hire'].includes(result.action)) {
          const next = result.taskKey === undefined ? ready[0] : ready.find(({ key }) => key === result.taskKey);
          if (!next) throw new Error('Директор выбрал недоступную задачу.');
          if (result.action !== 'next') {
            if (!result.taskKey) throw new Error('Директор не указал ключ задачи для обучения.');
            return retrain(studio, next, result);
          }
          routeTask(studio, next);
          return;
        }
        if (remaining.length || !['nextSprint', 'finish'].includes(result.action)) throw new Error('Директор не выбрал корректный следующий шаг.');
        const sprint = read('sprints', task.sprintId, 'Спринт');
        const closure = summary || task.review || task.summary;
        planningService.finalizeSprint(sprint, { summary: closure });
        if (result.action === 'nextSprint') {
          if (studio.lifecycle === 'paused') {
            return schedule(studio, { purpose: 'plan', kind: 'sprint', previousPlanId: sprint.planId }, 'Директор готовит план');
          }
          planning(studio, 'sprint', undefined, sprint.planId);
        } else {
          state(studio, studio.lifecycle === 'paused' ? 'paused' : 'idle', 'Спринт завершён');
        }
      }
    }
  }

  function readyToMerge(studio, task) {
    const operationId = `${task.id}:merge:${task.gitDelivery.receipt.id}`;
    update('tasks', { ...task, status: 'queued', stage: 'qa', activeAgentId: undefined, updatedAt: now() });
    return schedule(studio, { purpose: 'git-merge', taskId: task.id, operationId }, 'Слияние принятой версии');
  }

  function resumeInbox(item, task, answer, decision) {
    const studio = read('studios', task.studioId, 'Студия');
    const accepted = item.kind === 'acceptance' && decision === 'approve';
    if (item.kind === 'acceptance' && !['approve', 'revise'].includes(decision)) throw new Error('Укажите решение о приёмке.');
    const note = accepted ? 'Принято' : field(answer, 'ответ');
    const resolved = transaction(() => {
      const persisted = read('inbox', item.id, 'Сообщение');
      if (persisted.status !== 'open') return persisted;
      for (const job of dispatcher.jobs(studio.id)) {
        if (job.taskId === task.id && job.status === 'waiting') dispatcher.releaseWaiting(job.id);
      }
      if (accepted) {
        if (task.deliveryMode === 'git') readyToMerge(studio, task);
        else toDirector(studio, task);
      } else {
        nextTask(studio, item.kind === 'acceptance' ? { ...task, revision: (task.revision ?? 0) + 1, failedReviews: 0, review: note } : task);
      }
      return update('inbox', { ...item, status: 'resolved', answer: note });
    });
    queue(task.studioId);
    return changed(resolved);
  }

  function jobPayload({ id, studioId, sprintId, worktree, writes, status, attemptId, createdAt, updatedAt, reason, error, action, failureCount, availableAt, ...job }) {
    return job;
  }

  function currentTask(job) {
    return job.taskId ? read('tasks', job.taskId, 'Задача') : undefined;
  }

  function claimable(job) {
    if (job.purpose !== 'task') return true;
    const task = currentTask(job);
    return (task.dependencies ?? []).every((id) => read('tasks', id, 'Зависимость').stage === 'done')
      && !prerequisites?.pendingPrerequisites('task', task.id).length && !pendingRosterChange(task);
  }

  function activate(job) {
    const task = currentTask(job);
    if (!task || job.purpose === 'publish') return task;
    const stage = ['task', 'training-exercise', 'artifact', 'git-check'].includes(job.purpose) ? 'in_progress' : job.purpose === 'git-merge' ? 'qa' : 'review';
    const activeAgentId = { task: task.agentId, review: task.reviewerId, 'training-exercise': task.training?.targetAgentId }[job.purpose];
    return update('tasks', { ...task, stage, status: 'running', activeAgentId, error: '', updatedAt: now() });
  }

  function recordHold(studioId, { job, attempt }) {
    const task = currentTask(job);
    const title = task ? `Сверка · ${task.title}` : 'Сверка работы студии';
    const body = 'Проверьте завершение прежнего процесса и изменения рабочего дерева. После сверки выберите повтор шага или отмену.';
    if (!task) return addStudioInbox(studioId, 'reconcile', { title, body, attemptId: attempt.id });
    update('tasks', { ...task, status: 'interrupted', stage: 'blocked', activeAgentId: undefined, error: body, updatedAt: now() });
    return update('inbox', { ...addInbox(task, 'reconcile', { title, body }), attemptId: attempt.id });
  }

  function restoreLegacyJob(studio) {
    if (!studio.workflowJob || dispatcher.jobs(studio.id).length) return;
    transaction(() => {
      const job = putJob(studio, studio.workflowJob);
      const running = list('attempts').findLast((attempt) => !attempt.jobId && attempt.studioId === studio.id && attempt.status === 'running'
        && attempt.purpose === job.purpose && (attempt.taskId ?? null) === (job.taskId ?? null));
      if (!running) return;
      update('dispatch_jobs', { ...job, status: 'running', attemptId: running.id });
      update('attempts', { ...running, jobId: job.id, worktree: job.worktree, operationId: job.operationId, sprintId: job.sprintId });
    });
  }

  function reconcileWork(studioId, { restart = false, stop = false, taskId } = {}) {
    if (stop && !taskId) clearRetry(studioId);
    const studio = read('studios', studioId, 'Студия');
    if (restart) restoreLegacyJob(studio);
    const notices = [];
    const held = dispatcher.reconcileStudio({ studioId, taskId, restart, stop, isActive: ({ id }) => controllers.has(id) }, (claim) => {
      notices.push(recordHold(studioId, claim));
    });
    for (const { attempt } of held) controllers.get(attempt.id)?.controller.abort();
    if (!restart && !stop) dispatcher.markSilent(studioId, ({ job, attempt }) => {
      const task = currentTask(job);
      const title = task ? `Нет активности · ${task.title}` : 'Нет активности подключения';
      const body = 'Подключение давно не сообщало о ходе работы.';
      const item = task ? addInbox(task, 'error', { title, body }) : addStudioInbox(studioId, 'error', { title, body, attemptId: attempt.id });
      notices.push(item);
    });
    if (notices.length) changed();
    for (const item of notices) notifyInbox(item);
    return held;
  }

  function resolveReconciliation({ attemptId, decision, reason }) {
    let item;
    const result = dispatcher.resolveReconciliation({ attemptId, decision, reason }, ({ job, attempt }) => {
      const studio = read('studios', job.studioId, 'Студия');
      const task = currentTask(job);
      if (decision === 'complete') {
        if (!['artifact', 'publish'].includes(job.purpose)) throw new Error('Для проверки результата этого шага запустите его повторно.');
        const path = job.purpose === 'publish' ? read('plans', job.planId, 'План').files[job.fileIndex].path : job.path;
        item = finishStep(studio, jobPayload(job), task, path, attempt.id);
      } else if (decision === 'retry' && task) {
        update('tasks', { ...task, status: 'queued', stage: 'ready', error: '', updatedAt: now() });
      }
      for (const notice of task ? taskInbox(task.id) : list('studio_inbox')) {
        if (notice.attemptId === attemptId && notice.status === 'open' && notice.kind === 'reconcile') {
          update(task ? 'inbox' : 'studio_inbox', { ...notice, status: 'resolved', answer: reason.trim() });
        }
      }
      if (decision === 'retry' && !studio.manualPaused) {
        state(studio, job.purpose === 'plan' ? 'planning' : 'active', 'Работа продолжится после сверки', jobPayload(job));
      }
    });
    notifyInbox(item);
    queue(result.job.studioId);
    return changed(result);
  }

  async function drain(studioId) {
    const studio = availableStudio(studioId);
    if (!studio || !['active', 'planning'].includes(studio.lifecycle)) return;
    const limit = wip(studio) - nonWorkflowActiveCount(studioId);
    if (limit < 1) return;
    if (!hasDispatchWork(studioId)) transaction(() => activateQueuedSprint(studio));
    let task;
    const claim = dispatcher.claimAttempt({ studioId, limit, canClaim: claimable }, ({ job }) => { task = activate(job); });
    if (!claim) {
      scheduleRetry(studioId);
      return;
    }
    const job = jobPayload(claim.job);
    const { id: attemptId } = claim.attempt;
    const controller = new AbortController();
    const finished = Promise.withResolvers();
    controllers.set(attemptId, { id: job.taskId, studioId, job, attemptId, controller, completion: finished.promise });
    const isCurrent = () => !isClosed() && !controller.signal.aborted;
    const onEvent = (event) => {
      if (isCurrent() && !['failed', 'interrupted'].includes(event.type)) dispatcher.renewAttempt({ attemptId });
    };
    const heartbeat = ['git-check', 'git-merge', 'publish', 'artifact'].includes(job.purpose) ? setInterval(() => {
      if (isCurrent()) dispatcher.renewAttempt({ attemptId });
    }, 30_000) : null;
    heartbeat?.unref();
    try {
      changed();
      if (wip(studio) > 1) queue(studioId);
      if (!isCurrent()) return;
      const result = await execute(studio, { ...job, runAttemptId: attemptId, onEvent }, task, controller.signal);
      if (!isCurrent()) return;
      const ownerQuestion = job.purpose === 'task' && Boolean(result.question);
      const acceptance = job.purpose === 'review' && result.pass && task.kind !== 'train' && task.requiresAcceptance;
      const status = ownerQuestion || acceptance ? 'waiting' : 'completed';
      let item;
      const finishedAttempt = dispatcher.finishAttempt({ attemptId, status, reason: ownerQuestion ? 'owner-question' : acceptance ? 'owner-acceptance' : undefined }, () => {
        const latest = read('studios', studioId, 'Студия');
        item = finishStep(latest, job, task, result, attemptId);
        if (task) checkpoints?.save(checkpointInput(latest, currentTask(job), attemptId));
      });
      if (!finishedAttempt) return;
      changed();
      notifyInbox(item);
      if ((job.purpose === 'git-merge' && !task.sprintId) || (job.purpose === 'director' && task.deliveryMode === 'git')) {
        void Promise.resolve().then(() => afterGitMerge?.(studioId, task)).catch(() => {});
      }
      if (job.purpose === 'director') planningService.maybeRequestGrooming({ studioId });
    } catch (error) {
      if (!isCurrent()) return;
      let item;
      const readyToRecheck = task?.deliveryMode === 'git' && ['git-merge', 'review'].includes(job.purpose)
        && ['TARGET_CHANGED', 'STALE_REVISION'].includes(error?.code);
      const failure = readyToRecheck ? Object.assign(new Error(error.message, { cause: error }), { effect: 'none' }) : error;
      const failed = dispatcher.failAttempt({ attemptId, error: failure }, (claim) => {
        const latest = read('studios', studioId, 'Студия');
        const body = claim.attempt.error;
        if (claim.job.status === 'queued') {
          if (task && job.purpose !== 'publish') update('tasks', { ...task, status: 'queued', activeAgentId: undefined, updatedAt: now() });
          return;
        }
        if (claim.job.status === 'reconcile') {
          item = recordHold(studioId, claim);
          return;
        }
        const continuation = readyToRecheck ? { purpose: 'git-check', taskId: task.id } : job;
        if (readyToRecheck) {
          task = { ...task, gitDelivery: { ...task.gitDelivery, receipt: undefined, status: 'recheck' } };
          for (const acceptance of taskInbox(task.id)) {
            if (acceptance.kind === 'acceptance' && acceptance.status === 'open') {
              update('inbox', { ...acceptance, status: 'resolved', answer: 'Кандидат изменился. Требуется новая проверка.' });
            }
          }
        }
        if (wip(latest) === 1 || !task) state(latest, 'error', body, continuation);
        if (!task) item = addStudioInbox(studioId, 'error', { title: 'Ошибка · планирование', body });
        else {
          update('tasks', { ...task, stage: 'blocked', status: 'failed', activeAgentId: undefined, error: body, updatedAt: now() });
          if (readyToRecheck && wip(latest) > 1) schedule(latest, continuation, 'Проверка новой версии проекта');
          item = addInbox(task, 'error', { title: `Ошибка · ${task.title}`, body });
        }
      });
      if (failed) changed();
      notifyInbox(item);
    } finally {
      clearInterval(heartbeat);
      controllers.delete(attemptId);
      if (!isClosed()) dispatcher.releaseProcess({ attemptId });
      finished.resolve();
      if (!isClosed()) onAvailable(studioId);
    }
  }

  function startGitTask(studio, task) {
    if (studio.workflowJob || active.has(studio.id) || studio.manualPaused) throw new Error('Дождитесь свободного запуска студии.');
    const result = transaction(() => routeTask(studio, task));
    queue(studio.id);
    return changed(result);
  }

  function retryTask(studio, task) {
    if (task.status !== 'failed' || hasTaskWork(studio, task.id)) throw new Error('Эта задача не ждёт повторного запуска.');
    if (studio.manualPaused || studio.lifecycle === 'paused') throw new Error('Сначала снимите студию с паузы.');
    const previous = dispatcher.jobs(studio.id).findLast(job => job.taskId === task.id);
    const result = transaction(() => {
      for (const item of taskInbox(task.id)) {
        if (item.kind === 'error' && item.status === 'open') update('inbox', { ...item, status: 'resolved' });
      }
      const current = update('tasks', { ...task, status: 'queued', error: '', failedReviews: 0, updatedAt: now() });
      if (previous?.status === 'failed') return schedule(studio, jobPayload(previous), 'Повтор рабочего шага');
      return routeTask(studio, current);
    });
    queue(studio.id);
    return changed(result);
  }

  function cancelTask({ studioId, taskId }) {
    const task = read('tasks', taskId, 'Задача');
    if (task.studioId !== studioId) throw new Error('Задача принадлежит другой студии.');
    if (!hasTaskWork({ id: studioId }, taskId)) return;
    const held = reconcileWork(studioId, { stop: true, taskId });
    const result = transaction(() => {
      for (const job of dispatcher.jobs(studioId)) {
        if (job.taskId === taskId && ['queued', 'waiting'].includes(job.status)) {
          update('dispatch_jobs', { ...job, status: 'interrupted', reason: 'stopped', updatedAt: now() });
        }
      }
      for (const item of taskInbox(taskId)) {
        if (['question', 'acceptance'].includes(item.kind) && item.status === 'open') update('inbox', { ...item, status: 'resolved' });
      }
      if (held.length || hasTaskHold(studioId, taskId)) return read('tasks', taskId, 'Задача');
      return update('tasks', { ...task, status: 'interrupted', stage: 'blocked', activeAgentId: undefined, updatedAt: now() });
    });
    queue(studioId);
    return changed(result);
  }

  return {
    initializeStudio, startNextSprint, decidePlan, updatePlanAgents, setStudioRunning, resumeInbox, startStandaloneTraining, startGitTask,
    queue, hasDispatchWork, activeWork, reconcileWork, resolveReconciliation, cancelTask, retryTask,
  };
}
