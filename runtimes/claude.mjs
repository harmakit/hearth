import { capture, jsonLines, launch, providerError, stop } from './process.mjs';

export async function inspectClaude(binary, options) {
  const { output } = await capture(binary, ['auth', 'status', '--json'], options);
  const { loggedIn } = JSON.parse(output);
  return typeof loggedIn === 'boolean' ? { authenticated: loggedIn } : {};
}

export function runClaude(binary, { model, effort, prompt, nativeId, emit, signal, ...options }) {
  const args = [
    '--print', '--input-format', 'text', '--output-format', 'stream-json', '--verbose',
    '--safe-mode', '--restricted', '--tools', '', '--disable-slash-commands',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'dontAsk',
    '--settings', '{"disableAllHooks":true}',
  ];
  if (model) args.push(`--model=${model}`);
  if (effort) args.push(`--effort=${effort}`);
  if (nativeId) args.push(`--resume=${nativeId}`);

  return new Promise((resolve, reject) => {
    const child = launch(binary, args, options);
    let result;
    let started = false;
    let settled = false;

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reader.close();
      stop(child, { graceful: !error }).then(() => {
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
      if (!result) {
        finish(new Error(`Claude Code завершился без результата (код ${code ?? 'сигнал'}). Проверьте установку и вход в Claude Code.`));
      } else if (code !== 0 || result.is_error || result.subtype !== 'success') {
        finish(providerError(result.errors?.[0] || result.result, 'Claude Code завершил задачу с ошибкой.'));
      } else if (nativeId && nativeId !== result.session_id) {
        finish(new Error('Claude Code вернул другую сессию.'));
      } else {
        finish(null, { text: result.result, nativeId: result.session_id });
      }
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else child.stdin.end(prompt);
  });
}
