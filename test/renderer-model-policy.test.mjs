import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogEfforts, fixedModelChoices, readPolicyRows } from '../renderer/model-policy.mjs';

test('a matching catalog model uses its supported efforts instead of the provider presets', () => {
  const provider = { efforts: ['low', 'medium', 'max'], models: [{ id: 'sample', efforts: ['low'] }] };
  assert.deepEqual(catalogEfforts('codex', 'sample', provider), ['low']);
  assert.deepEqual(catalogEfforts('codex', 'other', provider), ['low', 'medium', 'max']);
  assert.deepEqual(catalogEfforts('codex', 'no-effort', { ...provider, models: [{ id: 'no-effort', efforts: [] }] }), []);
});

test('fixed assignments combine permitted efforts and distinguish the same model across providers', () => {
  assert.deepEqual(fixedModelChoices([
    { runtime: 'codex', model: 'sample', efforts: ['low', 'high'] },
    { runtime: 'codex', model: 'sample', efforts: ['low'] },
    { runtime: 'claude', model: 'sample', efforts: [] },
  ]), [
    { runtime: 'codex', model: 'sample', efforts: ['low', 'high'] },
    { runtime: 'claude', model: 'sample', efforts: [''] },
  ]);
});

test('a blank entry cannot silently turn a policy into an empty list', () => {
  assert.deepEqual(readPolicyRows([]), []);
  assert.throws(() => readPolicyRows([{ runtime: 'codex', model: '  ', efforts: [] }]), /модель/i);
  assert.deepEqual(readPolicyRows([{ runtime: 'codex', model: ' sample ', efforts: ['low'] }]), [
    { runtime: 'codex', model: 'sample', efforts: ['low'] },
  ]);
});
