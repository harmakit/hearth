import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlanning } from '../core/planning.mjs';
import { debtAssessment, debtPlanContext, normalizeDebtPolicy, validateDebtPlan } from '../core/debt.mjs';

function fixture({ approveSprints = true } = {}) {
  const studio = { id: 'studio', approveSprints, wip: 2 };
  const tables = new Map([['studios', [studio]]]);
  const list = (name) => tables.get(name) ?? [];
  const read = (name, id) => list(name).find((record) => record.id === id);
  const insert = (name, record) => {
    assert.equal(read(name, record.id), undefined);
    tables.set(name, [...list(name), record]);
    return record;
  };
  const update = (name, record) => {
    assert.ok(read(name, record.id));
    tables.set(name, list(name).map((old) => old.id === record.id ? record : old));
    return record;
  };
  function transaction(write) {
    const before = new Map(tables);
    try {
      return write();
    } catch (error) {
      for (const name of tables.keys()) tables.delete(name);
      for (const [name, records] of before) tables.set(name, records);
      throw error;
    }
  }
  const planning = createPlanning({ read, list, insert, update, transaction, changed: (value) => value, now: () => '2026-11-18T10:00:00.000Z' });
  const task = (id, patch = {}) => insert('tasks', { id, studioId: studio.id, title: id, prompt: id, status: 'queued', stage: 'ready', ...patch });
  const sprint = (id, taskIds = []) => insert('sprints', { id, studioId: studio.id, title: id, taskIds, status: 'active' });
  return { planning, studio, read, list, insert, task, sprint };
}

test('an epic and story retain their identity across sprints', () => {
  const { planning, studio, sprint, list } = fixture();
  const structure = planning.selectPlanStructure(studio, {
    epic: { title: 'Epic', description: 'Goal' }, story: { title: 'Story', acceptance: 'Fact' },
  });
  planning.attachPlanStructure({ ...structure, sprint: sprint('first') });
  const reused = planning.selectPlanStructure(studio, { epicId: structure.epic.id, storyId: structure.story.id });
  planning.attachPlanStructure({ ...reused, sprint: sprint('second') });
  assert.equal(list('epics').length, 1);
  assert.deepEqual(list('epics')[0].sprintIds, ['first', 'second']);
  assert.equal(list('stories').length, 1);
  assert.deepEqual(list('stories')[0].sprintIds, ['first', 'second']);
});

test('replacement redirects active links atomically and rejects cycles', () => {
  const { planning, studio, task, read } = fixture();
  const studioId = studio.id;
  task('old');
  task('uses-old', { dependencies: ['old'] });
  task('replacement', { dependencies: ['uses-old'] });
  assert.throws(() => planning.reviseBacklog({
    studioId, baseVersion: 0, edits: [{ type: 'replace', taskId: 'old', replacementId: 'replacement', redirectDependencies: true }],
  }), /цикл/i);
  assert.deepEqual(read('tasks', 'uses-old').dependencies, ['old']);
  const revision = planning.reviseBacklog({ studioId, baseVersion: 0, edits: [
    { type: 'update', taskId: 'replacement', links: [] },
    { type: 'replace', taskId: 'old', replacementId: 'replacement', redirectDependencies: true },
  ] });
  assert.equal(revision.version, 1);
  assert.equal(read('tasks', 'old').stage, 'replaced');
  assert.deepEqual(read('tasks', 'replacement').links, [{ type: 'replaces', taskId: 'old' }]);
  assert.deepEqual(read('tasks', 'uses-old').dependencies, ['replacement']);
  assert.throws(() => planning.reviseBacklog({ studioId, baseVersion: 0, edits: [{ type: 'update', taskId: 'replacement', points: 3 }] }), /верси/i);
});

test('carrying an unfinished task preserves its ID, original membership and retrospective on replay', () => {
  const { planning, studio, task, sprint, insert, read, list } = fixture();
  sprint('first', ['shipped', 'unfinished']);
  sprint('next');
  task('shipped', { sprintId: 'first', status: 'completed', stage: 'done', points: 3, failedReviews: 1 });
  task('unfinished', { sprintId: 'first', status: 'waiting', stage: 'blocked', points: 5, kind: 'debt' });
  insert('inbox', { id: 'issue', taskId: 'unfinished' });
  const input = {
    studioId: studio.id, sprintId: 'first', operationId: 'close-first',
    carryovers: [{ taskId: 'unfinished', reason: 'Waiting for a key', stage: 'ready', sprintId: 'next' }],
  };
  const closed = planning.closeSprint(input);
  assert.deepEqual(planning.closeSprint(input), closed);
  assert.deepEqual(read('sprints', 'first').taskIds, ['shipped', 'unfinished']);
  assert.deepEqual(read('sprints', 'next').taskIds, ['unfinished']);
  assert.equal(read('tasks', 'unfinished').sprintId, 'next');
  assert.deepEqual(list('inbox'), [{ id: 'issue', taskId: 'unfinished' }]);
  const retro = planning.calculateRetrospective(input);
  assert.equal(retro.methodVersion, 1);
  assert.equal(retro.planned.points, 8);
  assert.deepEqual(retro.accepted.taskIds, ['shipped']);
  assert.deepEqual(retro.carried.taskIds, ['unfinished']);
  assert.deepEqual(retro.blocked.taskIds, ['unfinished']);
  assert.equal(retro.rework.cycles, 1);
  assert.equal(list('meetings').length, 1);
  assert.throws(() => planning.closeSprint({ ...input, carryovers: [] }), /операци/i);
});

test('running attempts prevent carryover and leave the sprint open', () => {
  const { planning, studio, task, sprint, insert, read } = fixture();
  sprint('first', ['running']);
  task('running', { sprintId: 'first' });
  insert('attempts', { id: 'attempt', taskId: 'running', studioId: studio.id, status: 'running' });
  assert.throws(() => planning.closeSprint({
    studioId: studio.id, sprintId: 'first', operationId: 'close', carryovers: [{ taskId: 'running', reason: 'Later', stage: 'backlog' }],
  }), /попытк/i);
  assert.equal(read('sprints', 'first').status, 'active');
});

test('a phase transition requires accepted evidence and follows the owner approval policy', () => {
  const { planning, studio, task, sprint, read } = fixture();
  sprint('first', ['evidence', 'unfinished']);
  task('evidence', { sprintId: 'first', stage: 'done', status: 'completed' });
  task('unfinished', { sprintId: 'first' });
  const phase = planning.createPhase({
    studioId: studio.id, title: 'Launch', goal: 'Ship', criteria: [{ description: 'Shipped' }], sprintIds: ['first'],
  });
  assert.throws(() => planning.proposePhaseTransition({ studioId: studio.id, phaseId: phase.id, evidenceIds: ['unfinished'] }), /доказательств/i);
  const proposal = planning.proposePhaseTransition({ studioId: studio.id, phaseId: phase.id, evidenceIds: ['evidence'] });
  assert.equal(proposal.transition.status, 'pending');
  planning.decidePhaseTransition({ studioId: studio.id, phaseId: phase.id, decision: 'approve' });
  assert.equal(read('phases', phase.id).status, 'completed');
  assert.deepEqual(read('phases', phase.id).transitionHistory[0].evidenceIds, ['evidence']);
});

test('grooming triggers strictly below twice WIP and coalesces open reviews', () => {
  const { planning, studio, task } = fixture();
  const input = { studioId: studio.id };
  planning.updateGrooming({ ...input, enabled: true });
  for (let number = 0; number < 4; number += 1) task(`ready${number}`);
  assert.equal(planning.maybeRequestGrooming(input), undefined);
  planning.reviseBacklog({ ...input, baseVersion: 0, edits: [{ type: 'update', taskId: 'ready3', links: [{ type: 'blocks', taskId: 'ready2' }] }] });
  const request = planning.maybeRequestGrooming(input);
  assert.equal(request.readyTasks, 3);
  assert.equal(request.threshold, 4);
  assert.equal(planning.requestGrooming(input).id, request.id);
});

test('automatic grooming waits for free capacity in an existing draft', () => {
  const { planning, studio, insert } = fixture();
  const input = { studioId: studio.id };
  planning.updateGrooming({ ...input, enabled: true, nextSprintCapacity: 1 });
  insert('plans', { id: 'draft', studioId: studio.id, kind: 'sprint', status: 'pending', tasks: [{ key: 'planned' }] });
  assert.equal(planning.maybeRequestGrooming(input), undefined);
  assert.equal(planning.requestGrooming(input).freeCapacity, 0);
});

test('maintenance cadence excludes the initial sprint and validates points and task counts without training', () => {
  const base = { enabled: true, every: 2, minShare: 60, minOpenTasks: 1 };
  assert.equal(normalizeDebtPolicy().measure, 'points');
  assert.equal(normalizeDebtPolicy(base).measure, 'taskCount');
  const studio = { id: 'studio', debtPolicy: { ...base, measure: 'points' } };
  const queued = [{ id: 'debt', studioId: studio.id, kind: 'debt', status: 'queued', title: 'Maintenance', prompt: 'Repair' }];
  const sprints = [{ studioId: 'studio', planId: 'initial' }, { studioId: 'studio', planId: 'first' }];
  const context = debtPlanContext(studio, queued, sprints, new Set(['initial']));
  assert.equal(context.sprintNumber, 2);
  assert.equal(context.active, true);
  const points = [{ kind: 'debt', debtTaskId: 'debt', points: 3 }, { points: 2 }, { kind: 'train', points: 100 }];
  assert.doesNotThrow(() => validateDebtPlan(points, context));
  assert.throws(() => validateDebtPlan(points, { ...context, measure: 'taskCount' }), /60%/);
  assert.throws(() => validateDebtPlan([{ kind: 'debt', debtTaskId: 'debt' }], context), /оценк/i);
  assert.throws(() => validateDebtPlan([points[0], points[0]], context), /повторяющ/i);
  assert.throws(() => debtAssessment({ ...base, reason: 'Evidence' }), /способ измерения/i);
  assert.throws(() => debtAssessment({ ...base, measure: 'invalid', reason: 'Evidence' }), /способ измерения/i);
});

test('retrospective preserves the approved estimate and flags unmeasured work', () => {
  const { planning, studio, task, insert } = fixture();
  insert('sprints', {
    id: 'first', studioId: studio.id, status: 'active', taskIds: ['estimated', 'unestimated'],
    plannedWork: [{ id: 'estimated', points: 3 }, { id: 'unestimated' }],
  });
  task('estimated', { sprintId: 'first', stage: 'done', status: 'completed', points: 8 });
  task('unestimated', { sprintId: 'first', stage: 'done', status: 'completed', points: 1 });
  const retro = planning.calculateRetrospective({ studioId: studio.id, sprintId: 'first' });
  assert.deepEqual(retro.planned.missingPointTaskIds, ['unestimated']);
  assert.equal(retro.planned.knownPoints, 3);
  assert.equal(retro.planned.points, null);
});

test('retrospective counts recorded QA checks and only rework done in the current sprint', () => {
  const { planning, studio, task, sprint } = fixture();
  sprint('next', ['moved']);
  task('moved', {
    sprintId: 'next', revision: 3, failedReviews: 2, review: 'Reviewed',
    carryoverHistory: [{ fromSprintId: 'first', revision: 2, failedReviews: 1 }],
    gitDelivery: { checks: [{ checkId: 'test', status: 'PASS' }, { checkId: 'audit', status: 'NOT ASSESSED' }] },
  });
  const retro = planning.calculateRetrospective({ studioId: studio.id, sprintId: 'next' });
  assert.equal(retro.rework.cycles, 1);
  assert.equal(retro.qa.rejectedReviews, 1);
  assert.deepEqual(retro.qa.checks, { total: 2, passed: 1, failed: 0, notAssessed: 1 });
});
