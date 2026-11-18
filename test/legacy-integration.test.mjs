import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createStudioService } from '../core/service.mjs';
import { trainingReply } from './fixtures/training.mjs';

const initialPlan = {
  title: 'First', goal: 'Write report',
  epic: { title: 'Book', description: 'Book project' },
  story: { title: 'Outline', acceptance: 'Useful outline' },
  agents: [
    { key: 'writer', role: 'editor', description: 'Write outline' },
    { key: 'reviewer', role: 'other', description: 'Verify outline' },
  ],
  tasks: [{ key: 'first', title: 'First task', prompt: 'Write it', criteria: 'Has a title', agentKey: 'writer', reviewerKey: 'reviewer' }],
};

const json = data => ({ text: JSON.stringify(data) });

async function until(service, predicate) {
  for (let index = 0; index < 120; index++) {
    const value = predicate(service.snapshot());
    if (value) return value;
    await delay(5);
  }
  assert.fail('Studio did not advance: ' + JSON.stringify(service.snapshot().inbox));
}

async function approveInitial(service, studioId) {
  service.initializeStudio({ studioId });
  const plan = await until(service, ({ plans }) => plans[0]);
  service.decidePlan({ planId: plan.id, decision: 'approve' });
}

test('an owner note can use the second slot while a sprint task runs and returns an applicable priority proposal', async (t) => {
  const executing = Promise.withResolvers();
  let backlogId;
  const service = createStudioService({ dbPath: ':memory:', run: async request => {
    const training = trainingReply(request);
    if (training) return training;
    if (request.purpose === 'task') return executing.promise;
    if (request.purpose === 'conversation') {
      request.onEvent({ type: 'usage', usage: { inputTokens: 44, outputTokens: 8 } });
      return json({ text: 'Уточню приоритет', priorityChange: { taskId: backlogId, priority: 25 } });
    }
    return json({ plan: initialPlan, review: { pass: true, summary: 'Ready' }, director: { action: 'finish' } }[request.purpose]);
  } });
  t.after(() => { executing.resolve(json({ summary: 'Done' })); return service.close(); });
  const studio = service.createStudio({ name: 'Parallel', root: '/project', wipLimit: 2 });
  backlogId = service.createTask({ studioId: studio.id, title: 'Later', prompt: 'Consider it' }).id;
  await approveInitial(service, studio.id);
  await until(service, ({ tasks }) => tasks.some(task => task.key === 'first' && task.status === 'running'));
  service.postStudioMessage({ studioId: studio.id, kind: 'note', text: 'Поставь приоритет 25 карточке Later', operationId: 'note' });
  const reply = await until(service, ({ conversationMessages }) => conversationMessages.find(message => message.priorityProposal));
  assert.equal(service.snapshot().tasks.find(({ key }) => key === 'first').status, 'running');
  service.applyConversationProposal({ studioId: studio.id, messageId: reply.id });
  assert.equal(service.snapshot().tasks.find(({ id }) => id === backlogId).priority, 25);
  assert.equal(service.studioUsage({ studioId: studio.id }).totals.input, 44);
});

test('a carried task is reusable by the next plan with its prior owner decision', async t => {
  let nextPlan;
  let ask = true;
  const service = createStudioService({ dbPath: ':memory:', run: request => {
    const training = trainingReply(request);
    if (training) return training;
    const results = {
      plan: nextPlan ?? initialPlan,
      task: ask ? { question: { title: 'Review', body: 'Confirm count', choices: [{ label: 'Two', answer: 'Use two' }] } } : { summary: 'Reused' },
      review: { pass: true, summary: 'Good' }, director: { action: 'finish' },
    };
    return json(results[request.purpose]);
  } });
  t.after(() => service.close());
  const studio = service.createStudio({ name: 'Phases', root: '/project' });
  await approveInitial(service, studio.id);
  const question = await until(service, ({ inbox }) => inbox.find(item => item.kind === 'question'));
  const first = service.snapshot().sprints[0];
  service.closeSprint({ studioId: studio.id, sprintId: first.id, carryovers: [{ taskId: question.taskId, stage: 'ready', reason: 'Wait for confirmation' }], operationId: 'carry-over' });
  assert.equal(service.snapshot().studios[0].lifecycle, 'idle');
  service.answerInbox({ inboxId: question.id, version: 1, choiceId: 'option-1', operationId: 'answer' });
  nextPlan = { ...initialPlan, epicId: first.epicId, storyId: first.storyId,
    tasks: [{ ...initialPlan.tasks[0], backlogTaskId: question.taskId, points: 3 }] };
  ask = false;
  service.startNextSprint({ studioId: studio.id });
  const draft = await until(service, ({ plans }) => plans.find(plan => plan.kind === 'sprint' && plan.status === 'pending'));
  service.decidePlan({ planId: draft.id, decision: 'approve' });
  const next = await until(service, ({ sprints }) => sprints.find(sprint => sprint.id !== first.id && sprint.status === 'completed'));
  assert.equal(next.epicId, first.epicId);
  assert.equal(next.storyId, first.storyId);
  const carried = service.snapshot().tasks.find(({ id }) => id === question.taskId);
  assert.equal(carried.sprintId, next.id);
  assert.equal(carried.points, 3);
  assert.equal(carried.carryoverHistory[0].fromSprintId, first.id);
});
