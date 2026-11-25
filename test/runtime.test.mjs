import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { link, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRuntimes } from '../runtimes/index.mjs';
import { stageCodexImages } from '../runtimes/codex-images.mjs';
import { runtimePath, runtimeCandidates } from '../runtimes/executable.mjs';
import { scopedCommand } from '../runtimes/scope.mjs';

const fixture = fileURLToPath(new URL('./fixtures/runtime-cli.mjs', import.meta.url));
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const request = { runtime: 'codex', projectRoot, prompt: 'Test prompt', model: 'fixture-model', effort: 'high' };
const testScratch = join(projectRoot, '.tmp');

test('native Windows CLI candidates preserve drive letters and never invoke command scripts', () => {
  const directories = runtimePath({ Path: '"C:\\Program Files\\Agents";relative;D:\\CLI' }, 'win32');
  assert.deepEqual(directories, ['C:\\Program Files\\Agents', 'D:\\CLI']);
  assert.deepEqual(runtimeCandidates('claude', directories, 'win32'), [
    'C:\\Program Files\\Agents\\claude.exe', 'D:\\CLI\\claude.exe',
  ]);
});

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

test('Codex passes the native role, exact local skills and output schema through App Server', async t => {
  const scope = await workScope(t);
  const definitionPath = '.codex/agents/researcher.toml';
  const path = '.agents/skills/chronology/SKILL.md';
  for (const file of [definitionPath, path]) await mkdir(dirname(join(scope.root, file)), {recursive:true});
  await writeFile(join(scope.root, definitionPath), 'name = "researcher"');
  await writeFile(join(scope.root, path), '---\nname: chronology\ndescription: Check dates.\n---\n');
  const nativeRole = { name:'researcher', definitionPath, description:'Check references', instructions:'Check each date.',
    requiredSkills:[{name:'chronology',path}] };
  const outputSchema = {type:'object',properties:{summary:{type:'string'}},required:['summary'],additionalProperties:false};
  const result = await adapter('native-contract').run({...request,projectRoot:scope.root,nativeRole,outputSchema});
  assert.equal(result.text,'{"summary":"contract"}');
  await assert.rejects(adapter('native-skill-missing').run({...request,projectRoot:scope.root,nativeRole,outputSchema}),/chronology/);
});

test('Claude selects the role using native options and reads structured output instead of prose', async t => {
  const scope = await workScope(t);
  const definitionPath = '.claude/agents/researcher.md';
  await mkdir(dirname(join(scope.root,definitionPath)),{recursive:true});
  await writeFile(join(scope.root,definitionPath),'---\nname: researcher\n---\nCheck each date.');
  const outputSchema = {type:'object',properties:{summary:{type:'string'}},required:['summary'],additionalProperties:false};
  const result = await adapter('native-contract').run({...request,runtime:'claude',projectRoot:scope.root,outputSchema,
    nativeRole:{name:'researcher',definitionPath,description:'Check references', instructions:'Check each date.',requiredSkills:[]}});
  assert.equal(result.text,'{"summary":"contract"}');
});

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

test('legacy Claude has no file tools and explicit review access uses read tools', async t => {
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

test('Codex enables native web and records search and page attempts only from the active turn', async () => {
  const runtimes = adapter('web');
  assert.deepEqual((await runtimes.inspect({runtime:'codex'})).webCapabilities, {search:'available',read:'available'});
  const {web} = await runtimes.run(request);
  assert.equal(web.search, 'used');
  assert.deepEqual(web.pages, [{url:'https://archive.example/record',status:'attempted'}]);
  const blocked = adapter('web-blocked');
  assert.deepEqual((await blocked.inspect({runtime:'codex'})).webCapabilities, {search:'unavailable',read:'unavailable'});
  const answer = await blocked.run(request);
  assert.equal(answer.text, 'Codex answer');
  assert.equal(answer.web.search, 'unavailable');
  const older = adapter('web-older');
  assert.notEqual((await older.inspect({runtime:'codex'})).webCapabilities?.search,'available');
  assert.notEqual((await older.run(request)).web?.search,'not-used');
});

test('Claude enables native search with each file scope and pairs fetch results with their URLs', async t => {
  const working = await workScope(t);
  const isolateCommand = (command, args, {env}) => ({command,args,env});
  for (const [mode, scope] of [['web',undefined],['web-read',{...working,access:'read'}],['web-write',working]]) {
    const {web} = await adapter(mode,{isolateCommand}).run({...request,runtime:'claude',scope});
    assert.deepEqual(web.capabilities, {search:'available',read:'available'});
    assert.equal(web.search, 'used');
    assert.deepEqual(web.links, ['https://archive.example/index']);
    assert.deepEqual(web.pages, [
      {url:'https://archive.example/record',status:'read'},
      {url:'https://archive.example/missing',status:'failed',reason:'HTTP 404'},
      {url:'https://archive.example/redirect',status:'attempted'},
    ]);
  }
  const {web} = await adapter('web-blocked').run({...request,runtime:'claude'});
  assert.deepEqual(web.capabilities, {search:'unavailable',read:'available'});
  assert.equal(web.search, 'unavailable');
  const unfinished = await adapter('web-unfinished').run({...request,runtime:'claude'});
  assert.equal(unfinished.web.search, 'attempted');
});

test('local continuation can omit web tools without changing the file scope', async () => {
  for (const runtime of ['codex','claude']) {
    const result = await adapter('local-only').run({...request,runtime,webEnabled:false});
    assert.match(result.text,/answer$/);
  }
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

test('Claude receives the prompt on stdin and resumes explicitly without file tools', async () => {
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
    models: [{ id: 'fixture-model', name: 'Fixture model', efforts: ['high'] }],
    weeklyQuota:{status:'known',remainingPercent:73,resetAt:new Date(2000100000*1000).toISOString()},
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

test('a Codex weekly account notification reaches the scheduler without waiting for turn completion',async()=>{
  const events=[];
  await adapter('quota-notification').run({...request,onEvent:event=>events.push(event)});
  const quota=events.find(event=>event.type==='weekly-quota');
  assert.equal(quota.weeklyQuota.remainingPercent,5);
  assert.ok(events.indexOf(quota)<events.findIndex(event=>event.type==='completed'));
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

test('normal provider work may outlast the former four-minute deadline', async t => {
  const schedule = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => schedule(callback, ms === 240_000 ? 120 : ms, ...args));
  for (const runtime of ['codex', 'claude']) {
    const result = await adapter('slow-answer', { timeoutMs: undefined }).run({ ...request, runtime });
    assert.match(result.text, /answer$/u);
  }
});

test('approved artwork in a Git task imports only images generated by its own Codex turn', {skip:process.platform!=='darwin'}, async t => {
  const scope=await workScope(t);
  const result=await adapter('image-write').run({ ...request, scope,
    imageOutputDirectory:'generated-images/qa-artwork' });
  assert.deepEqual(result.generatedImages,['generated-images/qa-artwork/image-01.png']);
  const bytes=await readFile(join(scope.root,result.generatedImages[0]));
  assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
});

test('a portrait revision replaces only the requested slot without publishing earlier drafts twice', async t => {
  const scope = await workScope(t);
  const outputDirectory = 'generated-images/qa-artwork';
  const folder = join(scope.root, outputDirectory);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'image-01.png'), 'first portrait');
  await writeFile(join(folder, 'image-03.png'), 'earlier portrait');
  await writeFile(join(folder, 'image-03-cafebabe12345678.png'), 'previous draft');
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLmgAAAAASUVORK5CYII=', 'base64');
  const input = { root: scope.root, outputDirectory, options: { env: {} }, items: [{ result: bytes.toString('base64') }] };
  await assert.rejects(stageCodexImages({ ...input, slots: [7, 7] }), /номер/u);
  assert.deepEqual(await stageCodexImages({ ...input, slots: [3] }), [`${outputDirectory}/image-03.png`]);
  assert.deepEqual((await readdir(folder)).sort(), ['image-01.png', 'image-03.png']);
  assert.equal(await readFile(join(folder, 'image-01.png'), 'utf8'), 'first portrait');
  assert.deepEqual(await readFile(join(folder, 'image-03.png')), bytes);
});

test('parallel image calls are assigned their declared slots in invocation order', {skip:process.platform!=='darwin'}, async t => {
  const scope = await workScope(t);
  const result = await adapter('image-order').run({ ...request, scope, imageOutputDirectory: 'generated-images/qa-artwork' });
  assert.deepEqual(result.generatedImages, ['generated-images/qa-artwork/image-03.png', 'generated-images/qa-artwork/image-02.png']);
  assert.notEqual((await readFile(join(scope.root, result.generatedImages[0]))).subarray(-6).toString(), 'second');
  assert.equal((await readFile(join(scope.root, result.generatedImages[1]))).subarray(-6).toString(), 'second');
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
