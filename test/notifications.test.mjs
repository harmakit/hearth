import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotifications } from '../app/notifications.mjs';

test('a saved event is delivered once across instances, with its own version and studio preferences', () => {
  const deliveries = new Map();
  const shown = [];
  let preferences = { enabled: true, studios: { silent: false } };
  const create = () => createNotifications({
    readDelivery: (id) => deliveries.get(id),
    saveDelivery: (value) => deliveries.set(value.id, value),
    readPreferences: () => preferences,
    deliver: (notice) => shown.push(notice),
    now: () => '2026-11-18T12:00:00.000Z',
  });
  const event = { studioId: 'studio', inboxId: 'inbox', version: 2, kind: 'question', title: 'Вопрос' };
  assert.equal(create().notify(event), true);
  assert.equal(create().notify(event), false);
  assert.equal(create().notify({ ...event, version: 3 }), true);
  assert.deepEqual(shown.map(({ studioId, inboxId, version }) => ({ studioId, inboxId, version })), [
    { studioId: 'studio', inboxId: 'inbox', version: 2 },
    { studioId: 'studio', inboxId: 'inbox', version: 3 },
  ]);
  assert.equal(create().notify({ ...event, studioId: 'silent' }), false);
  preferences = { enabled: false };
  assert.equal(create().notify({ ...event, inboxId: 'other' }), false);
});
