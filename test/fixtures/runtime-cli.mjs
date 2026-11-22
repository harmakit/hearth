import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const [runtime, mode, tracePath, ...args] = process.argv.slice(2);
const sessionId = '12345678-1234-1234-1234-123456789abc';
const turnId = 'fixture-turn';
const readingProfile = 'hearth-studio-read-only';
const profile = JSON.parse(args.find(arg => arg.startsWith('default_permissions='))?.split('=').at(-1) ?? 'null');
const writing = ['write', 'wrong-write-profile', 'no-write-sandbox', 'scoped-background'].includes(mode);
const scopedRead = mode === 'scoped-read';
const native = ['native-contract','native-skill-missing'].includes(mode);
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
} else if (runtime === 'codex' && args[0] === 'sandbox') {
  if (tracePath) appendFileSync(tracePath, 'sandbox\n');
  assert.match(profile, /^hearth-studio-write-/);
  assert.ok(args.includes('--include-managed-config'));
  assert.equal(args[args.indexOf('-P') + 1], profile);
  assert.equal(args[args.indexOf('-C') + 1], process.cwd());
  assert.equal(args.at(-1), '/usr/bin/true');
  if (mode === 'no-write-sandbox') process.exitCode = 71;
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
    assert.equal(args[args.indexOf('--tools') + 1], writing ? 'Read,Glob,Grep,Edit,Write' : scopedRead ? 'Read,Glob,Grep' : '');
    assert.equal(args.includes('--no-session-persistence'), writing || scopedRead);
    assert.equal(args[args.indexOf('--permission-mode') + 1], writing ? 'acceptEdits' : 'dontAsk');
    if (writing || scopedRead) assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
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
      if(native){
        assert.equal(args[args.indexOf('--agent')+1],'researcher');
        assert.equal(JSON.parse(args[args.indexOf('--agents')+1]).researcher.prompt,'Check each date.');
        assert.deepEqual(JSON.parse(args[args.indexOf('--json-schema')+1]).required,['summary']);
      }
      if (mode === 'scoped-background') {
        const child = spawn(process.execPath, ['-e',
          'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "late"), 300)', process.env.TEST_SCOPED_OUTPUT,
        ], { stdio: 'ignore' });
        child.unref();
      }
      const usage = mode === 'usage' ? {
        input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 3,
      } : undefined;
      send({ type: 'result', subtype: 'success', is_error: false, result: mode === 'blank' ? ' ' : resumed ? 'Claude resumed' : 'Claude answer', session_id: sessionId, usage,
        structured_output:native?{summary:'contract'}:undefined });
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
  if (writing) assert.match(profile, /^hearth-studio-write-/);
  else assert.equal(profile, readingProfile);
  const permissions = args.find(arg => arg.startsWith(`permissions.${profile}=`));
  assert.ok(permissions.includes('network={enabled=false}'));
  if (writing) {
    assert.match(permissions, /":workspace_roots"=\{"\."="write","\.git"="read"/);
    assert.match(permissions, /scratch"=\{"\."="write"/);
    assert.ok(args.some(arg => arg.startsWith('shell_environment_policy.set={TMPDIR=')));
  }
  assert.ok(permissions.includes(`${JSON.stringify(realpathSync(process.execPath))}="read"`));
  assert.equal(process.argv0, realpathSync(process.execPath));
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let initialized = false;
  for await (const line of input) {
    const { id, method, params } = JSON.parse(line);
    if (tracePath) appendFileSync(tracePath, `${method}\n`);
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
      } else if (method === 'thread/start') {
        if(native)assert.equal(params.developerInstructions,'Check each date.');
        assert.equal(params.ephemeral, true);
        assert.equal(params.cwd, process.cwd());
        assert.deepEqual(params.runtimeWorkspaceRoots, [process.cwd()]);
        assert.equal(params.approvalPolicy, 'never');
        assert.equal(params.permissions, profile);
        const thread = { id: sessionId };
        if (mode === 'unsupported-ephemeral') {
          send({ id, error: { code: -32602, message: 'unknown field ephemeral' } });
          continue;
        }
        if (mode !== 'missing-ephemeral') thread.ephemeral = mode !== 'persistent-thread';
        reply({ thread, cwd: params.cwd, approvalPolicy: 'never', model: params.model,
          activePermissionProfile: { id: ['wrong-sandbox', 'wrong-write-profile'].includes(mode) ? ':danger-full-access' : profile, extends: null }, runtimeWorkspaceRoots: [process.cwd()] });
      } else if (method === 'skills/list') {
        assert.ok(native);
        reply({data:[{cwd:process.cwd(),skills:mode==='native-contract'?[{name:'chronology',
          path:join(process.cwd(),'.agents/skills/chronology/SKILL.md'),enabled:true}]:[]}]});
      } else if (method === 'turn/start') {
        assert.deepEqual(params.input, [{ type: 'text', text: 'Test prompt', text_elements: [] },...(native?[{type:'skill',name:'chronology',
          path:join(process.cwd(),'.agents/skills/chronology/SKILL.md')}]:[])]);
        if(native)assert.deepEqual(params.outputSchema.required,['summary']);
        assert.equal(params.effort, 'high');
        assert.equal(params.permissions, profile);
        reply({ turn: { id: turnId, status: 'inProgress' } });
        if (mode === 'interrupt' || mode === 'timeout') continue;
        event('item/completed', { turnId: 'foreign-turn', item: { type: 'agentMessage', text: 'foreign', phase: 'final_answer' } });
        event('item/completed', { turnId, item: { type: 'agentMessage', text: 'commentary', phase: 'commentary' } });
        if (mode === 'failure') event('turn/completed', { turn: { id: turnId, status: 'failed', error: { message: 'fixture failure' } } });
        else {
          if (mode !== 'blank') event('item/completed', { turnId, item: { type: 'agentMessage', text: native?'{"summary":"contract"}':'Codex answer', phase: 'final_answer' } });
          if (mode === 'usage') {
            const total = { inputTokens: 30, outputTokens: 5, cachedInputTokens: 7, cacheWriteInputTokens: 3 };
            event('thread/tokenUsage/updated', { turnId, tokenUsage: { total: { inputTokens: 10 }, last: { inputTokens: 5 } } });
            event('thread/tokenUsage/updated', { turnId, tokenUsage: { total, last: { inputTokens: 20 } } });
            event('thread/tokenUsage/updated', { turnId: 'foreign-turn', tokenUsage: { total: { inputTokens: 999 } } });
          }
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
