import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createMeetings } from '../core/meetings.mjs';
import { createPrerequisites } from '../core/prerequisites.mjs';

function setup(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  for (const table of ['studios', 'tasks', 'sprints', 'meetings', 'meeting_actions', 'prerequisites', 'evidence']) {
    db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
  }
  const store = {
    read(name, id) {
      const row = db.prepare(`SELECT data FROM ${name} WHERE id = ?`).get(id);
      assert.ok(row, `${name}/${id} does not exist`);
      return JSON.parse(row.data);
    },
    list: (name) => db.prepare(`SELECT data FROM ${name} ORDER BY rowid`).all().map(({ data }) => JSON.parse(data)),
    insert(name, record) {
      db.prepare(`INSERT INTO ${name} VALUES (?, ?)`).run(record.id, JSON.stringify(record));
      return record;
    },
    update(name, record) {
      db.prepare(`UPDATE ${name} SET data = ? WHERE id = ?`).run(JSON.stringify(record), record.id);
      return record;
    },
    transaction(run) {
      db.exec('BEGIN');
      try {
        const result = run();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    changed: (record) => record,
    wake() {},
  };
  const a = { id: 'a', name: 'Engineering', mode: 'fixed', runtime: 'codex', model: 'engineering' };
  const b = { id: 'b', name: 'Design', mode: 'fixed', runtime: 'claude', model: 'design' };
  const c = { id: 'c', name: 'QA', mode: 'inherit' };
  const studio = store.insert('studios', { id: 'studio', language: 'ru', agents: [a, b, c] });
  const training = store.insert('tasks', {
    id: 'train', studioId: studio.id, kind: 'train', training: { targetAgentId: 'a' }, stage: 'ready', status: 'queued',
  });
  const options = {
    ...store,
    createAction(studio, _meeting, action, id) {
      return store.insert('tasks', {
        id, studioId: studio.id, kind: action.kind, ...(action.kind === 'train' ? { training: { targetAgentId: action.agentId } } : {}),
      });
    },
  };
  const prerequisites = createPrerequisites(options);
  const makeMeetings = (extra) => createMeetings({ ...options, prerequisites, ...extra });
  const meetingApi = makeMeetings();
  const open = (extra) => meetingApi.openMeeting({ studioId: studio.id, kind: 'topic', agenda: 'Approve test plan', participants: ['a', 'b'], ...extra });
  const prerequisite = { trainTaskId: training.id, agentId: 'a', skillRef: 'qa@2', reason: 'New regression suite', criterion: 'Accepted exercise' };
  return { ...store, studio, a, b, c, training, prerequisites, prerequisite, makeMeetings, open, ...meetingApi };
}

const outcome = {
  summary: 'Проверить регрессию',
  decisions: [{ text: 'Проверяем новую сборку', rationale: 'Изменился контракт', verification: 'Отчёт прогона' }],
  actionItems: [{ kind: 'work', title: 'QA', prompt: 'Run the suite', criteria: 'Passing logs', agentId: 'b' }],
};

function completeNext(fixture, attemptId, data) {
  const step = fixture.nextMeetingStep(fixture.studio.id);
  fixture.startMeetingStep(step, attemptId);
  fixture.finishMeetingStep(step, attemptId, data);
  return step;
}

test('independent positions, objections, typed result and idempotent actions', (t) => {
  const f = setup(t);
  const meeting = f.open();
  const first = completeNext(f, 'one', { text: 'PRIVATE FIRST POSITION' });
  const second = completeNext(f, 'two', { text: 'second position' });
  assert.deepEqual([first.agentId, second.agentId], ['a', 'b']);
  assert.deepEqual([f.a.model, f.b.model], ['engineering', 'design']);
  assert.doesNotMatch(second.prompt, /PRIVATE FIRST POSITION/);
  const discussion = completeNext(f, 'three', { action: 'objections', agentIds: ['b'], question: 'Is timing acceptable?' });
  assert.match(discussion.prompt, /PRIVATE FIRST POSITION/);
  assert.equal(discussion.agentId, null);
  const objection = completeNext(f, 'four', { text: 'need an extra day' });
  assert.equal(objection.agentId, 'b');
  assert.match(objection.prompt, /Is timing acceptable/);
  const last = completeNext(f, 'five', { action: 'resolve', ...outcome });
  assert.match(last.prompt, /need an extra day/);
  const result = f.read('meetings', meeting.id);
  assert.equal(result.stage, 'resolved');
  assert.deepEqual(result.decisions, outcome.decisions);
  assert.equal(result.positions.length, 3);
  assert.equal(result.taskIds.length, 1);
  assert.deepEqual(f.resolveMeeting({ meetingId: meeting.id, version: last.version, ...outcome }), result);
  assert.throws(() => f.resolveMeeting({ meetingId: meeting.id, version: last.version, ...outcome, summary: 'other' }));
  assert.equal(f.list('meeting_actions').length, 1);
});

test('training gates only the linked consumer, with replacement and recorded owner exception', (t) => {
  const f = setup(t);
  const blocked = f.open({ prerequisites: [f.prerequisite] });
  assert.equal(f.nextMeetingStep(f.studio.id), undefined);
  const independent = f.open();
  assert.equal(f.nextMeetingStep(f.studio.id).meetingId, independent.id);
  const replacement = f.replaceParticipant({ meetingId: blocked.id, agentId: 'a', replacementAgentId: 'c' });
  assert.deepEqual(replacement.participants, ['c', 'b']);
  assert.equal(f.nextMeetingStep(f.studio.id).meetingId, blocked.id);
  const another = f.open({ prerequisites: [f.prerequisite] });
  const [gate] = f.prerequisites.pendingPrerequisites('meeting', another.id);
  assert.throws(() => f.prerequisites.waivePrerequisite({ prerequisiteId: gate.id, author: '', reason: 'Owner reviewed' }));
  const waived = f.prerequisites.waivePrerequisite({ prerequisiteId: gate.id, author: 'Owner', reason: 'Validated prior work' });
  assert.equal(waived.exception.author, 'Owner');
  assert.deepEqual(f.prerequisites.pendingPrerequisites('meeting', another.id), []);
  f.update('tasks', { ...f.training, stage: 'done', status: 'completed', review: 'accepted' });
  const passed = f.open({ prerequisites: [f.prerequisite] });
  assert.deepEqual(f.prerequisites.pendingPrerequisites('meeting', passed.id), []);
});

test('recovering a claimed position rejects late output and keeps completed positions', (t) => {
  const f = setup(t);
  const meeting = f.open();
  completeNext(f, 'one', { text: 'first position' });
  const step = f.nextMeetingStep(f.studio.id);
  f.startMeetingStep(step, 'old');
  const restarted = f.makeMeetings();
  restarted.recoverMeetings();
  assert.equal(restarted.nextMeetingStep(f.studio.id), undefined);
  assert.throws(() => restarted.finishMeetingStep(step, 'old', { text: 'late position' }));
  restarted.resumeMeeting({ meetingId: meeting.id });
  const next = restarted.nextMeetingStep(f.studio.id);
  assert.equal(next.agentId, 'b');
  restarted.startMeetingStep(next, 'new');
  restarted.submitPosition({ meetingId: meeting.id, agentId: 'b', attemptId: 'new', text: 'fresh position' });
  assert.deepEqual(f.read('meetings', meeting.id).positions.map(({ text }) => text), ['first position', 'fresh position']);
});

test('an escalated decision creates no actions before owner approval', (t) => {
  const f = setup(t);
  const notifications = [];
  const api = f.makeMeetings({ notifyOwner: (_studio, meeting, reason) => notifications.push({ meetingId: meeting.id, reason }) });
  const meeting = api.openMeeting({ studioId: f.studio.id, kind: 'topic', agenda: 'Resolve the dispute', participants: ['a'] });
  const g = { ...f, ...api };
  completeNext(g, 'one', { text: 'Keep the current scope' });
  completeNext(g, 'two', { action: 'owner', reason: 'Scope needs a budget decision', ...outcome });
  const review = f.read('meetings', meeting.id);
  assert.equal(review.stage, 'owner_review');
  assert.deepEqual(notifications, [{ meetingId: meeting.id, reason: 'Scope needs a budget decision' }]);
  assert.equal(f.list('meeting_actions').length, 0);
  assert.equal(api.nextMeetingStep(f.studio.id), undefined);
  assert.throws(() => api.resolveMeeting({ meetingId: meeting.id, version: review.version - 1, ...outcome }));
  const accepted = api.resolveMeeting({ meetingId: meeting.id, version: review.version, ...review.proposedOutcome });
  assert.equal(accepted.resolution.source, 'owner');
  assert.equal(f.list('meeting_actions').length, 1);
});

test('meeting references pin evidence to its recorded content and checked revision', (t) => {
  const f = setup(t);
  f.insert('evidence', { id: 'proof', studioId: f.studio.id, digest: 'content-1', revision: { digest: 'revision-1' } });
  const ref = { type: 'evidence', id: 'proof', digest: 'content-1', revisionDigest: 'revision-1' };
  const meeting = f.open({ kind: 'review', materialRefs: [ref] });
  assert.deepEqual(meeting.materialRefs, [ref]);
  assert.equal(meeting.materials[0].revisionDigest, 'revision-1');
  assert.throws(() => f.open({ kind: 'review', materialRefs: [{ ...ref, revisionDigest: 'stale' }] }));
});

test('retrospective includes stored facts and links approved training to its future consumer', (t) => {
  const f = setup(t);
  const consumer = f.insert('tasks', { id: 'future', studioId: f.studio.id, agentId: 'a', kind: 'work' });
  const sprint = f.insert('sprints', { id: 'sprint', studioId: f.studio.id, taskIds: [] });
  const api = f.makeMeetings({ reportFacts: () => ({ accepted: 3, carried: 2 }) });
  const meeting = api.openMeeting({
    studioId: f.studio.id, kind: 'retrospective', agenda: 'Improve QA', participants: ['a'], sprintId: sprint.id,
  });
  assert.deepEqual(meeting.facts, { accepted: 3, carried: 2 });
  const g = { ...f, ...api };
  completeNext(g, 'one', { text: 'Need training' });
  completeNext(g, 'two', {
    action: 'resolve', ...outcome,
    actionItems: [{
      kind: 'train', title: 'QA', prompt: 'Learn to run the suite', criteria: 'Passing exercise', agentId: 'a',
      futureConsumer: { consumerType: 'task', consumerId: consumer.id, skillRef: 'qa@3', reason: 'New QA method', criterion: 'Passing exercise' },
    }],
  });
  const result = f.read('meetings', meeting.id);
  const [gate] = f.prerequisites.pendingPrerequisites('task', consumer.id);
  assert.equal(gate.trainTaskId, result.taskIds[0]);
  assert.equal(f.read('tasks', result.taskIds[0]).kind, 'train');
});

test('invalid prerequisite rolls back the meeting or all actions of its resolution', (t) => {
  const f = setup(t);
  assert.throws(() => f.open({ prerequisites: [f.prerequisite, { ...f.prerequisite, agentId: 'b' }] }));
  assert.equal(f.list('meetings').length, 0);
  assert.equal(f.list('prerequisites').length, 0);

  const meeting = f.open({ participants: ['a'] });
  completeNext(f, 'one', { text: 'Need QA' });
  const step = f.nextMeetingStep(f.studio.id);
  f.startMeetingStep(step, 'two');
  const invalidTraining = {
    kind: 'train', title: 'QA', prompt: 'Learn the suite', criteria: 'Passing exercise', agentId: 'a',
    futureConsumer: { consumerType: 'invalid', consumerId: 'missing', skillRef: 'qa', reason: 'New suite', criterion: 'Passing exercise' },
  };
  assert.throws(() => f.finishMeetingStep(step, 'two', {
    action: 'resolve', ...outcome, actionItems: [...outcome.actionItems, invalidTraining],
  }));
  assert.equal(f.list('meeting_actions').length, 0);
  assert.deepEqual(f.list('tasks').map(({ id }) => id), [f.training.id]);
  assert.equal(f.read('meetings', meeting.id).activeStep.attemptId, 'two');
  assert.equal(f.finishMeetingStep(step, 'two', { action: 'resolve', ...outcome }).stage, 'resolved');
});
