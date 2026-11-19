import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { createStudioService as createService } from '../core/service.mjs';
import { productionSnapshot, trainingReply } from './fixtures/training.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));

function createStudioService({ run, onChange, ...settings }) {
  const service = createService({ ...settings, run: (request) => trainingReply(request) ?? run(request), onChange: onChange && ((snapshot) => onChange(productionSnapshot(snapshot))) });
  const snapshot = service.snapshot;
  return { ...service, snapshot: () => productionSnapshot(snapshot()) };
}

function database(t) {
  const scratch = join(project, '.tmp');
  mkdirSync(scratch, { recursive: true });
  const folder = mkdtempSync(join(scratch, 'service-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return join(folder, 'studio.sqlite');
}

function studio(service, name = 'Буквы') {
  return service.createStudio({ name, root: project, language: 'Русский', brief: 'Бережная редактура', wipLimit: 1 });
}

function task(service, studioId, agentId) {
  return service.createTask({ studioId, agentId, title: 'Проверить', prompt: 'Проверить рукопись' });
}

async function until(read, predicate) {
  for (let count = 0; count < 100; count += 1) {
    const value = read();
    if (predicate(value)) return value;
    await delay(5);
  }
  assert.fail(`State did not converge: ${JSON.stringify(read())}`);
}

test('stores app policy and an explicit empty studio override while preserving legacy role modes', async (t) => {
  const dbPath = database(t);
  const calls = [];
  const run = async ({ runtime, model, effort }) => {
    calls.push({ runtime, model, effort });
    return { text: 'Отчёт' };
  };
  const allowed = [{ runtime: 'claude', model: 'worker', efforts: ['high'] }];
  const oldAllowed = [{ runtime: 'codex', model: 'old-worker', efforts: [] }];
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE studios (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  const legacy = {
    id: 'legacy', name: 'Legacy', root: project, director: { runtime: 'codex', model: '', effort: '' }, allowed: oldAllowed,
    agents: ['fixed', 'dynamic', 'inherit'].map((mode) => ({ id: mode, mode, role: 'editor' })),
  };
  db.prepare('INSERT INTO studios VALUES (?, ?)').run(legacy.id, JSON.stringify(legacy));
  db.close();

  let service = createStudioService({ dbPath, run });
  t.after(() => service.close());
  service.updateModelPolicy({ allowed });
  const parent = studio(service, 'App');
  const override = service.createStudio({ name: 'Empty override', root: project, allowedMode: 'studio', allowed: [] });
  const first = service.addAgent({ studioId: parent.id, roleTitle: 'Редактор рукописи' });
  const second = service.addAgent({ studioId: override.id });
  const fixed = service.addAgent({ studioId: parent.id, mode: 'fixed', runtime: 'claude', model: 'worker', effort: 'high' });
  assert.equal(first.mode, 'dynamic');
  await service.close();

  service = createStudioService({ dbPath, run });
  const { modelPolicy, studios: [savedLegacy, savedParent, savedOverride] } = service.snapshot();
  assert.deepEqual(modelPolicy, { configured: true, allowed });
  assert.deepEqual(savedLegacy.agents.filter(({ systemRole }) => !systemRole), legacy.agents.map((agent) => ({ ...agent, trainingStatus: 'ready', skillIds: [] })));
  assert.equal(savedLegacy.allowedMode, 'studio');
  assert.deepEqual(savedLegacy.effectiveAllowed, oldAllowed);
  assert.equal(savedParent.allowedMode, 'app');
  assert.deepEqual(savedParent.effectiveAllowed, allowed);
  assert.equal(savedParent.agents.find(({ id }) => id === first.id).roleTitle, 'Редактор рукописи');
  assert.equal(savedOverride.allowedMode, 'studio');
  assert.deepEqual(savedOverride.effectiveAllowed, []);
  for (const [team, agent] of [[parent, first], [override, second]]) {
    service.startTask({ taskId: task(service, team.id, agent.id).id });
    await until(service.snapshot, ({ tasks }) => tasks.find(({ studioId }) => studioId === team.id)?.status === 'completed');
  }
  assert.deepEqual(calls, [{ runtime: 'claude', model: 'worker', effort: 'high' }, { runtime: 'codex', model: undefined, effort: undefined }]);
  service.startTask({ taskId: fixed.trainingTaskId });
  await until(service.snapshot, ({ training }) => training.find(({ id }) => id === fixed.trainingTaskId).stage === 'done');
  service.updateModelPolicy({ allowed: [] });
  await service.close();
  service = createStudioService({ dbPath, run });
  assert.deepEqual(service.snapshot().modelPolicy, { configured: true, allowed: [] });
  const blocked = task(service, parent.id, fixed.id);
  service.startTask({ taskId: blocked.id });
  await until(service.snapshot, ({ tasks }) => tasks.find(({ id }) => id === blocked.id)?.status === 'failed');
  assert.equal(calls.length, 2);
  assert.equal(service.snapshot().studios[1].agents.find(({ id }) => id === fixed.id).model, 'worker');
});

test('rechecks policy after asynchronous model selection and before dispatch', async (t) => {
  const choosing = Promise.withResolvers();
  const selection = Promise.withResolvers();
  const calls = [];
  const service = createStudioService({ dbPath: ':memory:', run: async ({ purpose, model }) => {
    calls.push([purpose, model]);
    choosing.resolve();
    return { text: JSON.stringify(await selection.promise) };
  } });
  t.after(() => { selection.resolve({}); return service.close(); });
  const allowed = [{ runtime: 'codex', model: 'old', efforts: ['low'] }, { runtime: 'claude', model: 'new', efforts: ['high'] }];
  service.updateModelPolicy({ allowed });
  const { id: studioId } = studio(service);
  const { id: agentId } = service.addAgent({ studioId });
  service.startTask({ taskId: task(service, studioId, agentId).id });
  await choosing.promise;
  service.updateModelPolicy({ allowed: [allowed[1]] });
  selection.resolve({ runtime: 'codex', model: 'old', effort: 'low' });
  const failure = await until(service.snapshot, ({ tasks }) => tasks[0].status === 'failed');
  assert.match(failure.tasks[0].error, /разрешённого списка/);
  assert.deepEqual(calls, [['select-model', undefined]]);
});

test('persists independent studios, role settings and unstarted work', async (t) => {
  const dbPath = database(t);
  let runs = 0;
  const run = async () => { runs += 1; return { text: 'Отчёт' }; };
  let service = createStudioService({ dbPath, run });
  t.after(() => service.close());
  const first = studio(service);
  const second = studio(service, 'Орнаменты');
  assert.throws(() => service.addAgent({ studioId: first.id, name: 'Вторая должность', role: 'director' }));
  const agent = service.addAgent({ studioId: first.id, name: 'Анна', role: 'editor' });
  assert.throws(() => service.updateAgent({ studioId: first.id, agentId: agent.id, role: 'director' }));
  service.updateStudio({ studioId: second.id, language: 'English', director: { runtime: 'claude' } });
  service.updateAgent({ studioId: first.id, agentId: agent.id, mode: 'fixed', runtime: 'codex', model: 'editor-model' });
  assert.throws(() => task(service, second.id, agent.id));
  const work = task(service, first.id, agent.id);
  await service.close();

  service = createStudioService({ dbPath, run });
  const saved = service.snapshot();
  assert.equal(saved.studios[0].language, 'Русский');
  assert.equal(saved.studios[0].agents.find(({ id }) => id === agent.id).model, 'editor-model');
  assert.equal(saved.studios[1].director.runtime, 'claude');
  assert.equal(saved.studios[1].agents[0].systemRole, 'coach');
  assert.deepEqual(saved.tasks, [{ ...work, dependencies: [] }]);
  await delay(20);
  assert.equal(runs, 0);
});

test('answers once, persists the decision, and completes through the selected role', async (t) => {
  const requests = [];
  const notifications = [];
  const seen = [];
  const service = createStudioService({
    dbPath: database(t),
    onChange: (snapshot) => seen.push(snapshot),
    notify: (notification) => notifications.push(notification),
    run: async (request) => {
      requests.push(request);
      if (requests.length === 1) return { text: JSON.stringify({
        summary: 'Черновик с двумя тонами',
        artifact: '1. Разговорный\n2. Спокойный',
        question: { title: 'Выбор', body: 'Какой тон?' },
      }) };
      return { text: '```json\n{"summary":"Готово","artifact":"Итоговая редактура"}\n```' };
    },
  });
  t.after(() => service.close());
  const first = studio(service);
  service.updateStudio({ studioId: first.id, allowed: [{ runtime: 'claude', model: 'chosen', efforts: ['high'] }] });
  const agent = service.addAgent({ studioId: first.id, name: 'Анна', role: 'editor', mode: 'dynamic' });
  const work = task(service, first.id, agent.id);
  service.startTask({ taskId: work.id });
  const waiting = await until(() => service.snapshot(), ({ tasks }) => tasks[0].status === 'waiting');
  const [question] = waiting.inbox;
  assert.equal(question.kind, 'question');
  assert.equal(question.body, 'Какой тон?');
  assert.equal(notifications[0].inboxId, question.id);
  assert.equal(requests[0].runtime, 'claude');
  assert.equal(requests[0].model, 'chosen');
  assert.equal(requests[0].effort, 'high');
  assert.match(requests[0].prompt, /Русский.*Бережная редактура.*editor.*Проверить рукопись/s);
  service.answerInbox({ inboxId: question.id, answer: 'Второй' });
  assert.throws(() => service.answerInbox({ inboxId: question.id, answer: 'Другой' }));
  const finished = await until(() => service.snapshot(), ({ tasks }) => tasks[0].status === 'completed');
  assert.equal(finished.tasks[0].artifact, 'Итоговая редактура');
  assert.equal(finished.inbox[0].answer, 'Второй');
  assert.equal(finished.inbox[0].status, 'resolved');
  assert.match(requests[1].prompt, /Черновик с двумя тонами.*2\. Спокойный.*Какой тон\?.*Второй/s);
  assert.equal(requests.length, 2);
  assert.equal(seen.at(-1).tasks[0].status, 'completed');
});

test('dynamic roles use the director’s exact allowlisted choice and reject outside choices', async (t) => {
  const requests = [];
  let pick = { runtime: 'claude', model: 'reader', effort: 'high' };
  const service = createStudioService({
    dbPath: ':memory:',
    run: async (request) => {
      requests.push(request);
      return { text: request.purpose === 'select-model' ? JSON.stringify(pick) : 'Done' };
    },
  });
  t.after(() => service.close());
  const { id: studioId } = studio(service);
  service.updateStudio({ studioId, allowed: [
    { runtime: 'codex', model: 'writer', efforts: ['low'] },
    { runtime: 'claude', model: 'reader', efforts: ['medium', 'high'] },
  ] });
  const agent = service.addAgent({ studioId, role: 'editor', mode: 'dynamic' });
  const first = task(service, studioId, agent.id);
  service.startTask({ taskId: first.id });
  await until(service.snapshot, ({ tasks }) => tasks[0].status === 'completed');
  assert.equal(requests[0].purpose, 'select-model');
  assert.equal(requests[0].runtime, 'codex');
  assert.match(requests[0].prompt, /writer.*low.*reader.*medium.*high/s);
  assert.deepEqual(
    requests.slice(1).map(({ runtime, model, effort }) => ({ runtime, model, effort })),
    [pick],
  );

  pick = { runtime: 'claude', model: 'reader', effort: 'low' };
  const second = task(service, studioId, agent.id);
  service.startTask({ taskId: second.id });
  const blocked = await until(service.snapshot, ({ tasks }) => tasks[1].status === 'failed');
  assert.equal(requests.length, 3);
  assert.match(blocked.tasks[1].error, /разрешён/);
});

test('serializes one studio while another runs and records provider errors', async (t) => {
  const requests = [];
  const service = createStudioService({
    dbPath: database(t),
    run: ({ prompt, signal }) => new Promise((resolve, reject) => requests.push({ prompt, signal, resolve, reject })),
  });
  t.after(() => service.close());
  const first = studio(service);
  const second = studio(service, 'Орнаменты');
  const cancelled = task(service, first.id);
  const queued = task(service, first.id);
  const independent = task(service, second.id);
  for (const work of [cancelled, queued, independent]) service.startTask({ taskId: work.id });
  await until(() => service.snapshot().tasks.map(({ status }) => status), (states) => states.filter((status) => status === 'running').length === 2);
  assert.deepEqual(service.snapshot().tasks.map(({ status }) => status), ['running', 'queued', 'running']);
  service.cancelTask({ taskId: cancelled.id });
  assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve({ text: 'Late output' });
  requests[1].reject(new Error('Provider unavailable'));
  await until(() => requests.length, (count) => count === 3);
  requests[2].resolve({ text: 'Обычный текст' });
  const saved = await until(() => service.snapshot(), ({ tasks }) => tasks[1].status === 'completed');
  assert.deepEqual(saved.tasks.map(({ status }) => status), ['interrupted', 'completed', 'failed']);
  assert.equal(saved.tasks[1].summary, 'Обычный текст');
  assert.equal(saved.tasks[2].error, 'Provider unavailable');
  assert.equal(saved.inbox[0].studioId, second.id);
  assert.equal(saved.inbox[0].kind, 'error');
});

test('reading a provider error preserves the open blocker until retry', async (t) => {
  let runs = 0;
  const service = createStudioService({ dbPath: database(t), run: async () => {
    runs += 1;
    throw new Error('Offline');
  } });
  t.after(() => service.close());
  const work = task(service, studio(service).id);
  service.startTask({ taskId: work.id });
  const { inbox: [error] } = await until(() => service.snapshot(), ({ inbox }) => inbox.length === 1);
  service.answerInbox({ inboxId: error.id, answer: 'Просмотрено' });
  assert.equal(service.snapshot().inbox[0].status, 'open');
  assert.ok(service.snapshot().inbox[0].readAt);
  assert.equal(service.snapshot().tasks[0].status, 'failed');
  await delay(20);
  assert.equal(runs, 1);
  service.startTask({ taskId: work.id });
  assert.equal(service.snapshot().inbox.find(item => item.id === error.id).status, 'resolved');
});

test('clears saved model controls and sends provider defaults', async (t) => {
  const service = createStudioService({ dbPath: database(t), run: async ({ model, effort }) => {
    assert.equal(model, undefined);
    assert.equal(effort, undefined);
    return { text: 'Готово' };
  } });
  t.after(() => service.close());
  const first = studio(service);
  service.updateStudio({ studioId: first.id, director: { model: 'set-model', effort: 'high' } });
  service.updateStudio({ studioId: first.id, director: { model: null, effort: null } });
  const work = task(service, first.id);
  service.startTask({ taskId: work.id });
  const finished = await until(() => service.snapshot().tasks[0], ({ status }) => status !== 'queued' && status !== 'running');
  assert.equal(finished.status, 'completed', finished.error);
});

test('marks running work interrupted after a process exits without closing the database', async (t) => {
  const dbPath = database(t);
  const serviceUrl = new URL('../core/service.mjs', import.meta.url);
  const program = `
    import { createStudioService } from ${JSON.stringify(serviceUrl.href)};
    const service = createStudioService({ dbPath: process.argv[1], run: () => process.exit(0) });
    const studio = service.createStudio({ name: 'Studio', root: process.cwd() });
    const task = service.createTask({ studioId: studio.id, title: 'Task', prompt: 'Work' });
    const queued = service.createTask({ studioId: studio.id, title: 'Started', prompt: 'Work' });
    service.createTask({ studioId: studio.id, title: 'Unstarted', prompt: 'Work' });
    service.startTask({ taskId: task.id });
    service.startTask({ taskId: queued.id });
  `;
  execFileSync(process.execPath, ['--input-type=module', '--eval', program, dbPath], { cwd: project });

  let runs = 0;
  const service = createStudioService({ dbPath, run: async () => { runs += 1; return { text: 'Done' }; } });
  t.after(() => service.close());
  const [work] = service.snapshot().tasks;
  assert.deepEqual(service.snapshot().tasks.map(({ status }) => status), ['interrupted', 'interrupted', 'queued']);
  await delay(20);
  assert.equal(runs, 0);
  service.startTask({ taskId: work.id });
  await until(() => service.snapshot().tasks[0].status, (status) => status === 'completed');
  assert.equal(runs, 1);
});

test('shutdown interrupts a run and waits for its provider to settle', async (t) => {
  const dbPath = database(t);
  const provider = Promise.withResolvers();
  let signal;
  const service = createStudioService({ dbPath, run: (request) => {
    signal = request.signal;
    return provider.promise;
  } });
  t.after(() => service.close());
  const work = task(service, studio(service).id);
  service.startTask({ taskId: work.id });
  await until(() => signal, Boolean);

  let closed = false;
  const closing = Promise.resolve(service.close()).then(() => { closed = true; });
  await delay(10);
  const closedEarly = closed;
  provider.resolve({ text: 'Late result' });
  await closing;
  assert.equal(signal.aborted, true);
  assert.equal(closedEarly, false);
  assert.throws(() => service.startTask({ taskId: work.id }));

  const restored = createStudioService({ dbPath, run: async () => assert.fail('Unexpected retry') });
  t.after(() => restored.close());
  assert.equal(restored.snapshot().tasks[0].status, 'interrupted');
  assert.equal(restored.snapshot().tasks[0].summary, '');
});

test('shutdown preserves an answer that was accepted while another task blocked its continuation', async (t) => {
  const dbPath = database(t);
  let runs = 0;
  const service = createStudioService({ dbPath, run: ({ signal }) => {
    runs += 1;
    if (runs === 1) return { text: '{"question":"Как продолжить?"}' };
    return new Promise(resolve => {
      signal.addEventListener('abort', () => resolve({ text: 'Late result' }), { once: true });
    });
  } });
  t.after(() => service.close());
  const first = studio(service);
  const work = task(service, first.id);
  service.startTask({ taskId: work.id });
  const { inbox: [question] } = await until(() => service.snapshot(), ({ inbox }) => inbox.length === 1);
  const blocker = task(service, first.id);
  service.startTask({ taskId: blocker.id });
  await until(() => runs, (count) => count === 2);
  service.answerInbox({ inboxId: question.id, answer: 'Продолжать' });
  assert.equal(service.snapshot().tasks[0].status, 'queued');
  await service.close();

  const resumed = createStudioService({ dbPath, run: async (request) => {
    assert.match(request.prompt, /Как продолжить\?.*Продолжать/s);
    return { text: 'Готово' };
  } });
  t.after(() => resumed.close());
  assert.equal(resumed.snapshot().tasks[0].status, 'interrupted');
  assert.equal(resumed.snapshot().inbox[0].answer, 'Продолжать');
  resumed.startTask({ taskId: work.id });
  await until(() => resumed.snapshot().tasks[0].status, (status) => status === 'completed');
});

test('normalizes overnight schedules and runs queued work only during the window', async (t) => {
  const dbPath = database(t);
  const onChange = [];
  const active = Promise.withResolvers();
  let date = new Date(2026, 10, 16, 21); // Monday
  let runs = 0;
  const options = { dbPath, now: () => date, onChange: (value) => onChange.push(value), run: async () => {
    runs += 1;
    if (runs === 1) await active.promise;
    return { text: 'Готово' };
  } };
  let service = createStudioService(options);
  t.after(() => service.close());
  const first = studio(service);
  assert.equal(first.schedule.enabled, false);
  assert.throws(() => service.updateStudio({ studioId: first.id, schedule: { enabled: true, days: [7], start: '9:00', end: '02:00' } }), /расписан/i);
  assert.deepEqual(service.updateStudio({ studioId: first.id, schedule: { enabled: true, days: [5, 1, 1], start: '22:00', end: '02:00' } }).schedule,
    { enabled: true, days: [1, 5], start: '22:00', end: '02:00' });
  const cancelled = task(service, first.id);
  service.startTask({ taskId: cancelled.id });
  assert.equal(service.cancelTask({ taskId: cancelled.id }).status, 'interrupted');
  for (let i = 0; i < 2; i += 1) service.startTask({ taskId: task(service, first.id).id });
  await delay(10);
  assert.equal(runs, 0);
  assert.equal(service.snapshot().studios[0].scheduleWaiting, true);
  await service.close();
  service = createStudioService(options);
  assert.deepEqual(service.snapshot().tasks.map(({ status }) => status), ['interrupted', 'queued', 'queued']);
  date = new Date(2026, 10, 17, 1); // Tuesday, inside Monday's window
  service.refreshSchedules();
  service.refreshSchedules();
  await until(() => runs, (count) => count === 1);
  assert.equal(service.snapshot().studios[0].scheduleWaiting, false);
  date = new Date(2026, 10, 17, 2);
  service.refreshSchedules();
  active.resolve();
  await until(() => onChange.at(-1), ({ studios, tasks }) => studios[0].scheduleWaiting && tasks[1].status === 'completed');
  assert.equal(runs, 1);
  const changes = onChange.length;
  service.refreshSchedules();
  assert.equal(onChange.length, changes);
  service.setStudioRunning({ studioId: first.id, action: 'pause' });
  assert.equal(service.snapshot().studios[0].manualPaused, true);
  date = new Date(2026, 10, 20, 22); // Friday
  service.refreshSchedules();
  await delay(10);
  assert.equal(runs, 1);
  service.setStudioRunning({ studioId: first.id, action: 'resume' });
  await until(service.snapshot, ({ tasks }) => tasks.slice(1).every(({ status }) => status === 'completed'));
  assert.equal(service.snapshot().studios[0].manualPaused, false);
  assert.equal(runs, 2);
});

test('requires the exact current name and removes only that studio while no attempt is active', async (t) => {
  const active = Promise.withResolvers();
  const dbPath = database(t);
  const service = createStudioService({ dbPath, run: async () => { await active.promise; return { text: '{"question":"Нужно решение"}' }; } });
  t.after(() => { active.resolve(); return service.close(); });
  const first = studio(service);
  const second = studio(service, 'Другая');
  const otherTask = task(service, second.id);
  const work = task(service, first.id);
  service.startTask({ taskId: work.id });
  await until(service.snapshot, ({ tasks }) => tasks.some(({ status }) => status === 'running'));
  assert.throws(() => service.deleteStudio({ studioId: first.id, confirmation: first.name }), /выполняется/i);
  active.resolve();
  await until(service.snapshot, ({ inbox }) => inbox.length === 1);
  service.updateStudio({ studioId: first.id, name: 'Словарь' });
  assert.throws(() => service.deleteStudio({ studioId: first.id, confirmation: first.name }), /название/i);
  assert.throws(() => service.deleteStudio({ studioId: first.id, confirmation: ' Словарь' }), /название/i);
  service.startTask({ taskId: task(service, first.id).id });
  assert.deepEqual(service.deleteStudio({ studioId: first.id, confirmation: 'Словарь' }), { studioId: first.id });
  assert.equal(service.wasStudioDeleted(first.id), true);
  assert.equal(service.wasStudioDeleted(second.id), false);
  await delay(10);
  assert.deepEqual(service.snapshot().studios.map(({ id }) => id), [second.id]);
  assert.deepEqual(service.snapshot().tasks, [otherTask]);
  assert.deepEqual(service.snapshot().inbox, []);
  await service.close();
  const restored = createStudioService({ dbPath, run: () => assert.fail('Unexpected run') });
  t.after(() => restored.close());
  assert.equal(restored.wasStudioDeleted(first.id), true);
  assert.equal(restored.wasStudioDeleted(second.id), false);
});
