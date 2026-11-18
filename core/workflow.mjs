import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { directorPrompt, field, parseResponse, planPrompt, publishableArtifactPath, reviewPrompt, validatePlan } from './protocol.mjs';

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
  run, writeArtifact, taskControls, runPrompt, report, isClosed, active, onAvailable,
}) {
  function state(studio, lifecycle, activity, job = null) {
    return update('studios', { ...studio, lifecycle, activity, workflowJob: job });
  }

  function queue(studioId) {
    queueMicrotask(() => { void drain(studioId); });
  }

  function planning(studio, kind, feedback, previousPlanId) {
    return state(studio, 'planning', 'Директор готовит план', { purpose: 'plan', kind, feedback, previousPlanId });
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
    if (studio.lifecycle === 'paused') return state(studio, 'paused', 'Студия на паузе', job);
    return state(studio, 'active', activity, job);
  }

  function nextTask(studio, task) {
    update('tasks', { ...task, stage: 'ready', status: 'queued', activeAgentId: undefined, error: '', updatedAt: now() });
    return schedule(studio, { purpose: 'task', taskId: task.id }, `Готовится задача «${task.title}»`);
  }

  function approve(studio, plan) {
    const { id, studioId } = plan;
    const agents = [...studio.agents];
    const byKey = new Map(agents.map((agent) => [agent.key ?? agent.id, agent]));
    for (const candidate of plan.agents) {
      if (byKey.has(candidate.key)) continue;
      const agent = { ...candidate, id: randomUUID(), mode: 'inherit', runtime: '', model: '', effort: '' };
      agents.push(agent);
      byKey.set(agent.key, agent);
    }
    const epic = insert('epics', { id: randomUUID(), studioId, ...plan.epic });
    const story = insert('stories', { id: randomUUID(), studioId, epicId: epic.id, ...plan.story });
    const taskIds = new Map(plan.tasks.map(({ key }) => [key, randomUUID()]));
    const sprint = insert('sprints', { id: randomUUID(), studioId, planId: id, title: plan.title, goal: plan.goal, status: 'active', taskIds: [...taskIds.values()] });
    const createdAt = now();
    const tasks = plan.tasks.map(({ agentKey, reviewerKey, dependsOn, artifactPath, ...task }) => insert('tasks', {
      ...task, id: taskIds.get(task.key), studioId, agentId: byKey.get(agentKey).id, reviewerId: byKey.get(reviewerKey).id,
      epicId: epic.id, storyId: story.id, sprintId: sprint.id, dependencies: dependsOn.map((key) => taskIds.get(key)),
      stage: dependsOn.length ? 'backlog' : 'ready', status: 'queued', summary: '', artifact: '', error: '',
      artifactTarget: artifactPath, workflowManaged: true, createdAt, updatedAt: createdAt,
    }));
    insert('meetings', {
      id: randomUUID(), studioId, sprintId: sprint.id, kind: 'planning', title: 'Планирование спринта',
      summary: plan.goal, taskIds: sprint.taskIds, createdAt,
    });
    const result = update('plans', { ...plan, status: 'approved', sprintId: sprint.id, decidedAt: createdAt });
    const ready = tasks.find(({ stage }) => stage === 'ready');
    const roster = { ...studio, agents };
    if (plan.files.length) {
      schedule(roster, { purpose: 'publish', planId: id, fileIndex: 0, taskId: ready.id }, 'Подготовка стартовых файлов');
    } else {
      nextTask(roster, ready);
    }
    return result;
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
      return state(studio, 'paused', action === 'stop' ? 'Студия остановлена' : 'Студия на паузе', studio.workflowJob);
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
    const agentId = purpose === 'task' ? task.agentId : purpose === 'review' ? task.reviewerId : undefined;
    const agent = studio.agents.find(({ id }) => id === agentId);
    const { runtime, model, effort } = await taskControls(studio, agent, task, { run, signal, purpose });
    signal.throwIfAborted();
    let prompt;
    switch (purpose) {
      case 'plan': {
        const previous = job.previousPlanId ? read('plans', job.previousPlanId, 'План') : undefined;
        prompt = planPrompt(studio, job, previous);
        break;
      }
      case 'task': {
        const decisions = taskInbox(task.id).filter(({ kind, answer }) => kind === 'question' && answer);
        prompt = runPrompt(studio, agent, task, decisions, {
          criteria: task.criteria, artifactPath: task.artifactTarget, previousArtifactPath: task.artifactPath, review: task.review,
          dependencies: task.dependencies.map((id) => {
            const { title, summary, artifactPath } = read('tasks', id, 'Задача');
            return { title, summary, artifactPath };
          }),
        });
        break;
      }
      case 'review':
        prompt = reviewPrompt(studio, task);
        break;
      case 'director':
        prompt = directorPrompt(studio, task, readyAfter(task).map(({ key, title }) => ({ key, title })));
        break;
    }
    const result = await run({ runtime, model: model || undefined, effort: effort || undefined, projectRoot: studio.root, purpose, prompt, signal });
    const data = parseResponse(result);
    if (purpose === 'plan') return validatePlan(data, studio.agents);
    if (purpose === 'task') {
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
    return sprintTasks(task).filter((candidate) => candidate.id !== task.id && (
      candidate.stage === 'ready' || (candidate.stage === 'backlog' && candidate.dependencies.every(
        (id) => id === task.id || read('tasks', id, 'Задача').stage === 'done',
      ))
    ));
  }

  function toReview(studio, task, patch = {}) {
    update('tasks', { ...task, ...patch, stage: 'review', status: 'completed', activeAgentId: undefined, error: '', updatedAt: now() });
    schedule(studio, { purpose: 'review', taskId: task.id }, 'Результат передан на ревью');
  }

  function toDirector(studio, task, patch = {}) {
    update('tasks', { ...task, ...patch, status: 'completed', stage: 'review', activeAgentId: undefined, updatedAt: now() });
    schedule(studio, { purpose: 'director', taskId: task.id }, 'Директор выбирает следующий шаг');
  }

  function finishStep(studio, job, task, result, attemptId) {
    switch (job.purpose) {
      case 'plan': {
        const plan = insert('plans', { id: randomUUID(), studioId: studio.id, kind: job.kind, status: 'pending', ...result, createdAt: now() });
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
          nextTask(studio, task);
        }
        return;
      }
      case 'task': {
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
      case 'review': {
        if (!result.pass) {
          const failedReviews = (task.failedReviews ?? 0) + 1;
          const updated = update('tasks', { ...task, failedReviews, revision: (task.revision ?? 0) + 1, review: result.summary });
          if (failedReviews >= 3) {
            update('tasks', { ...updated, stage: 'blocked', error: result.summary, status: 'failed', updatedAt: now() });
            state(studio, 'error', 'Задача трижды возвращена на доработку', { purpose: 'task', taskId: task.id });
            return addInbox(task, 'error', { title: `Задача заблокирована · ${task.title}`, body: result.summary });
          }
          nextTask(studio, updated);
          return;
        }
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
        if (result.action === 'next') {
          const next = result.taskKey === undefined ? ready[0] : ready.find(({ key }) => key === result.taskKey);
          if (!next) throw new Error('Директор выбрал недоступную задачу.');
          nextTask(studio, next);
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
          state(studio, 'idle', 'Спринт завершён');
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
    if (isClosed() || active.has(studioId)) return;
    const studio = read('studios', studioId, 'Студия');
    const job = studio.workflowJob;
    if (!job || !['active', 'planning'].includes(studio.lifecycle)) return;
    let task = job.taskId ? read('tasks', job.taskId, 'Задача') : undefined;
    const controller = new AbortController();
    const finished = Promise.withResolvers();
    const attemptId = randomUUID();
    try {
      transaction(() => {
        insert('attempts', { id: attemptId, studioId, taskId: job.taskId ?? null, purpose: job.purpose, status: 'running', startedAt: now() });
        if (['task', 'review', 'director'].includes(job.purpose)) {
          const stage = job.purpose === 'task' ? 'in_progress' : 'review';
          const activeAgentId = job.purpose === 'task' ? task.agentId : job.purpose === 'review' ? task.reviewerId : null;
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
      if (!isClosed()) {
        queue(studioId);
        onAvailable(studioId);
      }
    }
  }

  return { initializeStudio, decidePlan, setStudioRunning, resumeInbox, queue };
}
