import { capture, jsonLines, launch, providerError, stop } from './process.mjs';

export async function inspectClaude(binary, options) {
  const { output } = await capture(binary, ['auth', 'status', '--json'], options);
  const { loggedIn } = JSON.parse(output);
  return typeof loggedIn === 'boolean' ? { authenticated: loggedIn } : {};
}

export function runClaude(binary, { model, effort, prompt, nativeId, emit, signal, scope, isolateCommand, nativeRole, outputSchema, ...options }) {
  const scoped = Boolean(scope.scratch);
  const tools = !scoped ? '' : scope.access === 'worktree-write' ? 'Read,Glob,Grep,Edit,Write' : 'Read,Glob,Grep';
  const args = [
    '--print', '--input-format', 'text', '--output-format', 'stream-json', '--verbose',
    '--safe-mode', '--restricted', '--tools', tools, '--disable-slash-commands',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--permission-mode', scope.access === 'worktree-write' ? 'acceptEdits' : 'dontAsk',
    '--settings', '{"disableAllHooks":true}',
  ];
  if (scoped) args.push('--no-session-persistence', '--permission-prompts', 'none', '--no-chrome');
  if (model) args.push(`--model=${model}`);
  if (effort) args.push(`--effort=${effort}`);
  if (nativeId) args.push(`--resume=${nativeId}`);
  if (nativeRole) args.push('--agent',nativeRole.name,'--agents',JSON.stringify({[nativeRole.name]:{
    description:nativeRole.description,prompt:nativeRole.instructions,skills:nativeRole.requiredSkills.map(skill=>skill.name),
  }}));
  if (outputSchema) args.push('--json-schema',JSON.stringify(outputSchema));

  return new Promise((resolve, reject) => {
    const invocation = scoped ? isolateCommand(binary.command, [...(binary.args ?? []), ...args], {
      ...scope, network: true, env: { ...options.env, DISABLE_AUTOUPDATER: '1' },
    }) : { command: binary.command, args: [...(binary.args ?? []), ...args], env: options.env };
    const child = launch({ command: invocation.command }, invocation.args, { ...options, env: invocation.env });
    let result;
    let started = false;
    let settled = false;

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reader.close();
      stop(child, { graceful: !error, cleanupGroup: scoped }).then(() => {
        if (error) reject(error);
        else resolve(value);
      }, reject);
    }

    function abort() {
      finish(new DOMException('Запуск Claude Code отменён.', 'AbortError'));
    }

    const reader = jsonLines(child, message => {
      if (message.type === 'system' && message.subtype === 'init') {
        if (!started) {
          started = true;
          emit('started');
        }
      }
      if (message.type === 'result') result = message;
    }, finish);
    const timer = setTimeout(() => finish(new Error('Истекло время ожидания ответа Claude Code.')), options.timeoutMs);
    child.on('error', finish);
    child.stdin.on('error', () => {});
    child.on('close', code => {
      const measured = claudeUsage(result?.usage);
      try {
        if (measured) emit('usage', { usage: measured });
      } catch (error) {
        finish(error);
        return;
      }
      if (!result) {
        finish(new Error(`Claude Code завершился без результата (код ${code ?? 'сигнал'}). Проверьте установку и вход в Claude Code.`));
      } else if (code !== 0 || result.is_error || result.subtype !== 'success') {
        finish(providerError(result.errors?.[0] || result.result, 'Claude Code завершил задачу с ошибкой.'));
      } else if (nativeId && nativeId !== result.session_id) {
        finish(new Error('Claude Code вернул другую сессию.'));
      } else if (outputSchema && (result.structured_output === null || typeof result.structured_output !== 'object' || Array.isArray(result.structured_output))) {
        finish(new Error('Claude Code не вернул ответ по схеме.'));
      } else {
        finish(null, { text:outputSchema ? JSON.stringify(result.structured_output) : result.result, nativeId: scoped ? undefined : result.session_id });
      }
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else child.stdin.end(prompt);
  });
}

function claudeUsage(usage) {
  const validCount = value => Number.isSafeInteger(value) && value >= 0;
  const input = usage?.input_tokens;
  const output = usage?.output_tokens;
  const reads = usage?.cache_read_input_tokens;
  const writes = usage?.cache_creation_input_tokens;
  const tokens = {};
  if (validCount(input)) {
    const total = input + (validCount(reads) ? reads : 0) + (validCount(writes) ? writes : 0);
    if (validCount(total)) tokens.inputTokens = total;
  }
  if (validCount(output)) tokens.outputTokens = output;
  if (validCount(reads)) tokens.cacheReadTokens = reads;
  if (validCount(writes)) tokens.cacheWriteTokens = writes;
  return Object.keys(tokens).length ? tokens : undefined;
}
