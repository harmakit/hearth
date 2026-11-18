import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRuntimes } from '../runtimes/index.mjs';
import { scopedCommand } from '../runtimes/scope.mjs';

const fixture = fileURLToPath(new URL('./fixtures/runtime-cli.mjs', import.meta.url));
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const request = { runtime: 'codex', projectRoot, prompt: 'Test prompt', model: 'fixture-model', effort: 'high' };
const testScratch = join(projectRoot, '.tmp');

function adapter(mode = 'success', options = {}, tracePath = '') {
  function binary(runtime) {
    return { command: process.execPath, args: [fixture, runtime, mode, tracePath] };
  }
  return createRuntimes({ binaries: { codex: binary('codex'), claude: binary('claude') }, timeoutMs: 2000, ...options });
}

async function workScope(t) {
  await mkdir(testScratch, { recursive: true });
  const fixtureRoot = await mkdtemp(join(testScratch, 'runtime-scope-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const root = join(fixtureRoot, 'worktree');
  const scratch = join(fixtureRoot, 'scratch');
  await Promise.all([mkdir(root), mkdir(scratch)]);
  return { root: await realpath(root), scratch: await realpath(scratch), access: 'worktree-write' };
}

test('Codex opens a verified write scope on the managed root and denies a substituted native profile', async t => {
  const scope = await workScope(t);
  const scopedRequest = { ...request, scope };
  assert.deepEqual(await adapter('write').run(scopedRequest), { text: 'Codex answer' });
  const trace = join(scope.scratch, 'trace');
  await assert.rejects(adapter('wrong-write-profile', {}, trace).run(scopedRequest), /изол|профил/i);
  assert.equal(await readFile(trace, 'utf8'), 'sandbox\ninitialize\ninitialized\nthread/start\n');
});

test('Codex rejects write before the provider thread starts if its native sandbox probe fails', async t => {
  const scope = await workScope(t);
  const trace = join(scope.scratch, 'trace');
  await assert.rejects(adapter('no-write-sandbox', {}, trace).run({ ...request, scope }), /изоляц|sandbox/i);
  assert.equal(await readFile(trace, 'utf8'), 'sandbox\n');
});

test('Claude write exposes only file tools and is launched through the scoped command adapter', async t => {
  const scope = await workScope(t);
  const calls = [];
  const runtimes = adapter('write', {
    isolateCommand(command, args, options) {
      calls.push(options);
      return { command, args, env: options.env };
    }
  });
  const result = await runtimes.run({ ...request, runtime: 'claude', scope });
  assert.deepEqual(result, { text: 'Claude answer' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].root, scope.root);
  assert.equal(calls[0].scratch, scope.scratch);
  assert.equal(calls[0].access, scope.access);
  assert.equal(calls[0].network, true);
});

test('scoped Claude stops process-group children before releasing the write scope', async t => {
  if (process.platform === 'win32') return;
  const scope = await workScope(t);
  const orphanOutput = join(scope.scratch, 'late-write');
  const runtimes = adapter('scoped-background', {
    isolateCommand(command, args, { env }) {
      return { command, args, env: { ...env, TEST_SCOPED_OUTPUT: orphanOutput } };
    },
  });
  assert.deepEqual(await runtimes.run({ ...request, runtime: 'claude', scope }), { text: 'Claude answer' });
  await delay(500);
  await assert.rejects(readFile(orphanOutput, 'utf8'), { code: 'ENOENT' });
});

test('explicit scope validation fails closed for unsupported access and unsafe scratch', async t => {
  const scope = await workScope(t);
  await assert.rejects(adapter().run({ ...request, scope: { ...scope, access: 'full' } }), /режим доступа/i);
  await assert.rejects(adapter().run({ ...request, scope: { ...scope, scratch: scope.root } }), /времен|пересек/i);
  await assert.rejects(adapter().run({ ...request, scope: { ...scope, scratch: undefined } }), /временн/i);
  await assert.rejects(adapter().run({ ...request, projectRoot: scope.root, scope }), /исходн.*папк/i);
});

test('legacy Claude stays text-only and explicit review access uses read tools', async t => {
  const scope = { ...await workScope(t), access: 'read' };
  const runtimes = adapter('scoped-read', {
    isolateCommand(command, args, { access, env }) {
      assert.equal(access, 'read');
      return { command, args, env };
    }
  });
  assert.deepEqual(await runtimes.run({ ...request, runtime: 'claude', scope }), { text: 'Claude answer' });
});

test('native sandbox limits child writes to the chosen directories', async t => {
  const seatbelt = '/usr/bin/sandbox-exec';
  const installed = process.platform === 'darwin' && spawnSync(seatbelt, [
    '-p', '(version 1)(deny default)(allow process-exec)(allow file-read*)', '/usr/bin/true',
  ]).status === 0;
  const scope = await workScope(t);
  if (!installed) {
    assert.throws(() => scopedCommand('/usr/bin/true', [], scope), { code: 'ISOLATION_UNAVAILABLE' });
    t.diagnostic('Host Seatbelt is unavailable or already in use. The scoped command failed closed.');
    return;
  }
  const outside = join(dirname(scope.root), 'outside');
  await writeFile(outside, 'unchanged');
  await writeFile(join(scope.root, '.git'), 'pointer');
  await symlink(outside, join(scope.root, 'outside-link'));
  const child = `
    /bin/sh -c 'printf allowed > "$1"' child "$1/inside" &&
    /bin/sh -c 'printf scratch > "$1"' child "$2/inside" &&
    ! /bin/sh -c 'printf denied > "$1"' child "$1/../outside" &&
    ! /bin/sh -c 'printf denied > "$1"' child "$1/outside-link" &&
    ! /bin/sh -c 'printf denied > "$1"' child "$1/.GiT" &&
    ! /bin/ln "$1/../outside" "$1/outside-hardlink"`;
  const run = scopedCommand('/bin/sh', ['-c', child, 'fixture', scope.root, scope.scratch], scope);
  const result = spawnSync(run.command, run.args, { env: run.env, cwd: scope.root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(scope.root, 'inside'), 'utf8'), 'allowed');
  assert.equal(await readFile(join(scope.scratch, 'inside'), 'utf8'), 'scratch');
  assert.equal(await readFile(join(scope.root, '.git'), 'utf8'), 'pointer');
  assert.equal(await readFile(outside, 'utf8'), 'unchanged');
  const read = scopedCommand('/usr/bin/touch', [join(scope.root, 'read-only')], { ...scope, access: 'read', network: true });
  assert.notEqual(spawnSync(read.command, read.args, { env: read.env, cwd: scope.root }).status, 0);
});

test('execution rejects pre-existing hard links in writable roots', async t => {
  const scope = await workScope(t);
  const outside = join(dirname(scope.root), 'outside');
  await writeFile(outside, 'unchanged');
  await link(outside, join(scope.root, 'linked'));
  if (process.platform !== 'darwin') return;
  assert.throws(() => scopedCommand('/usr/bin/true', [], scope), /жёсткие ссылки/);
  await assert.rejects(adapter('write').run({ ...request, scope }), /жёсткие ссылки/);
});

test('runtime usage is emitted once per attempt with normalized provider counts', async () => {
  for (const runtime of ['codex', 'claude']) {
    const events = [];
    await adapter('usage').run({ ...request, runtime, onEvent: event => events.push(event) });
    assert.deepEqual(events.filter(event => event.type === 'usage'), [{
      runtime, type: 'usage', usage: { inputTokens: 30, outputTokens: 5, cacheReadTokens: 7, cacheWriteTokens: 3 },
    }]);
  }
});

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
