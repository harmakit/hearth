import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderWork } from '../renderer/work-view.mjs';
import { renderWorkspaceHome } from '../renderer/workspace-view.mjs';
import { createCommandRouter } from '../app/bridge.mjs';

test('the workspace shows an idle studio with a failed task as needing attention', () => {
  const studio = { id: 's', name: 'Studio', lifecycle: 'active', activeAttempts: 0 };
  const task = { id: 't', studioId: 's', status: 'failed' };
  const idle = renderWorkspaceHome({ studios: [studio], tasks: [task], attempts: [] });
  assert.match(idle, /Нужно внимание/);
  assert.doesNotMatch(idle, />В работе</);
  const active = renderWorkspaceHome({ studios: [{ ...studio, activeAttempts: 1 }], tasks: [task] });
  assert.match(active, />В работе</);
});

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
