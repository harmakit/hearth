import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { completeInitialRoster, directorPrompt, field, newDirectorHire, object, parseResponse, planPrompt, publishableArtifactPath, reviewPrompt, roleTitle, trainingTopics, validatePlan } from './protocol.mjs';
import { coachFor } from './training.mjs';
import { debtPlanContext, eligibleDebt, validateDebtPlan } from './debt.mjs';

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
}) {
  function state(studio, lifecycle, activity, job = null) {
    return update('studios', { ...studio, lifecycle, activity, workflowJob: job });
  }

  function queue(studioId) {
    queueMicrotask(() => { void drain(studioId); });
  }

  function planning(studio, kind, feedback, previousPlanId) {
    const job = { purpose: 'plan', kind, feedback, previousPlanId };
    if (studio.manualPaused) return state(studio, 'paused', 'Студия на паузе', job);
    return state(studio, 'planning', 'Директор готовит план', job);
  }

  function initializeStudio({ studioId }) {
    const studio = read('studios', studioId, 'Студия');
    if (studio.lifecycle === 'planning' || studio.lifecycle === 'awaiting-approval') return studio;
    if (studio.workflowJob || studio.lifecycle !== 'draft') throw new Error('Инициализация этой студии уже началась.');
    const result = planning(studio, 'initial');
    queue(studioId);
    return changed(result);
  }

  function schedule(studio, job, activity) {
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
    return nextTask(studio, task, continuation);
  }

  function routeSprint(studio, task) {
    const outstanding = sprintTasks(task).find((candidate) => candidate.kind === 'train' && candidate.stage !== 'done');
    return outstanding ? routeTask(studio, outstanding, { resumeTaskId: task.id, resumeSprint: true }) : routeTask(studio, task);
  }

  function startStandaloneTraining(studio, task) {
    if (hasHeldWorkflow(studio.id)) throw new Error('Сначала ответьте на вопрос Директора или завершите приёмку текущей задачи.');
    if (studio.workflowJob || !['draft', 'idle', 'active'].includes(studio.lifecycle)) throw new Error('Студия уже выполняет другой этап.');
    const result = transaction(() => routeTask(studio, task, {
      returnLifecycle: studio.lifecycle, returnActivity: studio.activity, resumeTaskId: task.id,
    }));
    queue(studio.id);
    return changed(result);
  }

  function approve(studio, draft) {
    const plan = completeInitialRoster(draft, studio.agents);
    const { id, studioId } = plan;
    const linkedDebt = new Map();
    for (const { debtTaskId } of plan.tasks) {
      if (!debtTaskId) continue;
      const task = read('tasks', debtTaskId, 'Задача техдолга');
      if (!eligibleDebt(task, studioId) || linkedDebt.has(debtTaskId)) {
        throw new Error('Задача техдолга больше недоступна. Верните план на доработку.');
      }
      linkedDebt.set(debtTaskId, task);
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
    const epic = insert('epics', { id: randomUUID(), studioId, ...plan.epic });
    const story = insert('stories', { id: randomUUID(), studioId, epicId: epic.id, ...plan.story });
    const taskIds = new Map(plan.tasks.map(({ key, debtTaskId }) => [key, debtTaskId || randomUUID()]));
    const sprint = { id: randomUUID(), studioId, planId: id, title: plan.title, goal: plan.goal, status: 'active', taskIds: [...taskIds.values()],
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
    const createdAt = now();
    const recommendations = new Map();
    if (plan.kind === 'initial') {
      for (const { key, recommendation } of plan.agents) {
        if (recommendation && byKey.get(key).mode === 'dynamic') recommendations.set(key, recommendation);
      }
    }
    const tasks = plan.tasks.map(({ agentKey, reviewerKey, dependsOn, artifactPath, debtTaskId, ...task }) => {
      const taskRecommendation = recommendations.get(agentKey);
      const reviewRecommendation = recommendations.get(reviewerKey);
      const agentId = byKey.get(agentKey).id;
      const reviewerId = byKey.get(reviewerKey).id;
      const dependencies = [...dependsOn.map((key) => taskIds.get(key)), ...training.pendingIds(roster, [agentId, reviewerId, coach.id])];
      const existingDebt = linkedDebt.get(debtTaskId);
      const record = {
        ...task, id: taskIds.get(task.key), studioId, agentId, reviewerId,
        epicId: epic.id, storyId: story.id, sprintId: sprint.id, dependencies,
        stage: dependencies.length ? 'backlog' : 'ready', status: 'queued', summary: '', artifact: '', error: '',
        artifactTarget: artifactPath, workflowManaged: true, createdAt, updatedAt: createdAt,
        ...(taskRecommendation || reviewRecommendation ? { modelRecommendations: { task: taskRecommendation, review: reviewRecommendation } } : {}),
      };
      if (!existingDebt) return insert('tasks', record);
      return update('tasks', { ...record, title: existingDebt.title, prompt: existingDebt.prompt, createdAt: existingDebt.createdAt });
    });
    insert('meetings', {
      id: randomUUID(), studioId, sprintId: sprint.id, kind: 'planning', title: 'Планирование спринта',
      summary: plan.goal, taskIds: sprint.taskIds, createdAt,
    });
    const result = update('plans', { ...plan, status: 'approved', sprintId: sprint.id, decidedAt: createdAt });
    const entry = tasks.find(({ key }) => plan.tasks.find((candidate) => candidate.key === key).dependsOn.length === 0);
    if (plan.files.length) {
      schedule(roster, { purpose: 'publish', planId: id, fileIndex: 0, taskId: entry.id }, 'Подготовка стартовых файлов');
    } else {
      routeSprint(roster, entry);
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
      const job = studio.workflowJob;
      if (job?.taskId) {
        const task = read('tasks', job.taskId, 'Задача');
        for (const item of taskInbox(task.id)) {
          if (item.kind === 'error' && item.status === 'open') update('inbox', { ...item, status: 'resolved' });
        }
      }
      for (const item of list('studio_inbox')) {
        if (item.studioId === studioId && item.kind === 'error' && item.status === 'open') {
          update('studio_inbox', { ...item, status: 'resolved' });
        }
      }
      studio = state(studio, job?.purpose === 'plan' ? 'planning' : job ? 'active' : 'idle', job ? 'Студия продолжает работу' : 'Ожидает нового плана', job);
      queue(studioId);
      return changed(studio);
    }
    const attempt = active.get(studioId);
    const result = transaction(() => {
      if (action === 'stop' && attempt?.job) {
        if (attempt.job?.taskId) {
          const task = read('tasks', attempt.job.taskId, 'Задача');
          update('tasks', { ...task, status: 'interrupted', stage: 'blocked', activeAgentId: undefined, updatedAt: now() });
        }
        if (attempt.attemptId) interruptAttempt(attempt.attemptId);
      }
      return state({ ...studio, manualPaused: true }, 'paused', action === 'stop' ? 'Студия остановлена' : 'Студия на паузе', studio.workflowJob);
    });
    if (action === 'stop' && attempt?.job) attempt.controller.abort();
    return changed(result);
  }

  function interruptAttempt(attemptId) {
    const attempt = read('attempts', attemptId, 'Запуск');
    update('attempts', { ...attempt, status: 'interrupted', finishedAt: now() });
  }

  async function publishArtifact(studio, path, content, operationId) {
    if (!writeArtifact) throw new Error('Запись файлов проекта недоступна.');
    let saved;
    try {
      saved = await writeArtifact({ root: studio.root, path, content, operationId });
    } catch (error) {
      throw new Error(`Файл «${path}»: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (publishableArtifactPath(saved?.path) !== path) throw new Error('Не удалось подтвердить путь записанного файла.');
    return saved.path;
  }

  async function execute(studio, job, task, signal) {
    const { purpose } = job;
    if (purpose === 'publish') {
      const { files } = read('plans', job.planId, 'План');
      const file = files[job.fileIndex];
      return publishArtifact(studio, file.path, file.content, `${job.planId}:file:${job.fileIndex}`);
    }
    if (purpose === 'artifact') return publishArtifact(studio, job.path, task.artifact, job.operationId);
    const lesson = task?.kind === 'train';
    const agentId = purpose === 'task' ? task.agentId : purpose === 'review' ? task.reviewerId : purpose === 'training-exercise' ? task.training.targetAgentId : undefined;
    const agent = studio.agents.find(({ id }) => id === agentId);
    const selected = recommendedTaskControls(studio, agent, task?.modelRecommendations?.[purpose])
      ?? await taskControls(studio, agent, task, { run, signal, purpose });
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
        prompt = planPrompt(studio, job, previous, allowed, debt);
        break;
      }
      case 'task': {
        if (lesson) {
          sources = await training.source(studio, task, signal);
          prompt = training.selectionPrompt(studio, task, sources);
          break;
        }
        const decisions = taskInbox(task.id).filter(({ kind, answer }) => kind === 'question' && answer);
        prompt = runPrompt(studio, agent, task, decisions, {
          criteria: task.criteria, artifactPath: task.artifactTarget, previousArtifactPath: task.artifactPath, review: task.review,
          training: training.context(studio, agent),
          dependencies: task.dependencies.map((id) => {
            const { title, summary, artifactPath } = read('tasks', id, 'Задача');
            return { title, summary, artifactPath };
          }),
        });
        break;
      }
      case 'review':
        prompt = lesson ? training.reviewPrompt(studio, task) : reviewPrompt(studio, task, agent, training.context(studio, agent));
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
    const result = await run({ runtime, model: model || undefined, effort: effort || undefined, projectRoot: studio.root, purpose, prompt, signal });
    const data = parseResponse(result);
    if (purpose === 'plan') {
      const plan = validatePlan(data, read('studios', studio.id, 'Студия').agents, job.kind === 'initial' ? allowed : []);
      validateDebtPlan(plan.tasks, debt);
      return { ...plan, ...(debt?.active ? { debtSprint: true } : {}) };
    }
    if (purpose === 'training-exercise') return field(data.summary, 'результат упражнения');
    if (purpose === 'task') {
      if (lesson) return training.selection(task, data, sources);
      const parsed = report(result);
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
    return sprintTasks(task).filter((candidate) => candidate.kind !== 'train' && candidate.id !== task.id && (
      ['ready', 'backlog'].includes(candidate.stage) && candidate.dependencies.every(
        (id) => id === task.id || read('tasks', id, 'Задача').stage === 'done',
      )
    ));
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
      agent = { id: randomUUID(), ...hire };
      studio.agents.push(agent);
    }
    const { sprintId, epicId, storyId } = next;
    const lesson = training.add(studio, agent, { topics, objective, sprintId, epicId, storyId });
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
        const patch = { summary: result.summary, artifact: result.artifact };
        if (result.question) {
          update('tasks', { ...task, ...patch, status: 'waiting', stage: 'blocked', activeAgentId: undefined, updatedAt: now() });
          state(studio, studio.lifecycle === 'paused' ? 'paused' : 'active', 'Задача ждёт решения');
          return addInbox(task, 'question', result.question);
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
            state(studio, 'error', 'Задача трижды возвращена на доработку', { ...job, purpose: 'task', taskId: task.id });
            return addInbox(task, 'error', { title: `Задача заблокирована · ${task.title}`, body: result.summary });
          }
          nextTask(studio, updated, job);
          return;
        }
        if (task.kind === 'train') return finishTraining(studio, job, task, result.summary);
        if (task.requiresAcceptance) {
          update('tasks', { ...task, review: result.summary, status: 'waiting', stage: 'qa', updatedAt: now() });
          state(studio, studio.lifecycle === 'paused' ? 'paused' : 'active', 'Результат ждёт приёмки');
          return addInbox(task, 'acceptance', { title: `Принять результат · ${task.title}`, body: result.summary });
        }
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
        update('sprints', { ...sprint, status: 'completed', summary: closure });
        insert('meetings', {
          id: randomUUID(), studioId: studio.id, sprintId: sprint.id, kind: 'retrospective',
          title: 'Ретроспектива спринта', summary: closure, taskIds: sprint.taskIds, createdAt: now(),
        });
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

  function resumeInbox(item, task, answer, decision) {
    const studio = read('studios', task.studioId, 'Студия');
    const accepted = item.kind === 'acceptance' && decision === 'approve';
    if (item.kind === 'acceptance' && !['approve', 'revise'].includes(decision)) throw new Error('Укажите решение о приёмке.');
    const note = accepted ? 'Принято' : field(answer, 'ответ');
    const resolved = transaction(() => {
      if (accepted) {
        toDirector(studio, task);
      } else {
        nextTask(studio, item.kind === 'acceptance' ? { ...task, revision: (task.revision ?? 0) + 1, failedReviews: 0, review: note } : task);
      }
      return update('inbox', { ...item, status: 'resolved', answer: note });
    });
    queue(task.studioId);
    return changed(resolved);
  }

  async function drain(studioId) {
    const studio = availableStudio(studioId);
    if (!studio) return;
    const job = studio.workflowJob;
    if (!job || !['active', 'planning'].includes(studio.lifecycle)) return;
    let task = job.taskId ? read('tasks', job.taskId, 'Задача') : undefined;
    const controller = new AbortController();
    const finished = Promise.withResolvers();
    const attemptId = randomUUID();
    try {
      transaction(() => {
        insert('attempts', { id: attemptId, studioId, taskId: job.taskId ?? null, purpose: job.purpose, status: 'running', startedAt: now() });
        if (['task', 'review', 'director', 'training-exercise'].includes(job.purpose)) {
          const stage = ['task', 'training-exercise'].includes(job.purpose) ? 'in_progress' : 'review';
          const activeAgentId = job.purpose === 'task' ? task.agentId : job.purpose === 'training-exercise' ? task.training.targetAgentId : job.purpose === 'review' ? task.reviewerId : null;
          task = update('tasks', { ...task, stage, status: 'running', activeAgentId, error: '', updatedAt: now() });
        }
      });
      active.set(studioId, { id: job.taskId, job, attemptId, controller, completion: finished.promise });
      changed();
      if (isClosed() || controller.signal.aborted) return;
      const result = await execute(studio, job, task, controller.signal);
      if (isClosed() || controller.signal.aborted) return;
      const item = transaction(() => {
        const latest = read('studios', studioId, 'Студия');
        const notice = finishStep(latest, job, task, result, attemptId);
        const attempt = read('attempts', attemptId, 'Запуск');
        update('attempts', { ...attempt, status: 'completed', finishedAt: now() });
        return notice;
      });
      changed();
      notifyInbox(item);
    } catch (error) {
      if (isClosed() || controller.signal.aborted) return;
      const body = error instanceof Error ? error.message : String(error);
      const item = transaction(() => {
        const latest = read('studios', studioId, 'Студия');
        const attempt = read('attempts', attemptId, 'Запуск');
        update('attempts', { ...attempt, status: 'failed', error: body, finishedAt: now() });
        state(latest, 'error', body, job);
        const title = task ? `Ошибка · ${task.title}` : 'Ошибка · планирование';
        if (!task) return addStudioInbox(studioId, 'error', { title, body });
        update('tasks', { ...task, stage: 'blocked', status: 'failed', activeAgentId: undefined, error: body, updatedAt: now() });
        return addInbox(task, 'error', { title, body });
      });
      changed();
      notifyInbox(item);
    } finally {
      active.delete(studioId);
      finished.resolve();
      if (!isClosed()) onAvailable(studioId);
    }
  }

  return { initializeStudio, decidePlan, updatePlanAgents, setStudioRunning, resumeInbox, startStandaloneTraining, queue };
}
