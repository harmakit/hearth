import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createStudioService } from '../core/service.mjs';

const confirmed = {
  codex: { available: true, authenticated: true, models: [{ id: 'default-model', name: 'Default', efforts: ['low', 'high'] }] },
  claude: { available: true, authenticated: false, models: [{ id: 'locked', efforts: [] }] },
};

test('fresh studios can start with defaults and the automatically discovered catalog', async t => {
  const service = createStudioService({ dbPath: ':memory:', inspectRuntime: ({ runtime }) => confirmed[runtime] });
  t.after(() => service.close());
  const studio = service.createStudio({ name: 'Studio', root: '/project' });
  assert.equal(studio.wipLimit, 5);
  assert.deepEqual(studio.groomingPolicy, { enabled: true, threshold: null, nextSprintCapacity: 5 });
  assert.deepEqual(studio.debtPolicy, { enabled: true, every: 4, minShare: 60, minOpenTasks: 1, measure: 'points' });
  await service.refreshProviders();
  const discovered = [{ runtime: 'codex', model: 'default-model', efforts: ['low', 'high'] }];
  assert.deepEqual(service.snapshot().studios[0].effectiveAllowed, discovered);
  service.updateProviderPreference({ runtime: 'codex', enabled: false });
  assert.equal(service.snapshot().providers.codex.enabled, false);
  assert.deepEqual(service.snapshot().studios[0].effectiveAllowed, []);
  await assert.rejects(service.assessDebtPolicy({ studioId: studio.id }), /отключён/);
});

test('an explicit studio policy and an empty director-only policy are distinct from automatic discovery', async t => {
  const service = createStudioService({ dbPath: ':memory:', inspectRuntime: ({ runtime }) => confirmed[runtime] });
  t.after(() => service.close());
  await service.refreshProviders();
  const direct = [{ runtime: 'claude', model: 'manual', efforts: [] }];
  const studio = service.createStudio({ name: 'Studio', root: '/project', allowedMode: 'studio', allowed: direct, wipLimit: 2, debtPolicy: {
    enabled: false, every: 6, minShare: 30, minOpenTasks: 1, measure: 'taskCount',
  } });
  service.createStudio({ name: 'Director', root: '/director', allowedMode: 'studio', allowed: [] });
  service.updateModelPolicy({ mode: 'all' });
  const [specific, director] = service.snapshot().studios;
  assert.deepEqual(specific.effectiveAllowed, direct);
  assert.deepEqual(director.effectiveAllowed, []);
  assert.equal(specific.wipLimit, 2);
  assert.equal(studio.debtPolicy.enabled, false);
});

test('the old empty startup list adopts defaults while explicit provider changes survive restart', async t => {
  const profile = await mkdtemp(fileURLToPath(new URL('../.tmp/catalog-test-', import.meta.url)));
  const dbPath = join(profile, 'studio.sqlite');
  let service = createStudioService({ dbPath });
  t.after(async () => { await service.close(); await rm(profile, { recursive: true, force: true }); });
  const oldStudio = service.createStudio({ name: 'Existing', root: '/existing', wipLimit: 1, groomingPolicy: { enabled: false } });
  await service.close();
  const db = new DatabaseSync(dbPath);
  db.prepare("INSERT INTO app_settings VALUES ('modelPolicy', ?)").run(JSON.stringify({ configured: true, allowed: [] }));
  db.close();
  service = createStudioService({ dbPath, inspectRuntime: ({ runtime }) => confirmed[runtime] });
  await service.refreshProviders();
  assert.equal(service.snapshot().modelPolicy.configured, false);
  assert.equal(service.snapshot().studios[0].effectiveAllowed[0].model, 'default-model');
  service.updateProviderPreference({ runtime: 'codex', enabled: false });
  service.updateModelPolicy({ mode: 'director' });
  await service.close();
  service = createStudioService({ dbPath });
  assert.equal(service.snapshot().providers.codex.enabled, false);
  assert.deepEqual(service.snapshot().modelPolicy, { configured: true, allowed: [] });
  const original = service.snapshot().studios.find(({ id }) => id === oldStudio.id);
  assert.equal(original.wipLimit, 1);
  assert.equal(original.groomingPolicy.enabled, false);
});
