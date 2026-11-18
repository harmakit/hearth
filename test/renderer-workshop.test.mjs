import assert from 'node:assert/strict';
import test from 'node:test';
import { agentActivity, buildRooms, languageChoices, pendingStudioPlan, taskForAgent } from '../renderer/workshop.mjs';

test('groups the live roster in stable rooms and gives different roles distinct desks', () => {
  const studio = { id: 'studio', agents: [
    { id: 'e', name: 'Инженер', role: 'engineer' },
    { id: 'a', name: 'Художник', role: 'artist' },
    { id: 'l', name: 'Архивист', role: 'library' },
    { id: 'w', name: 'Редактор', role: 'editor' },
    { id: 'x', name: 'Участник', role: 'custom' },
  ] };
  const rooms = buildRooms(studio);
  assert.deepEqual(rooms.map(room => room.id), ['director', 'library', 'workshop', 'atelier', 'common']);
  assert.deepEqual(rooms.find(room => room.id === 'library').desks.map(desk => desk.agent.id), ['l', 'w']);
  assert.notEqual(rooms[1].desks[0].props, rooms[1].desks[1].props);
  assert.deepEqual(buildRooms({ ...studio, agents: [] }).map(room => room.id), ['director']);
});

test('keeps stored report languages that are no longer in the preset list', () => {
  assert.equal(languageChoices()[0], 'Русский');
  assert.ok(languageChoices().includes('English'));
  assert.equal(languageChoices('Ndonga').at(-1), 'Ndonga');
  assert.equal(languageChoices('Русский').filter(value => value === 'Русский').length, 1);
});

test('shows only the selected studio’s pending plan and distinguishes actual agent activity', () => {
  const plans = [
    { id: 'a', studioId: 'one', status: 'approved' },
    { id: 'b', studioId: 'two', status: 'pending' },
    { id: 'c', studioId: 'one', status: 'pending' },
  ];
  assert.equal(pendingStudioPlan(plans, 'one').id, 'c');
  assert.deepEqual(agentActivity({ status: 'completed', stage: 'done' }), ['Свободен', '']);
  assert.deepEqual(agentActivity({ status: 'waiting' }), ['Ждёт ответа', 'warn']);
  assert.deepEqual(agentActivity({ status: 'running', stage: 'review' }), ['На ревью', 'good']);
  assert.deepEqual(agentActivity(undefined, 'planning'), ['Готовит план', 'good']);
});

test('shows an active assigned task before recent history and keeps studio boundaries', () => {
  const tasks = [
    { id: 1, studioId: 'one', agentId: 'a', status: 'completed', updatedAt: '2026-11-18' },
    { id: 2, studioId: 'one', agentId: 'a', status: 'waiting', updatedAt: '2026-11-17' },
    { id: 3, studioId: 'two', agentId: 'a', status: 'running', updatedAt: '2026-11-19' },
    { id: 4, studioId: 'one', agentId: null, status: 'queued', updatedAt: '2026-11-19' },
  ];
  assert.equal(taskForAgent(tasks, 'one', 'a').id, 2);
  assert.equal(taskForAgent(tasks, 'one', null).id, 4);
  assert.equal(taskForAgent(tasks, 'one', 'unknown'), undefined);
});

test('assigns an active review to its reviewer and a director decision to the director', () => {
  const reviewing = { id: 1, studioId: 'one', agentId: 'writer', activeAgentId: 'reviewer', status: 'running' };
  const directing = { id: 2, studioId: 'one', agentId: 'writer', activeAgentId: null, status: 'running' };
  assert.equal(taskForAgent([reviewing, directing], 'one', 'writer'), undefined);
  assert.equal(taskForAgent([reviewing, directing], 'one', 'reviewer'), reviewing);
  assert.equal(taskForAgent([reviewing, directing], 'one', null), directing);
});
