import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUsage, diagnoseStudioState } from '../core/usage.mjs';

test('usage deduplicates provider events within an attempt and preserves unavailable counters', () => {
  const rows = [];
  const usage = createUsage({
    list: () => rows,
    insert: (_table, value) => { rows.push(value); return value; },
    now: () => '2026-11-18T00:00:00.000Z',
  });
  const context = { studioId: 'a', role: 'programmer' };
  const event = { attemptId: 'attempt-a', eventId: 'tokens', runtime: 'codex', model: 'test-model', input: 30, output: 4, cacheRead: 10 };
  assert.deepEqual(usage.recordUsage(event, context), usage.recordUsage({ ...event, input: 900 }, context));
  usage.recordUsage({ ...event, attemptId: 'attempt-b', cacheRead: undefined, input: undefined }, context);
  usage.recordUsage({ ...event, attemptId: 'attempt-c' }, { ...context, studioId: 'b' });
  const result = usage.studioUsage('a');
  assert.equal(result.events.length, 2);
  assert.equal(result.events[1].input, null);
  assert.equal(result.totals.input, 30);
  assert.equal(result.totals.output, 8);
  assert.equal(result.totals.cacheWrite, null);
  assert.equal(result.byRole[0].role, 'programmer');
  assert.equal(result.byModel[0].model, 'test-model');
  assert.equal(result.byAttempt.length, 2);
  assert.equal(usage.studioUsage('unknown').totals.input, null);
});

test('diagnostics only exports service fields and excludes run output, paths and raw errors', () => {
  const secret = '$SECRET=/local/project';
  const state = diagnoseStudioState({
    studio: { id: 'studio-a', title: secret, root: secret, lifecycle: 'active', manualPaused: false },
    connection: { runtime: 'codex', status: 'available', command: secret },
    process: { status: 'running', pid: 31, stdout: secret },
    schedule: { waiting: true, nextAt: '2026-11-19T09:00:00.000Z' },
    queue: { pending: 7, active: 1, taskNames: [secret] },
    error: { kind: 'authorization', message: secret, stack: secret },
  });
  assert.equal(state.studioId, 'studio-a');
  assert.equal(state.connection.runtime, 'codex');
  assert.equal(state.process.status, 'running');
  assert.equal(state.queue.pending, 7);
  assert.equal(state.lastError.kind, 'authorization');
  assert.doesNotMatch(JSON.stringify(state), /SECRET|local\/project/);
});

test('configured estimates price cache separately and keep subscription data separate', () => {
  const rows = [];
  const usage = createUsage({
    list: () => rows,
    insert: (_table, value) => { rows.push(value); return value; },
  });
  usage.recordUsage({
    attemptId: 'attempt-priced', eventId: 'tokens', runtime: 'claude', model: 'test-model',
    input: 3_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000,
  }, { studioId: 'a', role: 'director' });
  const tariffs = [{
    runtime: 'claude', model: 'test-model', currency: 'USD',
    input: 8, output: 20, cacheRead: 1, cacheWrite: 10,
  }];
  const subscription = { usedPercent: 12, resetsAt: '2026-11-19T00:00:00.000Z' };
  const result = usage.studioUsage('a', { tariffs, subscription });
  assert.deepEqual(result.estimatedCost, { amount: 39, currency: 'USD', estimated: true });
  assert.deepEqual(result.subscription, subscription);
  assert.equal(usage.studioUsage('a').estimatedCost, null);
  assert.equal(usage.studioUsage('a').subscription, null);
});
test('imported incomplete usage keeps unknown counters distinct from a measured zero',()=>{
  const service=createUsage({list:()=>[{studioId:'s',runtime:'codex',model:'m',input:0}],insert:()=>{}});
  const r=service.studioUsage('s',{tariffs:[{runtime:'codex',model:'m',input:1,output:1,currency:'USD'}]});
  assert.equal(r.totals.input,0);assert.equal(r.totals.output,null);assert.equal(r.totals.cacheRead,null);assert.equal(r.estimatedCost,null);
});
