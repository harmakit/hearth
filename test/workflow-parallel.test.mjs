import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createArtifactStore } from '../app/artifacts.mjs';
import { createStudioService } from '../core/service.mjs';
import { trainingReply } from './fixtures/training.mjs';

const reply = (value) => ({ text: JSON.stringify(value) });

async function until(predicate, diagnostics) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await delay(5);
  }
  assert.fail(`Время ожидания рабочего шага истекло. ${JSON.stringify(diagnostics())}`);
}

test('an owner question frees one of two studio slots and a duplicate answer starts no duplicate work', async (t) => {
  const gates = new Map(['First', 'Second', 'Third'].map((title) => [title, Promise.withResolvers()]));
  const started = [];
  const service = createStudioService({ dbPath: ':memory:', run: async (request) => {
    const training = trainingReply(request);
    if (training) return training;
    if (request.purpose === 'plan') return reply({
      title: 'Parallel sprint', goal: 'Independent deliverables',
      epic: { title: 'Epic', description: 'Description' }, story: { title: 'Story', acceptance: 'All done' },
      agents: [
        { key: 'writer', role: 'editor', description: 'Deliver the result' },
        { key: 'reviewer', role: 'other', description: 'Review the result' },
      ],
      tasks: [...gates.keys()].map((title) => ({
        key: title.toLowerCase(), title, prompt: 'Deliver', criteria: 'Accepted', agentKey: 'writer', reviewerKey: 'reviewer', dependsOn: [],
      })), files: [],
    });
    if (request.purpose === 'review') return reply({ pass: true, summary: 'Pass' });
    if (request.purpose === 'director') return reply({ action: 'finish', summary: 'Complete' });
    const { title, decisions } = JSON.parse(request.prompt.split('\n\n').at(-1));
    started.push({ title, decisions });
    if (decisions.length) return reply({ summary: 'Continued', artifact: 'Result' });
    return gates.get(title).promise;
  } });
  t.after(async () => {
    for (const gate of gates.values()) gate.resolve(reply({ summary: 'Complete', artifact: 'Result' }));
    await service.close();
  });

  const state = () => {
    const { studios, tasks, attempts, inbox } = service.snapshot();
    return { studio: studios[0]?.lifecycle, tasks: tasks.map(({ title, status, stage }) => [title, status, stage]), started,
      attempts: attempts.map(({ purpose, status, error }) => [purpose, status, error]), inbox: inbox.map(({ kind, body }) => ({ kind, body })) };
  };
  const { id: studioId } = service.createStudio({ name: 'Study', root: '/project', wipLimit: 2 });
  service.initializeStudio({ studioId });
  const plan = await until(() => service.snapshot().plans[0], state);
  service.decidePlan({ planId: plan.id, decision: 'approve' });
  await until(() => started.length === 2, state);
  assert.deepEqual(started.map(({ title }) => title), ['First', 'Second']);

  gates.get('First').resolve(reply({ summary: 'Draft', artifact: 'Draft', question: 'Proceed?' }));
  const item = await until(() => service.snapshot().inbox.find(({ kind, status }) => kind === 'question' && status === 'open'), state);
  await until(() => started.length === 3, state);
  assert.equal(started[2].title, 'Third');
  assert.equal(service.snapshot().tasks.find(({ id }) => id === item.taskId).status, 'waiting');

  const response = { inboxId: item.id, answer: 'Yes' };
  service.answerInbox(response);
  try { service.answerInbox(response); } catch (error) { assert.match(error.message, /закрыт/); }
  gates.get('Second').resolve(reply({ summary: 'Complete', artifact: 'Result' }));
  gates.get('Third').resolve(reply({ summary: 'Complete', artifact: 'Result' }));
  await until(() => service.snapshot().sprints.find(({ status }) => status === 'completed'), state);
  assert.equal(started.filter(({ title }) => title === 'First').length, 2);
  assert.deepEqual(started.find(({ decisions }) => decisions.length).decisions, [{ question: 'Proceed?', answer: 'Yes' }]);
});

test('a published file survives interruption before the workflow records it and retries by the same operation', async (t) => {
  const base = new URL('../.tmp/', import.meta.url);
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(new URL('interrupted-artifact-', base));
  const root = join(directory, 'project');
  await mkdir(root);
  const store = createArtifactStore({ receipts: join(directory, 'receipts'), validateRoot: realpath });
  const acknowledgeWrite = Promise.withResolvers();
  const writes = [];
  let fileLinked = false;
  let workerCalls = 0;
  const options = {
    dbPath: join(directory, 'studio.sqlite'),
    async writeArtifact(input) {
      writes.push(input.operationId);
      const result = await store.write(input);
      if (writes.length === 1) {
        fileLinked = true;
        await acknowledgeWrite.promise;
      }
      return result;
    },
    async run(request) {
      const training = trainingReply(request);
      if (training) return training;
      if (request.purpose === 'plan') return reply({
        title: 'One result', goal: 'Publish an artifact',
        epic: { title: 'Epic', description: 'Description' }, story: { title: 'Story', acceptance: 'All done' },
        agents: [{ key: 'writer', role: 'editor', description: 'Write' }, { key: 'reviewer', role: 'other', description: 'Review' }],
        tasks: [{ key: 'write', title: 'Write', prompt: 'Publish', criteria: 'Accepted', agentKey: 'writer', reviewerKey: 'reviewer', dependsOn: [], artifactPath: 'result.md' }],
        files: [],
      });
      if (request.purpose === 'review') return reply({ pass: true, summary: 'Pass' });
      if (request.purpose === 'director') return reply({ action: 'finish' });
      workerCalls += 1;
      return reply({ summary: 'Written', artifact: '# Result\n' });
    },
  };
  let service = createStudioService(options);
  t.after(async () => {
    acknowledgeWrite.resolve();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  const diagnostics = () => service.snapshot().attempts.map(({ purpose, status, error }) => ({ purpose, status, error }));
  const { id: studioId } = service.createStudio({ name: 'Recovery', root, groomingPolicy: { enabled: false } });
  service.initializeStudio({ studioId });
  const plan = await until(() => service.snapshot().plans[0], diagnostics);
  service.decidePlan({ planId: plan.id, decision: 'approve' });
  await until(() => fileLinked, diagnostics);
  service.setStudioRunning({ studioId, action: 'stop' });
  const hold = service.snapshot().inbox.find(({ kind }) => kind === 'reconcile');
  assert.ok(hold);
  assert.throws(() => service.resolveReconciliation({ attemptId: hold.attemptId, decision: 'retry', reason: 'Проверено' }), /выполняется/);
  acknowledgeWrite.resolve();
  await service.close();

  service = createStudioService(options);
  assert.equal(service.snapshot().inbox.find(({ id }) => id === hold.id).status, 'open');
  assert.equal(await readFile(join(root, 'result.md'), 'utf8'), '# Result\n');
  service.resolveReconciliation({ attemptId: hold.attemptId, decision: 'retry', reason: 'Прежний процесс завершён, файл проверен' });
  service.setStudioRunning({ studioId, action: 'resume' });
  await until(() => service.snapshot().sprints.find(({ status }) => status === 'completed'), diagnostics);
  assert.equal(workerCalls, 1);
  assert.deepEqual(writes, [writes[0], writes[0]]);
  assert.deepEqual(service.snapshot().tasks.find(({ title }) => title === 'Write').artifactVersions, ['result.md']);
});
