import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createStudioService as createService } from '../core/service.mjs';
import { productionSnapshot, trainingReply } from './fixtures/training.mjs';

function createStudioService({ run, ...settings }) {
  const service = createService({ ...settings, run: (request) => trainingReply(request) ?? run(request) });
  return {
    ...service,
    createStudio: input => service.createStudio({ wipLimit: 1, groomingPolicy: { enabled: false }, ...input }),
    snapshot: () => productionSnapshot(service.snapshot()),
  };
}

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

test('owner can edit pending assignments and checkpoints before approving the displayed revision', async t => {
  const service = createStudioService({ dbPath: ':memory:', run: async () => ({ text: JSON.stringify(draft) }) });
  t.after(() => service.close());
  const { id: studioId } = service.createStudio({ name: 'Docs', root: '/project' });
  service.initializeStudio({ studioId });
  const { plans: [plan] } = await until(service.snapshot, s => s.plans.length === 1);
  const edits = [{key:'second', title:'Review chapter', agentKey:'reviewer', reviewerKey:'writer', requiresAcceptance:true}];
  const patch = { planId: plan.id, expectedEditVersion: 0, tasks: edits };
  assert.throws(()=>service.updatePlanTasks({...patch,tasks:[{...edits[0],modelOverride:{runtime:'codex',model:'unknown',effort:'high'}}]}),/разреш/);
  assert.throws(() => service.updatePlanTasks({...patch, tasks:[{...edits[0], reviewerKey:'reviewer'}]}), /проверяющ/);
  const updated = service.updatePlanTasks(patch);
  assert.equal(updated.editVersion, 1);
  assert.deepEqual(updated.tasks[1], {...plan.tasks[1], ...edits[0]});
  assert.throws(() => service.updatePlanTasks(patch), /измен/);
  assert.throws(() => service.decidePlan({planId:plan.id, decision:'approve', expectedEditVersion:0}), /измен/);
  service.decidePlan({planId:plan.id, decision:'approve', expectedEditVersion:1});
  const saved = service.snapshot().tasks.find(t=>t.key==='second');
  assert.equal(saved.requiresAcceptance,true);
  assert.equal(saved.title,'Review chapter');
});

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

test('initial plan recommends an allowed tuple but executes the owner’s saved fixed choice', async (t) => {
  const calls = [];
  let reviewerKey;
  const recommendation = { runtime: 'codex', model: 'light', effort: 'low' };
  const fixed = { runtime: 'claude', model: 'deep', effort: 'high' };
  const allowed = [{ runtime: 'codex', model: 'light', efforts: ['low'] }, { runtime: 'claude', model: 'deep', efforts: ['high'] }];
  const service = createStudioService({ dbPath: ':memory:', run: async ({ purpose, runtime, model, effort, prompt }) => {
    calls.push({ purpose, runtime, model, effort, prompt });
    const results = {
      plan: { ...draft, agents: [
        { ...draft.agents[0], roleTitle: 'Редактор концепции', recommendation },
        { ...draft.agents[1], key: reviewerKey, recommendation: { ...recommendation, effort: 'unlisted' } },
      ], tasks: [{ ...draft.tasks[0], reviewerKey, artifactPath: undefined }] },
      task: { summary: 'Done' }, review: { pass: true, summary: 'Accepted' }, director: { action: 'finish' },
    };
    return { text: JSON.stringify(results[purpose]) };
  } });
  t.after(() => service.close());
  assert.deepEqual(service.snapshot().modelPolicy, { configured: false, allowed: [] });
  service.updateModelPolicy({ allowed });
  const { id: studioId } = service.createStudio({ name: 'Writer', root: '/project' });
  ({ id: reviewerKey } = service.addAgent({ studioId, role: 'other', name: 'Старое имя', mode: 'dynamic' }));
  service.initializeStudio({ studioId });
  const { plans: [plan], studios: [studio] } = await until(service.snapshot, ({ plans }) => plans.length === 1);
  assert.deepEqual(studio.effectiveAllowed, allowed);
  assert.deepEqual(JSON.parse(calls[0].prompt.split('\n\n').at(-1)).allowed, allowed);
  assert.deepEqual(plan.agents[0].recommendation, recommendation);
  assert.equal(plan.agents[0].roleTitle, 'Редактор концепции');
  assert.equal(plan.agents[0].mode, 'dynamic');
  assert.equal(plan.agents[1].recommendation, undefined);
  const edit = { key: 'writer', mode: 'fixed', ...fixed, name: 'Мария', roleTitle: 'Главный редактор' };
  assert.throws(() => service.updatePlanAgents({ planId: plan.id, agents: [edit, { key: 'unknown' }] }), /ключ/);
  assert.deepEqual(service.snapshot().plans[0], plan);
  assert.throws(() => service.updatePlanAgents({ planId: plan.id, agents: [{ ...edit, effort: 'unlisted' }] }), /разрешённом/);
  service.updatePlanAgents({ planId: plan.id, agents: [edit, { key: reviewerKey, roleTitle: 'Рецензент', mode: 'inherit' }] });
  service.updateModelPolicy({ allowed: [allowed[0]] });
  assert.throws(() => service.decidePlan({ planId: plan.id, decision: 'approve' }), /разрешённом/);
  assert.equal(service.snapshot().plans[0].status, 'pending');
  assert.equal(service.snapshot().inbox[0].status, 'open');
  service.updateModelPolicy({ allowed });
  service.decidePlan({ planId: plan.id, decision: 'approve' });
  const finished = await until(service.snapshot, ({ sprints }) => sprints[0]?.status === 'completed');
  const { name, roleTitle, role, mode, runtime, model, effort } = finished.studios[0].agents.find(({ key }) => key === 'writer');
  assert.deepEqual({ name, roleTitle, role, mode, runtime, model, effort }, { name: 'Мария', roleTitle: 'Главный редактор', role: 'editor', mode: 'fixed', ...fixed });
  const { prompt, ...workerCall } = calls.find(({ purpose }) => purpose === 'task');
  assert.deepEqual(workerCall, { purpose: 'task', ...fixed });
  assert.equal(JSON.parse(prompt.split('\n\n').at(-1)).roleTitle, 'Главный редактор');
  const review = calls.find(({ purpose }) => purpose === 'review');
  assert.equal(JSON.parse(review.prompt.split('\n\n').at(-1)).reviewer.roleTitle, 'Рецензент');
  assert.equal(finished.studios[0].agents.find(({ id }) => id === reviewerKey).name, 'Старое имя');
});

test('the initial sprint uses allowed dynamic recommendations and reroutes stale ones', async (t) => {
  const calls = [];
  const planModel = { runtime: 'claude', model: 'proposed', effort: 'low' };
  const staleModel = { runtime: 'codex', model: 'stale', effort: '' };
  const replacement = { runtime: 'claude', model: 'replacement', effort: 'high' };
  const allowed = [planModel, staleModel, replacement].map(({ effort, ...choice }) => ({ ...choice, efforts: effort ? [effort] : [] }));
  const service = createStudioService({ dbPath: ':memory:', run: async ({ purpose, model }) => {
    calls.push([purpose, model]);
    const results = {
      plan: { ...draft, agents: [
        { ...draft.agents[0], recommendation: planModel }, { ...draft.agents[1], recommendation: staleModel },
      ], tasks: [{ ...draft.tasks[0], artifactPath: undefined }] },
      'select-model': replacement, task: { summary: 'Done' }, review: { pass: true, summary: 'Accepted' }, director: { action: 'finish' },
    };
    return { text: JSON.stringify(results[purpose]) };
  } });
  t.after(() => service.close());
  service.updateModelPolicy({ allowed });
  const { id: studioId } = service.createStudio({ name: 'Writer', root: '/project' });
  service.initializeStudio({ studioId });
  const { plans: [plan] } = await until(service.snapshot, ({ plans }) => plans.length === 1);
  service.decidePlan({ planId: plan.id, decision: 'approve' });
  service.updateModelPolicy({ allowed: [allowed[0], allowed[2]] });
  await until(service.snapshot, ({ sprints }) => sprints[0]?.status === 'completed');
  assert.deepEqual(calls, [['plan', undefined], ['task', 'proposed'], ['select-model', undefined], ['review', 'replacement'], ['director', undefined]]);
});

test('the Director can assess and save debt settings using current studio data', async (t) => {
  const calls = [];
  let release;
  let answer = { enabled: true, every: 2, minShare: 70, minOpenTasks: 1, measure: 'points', reason: 'Есть незакрытая задача.' };
  const service = createStudioService({
    dbPath: ':memory:', now: () => new Date('2026-11-18T10:00:00Z'),
    run: async request => {
      calls.push(request);
      if (release) await release.promise;
      return { text: JSON.stringify(answer) };
    },
  });
  t.after(() => service.close());
  const { id: studioId } = service.createStudio({
    name: 'Writer', root: '/project', director: { runtime: 'claude', model: 'director', effort: 'high' },
  });
  const debt = service.createTask({ studioId, kind: 'debt', title: 'Unify chapter headings', prompt: 'Create a consistent format.' });
  const result = await service.assessDebtPolicy({ studioId });
  assert.deepEqual(service.snapshot().studios[0].debtPolicy, { enabled: true, every: 2, minShare: 70, minOpenTasks: 1, measure: 'points' });
  assert.deepEqual(result.debtAssessment, { reason: answer.reason, assessedAt: '2026-11-18T10:00:00.000Z' });
  const { prompt, signal, ...call } = calls[0];
  assert.deepEqual(call, { runtime: 'claude', model: 'director', effort: 'high', projectRoot: '/project', purpose: 'assess-debt' });
  assert.equal(signal.aborted, false);
  assert.ok(prompt.includes(debt.title));
  answer = { ...answer, every: 100 };
  await assert.rejects(service.assessDebtPolicy({ studioId }), /период/i);
  assert.equal(service.snapshot().studios[0].debtPolicy.every, 2);
  release = Promise.withResolvers();
  answer = { ...answer, every: 2 };
  const assessment = service.assessDebtPolicy({ studioId });
  service.updateStudio({ studioId, debtPolicy: { enabled: false, every: 5, minShare: 60, minOpenTasks: 2 } });
  release.resolve();
  await assert.rejects(assessment, /изменились/i);
  assert.equal(service.snapshot().studios[0].debtPolicy.every, 5);
  assert.equal(service.snapshot().studios[0].debtAssessment, undefined);
});

test('debt mode starts after onboarding and schedules an existing open debt item once', async (t) => {
  let debt;
  let plans = 0;
  let decisions = 0;
  let context;
  const service = createStudioService({ dbPath: ':memory:', run: async ({ purpose, prompt }) => {
    if (purpose === 'plan') {
      plans++;
      context = JSON.parse(prompt.split('\n\n').at(-1));
      const task = { ...draft.tasks[0], artifactPath: undefined };
      return { text: JSON.stringify({ ...draft, tasks: [plans === 1 ? task : { ...task, kind: 'debt', debtTaskId: debt.id }] }) };
    }
    if (purpose === 'director') return { text: JSON.stringify({ action: decisions++ === 0 ? 'nextSprint' : 'finish' }) };
    const results = {
      task: { summary: 'Done' }, review: { pass: true, summary: 'Accepted' },
    };
    return { text: JSON.stringify(results[purpose]) };
  } });
  t.after(() => service.close());
  const { id: studioId } = service.createStudio({
    name: 'Writer', root: '/project', debtPolicy: { enabled: true, every: 1, minShare: 100, minOpenTasks: 1 },
  });
  debt = service.createTask({ studioId, kind: 'debt', title: 'Reorganize drafts', prompt: 'Group by chapter.' });
  service.initializeStudio({ studioId });
  const first = (await until(service.snapshot, ({ plans }) => plans.length === 1)).plans[0];
  assert.equal(first.debtSprint, undefined);
  assert.equal(context.debt?.active ?? false, false);
  service.decidePlan({ studioId, planId: first.id, decision: 'approve' });
  const second = (await until(service.snapshot, ({ plans }) => plans.length === 2)).plans[1];
  assert.equal(second.debtSprint, true);
  assert.equal(context.debt.active, true);
  assert.equal(context.debt.items[0].id, debt.id);
  service.updatePlanTasks({planId:second.id, expectedEditVersion:0,
    tasks:second.tasks.map(t => ({...t, title:'Owner revised title', requiresAcceptance:false}))});
  service.decidePlan({ studioId, planId: second.id, decision: 'approve' });
  const done = await until(service.snapshot, ({ sprints }) => sprints.every(({ status }) => status === 'completed'));
  assert.equal(done.sprints[1].debtSprint, true);
  assert.equal(done.tasks.find(({ id }) => id === debt.id).stage, 'done');
  assert.equal(done.tasks.find(({ id }) => id === debt.id).title, 'Owner revised title');
  assert.equal(done.tasks.filter(({ kind }) => kind === 'debt').length, 1);
});

test('initial team editing includes referenced agents omitted by the planner or older saves', async (t) => {
  const dbPath = database(t);
  let workerKey;
  let reviewerKey;
  const run = async () => ({ text: JSON.stringify({ ...draft, agents: [], tasks: [
    { ...draft.tasks[0], agentKey: workerKey, reviewerKey, artifactPath: undefined },
  ] }) });
  let service = createStudioService({ dbPath, run });
  t.after(() => service.close());
  const { id: studioId } = service.createStudio({ name: 'Writer', root: '/project' });
  const worker = service.addAgent({ studioId, role: 'editor', name: 'Ирина', roleTitle: 'Редактор', description: 'Ведёт рукопись', mode: 'inherit' });
  const reviewer = service.addAgent({ studioId, role: 'other', name: 'Николай', mode: 'dynamic' });
  workerKey = worker.id;
  reviewerKey = reviewer.id;
  service.addAgent({ studioId, role: 'artist', name: 'Анна' });
  service.initializeStudio({ studioId });
  const { plans: [plan] } = await until(service.snapshot, ({ plans }) => plans.length === 1);
  const { id: workerId, trainingStatus, trainingTaskId, skillIds, ...workerSettings } = worker;
  assert.deepEqual(plan.agents.map(({ key }) => key), [workerId, reviewer.id]);
  assert.deepEqual(plan.agents[0], { key: workerId, ...workerSettings });
  service.setStudioRunning({ studioId, action: 'pause' });
  await service.close();

  const db = new DatabaseSync(dbPath);
  db.prepare('UPDATE plans SET data = ? WHERE id = ?').run(JSON.stringify({ ...plan, agents: [] }), plan.id);
  db.close();
  service = createStudioService({ dbPath, run });
  assert.deepEqual(service.snapshot().plans[0].agents, plan.agents);
  service.updatePlanAgents({ planId: plan.id, agents: [{ key: workerId, roleTitle: 'Главный редактор' }] });
  service.decidePlan({ planId: plan.id, decision: 'approve' });
  const [savedWorker, savedReviewer] = service.snapshot().studios[0].agents.filter(({ systemRole }) => !systemRole);
  assert.deepEqual(savedWorker, { ...worker, roleTitle: 'Главный редактор' });
  const { roleTitle: unusedTitle, ...reviewerSettings } = reviewer;
  assert.deepEqual(savedReviewer, reviewerSettings);
});

test('approval creates one dependency-aware sprint, writes the artifact and runs review and director', async (t) => {
  const calls = [];
  const writes = [];
  let decisions = 0;
  const service = createStudioService({
    dbPath: ':memory:',
    run: async ({ purpose }) => {
      calls.push(purpose);
      const result = {
        plan: () => decisions ? { ...draft, tasks: [{ ...draft.tasks[0], artifactPath: 'next-outline.md' }, draft.tasks[1]] } : draft,
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

test('scheduled workflows retain a queued continuation after hours, manual pause, and restart', async (t) => {
  const dbPath = database(t);
  const calls = [];
  const taskStarted = Promise.withResolvers();
  const finishTask = Promise.withResolvers();
  let date = new Date(2026, 10, 16, 8);
  const options = {
    dbPath, now: () => date,
    run: async ({ purpose }) => {
      calls.push(purpose);
      if (purpose === 'task') {
        taskStarted.resolve();
        await finishTask.promise;
      }
      const results = {
        plan: { ...draft, tasks: [{ ...draft.tasks[0], artifactPath: undefined }] },
        task: { summary: 'Done' }, review: { pass: true, summary: 'Accepted' }, director: { action: 'finish' },
      };
      return { text: JSON.stringify(results[purpose]) };
    },
  };
  let service = createStudioService(options);
  t.after(() => { finishTask.resolve(); return service.close(); });
  const { id: studioId } = service.createStudio({ name: 'Writer', root: '/project', schedule: { enabled: true, days: [1], start: '09:00', end: '18:00' } });
  service.initializeStudio({ studioId });
  await delay(10);
  assert.deepEqual(calls, []);
  assert.equal(service.snapshot().studios[0].scheduleWaiting, true);
  date = new Date(2026, 10, 16, 9);
  service.refreshSchedules();
  const { plans: [plan] } = await until(service.snapshot, ({ plans }) => plans.length === 1);
  date = new Date(2026, 10, 16, 18);
  service.setStudioRunning({ studioId, action: 'pause' });
  service.decidePlan({ planId: plan.id, decision: 'approve' });
  await delay(10);
  assert.deepEqual(calls, ['plan']);
  assert.equal(service.snapshot().plans[0].status, 'approved');
  date = new Date(2026, 10, 23, 17);
  service.refreshSchedules();
  await delay(10);
  assert.deepEqual(calls, ['plan']);
  assert.equal(service.snapshot().studios[0].lifecycle, 'paused');
  service.setStudioRunning({ studioId, action: 'resume' });
  await taskStarted.promise;
  date = new Date(2026, 10, 23, 18);
  finishTask.resolve();
  await until(service.snapshot, ({ studios }) => studios[0].scheduleWaiting);
  assert.deepEqual(calls, ['plan', 'task']);
  await service.close();
  service = createStudioService(options);
  service.setStudioRunning({ studioId, action: 'pause' });
  date = new Date(2026, 10, 30, 9);
  service.refreshSchedules();
  await delay(10);
  assert.deepEqual(calls, ['plan', 'task']);
  service.startTask({ taskId: service.snapshot().tasks[0].id });
  await until(service.snapshot, ({ sprints }) => sprints[0]?.status === 'completed');
  assert.deepEqual(calls, ['plan', 'task', 'review', 'director']);
  const other = service.createStudio({ name: 'Other', root: '/project' });
  service.deleteStudio({ studioId, confirmation: 'Writer' });
  const { studios, modelPolicy, notificationPreferences, appLocale, onboardingHintsEnabled, training, ...records } = service.snapshot();
  assert.equal(appLocale, 'en');
  assert.equal(onboardingHintsEnabled, true);
  assert.deepEqual(notificationPreferences, { enabled: true, studios: {} });
  assert.deepEqual(modelPolicy, { configured: false, allowed: [] });
  assert.deepEqual(studios.map(({ id }) => id), [other.id]);
  assert.deepEqual(training.map(({ studioId }) => studioId), [other.id]);
  for (const table of Object.keys(records)) assert.deepEqual(records[table], [], table);
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
  assert.deepEqual(snapshot.studios[0].agents.map(({ systemRole }) => systemRole), ['coach']);
  assert.equal(snapshot.inbox[0].kind, 'error');
});

test('planning repairs one invalid director response and accepts criteria lists', async t => {
  const plan = structuredClone(draft);
  plan.story.acceptance = ['Readable outline'];
  plan.tasks[0].criteria = ['Has a heading', 'Names the time period'];
  const prompts = [];
  const service = createStudioService({dbPath: ':memory:', run: async ({prompt}) => {
    prompts.push(prompt);
    const response = structuredClone(plan);
    if (prompts.length === 1) response.tasks[0].criteria = [{ missing: 'criterion text' }];
    return {text: JSON.stringify(response)};
  }});
  t.after(() => service.close());
  const {id: studioId} = service.createStudio({name: 'Criteria', root: '/project'});
  service.initializeStudio({studioId});
  const result = await until(service.snapshot, view => view.plans.length || view.studios[0].lifecycle === 'error');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /previous plan/i);
  assert.match(prompts[1], /First/);
  assert.equal(result.plans[0].tasks[0].criteria, '- Has a heading\n- Names the time period');
  assert.equal(result.plans[0].story.acceptance, '- Readable outline');
  assert.deepEqual(result.inbox.map(row => row.kind), ['plan']);
  assert.equal(result.attempts.filter(row => row.purpose === 'plan').length, 1);
});

test('the next sprint sees completed artifacts and repairs reuse of an occupied path', async t => {
  let planning = 0;
  const followup = [];
  const plan = { ...draft, tasks: [draft.tasks[0]] };
  const service = createStudioService({ dbPath: ':memory:', writeArtifact: async ({path}) => ({path}), run: async ({purpose,prompt}) => {
    if (purpose === 'plan') {
      planning++;
      if (planning > 1) assert.match(prompt, /"recentCompleted"/);
      if (planning === 3) assert.match(prompt, /outline\.md/);
      return { text: JSON.stringify(planning === 3 ? {...plan, tasks:[{...plan.tasks[0],artifactPath:'outline-edited.md'}]} : plan) };
    }
    if (planning === 3 && ['task','review'].includes(purpose)) {
      const context = JSON.parse(prompt.split('\n\n').at(-1));
      followup.push([purpose, context.referenceArtifacts]);
    }
    return {text:JSON.stringify({task:{summary:'First outline saved',artifact:'# Outline'},review:{pass:true,summary:'OK'},director:{action:'finish'}}[purpose])};
  } });
  t.after(() => service.close());
  const {id:studioId} = service.createStudio({ root:'/project', name:'Prior sprint artifacts' });
  service.initializeStudio({studioId});
  const first = await until(service.snapshot, s => s.plans[0]?.status === 'pending');
  service.decidePlan({planId:first.plans[0].id,decision:'approve'});
  await until(service.snapshot,s=>s.sprints[0]?.status==='completed');
  service.startNextSprint({studioId});
  const next = await until(service.snapshot,s=>s.plans.some(p=>p.kind==='sprint'&&p.status==='pending')||s.studios[0].lifecycle==='error');
  assert.equal(next.plans.find(p=>p.kind==='sprint')?.tasks[0].artifactPath,'outline-edited.md');
  assert.equal(planning,3);
  service.decidePlan({planId:next.plans.find(p=>p.kind==='sprint').id,decision:'approve'});
  await until(service.snapshot,s=>s.sprints.filter(sprint=>sprint.status==='completed').length===2);
  const reference = [{title:'First',path:'outline.md',content:'# Outline',excerpt:false}];
  assert.deepEqual(followup,[['task',reference],['review',reference]]);
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
  assert.equal(snapshot.studios[0].agents.length, 3);
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
          return { summary: 'Draft', artifact: `# Version ${++work}\n${'Outline details. '.repeat(150)}\nEnd of proof.` };
        },
        'select-model': () => {
          assert.equal(runtime, 'codex');
          routingPrompts.push(prompt);
          return JSON.parse(prompt.split('\n\n').at(-1)).purpose === 'review'
            ? { runtime: 'claude', model: 'reader', effort: 'high' }
            : { runtime: 'codex', model: 'director', effort: '' };
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
  assert.deepEqual(routingPrompts.map((prompt) => JSON.parse(prompt.split('\n\n').at(-1)).purpose), ['task', 'review', 'task', 'review']);
  assert.match(reviewPrompts[1], /"artifactPath": "outline-v2.md"/);
  assert.match(reviewPrompts[1], /"previousArtifactPath": "outline.md"/);
  const reviewed = JSON.parse(reviewPrompts[1].split('\n\n').at(-1));
  assert.equal(reviewed.artifact, writes[1].content);
  assert.ok(reviewed.artifact.endsWith('End of proof.'));
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

test('quiet planning stays in progress without an inbox error and exposes its last signal', async t => {
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let progress;
  let time = new Date('2026-11-22T09:00:00Z');
  const service = createStudioService({ dbPath: ':memory:', now: () => time,
    run: async ({onEvent}) => {
      progress = onEvent;
      started.resolve();
      await finish.promise;
      return {text:JSON.stringify(draft)};
    } });
  t.after(()=>{finish.resolve();return service.close();});
  const {id:studioId}=service.createStudio({name:'Quiet project',root:'/project'});
  service.initializeStudio({studioId});
  await started.promise;
  time = new Date(time.getTime() + 65_000);
  service.refreshSchedules();
  assert.deepEqual(service.snapshot().inbox, []);
  assert.equal(service.snapshot().attempts.at(-1).status,'running');
  const before = service.diagnoseStudio({studioId}).process.observedAt;
  time = new Date(time.getTime()+1000);
  progress({type:'output'});
  service.refreshSchedules();
  assert.ok(service.diagnoseStudio({studioId}).process.observedAt > before);
  time = new Date(time.getTime()+65_000);
  service.refreshSchedules();
  assert.deepEqual(service.snapshot().inbox, []);
  finish.resolve();
  await until(service.snapshot,s=>s.plans.some(row=>row.status==='pending'));
});

test('opening an existing profile clears old silence notices while keeping actual failures open', async t => {
  const dbPath = database(t);
  const run = async () => ({text:JSON.stringify(draft)});
  const original = createStudioService({dbPath,run});
  const {id:studioId} = original.createStudio({name:'Existing studio',root:'/project'});
  await original.close();
  const db = new DatabaseSync(dbPath);
  const insert = db.prepare('INSERT INTO studio_inbox VALUES (?, ?)');
  for (const [id,title,body] of [
    ['silence','Нет активности подключения','Подключение давно не сообщало о ходе работы.'],
    ['failure','Ошибка · планирование','Подключение завершилось с ошибкой.'],
  ]) insert.run(id,JSON.stringify({id,studioId,kind:'error',title,body,status:'open'}));
  db.close();
  const reopened = createStudioService({dbPath,run});
  t.after(()=>reopened.close());
  const inbox = reopened.snapshot().inbox;
  assert.equal(inbox.find(({id})=>id==='silence').status,'resolved');
  assert.equal(inbox.find(({id})=>id==='failure').status,'open');
});

test('stopping the first plan publishes both the hold and release so an open dialog can recover', async t => {
  const snapshots = [];
  const started = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  const release = Promise.withResolvers();
  let calls = 0;
  const service = createStudioService({dbPath:':memory:',onChange:snapshot=>snapshots.push(snapshot),run:async ({purpose,signal})=>{
    assert.equal(purpose,'plan');
    if (++calls > 1) return {text:JSON.stringify(draft)};
    started.resolve();
    signal.addEventListener('abort',aborted.resolve,{once:true});
    await release.promise;
    throw signal.reason;
  }});
  t.after(()=>{release.resolve();return service.close();});
  const {id:studioId}=service.createStudio({name:'Docs',root:'/project'});
  service.initializeStudio({studioId});
  await started.promise;
  service.setStudioRunning({studioId,action:'stop'});
  await aborted.promise;
  const item=service.snapshot().inbox.find(row=>row.kind==='reconcile');
  assert.ok(item);
  const decision={attemptId:item.attemptId,decision:'retry',reason:'Retry first plan'};
  assert.throws(()=>service.resolveReconciliation(decision),/ещё выполняется/);
  release.resolve();
  await until(()=>snapshots.at(-1),snapshot=>snapshot.attempts.some(row=>row.id===item.attemptId&&row.processActive===false));
  service.resolveReconciliation(decision);
  assert.equal(service.snapshot().studios[0].lifecycle,'paused');
  assert.equal(calls,1);
  service.setStudioRunning({studioId,action:'resume'});
  await until(service.snapshot,snapshot=>snapshot.plans.some(row=>row.status==='pending'));
  assert.equal(calls,2);
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
