import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [runtime, mode, ...args] = process.argv.slice(2);
const sessionId = '12345678-1234-1234-1234-123456789abc';
const turnId = 'fixture-turn';
const profile = 'hearth-studio-read-only';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');

if (args[0] === '--version') {
  if (mode === 'slow-version') setInterval(() => {}, 500);
  else console.log(mode === 'old-version' ? 'codex-cli 0.100.0' : runtime === 'codex' ? 'codex-cli 0.169.0' : '2.1.326 (Claude Code)');
} else if (runtime === 'codex' && args[0] === 'mcp') {
  assert.equal(args[1], 'list');
  if (mode === 'configured-mcp') {
    console.log('Name  Command  Args  Env  Cwd  Status   Auth');
    console.log('disabled-mcp  /usr/bin/false  -  -  -  disabled  Unsupported');
    console.log('some-mcp  /usr/bin/false  -  -  -  enabled  Unsupported');
    console.log('Name  Url  Bearer Token Env Var  Status  Auth');
    console.log('http-mcp  https://example.invalid/mcp  -  enabled  Unknown');
  } else if (mode === 'unknown-mcp-list') console.log('unknown response');
  else console.log('No MCP servers configured yet. Try …');
} else if (runtime === 'claude') {
  if (args[0] === 'auth') {
    send({ loggedIn: false, email: 'should-not-escape@example.org' });
  } else {
    assert.equal(args[0], '--print');
    assert.ok(args.includes('--model=fixture-model'));
    assert.ok(args.includes('--effort=high'));
    assert.ok(args.includes('--safe-mode'));
    assert.ok(args.includes('--restricted'));
    assert.ok(args.includes('--strict-mcp-config'));
    assert.equal(args[args.indexOf('--tools') + 1], '');
    process.stdin.setEncoding('utf8');
    let prompt = '';
    for await (const chunk of process.stdin) prompt += chunk;
    assert.equal(prompt, 'Test prompt');
    if (mode === 'slow-termination') process.on('SIGTERM', () => setTimeout(() => process.exit(0), 220));
    send({ type: 'system', subtype: 'init', session_id: sessionId });
    if (mode === 'timeout' || mode === 'slow-termination') setInterval(() => {}, 500);
    else if (mode === 'malformed') process.stdout.write('invalid JSONL\n');
    else if (mode === 'truncated') process.exitCode = 1;
    else if (mode === 'failure') {
      send({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['fixture failure'] });
      process.exitCode = 1;
    } else {
      const resumed = args.includes(`--resume=${sessionId}`);
      send({ type: 'result', subtype: 'success', is_error: false, result: mode === 'blank' ? ' ' : resumed ? 'Claude resumed' : 'Claude answer', session_id: sessionId });
    }
  }
} else {
  assert.equal(args[0], 'app-server');
  if (mode === 'configured-mcp') {
    assert.ok(args.includes('mcp_servers.some-mcp.enabled=false'));
    assert.ok(args.includes('mcp_servers.some-mcp.command="/usr/bin/false"'));
    assert.ok(args.includes('mcp_servers.http-mcp.enabled=false'));
    assert.ok(args.includes('mcp_servers.http-mcp.url="http://127.0.0.1:0/"'));
    assert.ok(!args.includes('mcp_servers.disabled-mcp.enabled=false'));
  }
  assert.ok(args.includes(`default_permissions="${profile}"`));
  const permissions = args.find(arg => arg.startsWith(`permissions.${profile}=`));
  assert.ok(permissions.includes('network={enabled=false}'));
  assert.ok(permissions.includes(`${JSON.stringify(realpathSync(process.execPath))}="read"`));
  assert.equal(process.argv0, realpathSync(process.execPath));
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let initialized = false;
  let resumed = false;
  for await (const line of input) {
    const { id, method, params } = JSON.parse(line);
    const reply = result => send({ id, result });
    const event = (method, params) => send({ method, params: { threadId: sessionId, ...params } });
    if (method === 'initialize') {
      assert.equal(params.capabilities.experimentalApi, true);
      reply({ userAgent: 'fixture' });
    } else if (method === 'initialized') {
      initialized = true;
    } else {
      assert.ok(initialized);
      if (method === 'account/read') {
        assert.equal(params.refreshToken, false);
        reply({ account: { type: 'chatgpt', email: 'should-not-escape@example.org' }, requiresOpenaiAuth: true });
      } else if (method === 'model/list') {
        reply({ data: [{ model: 'fixture-model', displayName: 'Fixture model', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] });
      } else if (method === 'thread/read') {
        assert.equal(params.threadId, sessionId);
        reply({ thread: { id: sessionId, cwd: process.cwd() } });
      } else if (method === 'thread/start' || method === 'thread/resume') {
        resumed = method === 'thread/resume';
        if (resumed) assert.equal(params.threadId, sessionId);
        assert.equal(params.cwd, process.cwd());
        assert.deepEqual(params.runtimeWorkspaceRoots, [process.cwd()]);
        assert.equal(params.approvalPolicy, 'never');
        assert.equal(params.permissions, profile);
        reply({ thread: { id: sessionId }, cwd: params.cwd, approvalPolicy: 'never', model: params.model,
          activePermissionProfile: { id: mode === 'wrong-sandbox' ? ':danger-full-access' : profile, extends: null }, runtimeWorkspaceRoots: [process.cwd()] });
      } else if (method === 'turn/start') {
        assert.deepEqual(params.input, [{ type: 'text', text: 'Test prompt', text_elements: [] }]);
        assert.equal(params.effort, 'high');
        reply({ turn: { id: turnId, status: 'inProgress' } });
        if (mode === 'interrupt' || mode === 'timeout') continue;
        event('item/completed', { turnId: 'foreign-turn', item: { type: 'agentMessage', text: 'foreign', phase: 'final_answer' } });
        event('item/completed', { turnId, item: { type: 'agentMessage', text: 'commentary', phase: 'commentary' } });
        if (mode === 'failure') event('turn/completed', { turn: { id: turnId, status: 'failed', error: { message: 'fixture failure' } } });
        else {
          if (mode !== 'blank') event('item/completed', { turnId, item: { type: 'agentMessage', text: resumed ? 'Codex resumed' : 'Codex answer', phase: 'final_answer' } });
          event('turn/completed', { turn: { id: turnId, status: 'completed' } });
        }
      } else if (method === 'turn/interrupt') {
        assert.deepEqual(params, { threadId: sessionId, turnId });
        reply({});
        event('turn/completed', { turn: { id: turnId, status: 'interrupted' } });
      } else {
        assert.fail(`Unexpected request ${method}`);
      }
    }
  }
}
