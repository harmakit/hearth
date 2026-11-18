import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createWorkflow } from './workflow.mjs';
import { normalizeImport } from './import.mjs';
import { parseResponse } from './protocol.mjs';
import { normalizeSchedule, withinSchedule } from './schedule.mjs';

const runtimes = ['codex', 'claude'];
const modes = ['inherit', 'fixed', 'dynamic'];
const roles = ['library', 'engineer', 'editor', 'artist', 'other'];
const defaultDirector = { runtime: 'codex', model: '', effort: '' };
const restartable = ['queued', 'failed', 'interrupted'];
const now = () => new Date().toISOString();
const domains = ['plans', 'epics', 'stories', 'sprints', 'meetings', 'attempts'];
const stages = { queued: 'ready', scheduled: 'ready', running: 'in_progress', completed: 'done', waiting: 'blocked', failed: 'blocked', interrupted: 'blocked' };
const visibleStudio = (studio) => ({ approveSprints: true, lifecycle: 'draft', projectLanguage: '', ...studio, schedule: normalizeSchedule(studio.schedule) });

function string(value, label, { required = false, fallback = '' } = {}) {
  if (value === undefined) value = fallback;
  if (typeof value === 'string' && (value.trim() || !required)) return value.trim();
  throw new Error(`Укажите корректное значение поля «${label}».`);
}

function option(value, fallback, choices, label) {
  const selected = value === undefined ? fallback : value;
  if (choices.includes(selected)) return selected;
  throw new Error(`Неизвестное значение поля «${label}».`);
}

function controls(input, current, runtimeOptions = runtimes) {
  return {
    runtime: option(input.runtime, current.runtime, runtimeOptions, 'подключение'),
    model: string(input.model === null ? '' : input.model, 'модель', { fallback: current.model }),
    effort: string(input.effort === null ? '' : input.effort, 'усилие', { fallback: current.effort }),
  };
}

function allowlist(input) {
  if (!Array.isArray(input)) throw new Error('Укажите список моделей студии.');
  return input.map((entry) => {
    const { runtime, model } = controls(entry, defaultDirector);
    if (!Array.isArray(entry.efforts)) throw new Error('Укажите доступные усилия модели.');
    return { runtime, model, efforts: entry.efforts.map((effort) => string(effort, 'усилие', { required: true })) };
  });
}

function studioSettings(input, current = { brief: '', director: defaultDirector, allowed: [], agents: [] }) {
  const root = string(input.root, 'папка проекта', { required: true, fallback: current.root });
  if (!isAbsolute(root)) throw new Error('Укажите абсолютный путь к папке проекта.');
  const approveSprints = input.approveSprints ?? current.approveSprints ?? true;
  if (typeof approveSprints !== 'boolean') throw new Error('Некорректная настройка согласования спринтов.');
  return {
    name: string(input.name, 'название студии', { required: true, fallback: current.name }),
    brief: string(input.brief, 'бриф', { fallback: current.brief }),
    root,
    language: string(input.language, 'язык', { required: true, fallback: current.language ?? 'Русский' }),
    projectLanguage: string(input.projectLanguage, 'язык материалов проекта', { fallback: current.projectLanguage }),
    director: controls(input.director ?? {}, current.director),
    allowed: input.allowed === undefined ? current.allowed : allowlist(input.allowed),
    agents: current.agents,
    approveSprints,
    schedule: normalizeSchedule(input.schedule === undefined ? current.schedule : input.schedule),
  };
}

function agentSettings(input, current = { role: 'other', mode: 'inherit', runtime: '', model: '', effort: '' }) {
  return {
    name: string(input.name, 'имя агента', { fallback: current.name }),
    description: string(input.description, 'обязанности', { fallback: current.description }),
    role: option(input.role, current.role, roles, 'роль'),
    mode: option(input.mode, current.mode, modes, 'политика модели'),
    ...controls(input, current, ['', ...runtimes]),
  };
}

async function taskControls(studio, agent, task, { run, signal, purpose }) {
  if (!agent || agent.mode === 'inherit') return studio.director;
  const options = new Map();
  const tupleKey = ({ runtime, model, effort }) => JSON.stringify([runtime, model, effort]);
  for (const { runtime, model, efforts } of studio.allowed) {
    for (const effort of efforts.length ? efforts : ['']) {
      const tuple = { runtime, model, effort };
      options.set(tupleKey(tuple), tuple);
    }
  }
  if (agent?.mode === 'fixed') {
    const fixed = { runtime: agent.runtime || studio.director.runtime, model: agent.model, effort: agent.effort };
    if (options.size && !options.has(tupleKey(fixed))) {
      throw new Error('Модель и усилие агента отсутствуют в разрешённом списке студии.');
    }
    return fixed;
  }
  if (!options.size) return studio.director;
  if (options.size === 1) return options.values().next().value;
  const { runtime, model, effort } = studio.director;
  const context = {
    brief: studio.brief,
    purpose,
    agent: { role: agent.role, description: agent.description, preferredEffort: agent.effort },
    task: { title: task.title, prompt: task.prompt, criteria: task.criteria },
    allowed: [...options.values()],
  };
  const prompt = [
    'Select the model and effort for this studio task.',
    'Choose one option from allowed verbatim. Return it as a JSON object with exactly the runtime, model and effort fields. Leave project files unchanged.',
    JSON.stringify(context, null, 2),
  ].join('\n\n');
  const selected = parseResponse(await run({
    runtime, model: model || undefined, effort: effort || undefined,
    purpose: 'select-model', projectRoot: studio.root, prompt, signal,
  }));
  const permitted = options.get(tupleKey(selected));
  if (!permitted || Object.keys(selected).length !== 3) {
    throw new Error('Директор выбрал сочетание вне разрешённого списка студии.');
  }
  return permitted;
}

function runPrompt(studio, agent, task, decisions, workflowContext) {
  const priorDraft = decisions.length ? {
    summary: task.summary.slice(0, 4000),
    artifact: task.artifact.slice(0, 16_000),
  } : undefined;
  const context = {
    language: studio.language,
    projectLanguage: studio.projectLanguage || studio.language,
    brief: studio.brief,
    role: agent?.role ?? 'director',
    agent: agent?.name ?? '',
    title: task.title,
    task: task.prompt,
    priorDraft,
    decisions: decisions.map(({ body, answer }) => ({ question: body, answer })),
    ...workflowContext,
  };
  return [
    'Work on the task described in the JSON context. Read the project as needed and leave its files unchanged.',
    'Use the owner’s language from the language field for the report, artifact, and any question.',
    'Return one JSON object with string fields "summary" and "artifact". If you need an owner decision to continue, add "question" as a string or as {"title": "…", "body": "…"}. Omit "question" when finished.',
    ...(workflowContext ? ['For a file, return its exact content in "artifact" and its relative path in "artifactPath". Use projectLanguage for the artifact. Use the planned artifactPath when present. For a revision of an already published result, propose a new unused filename.'] : []),
    'Use any recorded decisions and the prior draft to continue the original task. Ask only for decisions that are still needed.',
    JSON.stringify(context, null, 2),
  ].join('\n\n');
}

function report(result) {
  const output = string(result?.text, 'отчёт', { required: true });
  const json = output.match(/^```(?:json)?\s*\n([\s\S]+?)\n```$/i)?.[1] ?? output;
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    return { summary: output, artifact: '', question: null };
  }
  const summary = typeof value?.summary === 'string' ? value.summary.trim() : '';
  const artifact = typeof value?.artifact === 'string' ? value.artifact.trim() : '';
  const questionBody = typeof value?.question === 'string' ? value.question : value?.question?.body;
  const questionTitle = value?.question?.title;
  const question = typeof questionBody === 'string' && questionBody.trim()
    ? { title: typeof questionTitle === 'string' && questionTitle.trim() ? questionTitle.trim() : 'Нужно решение', body: questionBody.trim() }
    : null;
  return { summary: summary || (!artifact && !question ? output : ''), artifact, question };
}

function visibleTask(task) {
  return { stage: stages[task.status], dependencies: [], ...task, status: task.status === 'scheduled' ? 'queued' : task.status };
}

export function createStudioService({ dbPath, run, onChange, notify, writeArtifact, now: clock = () => new Date() }) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS studios (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS deleted_studios (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, studio_id TEXT NOT NULL REFERENCES studios(id), data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inbox (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS inbox_by_task ON inbox(task_id);
    CREATE TABLE IF NOT EXISTS studio_inbox (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    ${domains.map((table) => `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL);`).join('\n')}
  `);

  const active = new Map();
  const pending = new Map();
  const publishedWaiting = new Map();
  let closed = false;
  let closing;

  function assertOpen() {
    if (closed) throw new Error('Hearth Studio завершает работу.');
  }

  function read(table, id, label) {
    assertOpen();
    const row = typeof id === 'string' && db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id);
    if (row) {
      const record = JSON.parse(row.data);
      if (table === 'studios') return visibleStudio(record);
      return table === 'tasks' ? visibleTask(record) : record;
    }
    throw new Error(`${label} не найдено.`);
  }

  function availableStudio(studioId) {
    if (closed || active.has(studioId)) return;
    const row = db.prepare('SELECT data FROM studios WHERE id = ?').get(studioId);
    if (!row) return;
    const studio = visibleStudio(JSON.parse(row.data));
    if (!isPaused(studio) && withinSchedule(studio.schedule, clock())) return studio;
  }

  function isPaused(studio) {
    return studio.manualPaused || studio.lifecycle === 'paused';
  }

  function hasWorkflowWork(studio) {
    return studio.workflowJob && ['planning', 'active'].includes(studio.lifecycle);
  }

  function waitingForSchedule(studio, date) {
    return !active.has(studio.id) && !isPaused(studio) && !withinSchedule(studio.schedule, date)
      && Boolean(hasWorkflowWork(studio) || pending.get(studio.id)?.size);
  }

  function list(table) {
    return db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all().map(({ data }) => JSON.parse(data));
  }

  function update(table, value) {
    db.prepare(`UPDATE ${table} SET data = ? WHERE id = ?`).run(JSON.stringify(value), value.id);
    return value;
  }

  function insert(table, value) {
    const data = JSON.stringify(value);
    if (table === 'tasks') db.prepare('INSERT INTO tasks VALUES (?, ?, ?)').run(value.id, value.studioId, data);
    else if (table === 'inbox') db.prepare('INSERT INTO inbox VALUES (?, ?, ?)').run(value.id, value.taskId, data);
    else db.prepare(`INSERT INTO ${table} VALUES (?, ?)`).run(value.id, data);
    return value;
  }

  function transaction(write) {
    db.exec('BEGIN');
    try {
      const value = write();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function snapshot() {
    assertOpen();
    const date = clock();
    return {
      studios: list('studios').map((value) => {
        const record = visibleStudio(value);
        const { workflowJob, manualPaused, resumeDraft, importedPaused, ...studio } = record;
        return { ...studio, manualPaused: Boolean(manualPaused), scheduleWaiting: waitingForSchedule(record, date) };
      }),
      tasks: list('tasks').map(visibleTask),
      inbox: [...list('inbox'), ...list('studio_inbox')].sort((left, right) => String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''))),
      ...Object.fromEntries(domains.map((table) => [table, list(table)])),
    };
  }

  function publish(callback, value) {
    if (closed || !callback) return;
    try {
      Promise.resolve(callback(value)).catch(() => {});
    } catch {
      // Presentation and desktop notification failures do not change a saved task.
    }
  }

  function changed(value) {
    if (!closed && onChange) {
      const state = snapshot();
      for (const { id, scheduleWaiting } of state.studios) publishedWaiting.set(id, scheduleWaiting);
      publish(onChange, state);
    }
    return value;
  }

  function wake(studioId) {
    queueMicrotask(() => { void drain(studioId); });
  }

  function refreshSchedules() {
    assertOpen();
    const date = clock();
    let waitingChanged = false;
    for (const studio of list('studios').map(visibleStudio)) {
      if (waitingForSchedule(studio, date) !== (publishedWaiting.get(studio.id) ?? false)) waitingChanged = true;
      if (!active.has(studio.id) && !isPaused(studio) && withinSchedule(studio.schedule, date)
        && (hasWorkflowWork(studio) || pending.get(studio.id)?.size)) wake(studio.id);
    }
    if (waitingChanged) changed();
  }

  function createStudio(input) {
    assertOpen();
    const studio = { id: randomUUID(), lifecycle: 'draft', ...studioSettings(input) };
    db.prepare('INSERT INTO studios VALUES (?, ?)').run(studio.id, JSON.stringify(studio));
    return changed(studio);
  }

  function updateStudio({ studioId, ...patch }) {
    const studio = read('studios', studioId, 'Студия');
    const settings = studioSettings(patch, studio);
    if (settings.root !== studio.root) {
      const attachedTask = list('tasks').some((task) => task.studioId === studioId && (
        task.artifactPath || ['scheduled', 'running', 'waiting'].includes(task.status)
      ));
      const publishedFiles = list('plans').some((plan) => plan.studioId === studioId && plan.publishedFiles?.length);
      if (studio.workflowJob || active.has(studioId) || pending.has(studioId) || attachedTask || publishedFiles) {
        throw new Error('Папка проекта уже связана с текущей работой или опубликованными файлами.');
      }
    }
    const result = changed(update('studios', { ...studio, ...settings }));
    if (patch.schedule !== undefined && (hasWorkflowWork(result) || pending.get(studioId)?.size)) wake(studioId);
    return result;
  }

  function deleteStudio({ studioId, confirmation }) {
    const studio = read('studios', studioId, 'Студия');
    if (confirmation !== studio.name) throw new Error('Введите точное название студии.');
    if (active.has(studioId)) throw new Error('В студии выполняется работа. Дождитесь её завершения или остановите студию.');
    transaction(() => {
      db.prepare('DELETE FROM inbox WHERE task_id IN (SELECT id FROM tasks WHERE studio_id = ?)').run(studioId);
      for (const table of ['studio_inbox', ...domains]) {
        db.prepare(`DELETE FROM ${table} WHERE json_extract(data, '$.studioId') = ?`).run(studioId);
      }
      db.prepare('DELETE FROM tasks WHERE studio_id = ?').run(studioId);
      db.prepare('DELETE FROM studios WHERE id = ?').run(studioId);
      db.prepare('INSERT INTO deleted_studios (id) VALUES (?) ON CONFLICT (id) DO NOTHING').run(studioId);
    });
    pending.delete(studioId);
    publishedWaiting.delete(studioId);
    return changed({ studioId });
  }

  function wasStudioDeleted(studioId) {
    assertOpen();
    return typeof studioId === 'string' && Boolean(db.prepare('SELECT 1 FROM deleted_studios WHERE id = ?').get(studioId));
  }

  function getAgent(studio, agentId) {
    const agent = studio.agents.find(({ id }) => id === agentId);
    if (agent) return agent;
    throw new Error('Агент не найден в этой студии.');
  }

  function addAgent({ studioId, ...input }) {
    const studio = read('studios', studioId, 'Студия');
    const agent = { id: randomUUID(), ...agentSettings(input) };
    studio.agents.push(agent);
    update('studios', studio);
    return changed(agent);
  }

  function updateAgent({ studioId, agentId, ...patch }) {
    const studio = read('studios', studioId, 'Студия');
    const agent = getAgent(studio, agentId);
    Object.assign(agent, agentSettings(patch, agent));
    update('studios', studio);
    return changed(agent);
  }

  function createTask({ studioId, agentId, title, prompt }) {
    const studio = read('studios', studioId, 'Студия');
    if (agentId) getAgent(studio, agentId);
    const createdAt = now();
    const task = {
      id: randomUUID(), studioId, agentId: agentId || null,
      title: string(title, 'название задачи', { required: true }),
      prompt: string(prompt, 'описание задачи', { required: true }),
      status: 'queued', summary: '', artifact: '', error: '', createdAt, updatedAt: createdAt,
    };
    db.prepare('INSERT INTO tasks VALUES (?, ?, ?)').run(task.id, studioId, JSON.stringify(task));
    return changed(visibleTask(task));
  }

  function taskState(task, status, patch = {}) {
    return visibleTask(update('tasks', { ...task, stage: stages[status], ...patch, status, updatedAt: now() }));
  }

  function taskInbox(taskId) {
    return db.prepare('SELECT data FROM inbox WHERE task_id = ? ORDER BY rowid').all(taskId)
      .map(({ data }) => JSON.parse(data));
  }

  function resolveInbox(taskId) {
    for (const item of taskInbox(taskId)) {
      if (item.status === 'open') update('inbox', { ...item, status: 'resolved' });
    }
  }

  function addInbox(task, kind, { title, body }) {
    const item = {
      id: randomUUID(), studioId: task.studioId, taskId: task.id, kind,
      title, body, status: 'open', answer: '', createdAt: now(),
    };
    db.prepare('INSERT INTO inbox VALUES (?, ?, ?)').run(item.id, item.taskId, JSON.stringify(item));
    return item;
  }

  function addStudioInbox(studioId, kind, input) {
    return insert('studio_inbox', { id: randomUUID(), studioId, taskId: null, kind, ...input, status: 'open', answer: '', createdAt: now() });
  }

  function enqueue({ id, studioId }, { start = true } = {}) {
    const queue = pending.get(studioId) ?? new Set();
    queue.add(id);
    pending.set(studioId, queue);
    if (start) wake(studioId);
  }

  function startTask({ taskId, confirmLegacy }) {
    const task = read('tasks', taskId, 'Задача');
    if (task.workflowManaged) {
      const studio = read('studios', task.studioId, 'Студия');
      if (studio.workflowJob?.taskId !== task.id || !['paused', 'error'].includes(studio.lifecycle)) throw new Error('Директор управляет запуском этой задачи.');
      return setStudioRunning({ studioId: studio.id, action: 'resume' });
    }
    if (!restartable.includes(task.status)) throw new Error('Задача сейчас недоступна для запуска.');
    if (pending.get(task.studioId)?.has(taskId)) return task;
    if (task.legacyWorktreeReview && confirmLegacy !== true) {
      throw new Error('Подтвердите сверку рабочего дерева и изменений перед запуском.');
    }
    if (task.dependencies.some((id) => read('tasks', id, 'Зависимость').stage !== 'done')) {
      throw new Error('Сначала завершите задачи, от которых зависит эта работа.');
    }
    const studio = read('studios', task.studioId, 'Студия');
    const queued = transaction(() => {
      resolveInbox(taskId);
      if (studio.importedPaused) {
        update('studios', { ...studio, lifecycle: 'idle', activity: 'Студия готова к ручному запуску задач', importedPaused: undefined });
      }
      return taskState(task, 'scheduled', { error: '', ...(task.legacyWorktreeReview ? { legacyWorktreeReview: false } : {}) });
    });
    enqueue(queued);
    return changed(queued);
  }

  function cancelTask({ taskId }) {
    const task = read('tasks', taskId, 'Задача');
    if (task.workflowManaged) {
      const studio = read('studios', task.studioId, 'Студия');
      if (studio.workflowJob?.taskId !== task.id) throw new Error('Директор управляет остановкой этой задачи.');
      return setStudioRunning({ studioId: studio.id, action: 'stop' });
    }
    if (!['queued', 'scheduled', 'running', 'waiting'].includes(task.status)) throw new Error('Задача сейчас недоступна для остановки.');
    const cancelled = transaction(() => {
      resolveInbox(taskId);
      return taskState(task, 'interrupted');
    });
    const queue = pending.get(task.studioId);
    queue?.delete(task.id);
    if (queue?.size === 0) pending.delete(task.studioId);
    const attempt = active.get(task.studioId);
    if (attempt?.id === taskId) attempt.controller.abort();
    return changed(cancelled);
  }

  function answerInbox({ inboxId, answer, decision }) {
    const studioItem = list('studio_inbox').find(({ id }) => id === inboxId);
    const item = studioItem ?? read('inbox', inboxId, 'Сообщение');
    if (item.status !== 'open') throw new Error('Сообщение уже закрыто.');
    if (item.kind === 'plan') return workflow.decidePlan({ planId: item.planId, decision, feedback: answer });
    if (item.kind === 'error') return changed(update(studioItem ? 'studio_inbox' : 'inbox', { ...item, status: 'resolved' }));
    const task = read('tasks', item.taskId, 'Задача');
    if (task.status !== 'waiting') {
      throw new Error('Ответ на этот вопрос уже закрыт.');
    }
    if (task.workflowManaged) return workflow.resumeInbox(item, task, answer, decision);
    const body = string(answer, 'ответ', { required: true });
    const resolved = transaction(() => {
      taskState(task, task.legacyWorktreeReview ? 'interrupted' : 'scheduled');
      return update('inbox', { ...item, status: 'resolved', answer: body });
    });
    if (!task.legacyWorktreeReview) enqueue(task);
    return changed(resolved);
  }

  function notifyInbox(item) {
    if (item) publish(notify, { title: item.title, body: item.body, studioId: item.studioId, inboxId: item.id });
  }

  async function drain(studioId) {
    const studio = availableStudio(studioId);
    if (!studio) return;
    if (hasWorkflowWork(studio)) {
      workflow.queue(studioId);
      return;
    }
    const queue = pending.get(studioId);
    const taskId = queue?.values().next().value;
    if (!taskId) return;
    queue.delete(taskId);
    if (!queue.size) pending.delete(studioId);

    const task = read('tasks', taskId, 'Задача');
    const agent = task.agentId ? getAgent(studio, task.agentId) : undefined;
    const decisions = taskInbox(taskId).filter(({ kind, answer }) => kind === 'question' && answer);
    const controller = new AbortController();
    const finished = Promise.withResolvers();
    const running = taskState(task, 'running');
    active.set(studioId, { id: taskId, controller, completion: finished.promise });
    const isCurrent = () => !closed && !controller.signal.aborted;

    try {
      changed(running);
      if (!isCurrent()) return;
      const { runtime, model, effort } = await taskControls(studio, agent, running, { run, signal: controller.signal, purpose: 'task' });
      if (!isCurrent()) return;
      const result = report(await run({
        runtime,
        model: model || undefined,
        effort: effort || undefined,
        projectRoot: studio.root,
        prompt: runPrompt(studio, agent, running, decisions),
        signal: controller.signal,
      }));
      if (!isCurrent()) return;
      const item = transaction(() => {
        const { summary, artifact, question } = result;
        taskState(running, question ? 'waiting' : 'completed', { summary, artifact });
        return question && addInbox(running, 'question', question);
      });
      changed();
      notifyInbox(item);
    } catch (error) {
      if (!isCurrent()) return;
      const body = error instanceof Error ? error.message : String(error);
      const item = transaction(() => {
        taskState(running, 'failed', { error: body });
        return addInbox(running, 'error', { title: `Ошибка · ${running.title}`, body });
      });
      changed();
      notifyInbox(item);
    } finally {
      active.delete(studioId);
      finished.resolve();
      if (!closed) onAvailable(studioId);
    }
  }

  function interruptUnfinishedAttempts({ restore = false } = {}) {
    const date = now();
    transaction(() => {
      const studios = list('studios').map(visibleStudio);
      const scheduledStudios = new Set(studios.filter(({ schedule }) => schedule.enabled).map(({ id }) => id));
      const runningWorkflow = new Set();
      for (const task of list('tasks')) {
        if (task.status === 'scheduled' && scheduledStudios.has(task.studioId)) {
          if (restore) enqueue(task, { start: false });
          continue;
        }
        if (['scheduled', 'running'].includes(task.status)) {
          update('tasks', { ...task, status: 'interrupted', stage: 'blocked', activeAgentId: undefined, updatedAt: date });
        }
      }
      for (const attempt of list('attempts')) {
        if (attempt.status === 'running') {
          runningWorkflow.add(attempt.studioId);
          update('attempts', { ...attempt, status: 'interrupted', finishedAt: date });
        }
      }
      for (const studio of studios) {
        if (hasWorkflowWork(studio) && (!studio.schedule.enabled || runningWorkflow.has(studio.id))) {
          update('studios', { ...studio, lifecycle: 'paused', activity: 'Работа прервана. Продолжите после сверки результатов.' });
        }
      }
    });
  }

  function onAvailable(studioId) {
    const studio = read('studios', studioId, 'Студия');
    if (waitingForSchedule(studio, clock()) !== (publishedWaiting.get(studioId) ?? false)) changed();
    if (hasWorkflowWork(studio) || pending.get(studioId)?.size) wake(studioId);
  }

  function close() {
    if (closing) return closing;
    closed = true;
    pending.clear();
    closing = Promise.resolve().then(async () => {
      const attempts = [...active.values()];
      try {
        interruptUnfinishedAttempts();
      } finally {
        for (const { controller } of attempts) controller.abort();
        try {
          if (attempts.length) {
            // Allow for the executable probe and the provider's graceful process shutdown.
            let timeout;
            try {
              await Promise.race([
                Promise.all(attempts.map(({ completion }) => completion)),
                new Promise((resolve) => { timeout = setTimeout(resolve, 12_000); }),
              ]);
            } finally {
              clearTimeout(timeout);
            }
          }
        } finally {
          db.close();
        }
      }
    });
    return closing;
  }

  const workflow = createWorkflow({
    read, list, insert, update, transaction, changed, notifyInbox, addStudioInbox, addInbox, taskInbox,
    run, writeArtifact, taskControls, runPrompt, report, isClosed: () => closed, active, availableStudio, onAvailable,
  });

  function setStudioRunning({ studioId, action, running }) {
    action ??= running === true ? 'resume' : running === false ? 'pause' : undefined;
    if (!['pause', 'resume', 'stop'].includes(action)) throw new Error('Неизвестная команда студии.');
    const studio = read('studios', studioId, 'Студия');
    const attempt = active.get(studioId);
    if (action === 'stop') {
      const queued = pending.get(studioId) ?? [];
      transaction(() => {
        for (const taskId of queued) taskState(read('tasks', taskId, 'Задача'), 'interrupted');
        if (attempt && !attempt.job) taskState(read('tasks', attempt.id, 'Задача'), 'interrupted');
      });
      pending.delete(studioId);
      if (attempt && !attempt.job) attempt.controller.abort();
    }
    let result;
    if (studio.lifecycle === 'awaiting-approval') {
      result = changed(update('studios', { ...studio, manualPaused: action !== 'resume' }));
    } else if (studio.lifecycle === 'draft' && action !== 'resume') {
      result = changed(update('studios', { ...studio, lifecycle: 'paused', activity: 'Студия на паузе', resumeDraft: true, manualPaused: true }));
    } else if (action === 'resume' && studio.resumeDraft) {
      result = changed(update('studios', { ...studio, lifecycle: 'draft', activity: '', resumeDraft: undefined, manualPaused: false }));
    } else {
      if (action === 'resume' && (studio.manualPaused || studio.importedPaused)) {
        update('studios', { ...studio, manualPaused: false, importedPaused: undefined });
      }
      result = workflow.setStudioRunning({ studioId, action });
    }
    if (action === 'resume' && pending.get(studioId)?.size) wake(studioId);
    return result;
  }

  function importStudio(payload) {
    assertOpen();
    const normalized = normalizeImport(payload, studioSettings, agentSettings);
    const studio = transaction(() => {
      insert('studios', normalized.studio);
      for (const table of ['tasks', ...domains.filter((name) => name !== 'attempts')]) {
        for (const record of normalized[table]) insert(table, record);
      }
      for (const record of normalized.inbox) insert(record.taskId ? 'inbox' : 'studio_inbox', record);
      return normalized.studio;
    });
    return changed(studio);
  }

  interruptUnfinishedAttempts({ restore: true });
  refreshSchedules();
  const { initializeStudio, decidePlan } = workflow;
  return { snapshot, createStudio, updateStudio, deleteStudio, wasStudioDeleted, refreshSchedules, addAgent, updateAgent, createTask, startTask, cancelTask, answerInbox, initializeStudio, decidePlan, setStudioRunning, importStudio, close };
}
