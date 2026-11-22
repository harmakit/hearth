import assert from 'node:assert/strict';
import test from 'node:test';
import { selectOnboardingHint } from '../renderer/onboarding-hints.mjs';

const create = {kind:'create', id:'empty'};

test('selects the visible current action in order of relevance', () => {
  assert.equal(selectOnboardingHint({enabled:false, surface:'today', targets:[create]}), null);
  assert.equal(selectOnboardingHint({enabled:true, surface:'today', targets:[{...create, visible:false}]}), null);
  const targets = [{kind:'result', id:'file'}, {kind:'plan', id:'draft'}, {kind:'recover', id:'failed', action:'checks'}];
  const hint = selectOnboardingHint({enabled:true, surface:'overview', targets});
  assert.equal(hint.target.kind, 'recover');
  assert.match(hint.description,/вывод проверки/i);
  assert.equal(selectOnboardingHint({enabled:true, surface:'overview', targets}).key, hint.key);
  assert.notEqual(selectOnboardingHint({enabled:true, surface:'overview', targets:targets.slice(0,2)}).key,hint.key);
});

test('records profile preference without exposing studio options', async () => {
  const {createStudioService} = await import('../core/service.mjs');
  const service = createStudioService({ dbPath: ':memory:' });
  try {
    assert.equal(service.snapshot().onboardingHintsEnabled, true);
    assert.throws(() => service.setOnboardingHintsEnabled({enabled:'no'}));
    service.setOnboardingHintsEnabled({enabled:false});
    assert.equal(service.snapshot().onboardingHintsEnabled,false);
  } finally {await service.close();}
});
