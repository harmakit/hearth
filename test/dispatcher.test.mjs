import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createPowerController } from '../app/power.mjs';
import { buildTaskContext, createCheckpointStore } from '../core/checkpoints.mjs';
import { createDispatcher } from '../core/dispatcher.mjs';
import { nextScheduleWindow, normalizeSchedule } from '../core/schedule.mjs';

function persistence(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(['dispatch_jobs', 'attempts', 'checkpoints'].map((name) => `CREATE TABLE IF NOT EXISTS ${name} (id TEXT PRIMARY KEY, data TEXT)`).join(';'));
  return {
    list: (table) => db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all().map(({ data }) => JSON.parse(data)),
    insert: (table, value) => {
      db.prepare(`INSERT INTO ${table} VALUES (?, ?)`).run(value.id, JSON.stringify(value));
      return value;
    },
    update: (table, value) => {
      db.prepare(`UPDATE ${table} SET data = ? WHERE id = ?`).run(JSON.stringify(value), value.id);
      return value;
    },
    transaction: (callback) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = callback();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    close: () => db.close(),
  };
}

function setup(t, options) {
  const store = persistence();
  t.after(store.close);
  let time = Date.parse('2026-11-18T11:00:00Z');
  const dispatcher = createDispatcher({ ...store, now: () => new Date(time), ...options });
  return { dispatcher, advance: (elapsed) => { time += elapsed; }, store };
}

function task(dispatcher, taskId, extras) {
  return dispatcher.enqueue({ studioId: 'studio', taskId, purpose: 'task', ...extras });
}

test('two claims can run and the third starts when one job starts waiting for the owner', (t) => {
  const { dispatcher } = setup(t);
  const first = task(dispatcher, 'task-1');
  const second = task(dispatcher, 'task-2');
  const third = task(dispatcher, 'task-3');
  const claim = () => dispatcher.claimAttempt({ studioId: 'studio', limit: 2 });
  const { job, attempt } = claim();
  assert.equal(job.id, first.id);
  assert.equal(claim().job.id, second.id);
  assert.equal(claim(), undefined);
  dispatcher.finishAttempt({ attemptId: attempt.id, status: 'waiting', reason: 'owner-question' });
  assert.equal(claim().job.id, third.id);
  assert.equal(dispatcher.findJob(first.id).status, 'waiting');
  assert.equal(dispatcher.activeAttempts('studio').length, 2);
});

test('a claimed task and worktree exclude conflicting claims across studios', (t) => {
  const { dispatcher } = setup(t);
  const first = task(dispatcher, 'task-1', { worktree: '/work/tree-1' });
  const review = task(dispatcher, 'task-1', { purpose: 'review', worktree: '/work/tree-2' });
  const second = task(dispatcher, 'task-2', { studioId: 'other', worktree: '/work/tree-1' });
  const independent = task(dispatcher, 'task-3', { worktree: '/work/tree-3' });
  const { attempt } = dispatcher.claimAttempt({ studioId: 'studio', jobId: first.id });
  assert.equal(dispatcher.claimAttempt({ studioId: 'studio', jobId: review.id, limit: 2 }), undefined);
  assert.equal(dispatcher.claimAttempt({ studioId: 'other', jobId: second.id }), undefined);
  assert.equal(dispatcher.claimAttempt({ studioId: 'studio', limit: 2 }).job.id, independent.id);
  dispatcher.finishAttempt({ attemptId: attempt.id, status: 'completed' });
  assert.equal(dispatcher.claimAttempt({ studioId: 'studio', jobId: review.id }), undefined);
  assert.equal(dispatcher.claimAttempt({ studioId: 'other' }).job.id, second.id);
});

test('expired live leases keep custody until the process exits and the owner resolves the attempt', (t) => {
  const { dispatcher, advance } = setup(t, { leaseMs: 2_000 });
  const prior = task(dispatcher, 'task-1', { worktree: '/work/shared', writes: true });
  const next = task(dispatcher, 'task-2', { worktree: '/work/shared' });
  const independent = task(dispatcher, 'task-3', { worktree: '/work/independent' });
  const { attempt } = dispatcher.claimAttempt({ studioId: 'studio', attemptId: 'prior' });
  advance(2_001);
  const [held] = dispatcher.reconcileStudio({ studioId: 'studio', isActive: ({ id }) => id === attempt.id });
  assert.equal(held.attempt.reason, 'lease-expired');
  assert.equal(held.job.id, prior.id);
  assert.equal(dispatcher.renewAttempt({ attemptId: attempt.id }), undefined);
  assert.equal(dispatcher.finishAttempt({ attemptId: attempt.id, status: 'completed' }), undefined);
  assert.throws(() => dispatcher.resolveReconciliation({ attemptId: attempt.id, decision: 'retry', reason: 'checked' }), /выполняется/);
  assert.equal(dispatcher.claimAttempt({ studioId: 'studio', limit: 2 }).job.id, independent.id);
  dispatcher.releaseProcess({ attemptId: attempt.id });
  assert.equal(dispatcher.claimAttempt({ studioId: 'studio', jobId: next.id, limit: 2 }), undefined);
  dispatcher.resolveReconciliation({ attemptId: attempt.id, decision: 'discard', reason: 'owner checked the files' });
  assert.equal(dispatcher.claimAttempt({ studioId: 'studio', limit: 2 }).job.id, next.id);
});

test('a persisted writing attempt without a receipt enters reconciliation after restart', (t) => {
  const base = join(process.cwd(), '.tmp');
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, 'dispatch-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'dispatch.sqlite');
  const first = persistence(dbPath);
  const before = createDispatcher(first);
  const queued = task(before, 'task-1', { purpose: 'artifact', worktree: '/work/shared', writes: true, operationId: 'write-1' });
  const { attempt } = before.claimAttempt({ studioId: 'studio' });
  first.close();

  const second = persistence(dbPath);
  t.after(second.close);
  const after = createDispatcher(second);
  const [held] = after.reconcileStudio({ studioId: 'studio', restart: true });
  assert.equal(held.job.status, 'reconcile');
  assert.equal(held.job.operationId, 'write-1');
  assert.equal(after.claimAttempt({ studioId: 'studio' }), undefined);
  after.resolveReconciliation({ attemptId: attempt.id, decision: 'retry', reason: 'process stopped and workspace reviewed' });
  const reclaimed = after.claimAttempt({ studioId: 'studio' });
  assert.equal(reclaimed.job.id, queued.id);
  assert.equal(reclaimed.job.operationId, 'write-1');
  assert.notEqual(reclaimed.attempt.id, attempt.id);
});

test('temporary failures wait with backoff before the third failure requires attention', (t) => {
  const { dispatcher, advance } = setup(t);
  const job = task(dispatcher, 'task-1');
  const claim = () => dispatcher.claimAttempt({ studioId: 'studio' });
  const failure = Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' });
  assert.equal(dispatcher.failAttempt({ attemptId: claim().attempt.id, error: failure }).job.status, 'queued');
  assert.equal(dispatcher.delayUntil('studio'), '2026-11-18T11:00:01.000Z');
  assert.equal(claim(), undefined);
  advance(1_000);
  assert.equal(dispatcher.failAttempt({ attemptId: claim().attempt.id, error: failure }).attempt.status, 'retry');
  advance(2_000);
  assert.equal(dispatcher.failAttempt({ attemptId: claim().attempt.id, error: failure }).job.status, 'failed');
  assert.equal(dispatcher.findJob(job.id).failureCount, 3);
  assert.equal(claim(), undefined);
});

test('a known rate-limit restart time is honored while uncertain writes require reconciliation', (t) => {
  const { dispatcher } = setup(t);
  task(dispatcher, 'task-1');
  task(dispatcher, 'task-2', { writes: true });
  const claim = () => dispatcher.claimAttempt({ studioId: 'studio' });
  const rateLimit = Object.assign(new Error('rate limit'), { status: 429, retryAt: '2026-11-18T11:15:00Z' });
  const waiting = dispatcher.failAttempt({ attemptId: claim().attempt.id, error: rateLimit });
  assert.equal(waiting.job.availableAt, '2026-11-18T11:15:00.000Z');
  assert.equal(waiting.attempt.reason, 'rate-limit');
  const uncertain = Object.assign(new Error('connection reset after write'), { code: 'ECONNRESET' });
  assert.equal(dispatcher.failAttempt({ attemptId: claim().attempt.id, error: uncertain }).job.status, 'reconcile');
  assert.equal(claim(), undefined);
});

test('activity extends the lease while a quiet attempt stays running until expiry', (t) => {
  const { dispatcher, advance } = setup(t, { leaseMs: 5_000 });
  task(dispatcher, 'task-1');
  const { attempt } = dispatcher.claimAttempt({ studioId: 'studio' });
  advance(1_000);
  assert.equal(dispatcher.renewAttempt({ attemptId: attempt.id }).expiresAt, '2026-11-18T11:00:06.000Z');
  advance(4_500);
  assert.equal(dispatcher.reconcileStudio({ studioId: 'studio' }).length, 0);
});

test('bounded context keeps attachment references and short excerpts in a durable checkpoint', (t) => {
  const { store } = setup(t);
  const input = {
    studioId: 'studio', taskId: 'task-1', attemptId: 'attempt-1',
    task: { summary: 'Draft', artifact: 'a'.repeat(30_000), artifactPath: 'docs/result.md', artifactVersions: ['docs/result.md'], review: 'Review' },
    decisions: [{ body: 'Question', answer: 'Decision' }],
    materials: [{ sourceRef: 'material-1', path: 'docs/reference.md', text: 'unabridged'.repeat(50_000), excerpt: 'Prepared excerpt' }],
    operations: [{ operationId: 'write-1', path: 'docs/result.md', status: 'completed' }],
    activeAttempts: [{ id: 'attempt-2', taskId: 'task-2', purpose: 'review' }],
  };
  const context = buildTaskContext(input);
  assert.deepEqual(context.decisions, [{ question: 'Question', answer: 'Decision' }]);
  assert.deepEqual(context.artifactVersions, ['docs/result.md']);
  assert.deepEqual(context.materials, [{ sourceRef: 'material-1', path: 'docs/reference.md', excerpt: 'Prepared excerpt' }]);
  assert.equal(context.priorDraft.artifactPath, 'docs/result.md');
  assert.ok(!JSON.stringify(context).includes('unabridged'));
  assert.ok(JSON.stringify(context).length < 16_000);
  createCheckpointStore(store).save(input);
  const saved = createCheckpointStore(store).get('studio', 'task-1');
  assert.deepEqual(saved.context, context);
  assert.equal(saved.attemptId, 'attempt-1');
  assert.equal(saved.context.operations[0].operationId, 'write-1');
  assert.equal(saved.context.activeAttempts[0].id, 'attempt-2');
});

test('next work window follows the local calendar including overnight windows', () => {
  const overnight = normalizeSchedule({ enabled: true, days: [1], start: '22:00', end: '06:00' });
  const morning = new Date(2026, 10, 17, 5, 30);
  assert.equal(nextScheduleWindow(overnight, morning).getTime(), morning.getTime());
  assert.equal(nextScheduleWindow(overnight, new Date(2026, 10, 17, 6)).getTime(), new Date(2026, 10, 23, 22).getTime());
  assert.equal(nextScheduleWindow(normalizeSchedule(), morning), null);
});

test('next work window follows changes in local timezone and repeated hours', (t) => {
  const previous = process.env.TZ;
  t.after(() => { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; });
  const overnight = normalizeSchedule({ enabled: true, days: [6], start: '22:00', end: '01:30' });
  const firstOccurrence = new Date('2026-11-01T05:45:00.000Z');
  process.env.TZ = 'America/New_York';
  assert.equal(nextScheduleWindow(overnight, firstOccurrence).toISOString(), '2026-11-01T06:00:00.000Z');
  process.env.TZ = 'UTC';
  assert.equal(nextScheduleWindow(overnight, firstOccurrence).toISOString(), '2026-11-07T22:00:00.000Z');
});

test('power policy holds one blocker across studios and releases it on a mode change and close', () => {
  const calls = [];
  const power = createPowerController({ start: (kind) => { calls.push(kind); return 7; }, stop: (id) => calls.push(id) });
  const date = new Date(2026, 10, 18, 12);
  const studio = { powerMode: 'active', activeAttempts: 2 };
  const overnight = { powerMode: 'window', schedule: normalizeSchedule({ enabled: true, days: [3], start: '12:00', end: '06:00' }) };
  power.refresh([studio, overnight], date);
  power.refresh([overnight], date);
  assert.deepEqual(calls, ['prevent-app-suspension']);
  power.refresh([{ ...overnight, powerMode: 'normal' }], date);
  power.refresh([studio], date);
  power.close();
  power.close();
  assert.deepEqual(calls, ['prevent-app-suspension', 7, 'prevent-app-suspension', 7]);
});
