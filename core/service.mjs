import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const runtimes = ['codex', 'claude'];
const modes = ['inherit', 'fixed', 'dynamic'];
const roles = ['library', 'engineer', 'editor', 'artist', 'other'];
const defaultDirector = { runtime: 'codex', model: '', effort: '' };
const restartable = ['queued', 'failed', 'interrupted'];
const now = () => new Date().toISOString();

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
  return {
    name: string(input.name, 'название студии', { required: true, fallback: current.name }),
    brief: string(input.brief, 'бриф', { fallback: current.brief }),
    root,
    language: string(input.language, 'язык', { required: true, fallback: current.language ?? 'Русский' }),
    director: controls(input.director ?? {}, current.director),
    allowed: input.allowed === undefined ? current.allowed : allowlist(input.allowed),
    agents: current.agents,
  };
}

function agentSettings(input, current = { role: 'other', mode: 'inherit', runtime: '', model: '', effort: '' }) {
  return {
    name: string(input.name, 'имя агента', { required: true, fallback: current.name }),
    role: option(input.role, current.role, roles, 'роль'),
    mode: option(input.mode, current.mode, modes, 'политика модели'),
    ...controls(input, current, ['', ...runtimes]),
  };
}

function taskControls(studio, agent) {
  if (agent?.mode === 'fixed') {
    return { runtime: agent.runtime || studio.director.runtime, model: agent.model, effort: agent.effort };
  }
  if (agent?.mode === 'dynamic' && studio.allowed.length) {
    // The studio sets the preference order. Keep the role's requested effort when supported.
    const selection = studio.allowed[0];
    const preferred = agent.effort || studio.director.effort;
    const effort = selection.efforts.includes(preferred) ? preferred : selection.efforts[0] ?? '';
    return { runtime: selection.runtime, model: selection.model, effort };
  }
  return studio.director;
}

function runPrompt(studio, agent, task, decisions) {
  const priorDraft = decisions.length ? {
    summary: task.summary.slice(0, 4000),
    artifact: task.artifact.slice(0, 16_000),
  } : undefined;
  const context = {
    language: studio.language,
    brief: studio.brief,
    role: agent?.role ?? 'director',
    agent: agent?.name ?? '',
    title: task.title,
    task: task.prompt,
    priorDraft,
    decisions: decisions.map(({ body, answer }) => ({ question: body, answer })),
  };
  return [
    'Work on the task described in the JSON context. Read the project as needed and leave its files unchanged.',
    'Use the owner’s language from the language field for the report, artifact, and any question.',
    'Return one JSON object with string fields "summary" and "artifact". If you need an owner decision to continue, add "question" as a string or as {"title": "…", "body": "…"}. Omit "question" when finished.',
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
  return task.status === 'scheduled' ? { ...task, status: 'queued' } : task;
}

export function createStudioService({ dbPath, run, onChange, notify }) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS studios (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, studio_id TEXT NOT NULL REFERENCES studios(id), data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inbox (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS inbox_by_task ON inbox(task_id);
  `);

  const active = new Map();
  const pending = new Map();
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
      return table === 'tasks' ? visibleTask(record) : record;
    }
    throw new Error(`${label} не найдено.`);
  }

  function list(table) {
    return db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all().map(({ data }) => JSON.parse(data));
  }

  function update(table, value) {
    db.prepare(`UPDATE ${table} SET data = ? WHERE id = ?`).run(JSON.stringify(value), value.id);
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
    return { studios: list('studios'), tasks: list('tasks').map(visibleTask), inbox: list('inbox') };
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
    if (!closed && onChange) publish(onChange, snapshot());
    return value;
  }

  function createStudio(input) {
    assertOpen();
    const studio = { id: randomUUID(), ...studioSettings(input) };
    db.prepare('INSERT INTO studios VALUES (?, ?)').run(studio.id, JSON.stringify(studio));
    return changed(studio);
  }

  function updateStudio({ studioId, ...patch }) {
    const studio = read('studios', studioId, 'Студия');
    return changed(update('studios', { id: studio.id, ...studioSettings(patch, studio) }));
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
    return changed(task);
  }

  function taskState(task, status, patch = {}) {
    return visibleTask(update('tasks', { ...task, ...patch, status, updatedAt: now() }));
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

  function enqueue({ id, studioId }) {
    const queue = pending.get(studioId) ?? new Set();
    queue.add(id);
    pending.set(studioId, queue);
    queueMicrotask(() => { void drain(studioId); });
  }

  function startTask({ taskId }) {
    const task = read('tasks', taskId, 'Задача');
    if (!restartable.includes(task.status)) throw new Error('Задача сейчас недоступна для запуска.');
    if (pending.get(task.studioId)?.has(taskId)) return task;
    const queued = transaction(() => {
      resolveInbox(taskId);
      return taskState(task, 'scheduled', { error: '' });
    });
    enqueue(queued);
    return changed(queued);
  }

  function cancelTask({ taskId }) {
    const task = read('tasks', taskId, 'Задача');
    if (!['queued', 'running', 'waiting'].includes(task.status)) throw new Error('Задача сейчас недоступна для остановки.');
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

  function answerInbox({ inboxId, answer }) {
    const item = read('inbox', inboxId, 'Сообщение');
    if (item.status !== 'open') throw new Error('Сообщение уже закрыто.');
    if (item.kind === 'error') return changed(update('inbox', { ...item, status: 'resolved' }));
    const task = read('tasks', item.taskId, 'Задача');
    if (task.status !== 'waiting') {
      throw new Error('Ответ на этот вопрос уже закрыт.');
    }
    const body = string(answer, 'ответ', { required: true });
    const resolved = transaction(() => {
      taskState(task, 'scheduled');
      return update('inbox', { ...item, status: 'resolved', answer: body });
    });
    enqueue(task);
    return changed(resolved);
  }

  function notifyInbox(item) {
    if (item) publish(notify, { title: item.title, body: item.body, studioId: item.studioId, inboxId: item.id });
  }

  async function drain(studioId) {
    if (closed || active.has(studioId)) return;
    const queue = pending.get(studioId);
    const taskId = queue?.values().next().value;
    if (!taskId) return;
    queue.delete(taskId);
    if (!queue.size) pending.delete(studioId);

    const task = read('tasks', taskId, 'Задача');
    const studio = read('studios', studioId, 'Студия');
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
      const { runtime, model, effort } = taskControls(studio, agent);
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
      if (!closed && pending.get(studioId)?.size) queueMicrotask(() => { void drain(studioId); });
    }
  }

  function interruptUnfinishedAttempts() {
    db.prepare(`
      UPDATE tasks
      SET data = json_set(data, '$.status', 'interrupted', '$.updatedAt', ?)
      WHERE json_extract(data, '$.status') IN ('scheduled', 'running')
    `).run(now());
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

  interruptUnfinishedAttempts();
  return { snapshot, createStudio, updateStudio, addAgent, updateAgent, createTask, startTask, cancelTask, answerInbox, close };
}
