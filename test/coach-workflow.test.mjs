import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createStudioService } from '../core/service.mjs';
import { makeStudioBundle, prepareBundleImport } from '../migration/transfer.mjs';
import { trainingReply } from './fixtures/training.mjs';

const commit = '1'.repeat(40);
const candidate = { id: 'candidate-1', repo: 'publisher/tool', commit, path: 'tool/SKILL.md', title: 'Outline', stars: 15_000, license: 'MIT', url: `https://github.com/publisher/tool/blob/${commit}/tool/SKILL.md`, content: 'Pinned instructions for outlining.' };
const json = (value) => ({ text: JSON.stringify(value) });
const filePlan = {
  title: 'File sprint', goal: 'Publish one report',
  epic: { title: 'Reports', description: 'Report project' }, story: { title: 'Report', acceptance: 'Review the file' },
  agents: [{ key: 'writer', role: 'editor', description: 'Write' }, { key: 'reader', role: 'other', description: 'Review' }],
  tasks: [{ key: 'report', title: 'Report', prompt: 'Write the report', criteria: 'File exists', agentKey: 'writer', reviewerKey: 'reader', artifactPath: 'reports/first.md' }],
};

function fileSprintReply(request) {
  return trainingReply(request) ?? json({
    plan: filePlan,
    task: { summary: 'Report written', artifact: '# Report', artifactPath: 'reports/first.md' },
    review: { pass: true, summary: 'File verified' },
    director: { action: 'finish', summary: 'Sprint complete' },
  }[request.purpose]);
}

function database(t) {
  const base = fileURLToPath(new URL('../.tmp', import.meta.url));
  mkdirSync(base, { recursive: true });
  const folder = mkdtempSync(join(base, 'coach-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return join(folder, 'studio.sqlite');
}

async function until(read, predicate) {
  for (let tries = 0; tries < 100; tries += 1) {
    const value = read();
    if (predicate(value)) return value;
    await delay(10);
  }
  assert.fail(`Не дождались ожидаемого состояния: ${JSON.stringify(read())}`);
}

test('a blocked coach can retry from its existing task even when only one launch is allowed', async t => {
  let reviews = 0;
  const service = createStudioService({dbPath:':memory:',run:async ({purpose,prompt})=>{
    if(purpose==='task') return json({summary:'Prepared',selectedSkillIds:[],guide:'Check the source.'});
    if(purpose==='training-exercise') return json({summary:'Missing license means the sample needs more evidence.'});
    assert.match(prompt,/Missing license means the sample needs more evidence/);
    return json({pass:++reviews>3,summary:'Sample assessment'});
  }});
  t.after(()=>service.close());
  const studio=service.createStudio({root:'/project',name:'Retry bootstrap',wipLimit:1});
  const taskId=studio.agents[0].trainingTaskId;
  service.startTask({taskId});
  const failed=await until(service.snapshot,s=>s.tasks.some(row=>row.id===taskId&&row.status==='failed'));
  assert.equal(failed.inbox.find(row=>row.taskId===taskId).status,'open');
  service.startTask({taskId});
  const recovered=await until(service.snapshot,s=>s.tasks.some(row=>row.id===taskId&&row.stage==='done'));
  assert.equal(recovered.studios[0].agents[0].trainingStatus,'ready');
  assert.equal(recovered.inbox.find(row=>row.taskId===taskId).status,'resolved');
  assert.equal(reviews,4);
});

test('retrying a coach rejected by the director continues the approved parallel sprint and publishes its file', async t => {
  let reviews = 0;
  const writes = [];
  const service = createStudioService({ dbPath: ':memory:', writeArtifact: async ({ path }) => (writes.push(path), { path }), run: async request => {
    if (request.prompt.startsWith('Review the studio agent') && request.prompt.includes('"bootstrap": true')) {
      return json({ pass: ++reviews > 3, summary: 'Review of the coach exercise' });
    }
    return fileSprintReply(request);
  } });
  t.after(() => service.close());
  const studio = service.createStudio({ root: '/project', name: 'Parallel coach retry', wipLimit: 5, sprintReview: 'off' });
  const coachTaskId = studio.agents.find(agent => agent.systemRole === 'coach').trainingTaskId;
  service.initializeStudio({ studioId: studio.id });
  const { plans: [plan] } = await until(service.snapshot, view => view.plans.length);
  service.decidePlan({ planId: plan.id, decision: 'approve' });
  await until(service.snapshot, view => view.tasks.some(task => task.id === coachTaskId && task.failedReviews === 3));
  service.startTask({ taskId: coachTaskId });
  await until(service.snapshot, view => view.sprints[0]?.status === 'completed');
  assert.equal(reviews, 4);
  assert.deepEqual(writes, ['reports/first.md']);
});

test('automatic sprint training still requires an exercise and review when GitHub returns no usable skills', async t => {
  const plan = structuredClone(filePlan);
  plan.agents[0].trainingTopics = ['writing'];
  const reason = 'GitHub repository search failed (rate limit reached).';
  const service = createStudioService({
    dbPath: ':memory:', findSkills: async () => ({candidates: [], warnings: [reason]}),
    writeArtifact: async ({path}) => ({path}),
    run: async request => request.purpose === 'plan' ? json(plan) : fileSprintReply(request),
  });
  t.after(() => service.close());
  const {id: studioId} = service.createStudio({root: '/project', name: 'External lookup failure', wipLimit: 5, sprintReview: 'off'});
  service.initializeStudio({studioId});
  const pending = await until(service.snapshot, view => view.plans[0]?.status === 'pending');
  service.decidePlan({planId: pending.plans[0].id, decision: 'approve'});
  const result = await until(service.snapshot, view => view.sprints[0]?.status === 'completed' || view.training.some(task => task.status === 'failed'));
  const training = result.training.find(task => task.training.topics.includes('writing'));
  assert.equal(training.stage, 'done');
  assert.equal(training.training.searchOutcome, 'error');
  assert.deepEqual(training.training.warnings, [reason]);
  assert.deepEqual(training.training.selectedSkillIds, []);
  assert.ok(training.training.exercise && training.review);
  assert.equal(result.tasks.find(task => task.key === 'report').stage, 'done');
});

test('a technical blocker goes to the director and the task retries with a recovery plan before asking the owner', async t => {
  let attempts=0;
  let triaged=0;
  const service=createStudioService({dbPath:':memory:',writeArtifact:async ({path})=>({path}),run:async request=>{
    if(request.purpose==='resolve-blocker'){
      triaged++;
      return json({nextStep:'Use available local evidence and label pending claims.'});
    }
    if(request.purpose==='task' && request.prompt.includes('"title": "Report"') && request.prompt.includes('"task": "Write the report"')){
      if(++attempts===1)return json({summary:'Source host offline',artifact:'Existing material.',
        question:{kind:'technical',title:'Unavailable source',body:'The external source is unreachable.'}});
      assert.match(request.prompt,/Use available local evidence and label pending claims/);
    }
    return fileSprintReply(request);
  }});
  t.after(()=>service.close());
  const studio=service.createStudio({root:'/project',name:'Recover from blocker'});
  service.initializeStudio({studioId:studio.id});
  const ready=await until(service.snapshot,view=>view.plans[0]?.status==='pending');
  service.decidePlan({planId:ready.plans[0].id,decision:'approve'});
  const view=await until(service.snapshot,s=>s.sprints.some(sprint=>sprint.status==='completed') ||
    s.inbox.some(item=>item.kind==='question' && item.status==='open'));
  assert.equal(view.sprints[0].status,'completed');
  assert.equal(view.inbox.some(item=>item.kind==='question' && item.status==='open'),false);
  assert.equal(triaged,1);
  assert.equal(attempts,2);
});

test('a saved studio left idle after coaching resumes its approved sprint on restart', async t => {
  const dbPath = database(t);
  const review = Promise.withResolvers();
  const initial = createStudioService({ dbPath, run: async request => {
    if (request.prompt.startsWith('Review the studio agent') && request.prompt.includes('"bootstrap": true')) return review.promise;
    return fileSprintReply(request);
  } });
  t.after(() => { review.resolve(json({ pass: true, summary: 'Approved' })); return initial.close(); });
  const studio = initial.createStudio({ root: '/project', name: 'Saved sprint', wipLimit: 5, sprintReview: 'off' });
  initial.initializeStudio({ studioId: studio.id });
  const { plans: [plan] } = await until(initial.snapshot, view => view.plans.length);
  initial.decidePlan({ planId: plan.id, decision: 'approve' });
  await until(initial.snapshot, view => view.attempts.some(attempt => attempt.purpose === 'review' && attempt.status === 'running'));
  initial.setStudioRunning({ studioId: studio.id, action: 'pause' });
  review.resolve(json({ pass: true, summary: 'Approved' }));
  await until(initial.snapshot, view => view.tasks.some(task => task.training?.bootstrap && task.stage === 'done'));
  await initial.close();

  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE studios SET data=json_set(data,'$.lifecycle','idle','$.activity','Обучение завершено','$.workflowJob',NULL,'$.manualPaused',json('false')) WHERE id=?").run(studio.id);
  db.exec("DELETE FROM dispatch_jobs WHERE json_extract(data,'$.status')='queued'");
  db.close();

  const reopened = createStudioService({ dbPath, writeArtifact: async ({ path }) => ({ path }), run: async request => {
    assert.equal(request.prompt.includes('"bootstrap": true'), false, 'completed coaching is not replayed');
    return fileSprintReply(request);
  } });
  t.after(() => reopened.close());
  const done = await until(reopened.snapshot, view => view.sprints[0]?.status === 'completed');
  assert.equal(done.tasks.find(task => task.key === 'report').artifactPath, 'reports/first.md');
});

test('resuming the studio keeps the failed coach and its request until an explicit retry', async t=>{
  let reviews=0;
  const service=createStudioService({dbPath:':memory:',run:async ({purpose})=>{
    if(purpose==='task')return json({summary:'Guide',selectedSkillIds:[],guide:'Check the source.'});
    if(purpose==='training-exercise')return json({summary:'The source lacks a verifiable license.'});
    return json({pass:++reviews>3,summary:'Director’s rationale'});
  }});
  t.after(()=>service.close());
  const studio=service.createStudio({root:'/project',name:'Resume training',wipLimit:5});
  const taskId=studio.agents[0].trainingTaskId;
  service.startTask({taskId});
  const failed=await until(service.snapshot,s=>s.tasks.some(row=>row.id===taskId&&row.status==='failed')&&s.studios[0].activeAttempts===0);
  const inboxId=failed.inbox.find(row=>row.taskId===taskId).id;
  service.setStudioRunning({studioId:studio.id,action:'pause'});
  service.setStudioRunning({studioId:studio.id,action:'resume'});
  const resumed=service.snapshot();
  assert.equal(resumed.inbox.find(row=>row.id===inboxId).status,'open');
  assert.equal(resumed.tasks.find(row=>row.id===taskId).status,'failed');
  service.startTask({taskId});
  await until(service.snapshot,s=>s.tasks.some(row=>row.id===taskId&&row.stage==='done'));
  assert.equal(service.snapshot().inbox.find(row=>row.id===inboxId).status,'resolved');
});

test('a coach exercise repairs malformed replies once per attempt and unblocks dependent work after review', async t => {
  const director = Promise.withResolvers();
  let reviewPrompt;
  let exercises = 0;
  let guides = 0;
  const published = [];
  const service = createStudioService({
    dbPath: database(t),
    onChange: snapshot => published.push(snapshot),
    run: async ({ purpose, prompt, onEvent }) => {
      if (purpose === 'task' && prompt.startsWith('Prepare a studio agent')) {
        if (prompt.includes('"bootstrap": true')) guides++;
        return json({ summary: 'Guide', selectedSkillIds: [], guide: 'Check the source.' });
      }
      if (purpose === 'training-exercise' && prompt.includes('"bootstrap": true')) {
        onEvent?.({ type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } });
        exercises++;
        if (exercises === 1) return json({ result: 'Wrong field' });
        if (exercises === 3) throw Object.assign(new Error('Provider returned an empty answer'), { code: 'EMPTY_RESPONSE' });
        assert.match(prompt, /previous answer/i);
        if (exercises === 2) return json({ summary: ' ' });
        return json({ summary: 'Defer use until the license can be verified at the pinned revision.' });
      }
      if (purpose === 'training-exercise') return json({ summary: 'Trainee sample' });
      if (purpose === 'review' && prompt.includes('"bootstrap": true')) {
        reviewPrompt = prompt;
        await director.promise;
      }
      if (purpose === 'review') return json({ pass: true, summary: 'Reviewed' });
      return json({ summary: 'Dependent work delivered' });
    },
  });
  t.after(() => { director.resolve(); return service.close(); });
  const studio = service.createStudio({ root: '/project', name: 'Coach exercise recovery', wipLimit: 5 });
  const coach = studio.agents.find(agent => agent.systemRole === 'coach');
  const hire = service.addAgent({ studioId: studio.id, role: 'editor', name: 'Writer' });
  const work = service.createTask({ studioId: studio.id, agentId: hire.id, title: 'Outline', prompt: 'Write the outline' });
  const coachTask = snapshot => snapshot.tasks.find(task => task.id === coach.trainingTaskId);
  service.startTask({ taskId: work.id });
  const failure = await until(service.snapshot, snapshot => coachTask(snapshot).status === 'failed');
  assert.equal(exercises, 2);
  assert.match(coachTask(failure).error, /пуст/i);
  assert.equal(failure.tasks.find(task => task.id === work.id).stage, 'backlog');
  assert.ok(published.some(snapshot => coachTask(snapshot)?.status === 'failed' && snapshot.studios[0].activeAttempts === 0));
  assert.equal(reviewPrompt, undefined);

  service.startTask({ taskId: coach.trainingTaskId });
  await until(() => reviewPrompt, Boolean);
  assert.match(reviewPrompt, /Defer use until the license can be verified/);
  assert.equal(service.snapshot().tasks.find(task => task.id === work.id).stage, 'backlog');
  director.resolve();
  const done = await until(service.snapshot, snapshot => snapshot.tasks.find(task => task.id === work.id).stage === 'done');
  assert.equal(done.studios[0].agents.find(agent => agent.id === coach.id).trainingStatus, 'ready');
  assert.equal(done.tasks.find(task => task.id === hire.trainingTaskId).stage, 'done');
  assert.equal(guides, 1);
  assert.equal(exercises, 4);
  const retries = done.attempts.filter(attempt => attempt.taskId === coach.trainingTaskId && attempt.purpose === 'training-exercise');
  assert.deepEqual(retries.map(attempt => attempt.calls.length), [2, 2]);
  for (const attempt of retries) assert.equal(done.usageEvents.filter(event => event.attemptId === attempt.id).length, 2);
});

test('a manual hire is gated by coach bootstrap, trainee exercise, and Director review', async (t) => {
  const calls = [];
  let review;
  const service = createStudioService({
    dbPath: ':memory:',
    findSkills: async ({ topics, minStars, signal }) => {
      assert.deepEqual(topics, ['outline']);
      assert.equal(minStars, 10_000);
      assert.ok(signal instanceof AbortSignal);
      return { candidates: [candidate], warnings: [] };
    },
    run: async ({ prompt, purpose }) => {
      calls.push({ prompt, purpose });
      if (prompt.startsWith('Prepare a studio agent')) return json({ summary: 'Prepared', selectedSkillIds: prompt.includes(candidate.id) ? [candidate.id] : [], guide: 'Review the introduction and write an outline.' });
      if (purpose === 'training-exercise') return json({ summary: 'Practiced with one heading and two sections.' });
      if (prompt.startsWith('Review the studio agent')) {
        if (prompt.includes(candidate.id)) {
          review ??= Promise.withResolvers();
          await review.promise;
        }
        return json({ pass: true, summary: 'Evidence verified' });
      }
      return json({ summary: 'Production finished', artifact: 'Outline' });
    },
  });
  t.after(() => { review?.resolve(); return service.close(); });
  const studio = service.createStudio({ root: '/project', name: 'Coach test' });
  const hire = service.addAgent({ studioId: studio.id, role: 'editor', name: 'Writer', trainingTopics: ['outline'] });
  const work = service.createTask({ studioId: studio.id, agentId: hire.id, title: 'Outline', prompt: 'Write the outline' });
  const created = service.snapshot();
  assert.equal(created.studios[0].agents.filter(({ systemRole }) => systemRole === 'coach').length, 1);
  assert.equal(created.training.length, 2);
  assert.equal(hire.trainingStatus, 'pending');
  assert.equal(work.stage, 'backlog');
  assert.deepEqual(work.dependencies, [hire.trainingTaskId]);
  service.startTask({ taskId: work.id });
  await until(() => review, Boolean);
  assert.equal(service.snapshot().skills.length, 0);
  assert.equal(service.snapshot().tasks.find(({ id }) => id === work.id).stage, 'backlog');
  assert.equal(calls.some(({ prompt }) => prompt.startsWith('Work on')), false);
  review.resolve();
  const snapshot = await until(() => service.snapshot(), ({ tasks }) => tasks.find(({ id }) => id === work.id).stage === 'done');
  assert.equal(snapshot.training.every(({ stage }) => stage === 'done'), true);
  const bootstrap = snapshot.training.find(({ training }) => training.bootstrap);
  assert.equal(bootstrap.training.exercise, 'Practiced with one heading and two sections.');
  const bootstrapReview = calls.find(({ prompt }) => prompt.startsWith('Review the studio agent'));
  assert.match(bootstrapReview.prompt, /Practiced with one heading and two sections/);
  assert.match(bootstrapReview.prompt, /Empty source and skill lists are expected/);
  const bootstrapExercise = calls.find(({purpose}) => purpose === 'training-exercise');
  const exerciseCase = prompt => JSON.parse(prompt.split('\n\n').at(-1)).exerciseCase;
  assert.deepEqual(exerciseCase(bootstrapExercise.prompt), exerciseCase(bootstrapReview.prompt));
  assert.equal(exerciseCase(bootstrapReview.prompt).fictional, true);
  const roleReview = calls.find(({prompt}) => prompt.startsWith('Review the studio agent') && !prompt.includes('"bootstrap": true'));
  assert.match(roleReview.prompt, /full production deliverable is outside this exercise/);
  const bootstrapGuide = calls.find(({prompt}) => prompt.startsWith('Prepare a studio agent') && prompt.includes('"bootstrap": true'));
  assert.match(bootstrapGuide.prompt, /studio brief is project context/);
  assert.equal(snapshot.skills[0].commit, candidate.commit);
  assert.equal(snapshot.studios[0].agents.find(({ id }) => id === hire.id).trainingStatus, 'ready');
  assert.match(calls.find(({ prompt }) => prompt.startsWith('Work on')).prompt, /Pinned instructions for outlining/);

  const bundle = makeStudioBundle(snapshot, { studioId: studio.id, mode: 'snapshot' });
  for (const missing of ['exercise', 'guide', 'review']) {
    const malformed = structuredClone(bundle);
    const lesson = malformed.tasks.find(({ kind, training }) => kind === 'train' && !training.bootstrap);
    delete (missing === 'review' ? lesson : lesson.training)[missing];
    assert.throws(() => service.importStudio(prepareBundleImport(malformed, { root: '/copy' })), /проверенное|решение Директора/);
  }
  const imported = service.importStudio(prepareBundleImport(bundle, { root: '/copy' }));
  const copied = service.snapshot();
  const copiedWriter = imported.agents.find(({ name }) => name === hire.name);
  const [pinned] = copied.skills.filter(({ studioId }) => studioId === imported.id);
  assert.deepEqual(copiedWriter.skillIds, [pinned.id]);
  assert.notEqual(pinned.id, snapshot.skills[0].id);
  assert.equal(pinned.content, candidate.content);
  assert.equal(pinned.commit, candidate.commit);
  assert.equal(copied.training.filter(({ studioId }) => studioId === imported.id).length, 2);
  assert.equal(imported.agents.filter(({ systemRole }) => systemRole === 'coach').length, 1);

  const template = makeStudioBundle(snapshot, { studioId: studio.id, mode: 'template' });
  const freshStudio = service.importStudio(prepareBundleImport(template, { root: '/fresh' }));
  assert.equal(freshStudio.agents.length, 2);
  assert.equal(freshStudio.agents.every(({ trainingStatus, skillIds }) => trainingStatus === 'pending' && skillIds.length === 0), true);
  assert.equal(service.snapshot().training.filter(({ studioId }) => studioId === freshStudio.id).length, 2);
});

test('a director trains and hires in the same sprint, preserving prior dependencies and separate review', async (t) => {
  const proposals = [
    { action: 'train', taskKey: 'second', objective: 'Improve the heading', topics: ['outline'] },
    { action: 'hire', taskKey: 'third', objective: 'Write a summary', topics: [], agent: { key: 'summarizer', role: 'editor', description: 'Summarizes reports' } },
    { action: 'finish' },
  ];
  let attempts = 0;
  let manual;
  let manualTraining;
  const originals = [];
  const service = createStudioService({
    dbPath: ':memory:',
    findSkills: async ({ topics, minStars }) => {
      assert.deepEqual(topics, ['outline']);
      assert.equal(minStars, 500);
      return { candidates: [candidate], warnings: [] };
    },
    run: async ({ prompt, purpose }) => {
      const context = JSON.parse(prompt.split('\n\n').at(-1));
      if (prompt.startsWith('Prepare a studio agent')) return json({ summary: 'Prepared', selectedSkillIds: context.candidates.map(({ id }) => id), guide: 'Write a practice draft with headings.' });
      if (purpose === 'training-exercise') return json({ summary: 'The practice draft has three headings.' });
      if (prompt.startsWith('Review the studio agent')) {
        if (context.training.objective === 'Improve the heading') {
          assert.equal(context.training.exercise, 'The practice draft has three headings.');
          assert.equal(service.snapshot().skills.length, 0);
          const state = service.snapshot();
          manualTraining = state.training.find(({ training }) => training.objective === 'Improve the heading').id;
          const queuedManual = state.tasks.find(({ id }) => id === manual.id);
          const targeted = state.tasks.find(({ targetedTrainingId }) => targetedTrainingId === manualTraining);
          assert.equal(targeted.stage, 'backlog');
          assert.ok(targeted.dependencies.includes(manualTraining));
          assert.notEqual(queuedManual.stage, 'backlog');
          assert.ok(!queuedManual.dependencies.includes(manualTraining));
          return json({ pass: ++attempts === 2, summary: 'Checked the exercise and source' });
        }
        return json({ pass: true, summary: 'Checked the guide' });
      }
      if (purpose === 'director') return json(proposals.shift());
      if (purpose === 'review') return json({ pass: true, summary: 'Verified' });
      if (purpose === 'task') {
        originals.push(context);
        if (context.title === 'first') {
          const [studio] = service.snapshot().studios;
          const writer = studio.agents.find(({ key }) => key === 'writer');
          manual = service.createTask({ studioId: studio.id, agentId: writer.id, title: 'Independent notes', prompt: 'Write notes' });
          service.startTask({ taskId: manual.id });
          assert.equal(manual.dependencies.length, 0);
        }
        return json({ summary: 'Done' });
      }
      if (!purpose) {
        const approved = service.snapshot().training.find(({ id }) => id === manualTraining)?.stage === 'done';
        assert.deepEqual(context.training.skills.map(({ commit }) => commit), approved ? [candidate.commit] : []);
        return json({ summary: 'Notes ready' });
      }
      return json({
        title: 'Sprint', goal: 'Publish a report', epic: { title: 'Reports', description: 'Report project' },
        story: { title: 'Report', acceptance: 'Readable report' },
        agents: [{ key: 'writer', role: 'editor', description: 'Writes reports' }, { key: 'reader', role: 'other', description: 'Reads reports' }],
        tasks: [['first', []], ['second', ['first']], ['third', ['second']]].map(([key, dependsOn]) => ({ key, title: key, prompt: key, criteria: 'Clear result', agentKey: 'writer', reviewerKey: 'reader', dependsOn })),
      });
    },
  });
  t.after(() => service.close());
  const studio = service.createStudio({ root: '/project', name: 'Director test', skillMinStars: 500 });
  service.initializeStudio({ studioId: studio.id });
  const { plans: [plan] } = await until(service.snapshot, ({ plans }) => plans.length);
  service.decidePlan({ planId: plan.id, decision: 'approve' });
  const done = await until(service.snapshot, ({ sprints, tasks }) => sprints[0]?.status === 'completed' && tasks.find(({ id }) => id === manual?.id).stage === 'done');
  const [first, second, third] = ['first', 'second', 'third'].map((key) => done.tasks.find((task) => task.key === key));
  assert.equal(done.training.length, 5);
  assert.equal(done.training.filter(({ failedReviews }) => failedReviews === 1).length, 1);
  assert.equal(done.skills.length, 1);
  assert.ok(second.dependencies.includes(first.id));
  assert.ok(second.dependencies.includes(second.targetedTrainingId));
  assert.ok(third.dependencies.includes(third.targetedTrainingId));
  assert.equal(first.agentId, second.agentId);
  assert.notEqual(second.agentId, third.agentId);
  assert.equal(first.reviewerId, third.reviewerId);
  assert.equal(originals[0].training.skills.length, 0);
  assert.equal(originals[1].training.skills[0].commit, candidate.commit);
  assert.equal(originals[2].training.skills.length, 0);
});

test('a failed lookup stays visible until retried, then a verified no-match guide releases work', async (t) => {
  let requests = 0;
  let lookups = 0;
  const service = createStudioService({
    dbPath: ':memory:',
    findSkills: async () => ({ candidates: [], warnings: ++lookups === 1 ? ['GitHub rate limit'] : [] }),
    run: async ({ prompt, purpose }) => {
      if (prompt.startsWith('Prepare a studio agent')) return json({ summary: 'Prepared', selectedSkillIds: [], guide: 'Read the draft aloud.' });
      if (purpose === 'training-exercise') return json({ summary: 'Marked a long sentence.' });
      if (purpose === 'review') return json({ pass: true, summary: 'Exercise checked' });
      requests++;
      return json({ summary: 'Ready' });
    },
  });
  t.after(() => service.close());
  const { id: studioId } = service.createStudio({ name: 'Retry', root: '/project', wipLimit: 1 });
  const hire = service.addAgent({ studioId, name: 'Editor', trainingTopics: ['outline'] });
  const work = service.createTask({ studioId, agentId: hire.id, title: 'Read', prompt: 'Check the draft.' });
  service.startTask({ taskId: work.id });
  const failure = await until(service.snapshot, ({ studios }) => studios[0].lifecycle === 'error');
  assert.match(failure.inbox[0].body, /GitHub rate limit/);
  assert.equal(requests, 0);
  assert.equal(failure.tasks.find(({ id }) => id === work.id).stage, 'backlog');
  service.setStudioRunning({ studioId, action: 'resume' });
  const finished = await until(service.snapshot, ({ tasks }) => tasks.find(({ id }) => id === work.id).stage === 'done');
  assert.equal(finished.training.find(({ id }) => id === hire.trainingTaskId).training.searchOutcome, 'no-match');
  assert.equal(finished.skills.length, 0);
  assert.equal(requests, 1);
});

test('promotes a saved librarian exactly once while existing work stays runnable', async (t) => {
  const dbPath = database(t);
  const initial = createStudioService({ dbPath });
  await initial.close();
  const db = new DatabaseSync(dbPath);
  const studio = { id: 'legacy', lifecycle: 'idle', name: 'Legacy', root: '/project', director: { runtime: 'codex', model: '', effort: '' }, agents: [{ id: 'librarian', name: 'Librarian', role: 'library', mode: 'inherit' }] };
  db.prepare('INSERT INTO studios VALUES (?, ?)').run(studio.id, JSON.stringify(studio));
  const old = { id: 'work', studioId: studio.id, agentId: 'librarian', title: 'Index', prompt: 'Index notes', stage: 'ready', status: 'queued', dependencies: [], summary: '', artifact: '', error: '' };
  db.prepare('INSERT INTO tasks VALUES (?, ?, ?)').run(old.id, studio.id, JSON.stringify(old));
  db.close();

  const run = async ({ prompt }) => {
    assert.match(prompt, /Index notes/);
    return json({ summary: 'Indexed' });
  };
  const service = createStudioService({ dbPath, run });
  t.after(() => service.close());
  assert.deepEqual(service.snapshot().tasks.find(({ id }) => old.id === id), old);
  const [coach] = service.snapshot().studios[0].agents;
  assert.equal(coach.id, 'librarian');
  assert.equal(coach.systemRole, 'coach');
  assert.equal(service.snapshot().training.length, 1);
  service.startTask({ taskId: old.id });
  await until(service.snapshot, ({ tasks }) => tasks.find(({ id }) => old.id === id).stage === 'done');
  await service.close();
  const reopened = createStudioService({ dbPath, run });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.snapshot().training.map(({ id }) => id), [coach.trainingTaskId]);
  assert.equal(reopened.snapshot().studios[0].agents.length, 1);
});

test('scheduled manual work waits through restart for its pending training and review', async (t) => {
  const dbPath = database(t);
  let hour = 8;
  const calls = [];
  const options = {
    dbPath, now: () => new Date(2026, 10, 16, hour),
    run: async (request) => { calls.push(request); return trainingReply(request) ?? json({ summary: 'Finished' }); },
  };
  const initial = createStudioService(options);
  t.after(() => initial.close());
  const studio = initial.createStudio({ root: '/project', name: 'Scheduled', schedule: { enabled: true, days: [1], start: '09:00', end: '10:00' } });
  const hire = initial.addAgent({ studioId: studio.id, name: 'Writer' });
  const work = initial.createTask({ studioId: studio.id, agentId: hire.id, title: 'Write', prompt: 'Write the project brief' });
  initial.startTask({ taskId: work.id });
  assert.equal(initial.snapshot().studios[0].scheduleWaiting, true);
  assert.equal(initial.snapshot().tasks.find(({ id }) => id === work.id).stage, 'backlog');
  await initial.close();
  const restored = createStudioService(options);
  t.after(() => restored.close());
  assert.deepEqual(calls, []);
  hour = 9;
  restored.refreshSchedules();
  const done = await until(restored.snapshot, ({ tasks }) => tasks.find(({ id }) => id === work.id).stage === 'done');
  assert.equal(done.training.every(({ stage }) => stage === 'done'), true);
  assert.equal(calls.at(-1).prompt.startsWith('Work on the task'), true);
  assert.equal(done.studios[0].lifecycle, 'draft');
});

test('standalone training waits behind a workflow task awaiting owner acceptance', async (t) => {
  const calls = [];
  const service = createStudioService({
    dbPath: ':memory:',
    run: async (request) => {
      calls.push(request);
      return trainingReply(request) ?? json({
        plan: {
          title: 'Sprint', goal: 'Write', epic: { title: 'Book', description: 'Make a book' }, story: { title: 'Draft', acceptance: 'Clear draft' },
          agents: [{ key: 'writer', role: 'editor', description: 'Writes' }, { key: 'reviewer', role: 'other', description: 'Reviews' }],
          tasks: [{ key: 'draft', title: 'Write', prompt: 'Write a draft', criteria: 'Clear draft', agentKey: 'writer', reviewerKey: 'reviewer', requiresAcceptance: true }],
        },
        task: { summary: 'Draft ready' }, review: { pass: true, summary: 'Draft reviewed' }, director: { action: 'finish' },
      }[request.purpose] ?? { summary: 'Manual work completed' });
    },
  });
  t.after(() => service.close());
  const { id: studioId } = service.createStudio({ root: '/project', name: 'Held review', wipLimit: 1, groomingPolicy: { enabled: false } });
  service.initializeStudio({ studioId });
  const { plans: [plan] } = await until(service.snapshot, ({ plans }) => plans.length);
  service.decidePlan({ planId: plan.id, decision: 'approve' });
  const qa = await until(service.snapshot, ({ inbox }) => inbox.some(({ kind, status }) => kind === 'acceptance' && status === 'open'));
  const hire = service.addAgent({ studioId, role: 'artist', name: 'Illustrator' });
  const work = service.createTask({ studioId, agentId: hire.id, title: 'Manual work', prompt: 'Draw an outline' });
  assert.throws(() => service.startTask({ taskId: hire.trainingTaskId }), /приёмку/);
  const heldCalls = calls.length;
  service.startTask({ taskId: work.id });
  await delay(20);
  assert.equal(calls.length, heldCalls);
  assert.equal(service.snapshot().tasks.find(({ id }) => id === work.id).stage, 'backlog');
  service.answerInbox({ inboxId: qa.inbox.find(({ kind }) => kind === 'acceptance').id, decision: 'approve' });
  const done = await until(service.snapshot, ({ tasks }) => tasks.find(({ id }) => id === work.id).stage === 'done');
  assert.equal(done.sprints[0].status, 'completed');
  assert.equal(calls[heldCalls].purpose, 'director');
  assert.equal(calls[heldCalls + 1].prompt.startsWith('Prepare a studio agent'), true);
});
