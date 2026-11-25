import assert from 'node:assert/strict';
import test from 'node:test';
import * as owner from '../renderer/owner-facts.mjs';
import { renderWork } from '../renderer/work-view.mjs';

const studio = { id:'studio', agents:[{id:'editor', name:'Редактор'}] };
const tasks = [
  { id:'waiting', studioId:studio.id, title:'Решение о пьесе', agentId:'editor', stage:'qa', status:'waiting', sprintId:'one' },
  { id:'done', studioId:studio.id, title:'Персонаж Вера', agentId:'editor', stage:'done', status:'completed', artifactPath:'vera.md', sprintId:'one' },
  { id:'backlog', studioId:studio.id, title:'Резерв для будущего спринта', stage:'backlog', status:'queued' },
];
const inbox = [{ id:'accept', studioId:studio.id, taskId:'waiting', kind:'acceptance', status:'open' }];

test('task status separates owner acceptance, blocked dependencies, and a completed attempt before review', () => {
  assert.deepEqual(owner.taskOwnerState(tasks[0], {inbox}), {stage:'qa', label:'Ждёт вашей приёмки'});
  assert.deepEqual(owner.taskOwnerState({id:'b', stage:'blocked', dependencies:['waiting']}, {tasks}), {stage:'blocked', label:'Ждёт зависимую задачу'});
  assert.deepEqual(owner.taskOwnerState({id:'b', stage:'in_progress', status:'completed'}), {stage:'in_progress', label:'Передача результата'});
  assert.deepEqual(owner.taskOwnerState({id:'b', stage:'ready', status:'scheduled'}), {stage:'ready', label:'В очереди на запуск'});
  assert.deepEqual(owner.currentStudioTasks(tasks).map(t=>t.id), ['waiting']);
});

test('board keeps the task search and owner-decision filter from the register', () => {
  const context = {studio,tasks,inbox,registryQuery:'пьесе',registryOwner:'editor',registryDecision:true};
  for (const tab of ['board','registry']) {
    const markup = renderWork({...context,tab});
    assert.match(markup,/data-registry-query/);
    assert.match(markup,/data-registry-decision[^>]*checked/);
    assert.match(markup,/data-task="waiting"/);
    assert.doesNotMatch(markup,/data-task="done"|data-task="backlog"/);
    assert.match(markup,/Ждёт вашей приёмки/);
  }
});

test('artifacts foreground delivered files and group verbose verification records', () => {
  const evidence = [{id:'proof',taskId:'done',kind:'qa-log',sourcePath:'build.log',recordedAt:'2026-11-25'}];
  const markup = renderWork({studio,tasks,evidence,tab:'artifacts'});
  assert.ok(markup.indexOf('vera.md') < markup.indexOf('build.log'));
  assert.match(markup,/<details[^>]*data-artifact-evidence[^>]*>/);
  assert.match(markup,/data-file-key="[^"]*build\.log/);
});
