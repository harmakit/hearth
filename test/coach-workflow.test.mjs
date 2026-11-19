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
