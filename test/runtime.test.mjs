import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRuntimes } from '../runtimes/index.mjs';

const fixture = fileURLToPath(new URL('./fixtures/runtime-cli.mjs', import.meta.url));
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const request = { runtime: 'codex', projectRoot, prompt: 'Test prompt', model: 'fixture-model', effort: 'high' };

function adapter(mode = 'success', options = {}) {
  function binary(runtime) {
    return { command: process.execPath, args: [fixture, runtime, mode] };
  }
  return createRuntimes({ binaries: { codex: binary('codex'), claude: binary('claude') }, timeoutMs: 2000, ...options });
}

test('Codex exchanges JSONL, scopes final content to the active turn and resumes the native thread', async () => {
  const events = [];
  const runtimes = adapter();
  const result = await runtimes.run({ ...request, onEvent: event => events.push(event) });
  assert.equal(result.text, 'Codex answer');
  assert.ok(result.sessionId);
  assert.ok(events.some(event => event.type === 'completed'));
  const resumed = await runtimes.run({ ...request, sessionId: result.sessionId });
  assert.equal(resumed.text, 'Codex resumed');
  assert.equal(resumed.sessionId, result.sessionId);
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
  const { sessionId } = await runtimes.run(request);
  await assert.rejects(runtimes.run({ ...request, sessionId, runtime: 'claude' }), /сесси/i);
  await assert.rejects(runtimes.run({ ...request, sessionId, projectRoot: process.cwd() + '/test' }), /сесси/i);
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
