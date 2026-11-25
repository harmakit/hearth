import assert from 'node:assert/strict';
import test from 'node:test';
import { currentStudioTasks, taskFacts } from '../renderer/owner-facts.mjs';

test('task details scope attempts, dependencies and provider measurements to the owning studio', () => {
  const task = { id: 't', studioId: 'a', dependencies: ['before'] };
  const snapshot = {
    tasks: [task, { id: 'before', studioId: 'a' }, { id: 'after', studioId: 'a', dependencies: ['t'] }],
    attempts: [{ id: 'one', taskId: 't', studioId: 'a' }, { id: 'two', taskId: 't', studioId: 'a' },
      { id: 'three', taskId: 't', studioId: 'a' }, { id: 'foreign', taskId: 't', studioId: 'b' }],
    usageEvents: [
      { attemptId: 'one', studioId: 'a', input: 71120, cacheRead: 48120, output: 10070 },
      { attemptId: 'two', studioId: 'a', input: 0, output: 0 },
      { attemptId: 'one', studioId: 'b', input: 500, output: 100 },
    ],
  };
  const facts = taskFacts(snapshot, 'a', 't');
  assert.equal(facts.usage.total, 81190);
  assert.equal(facts.usage.measured, 2);
  assert.equal(facts.attempts.length, 3);
  assert.deepEqual(facts.before.map(t => t.id), ['before']);
  assert.deepEqual(facts.after.map(t => t.id), ['after']);
  assert.equal(taskFacts(snapshot, 'b', 't'), null);
  assert.equal(taskFacts(snapshot, 'a', 'before').usage.total, null);
});

test('the overview omits unscheduled backlog cards and retains work queued inside a sprint', () => {
  const tasks = [
    {id:'future',status:'queued',stage:'backlog'},
    {id:'sprint-dependency',status:'queued',stage:'backlog',sprintId:'sprint'},
    {id:'requested',status:'scheduled',stage:'backlog'},
    {id:'lesson',status:'queued',stage:'backlog',kind:'train'},
    {id:'replaced',status:'queued',stage:'replaced'},
    {id:'finished',status:'completed',stage:'done'},
  ];
  assert.deepEqual(currentStudioTasks(tasks).map(task=>task.id), ['sprint-dependency','requested','lesson']);
});

test('task history links only messages of this task and retains known timestamps for old attempts', () => {
  const facts = taskFacts({
    tasks: [{ studioId: 's', id: 't', createdAt: '2026-01-01' }],
    evidence: [{ id: 'proof', studioId: 's', taskId: 't', recordedAt: '2026-01-04', sourcePath: 'result.md' }],
    attempts: [{ studioId: 's', id: 'r', taskId: 't', finishedAt: '2026-01-03', status: 'failed' }],
    conversations: [{ studioId: 's', id:'c', taskId:'t', agentId:'writer' }],
    conversationMessages: [{ studioId:'s', id:'m', conversationId:'c', text:'Отчёт', createdAt:'2026-01-02' },
      { studioId:'other', id:'foreign', conversationId:'c', text:'Private' }],
  }, 's', 't');
  assert.deepEqual(facts.messages.map(m => [m.id, m.agentId]), [['m','writer']]);
  assert.deepEqual(facts.history.map(e => e.type), ['evidence','attempt-end','message','created']);
});
