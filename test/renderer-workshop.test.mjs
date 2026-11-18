import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRooms, taskForAgent } from '../renderer/workshop.mjs';

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
