import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRuntimes } from '../runtimes/index.mjs';

const fixture = fileURLToPath(new URL('./fixtures/runtime-cli.mjs', import.meta.url));
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const request = { runtime: 'codex', projectRoot, prompt: 'Test prompt', model: 'fixture-model', effort: 'high' };

function adapter(mode = 'success', options = {}, tracePath = '') {
  function binary(runtime) {
    return { command: process.execPath, args: [fixture, runtime, mode, tracePath] };
  }
  return createRuntimes({ binaries: { codex: binary('codex'), claude: binary('claude') }, timeoutMs: 2000, ...options });
}

test('Codex uses an ephemeral thread and returns only the active turn answer', async () => {
  const events = [];
  const runtimes = adapter();
  const result = await runtimes.run({ ...request, onEvent: event => events.push(event) });
  assert.deepEqual(result, { text: 'Codex answer' });
  assert.ok(events.some(event => event.type === 'completed'));
});

test('Codex sends no prompt and does not retry if ephemeral mode is unconfirmed', async t => {
  const scratch = join(projectRoot, '.tmp');
  await mkdir(scratch, { recursive: true });
  const folder = await mkdtemp(join(scratch, 'runtime-privacy-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  for (const mode of ['missing-ephemeral', 'persistent-thread', 'unsupported-ephemeral']) {
    const trace = join(folder, mode);
    const events = [];
    await assert.rejects(adapter(mode, {}, trace).run({ ...request, onEvent: event => events.push(event.type) }), /временн/i);
    assert.equal(await readFile(trace, 'utf8'), 'initialize\ninitialized\nthread/start\n');
    assert.deepEqual(events, ['failed']);
  }
});

test('Codex rejects a previously persisted native session handle', async () => {
  const tuple = ['codex', await realpath(projectRoot), '12345678-1234-1234-1234-123456789abc'];
  const sessionId = Buffer.from(JSON.stringify(tuple)).toString('base64url');
  await assert.rejects(adapter().run({ ...request, sessionId }), /сохранённ.*сесси/i);
});

test('Claude receives the prompt on stdin and resumes explicitly with tools disabled', async () => {
  const runtimes = adapter();
  const result = await runtimes.run({ ...request, runtime: 'claude' });
  assert.equal(result.text, 'Claude answer');
  assert.ok(result.sessionId);
  const resumed = await runtimes.run({ ...request, runtime: 'claude', sessionId: result.sessionId });
  assert.equal(resumed.text, 'Claude resumed');
  assert.equal(resumed.sessionId, result.sessionId);
});

test('native session handles reject cross-project and cross-provider use', async () => {
  const runtimes = adapter();
  const claude = { ...request, runtime: 'claude' };
  const { sessionId } = await runtimes.run(claude);
  await assert.rejects(runtimes.run({ ...request, sessionId }), /сесси/i);
  await assert.rejects(runtimes.run({ ...claude, sessionId, projectRoot: join(projectRoot, 'test') }), /сесси/i);
});

test('Codex disables configured MCP servers before creating a thread', async () => {
  const result = await adapter('configured-mcp').run(request);
  assert.equal(result.text, 'Codex answer');
  await assert.rejects(adapter('unknown-mcp-list').run(request), /MCP/);
});

test('inspect reports local availability, authentication and the native Codex catalog', async () => {
  const runtimes = adapter();
  assert.deepEqual(await runtimes.inspect({ runtime: 'codex' }), {
    runtime: 'codex', available: true, version: '0.169.0', authenticated: true,
    models: [{ id: 'fixture-model', name: 'Fixture model', efforts: ['high'] }]
  });
  assert.deepEqual(await runtimes.inspect({ runtime: 'claude' }), {
    runtime: 'claude', available: true, version: '2.1.326', authenticated: false
  });
  const unavailable = createRuntimes({ binaries: { codex: { command: '/nonexistent-codex' } } });
  assert.equal((await unavailable.inspect({ runtime: 'codex' })).available, false);
  const old = await adapter('old-version').inspect({ runtime: 'codex' });
  assert.equal(old.available, false);
  assert.match(old.detail, /0\.169\.0/);
});

test('invalid controls, empty final answers, and terminal errors surface as failures', async () => {
  await assert.rejects(adapter().run({ ...request, runtime: 'claude', effort: 'ultra' }), /усили/i);
  await assert.rejects(adapter('wrong-sandbox').run(request), /изол|профил/i);
  for (const runtime of ['codex', 'claude']) {
    await assert.rejects(adapter('blank').run({ ...request, runtime }), /пуст/i);
    await assert.rejects(adapter('failure').run({ ...request, runtime }), /fixture failure/);
    await assert.rejects(adapter('timeout', { timeoutMs: 500 }).run({ ...request, runtime }), /время/i);
  }
});

test('Codex sends turn/interrupt on cancellation and reports AbortError', async () => {
  const controller = new AbortController();
  const events = [];
  await assert.rejects(adapter('interrupt').run({
    ...request, signal: controller.signal, onEvent(event) {
      events.push(event.type);
      if (event.type === 'started') controller.abort();
    }
  }), { name: 'AbortError' });
  assert.deepEqual(events, ['started', 'interrupted']);
});

test('Claude stops on cancellation and rejects truncated or malformed result streams', async () => {
  const controller = new AbortController();
  const events = [];
  await assert.rejects(adapter('timeout').run({
    ...request, runtime: 'claude', signal: controller.signal, onEvent(event) {
      events.push(event.type);
      if (event.type === 'started') controller.abort();
    }
  }), { name: 'AbortError' });
  assert.deepEqual(events, ['started', 'interrupted']);
  await assert.rejects(adapter('truncated').run({ ...request, runtime: 'claude' }), /без результата/);
  await assert.rejects(adapter('malformed').run({ ...request, runtime: 'claude' }), /JSON/);
});

test('cancellation interrupts executable probing before a provider starts', async () => {
  const controller = new AbortController();
  const events = [];
  const startedAt = Date.now();
  const run = adapter('slow-version', { inspectTimeoutMs: 3000 }).run({
    ...request, signal: controller.signal, onEvent: event => events.push(event.type)
  });
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(run, { name: 'AbortError' });
  assert.ok(Date.now() - startedAt < 2000);
  assert.deepEqual(events, ['interrupted']);
});

test('Claude cancellation waits for the provider process to exit', async () => {
  const controller = new AbortController();
  let cancelledAt;
  await assert.rejects(adapter('slow-termination').run({
    ...request, runtime: 'claude', signal: controller.signal, onEvent(event) {
      if (event.type !== 'started') return;
      cancelledAt = Date.now();
      controller.abort();
    }
  }), { name: 'AbortError' });
  assert.ok(Date.now() - cancelledAt >= 150);
});
