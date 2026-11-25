import { capture, jsonLines, launch, providerError, stop } from './process.mjs';
import { publicWebUrl, recordWebLinks, recordWebPage } from './web.mjs';

export async function inspectClaude(binary, options) {
  const { output } = await capture(binary, ['auth', 'status', '--json'], options);
  const { loggedIn } = JSON.parse(output);
  return typeof loggedIn === 'boolean' ? { authenticated: loggedIn } : {};
}

export function runClaude(binary, { model, effort, prompt, nativeId, emit, signal, scope, isolateCommand, nativeRole, outputSchema, webEnabled, ...options }) {
  const scoped = Boolean(scope.scratch);
  const fileTools = scoped ? ['Read','Glob','Grep'] : [];
  if (scope.access === 'worktree-write') fileTools.push('Edit','Write');
  const webTools = webEnabled === false ? [] : ['WebSearch','WebFetch'];
  const tools = [...fileTools, ...webTools].join(',');
  const args = [
    '--print', '--input-format', 'text', '--output-format', 'stream-json', '--verbose',
    '--safe-mode', '--restricted', '--tools', tools, '--disable-slash-commands',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--permission-mode', scope.access === 'worktree-write' ? 'acceptEdits' : 'dontAsk',
    '--settings', JSON.stringify({ disableAllHooks: true, permissions: { allow: webTools, deny: ['Agent(web-fetch)'] } }),
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
    const web = claudeWebObservation();

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(startupTimer);
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
      web.observe(message);
      if (message.type === 'system' && message.subtype === 'init') {
        if (!started) {
          started = true;
          clearTimeout(startupTimer);
          emit('started');
        }
      }
      if (message.type === 'result') result = message;
    }, finish);
    const timer = options.timeoutMs == null ? undefined : setTimeout(() => finish(new Error('Истекло время ожидания ответа Claude Code.')), options.timeoutMs);
    const startupTimer = options.startupTimeoutMs == null ? undefined : setTimeout(() => {
      finish(new Error('Claude Code не подтвердил запуск. Проверьте подключение и повторите попытку.'));
    }, options.startupTimeoutMs);
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
        finish(null, { text:outputSchema ? JSON.stringify(result.structured_output) : result.result,
          nativeId: scoped ? undefined : result.session_id, web: web.result() });
      }
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else child.stdin.end(prompt);
  });
}

function claudeWebObservation() {
  const capabilities = { search: 'unknown', read: 'unknown' };
  const pages = new Map();
  const links = new Set();
  const calls = new Map();
  let search;

  function observe(message) {
    if (message.type === 'system' && message.subtype === 'init' && Array.isArray(message.tools)) {
      capabilities.search = message.tools.includes('WebSearch') ? 'available' : 'unavailable';
      capabilities.read = message.tools.includes('WebFetch') ? 'available' : 'unavailable';
    }
    if (message.type === 'result' && Array.isArray(message.permission_denials)) {
      for (const denial of message.permission_denials) {
        if (denial.tool_name === 'WebSearch' && search !== 'used') search = 'unavailable';
        if (denial.tool_name === 'WebFetch') recordWebPage(pages, denial.tool_input?.url, 'failed', 'permission');
      }
    }
    const blocks = message.message?.content;
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (message.type === 'assistant' && ['tool_use','server_tool_use'].includes(block.type) && typeof block.id === 'string') {
        if (block.name === 'WebSearch' || block.name === 'web_search') {
          calls.set(block.id, { tool: 'search' });
          search ??= 'attempted';
        } else if (block.name === 'WebFetch') {
          const url = publicWebUrl(block.input?.url);
          if (url) {
            calls.set(block.id, { tool: 'read', url });
            recordWebPage(pages, url, 'attempted');
          }
        }
      }
      if (block.type !== 'web_search_tool_result' && (message.type !== 'user' || block.type !== 'tool_result')) continue;
      const call = calls.get(block.tool_use_id);
      if (!call) continue;
      const error = block.is_error || block.content?.type === 'web_search_tool_result_error';
      if (call.tool === 'search') {
        if (!error) {
          search = 'used';
          recordWebLinks(links,block.content);
        }
        else if (search !== 'used') search = 'failed';
      } else {
        const text = typeof block.content === 'string' ? block.content : Array.isArray(block.content)
          ? block.content.filter(value => value.type === 'text').map(value => value.text).join('\n') : '';
        if (error) {
          const code = text.match(/(?:status(?: code)?\s+|HTTP\s+)([45]\d\d)\b/iu)?.[1];
          recordWebPage(pages, call.url, 'failed', code && `HTTP ${code}`);
        } else if (text.trim() && !/^redirect(?:ed)?\b/iu.test(text.trim())) {
          recordWebPage(pages, call.url, 'read');
        }
      }
      calls.delete(block.tool_use_id);
    }
  }

  return { observe, result() {
    if (search === 'used' || search === 'attempted') capabilities.search = 'available';
    if (search === 'unavailable') capabilities.search = 'unavailable';
    if ([...pages.values()].some(page => page.status === 'read')) capabilities.read = 'available';
    if (!search && !pages.size && capabilities.search === 'unknown' && capabilities.read === 'unknown') return;
    search ??= { available: 'not-used', unavailable: 'unavailable', unknown: 'unknown' }[capabilities.search];
    return { capabilities, search, pages: [...pages.values()], links: [...links] };
  } };
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
