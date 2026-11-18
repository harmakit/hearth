import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createStudioService } from '../core/service.mjs';

const draft = {
  title: 'Sprint', goal: 'Write a brief',
  epic: { title: 'Book', description: 'Book project' },
  story: { title: 'Outline', acceptance: 'Reader understands the outline' },
  agents: [
    { key: 'writer', role: 'editor', description: 'Write the outline' },
    { key: 'reviewer', role: 'other', description: 'Verify the outline' },
  ],
  tasks: [
    { key: 'first', title: 'First', prompt: 'Write it', criteria: 'Has a heading', agentKey: 'writer', reviewerKey: 'reviewer', dependsOn: [], artifactPath: 'outline.md' },
    { key: 'second', title: 'Second', prompt: 'Summarize it', criteria: 'One paragraph', agentKey: 'writer', reviewerKey: 'reviewer', dependsOn: ['first'] },
  ],
  files: [],
};

async function until(read, predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = read();
    if (predicate(value)) return value;
    await delay(5);
  }
  assert.fail(JSON.stringify(read()));
}

function database(t) {
  const base = fileURLToPath(new URL('../.tmp', import.meta.url));
  mkdirSync(base, { recursive: true });
  const folder = mkdtempSync(join(base, 'workflow-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return join(folder, 'studio.sqlite');
}

test('approval creates one dependency-aware sprint, writes the artifact and runs review and director', async (t) => {
  const calls = [];
  const writes = [];
  let decisions = 0;
  const service = createStudioService({
    dbPath: ':memory:',
    run: async ({ purpose }) => {
      calls.push(purpose);
      const result = {
        plan: () => draft,
        task: () => ({ summary: 'Done', artifact: '# Outline' }),
        review: () => ({ pass: true, summary: 'Accepted' }),
        director: () => (++decisions === 1 ? { action: 'next', taskKey: 'second' } : { action: 'nextSprint' }),
      };
      return { text: JSON.stringify(result[purpose]()) };
    },
    writeArtifact: async (request) => {
      writes.push(request);
      return { path: request.path };
    },
  });
  t.after(() => service.close());
  const { id: studioId } = service.createStudio({ name: 'Writer', root: '/project' });
  service.initializeStudio({ studioId });
  const { plans: [plan] } = await until(service.snapshot, ({ plans }) => plans.some(({ status }) => status === 'pending'));
  assert.deepEqual(calls, ['plan']);
  assert.equal(service.snapshot().tasks.length, 0);
  service.decidePlan({ planId: plan.id, decision: 'approve' });
  service.decidePlan({ planId: plan.id, decision: 'approve' });
  const snapshot = await until(service.snapshot, ({ plans }) => plans.some(({ kind, status }) => kind === 'sprint' && status === 'pending'));
  assert.deepEqual(calls, ['plan', 'task', 'review', 'director', 'task', 'review', 'director', 'plan']);
  assert.deepEqual(snapshot.tasks.map(({ stage }) => stage), ['done', 'done']);
  assert.deepEqual(snapshot.tasks[1].dependencies, [snapshot.tasks[0].id]);
  assert.equal(snapshot.tasks[0].artifactPath, 'outline.md');
  assert.equal(writes.length, 1);
  assert.deepEqual(snapshot.meetings.map(({ kind }) => kind), ['planning', 'retrospective']);
});

test('invalid dependency graphs fail planning before creating studio records', async (t) => {
  const invalid = structuredClone(draft);
  invalid.tasks[0].dependsOn = ['second'];
  const service = createStudioService({ dbPath: ':memory:', run: async () => ({ text: JSON.stringify(invalid) }) });
  t.after(() => service.close());
  const { id: studioId } = service.createStudio({ name: 'Writer', root: '/project' });
  service.initializeStudio({ studioId });
  const snapshot = await until(service.snapshot, ({ studios }) => studios[0].lifecycle === 'error');
  assert.equal(snapshot.tasks.length, 0);
  assert.equal(snapshot.studios[0].agents.length, 0);
  assert.equal(snapshot.inbox[0].kind, 'error');
});

test('a revised initialization survives restart and later plans can run without approval', async (t) => {
  const dbPath = database(t);
  const calls = [];
  const solo = { ...draft, tasks: [{ ...draft.tasks[0], artifactPath: undefined }] };
  let finishedSprints = 0;
  const run = async ({ purpose, prompt }) => {
    calls.push({ purpose, prompt });
    const result = {
      plan: () => solo,
      task: () => ({ summary: 'Done' }),
      review: () => ({ pass: true, summary: 'Accepted' }),
      director: () => ({ action: ++finishedSprints === 1 ? 'nextSprint' : 'finish' }),
    };
    return { text: JSON.stringify(result[purpose]()) };
  };
  let service = createStudioService({ dbPath, run });
  t.after(() => service.close());
  const { id: studioId } = service.createStudio({ name: 'Writer', root: '/project', approveSprints: false, projectLanguage: 'English' });
  service.initializeStudio({ studioId });
  const original = (await until(service.snapshot, ({ plans }) => plans.length === 1)).plans[0];
  service.decidePlan({ planId: original.id, decision: 'revise', feedback: 'Use shorter paragraphs' });
  const [, revised] = (await until(service.snapshot, ({ plans }) => plans.length === 2)).plans;
  assert.match(calls.at(-1).prompt, /Use shorter paragraphs/);
  assert.match(calls.at(-1).prompt, /"projectLanguage": "English"/);
  await service.close();
  service = createStudioService({ dbPath, run });
  assert.equal(service.snapshot().plans[0].status, 'returned');
  assert.equal(service.snapshot().plans[1].id, revised.id);
  assert.equal(service.snapshot().studios[0].lifecycle, 'awaiting-approval');
  assert.throws(() => service.decidePlan({ planId: original.id, decision: 'approve' }));
  service.decidePlan({ planId: revised.id, decision: 'approve' });
  const snapshot = await until(service.snapshot, ({ studios }) => studios[0].lifecycle === 'idle');
  assert.deepEqual(snapshot.plans.map(({ status }) => status), ['returned', 'approved', 'approved']);
  assert.deepEqual(snapshot.inbox.map(({ status }) => status), ['resolved', 'resolved']);
  assert.equal(snapshot.studios[0].agents.length, 2);
  assert.equal(snapshot.sprints.filter(({ status }) => status === 'completed').length, 2);
});

test('a failed write stops before review and resumes the exact write without rerunning the worker', async (t) => {
  const writes = [];
  const calls = [];
  const service = createStudioService({
    dbPath: ':memory:',
    run: async ({ purpose }) => {
      calls.push(purpose);
      return { text: JSON.stringify(purpose === 'plan' ? draft : { summary: 'Written', artifact: '# Outline\n' }) };
    },
    writeArtifact: async (record) => {
      writes.push(record);
      throw new Error('File exists');
    },
  });
  t.after(() => service.close());
  const { id: studioId } = service.createStudio({ name: 'Writer', root: '/project' });
  service.initializeStudio({ studioId });
  const { plans: [plan] } = await until(service.snapshot, ({ plans }) => plans.length);
  service.decidePlan({ planId: plan.id, decision: 'approve' });
  await until(service.snapshot, ({ studios }) => studios[0].lifecycle === 'error');
  service.setStudioRunning({ studioId, action: 'resume' });
  const snapshot = await until(service.snapshot, ({ studios }) => studios[0].lifecycle === 'error');
  assert.deepEqual(calls, ['plan', 'task']);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], writes[1]);
  assert.equal(writes[0].content, '# Outline\n');
  assert.equal(snapshot.tasks[0].artifactPath, undefined);
  assert.equal(snapshot.tasks[0].stage, 'blocked');
  assert.equal(snapshot.tasks[1].stage, 'backlog');
});

test('rework publishes a distinct file and a reviewer routed by the director sees both paths', async (t) => {
  const writes = [];
  const reviewPrompts = [];
  const routingPrompts = [];
  let reviewerId;
  let work = 0;
  const service = createStudioService({
    dbPath: ':memory:',
    run: async ({ purpose, runtime, prompt }) => {
      const result = {
        plan: () => ({
          ...draft, agents: [draft.agents[0]], tasks: [{ ...draft.tasks[0], reviewerKey: reviewerId }],
        }),
        task: () => {
          assert.equal(runtime, 'codex');
          return { summary: 'Draft', artifact: `# Version ${++work}` };
        },
        'select-model': () => {
          assert.equal(runtime, 'codex');
          routingPrompts.push(prompt);
          return { runtime: 'claude', model: 'reader', effort: 'high' };
        },
        review: () => {
          assert.equal(runtime, 'claude');
          reviewPrompts.push(prompt);
          return { pass: reviewPrompts.length === 2, summary: 'Reviewed' };
        },
        director: () => ({ action: 'finish' }),
      };
      return { text: JSON.stringify(result[purpose]()) };
    },
    writeArtifact: async (record) => {
      assert.ok(!writes.some(({ path }) => path === record.path));
      writes.push(record);
      return { path: record.path };
    },
  });
  t.after(() => service.close());
  const { id: studioId } = service.createStudio({ name: 'Writer', root: '/project', allowed: [
    { runtime: 'codex', model: 'director', efforts: [] },
    { runtime: 'claude', model: 'reader', efforts: ['high'] },
  ] });
  ({ id: reviewerId } = service.addAgent({ studioId, role: 'editor', mode: 'dynamic' }));
  service.initializeStudio({ studioId });
  const { plans: [plan] } = await until(service.snapshot, ({ plans }) => plans.length);
  service.decidePlan({ planId: plan.id, decision: 'approve' });
  const snapshot = await until(service.snapshot, ({ studios }) => studios[0].lifecycle === 'idle');
  assert.deepEqual(writes.map(({ path }) => path), ['outline.md', 'outline-v2.md']);
  assert.notEqual(writes[0].operationId, writes[1].operationId);
  assert.equal(routingPrompts.length, 2);
  assert.match(routingPrompts[0], /"purpose": "review"/);
  assert.match(reviewPrompts[1], /"artifactPath": "outline-v2.md"/);
  assert.match(reviewPrompts[1], /"previousArtifactPath": "outline.md"/);
  assert.equal(snapshot.tasks[0].artifactPath, 'outline-v2.md');
});

test('snapshot import commits related records atomically without starting them', async (t) => {
  let service = createStudioService({ dbPath: database(t), run: async () => assert.fail('unexpected provider run') });
  t.after(() => service.close());
  const payload = {
    studio: { id: 'new-studio', root: '/work', name: 'Copy', lifecycle: 'paused' },
    epics: [{ id: 'epic', title: 'Book' }],
    tasks: [{ id: 'task', title: 'Copy', epicId: 'epic', sprintId: 'sprint', status: 'running' }],
    sprints: [{ id: 'sprint', title: 'First', taskIds: ['task'] }],
    meetings: [{ id: 'meeting', kind: 'planning', sprintId: 'sprint' }],
  };
  assert.throws(() => service.importStudio({ ...payload, tasks: [{ ...payload.tasks[0], epicId: 'missing' }] }), /epicId/);
  assert.equal(service.snapshot().studios.length, 0);
  const imported = service.importStudio(payload);
  assert.throws(() => service.importStudio({ ...payload, studio: { ...payload.studio, id: 'other' } }));
  const snapshot = service.snapshot();
  assert.equal(snapshot.studios.length, 1);
  assert.equal(snapshot.tasks[0].studioId, imported.id);
  assert.equal(snapshot.tasks[0].status, 'interrupted');
  assert.equal(snapshot.meetings[0].sprintId, snapshot.sprints[0].id);
  assert.equal(snapshot.sprints[0].taskIds[0], snapshot.tasks[0].id);
});

test('studio controls pause the manual queue and stop both running and queued manual work', async (t) => {
  const actions = new Map();
  const service = createStudioService({
    dbPath: ':memory:',
    run: ({ prompt, signal }) => new Promise((resolve, reject) => {
      const title = ['First', 'Second', 'Third'].find((value) => prompt.includes(value));
      actions.set(title, () => resolve({ text: 'Done' }));
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  t.after(() => service.close());
  const { id: studioId } = service.createStudio({ name: 'Writer', root: '/project' });
  const [first, second, third] = ['First', 'Second', 'Third'].map((title) => service.createTask({ studioId, title, prompt: title }));
  service.startTask({ taskId: first.id });
  service.startTask({ taskId: second.id });
  await until(service.snapshot, ({ tasks }) => tasks[0].status === 'running');
  service.setStudioRunning({ studioId, action: 'pause' });
  actions.get('First')();
  await until(service.snapshot, ({ tasks }) => tasks[0].status === 'completed');
  assert.equal(actions.has('Second'), false);
  service.setStudioRunning({ studioId, action: 'resume' });
  await until(service.snapshot, ({ tasks }) => tasks[1].status === 'running');
  service.startTask({ taskId: third.id });
  service.setStudioRunning({ studioId, action: 'stop' });
  assert.deepEqual(service.snapshot().tasks.map(({ status }) => status), ['completed', 'interrupted', 'interrupted']);
  service.setStudioRunning({ studioId, action: 'resume' });
  await delay(10);
  assert.equal(actions.has('Third'), false);
  assert.equal(service.snapshot().studios[0].lifecycle, 'draft');
});

test('a studio can change a draft root and settings but cannot relocate tracked work', async (t) => {
  const plan = { ...draft, tasks: [draft.tasks[0]] };
  const service = createStudioService({
    dbPath: ':memory:',
    run: async ({ purpose }) => ({
      text: JSON.stringify({
        plan, task: { artifact: '# Outline' }, review: { pass: true, summary: 'Accepted' }, director: { action: 'finish' },
      }[purpose]),
    }),
    writeArtifact: async ({ path }) => ({ path }),
  });
  t.after(() => service.close());
  const { id: studioId } = service.createStudio({ name: 'Writer', root: '/project' });
  assert.equal(service.updateStudio({ studioId, root: '/redirect' }).root, '/redirect');
  service.initializeStudio({ studioId });
  assert.throws(() => service.updateStudio({ studioId, root: '/old-project' }), /Папка/);
  const { plans: [pending] } = await until(service.snapshot, ({ plans }) => plans.length);
  service.decidePlan({ planId: pending.id, decision: 'approve' });
  await until(service.snapshot, ({ studios }) => studios[0].lifecycle === 'idle');
  assert.throws(() => service.updateStudio({ studioId, root: '/other-project' }), /Папка/);
  assert.equal(service.updateStudio({ studioId, name: 'Updated', approveSprints: false }).name, 'Updated');
  assert.equal(service.snapshot().studios[0].root, '/redirect');
});

test('replying to a held imported task records the decision and still requires worktree confirmation', async (t) => {
  const calls = [];
  const service = createStudioService({
    dbPath: ':memory:',
    run: async ({ prompt }) => {
      calls.push(prompt);
      return { text: 'Done' };
    },
  });
  t.after(() => service.close());
  service.importStudio({
    studio: { id: 'store', name: 'Copy', root: '/work', lifecycle: 'paused' },
    sprints: [{ id: 'old-sprint', title: 'Previous' }],
    tasks: [{ id: 'held', title: 'Bound to a worktree', sprintId: 'old-sprint', status: 'waiting', stage: 'blocked', legacyWorktreeReview: true }],
    inbox: [{ id: 'question', taskId: 'held', kind: 'question', title: 'Decision', body: 'Which heading?', status: 'open' }],
  });
  service.answerInbox({ inboxId: 'question', answer: 'Working title' });
  assert.equal(service.snapshot().tasks[0].status, 'interrupted');
  assert.equal(service.snapshot().inbox[0].answer, 'Working title');
  assert.throws(() => service.startTask({ taskId: 'held' }), /рабочего дерева/);
  service.startTask({ taskId: 'held', confirmLegacy: true });
  const snapshot = await until(service.snapshot, ({ tasks }) => tasks[0].status === 'completed');
  assert.equal(snapshot.tasks[0].legacyWorktreeReview, false);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /Working title/);
});
