import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderWork } from '../renderer/work-view.mjs';
import { createCommandRouter } from '../app/bridge.mjs';

test('registry names the assignee and searches title, ID and sprint without dropping the board', () => {
  const html = renderWork({ tab: 'registry', registryQuery: 'Спринт 41', studio: { agents: [{ id: 'a', name: 'Ира' }] },
    sprints: [{ id: 's', title: 'Спринт 41' }],
    tasks: [{ id: 't1', title: 'Первая', sprintId: 's', agentId: 'a' }, { id: 't2', title: 'Вторая' }] });
  assert.match(html, /data-work-tab="board"/);
  assert.match(html, /data-task="t1"/);
  assert.match(html, /Ира/);
  assert.doesNotMatch(html, /data-task="t2"/);
});

test('reveal and copy evidence use the stored record without accepting paths from the renderer', async () => {
  const saved = { id: 'proof', studioId: 's' };
  const dispatch = createCommandRouter({ service: { findEvidence: () => saved },
    revealEvidence: record => record, copyEvidencePath: record => record });
  for (const command of ['revealEvidence', 'copyEvidencePath']) {
    assert.equal(await dispatch(command, { studioId: 's', evidenceId: 'proof', path: '/arbitrary' }), saved);
  }
});
