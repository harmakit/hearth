import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const processes = new WeakMap();
const processGroups = process.platform !== 'win32';

export function launch(binary, args, { cwd, env }) {
  const child = spawn(binary.command, [...(binary.args ?? []), ...args], {
    cwd, env, detached: processGroups, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const state = { closed: false };
  state.closing = new Promise(resolve => child.once('close', () => {
    state.closed = true;
    resolve();
  }));
  processes.set(child, state);
  return child;
}

export async function stop(child, { graceful = false, cleanupGroup = false } = {}) {
  const state = processes.get(child);

  function send(signal) {
    if (!child.pid) return;
    try {
      if (processGroups) process.kill(-child.pid, signal);
      else if (!state.closed) child.kill(signal);
    } catch (error) {
      if (error.code !== 'ESRCH' && !state.closed) {
        try { child.kill(signal); } catch { /* Wait for the close event or report uncertainty. */ }
      }
    }
  }

  if (state.closed) {
    if (!graceful || cleanupGroup) send('SIGKILL');
    return;
  }
  let terminate;
  if (graceful) {
    child.stdin.end();
    terminate = setTimeout(() => send('SIGTERM'), 300);
  } else {
    send('SIGTERM');
  }
  const force = setTimeout(() => send('SIGKILL'), 1000);
  let deadline;
  try {
    await Promise.race([state.closing, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(Object.assign(new Error('Не удалось завершить процесс подключения.'), {
        processMayBeRunning: true, processExited: state.closing,
      })), 2000);
    })]);
    if (!graceful || cleanupGroup) send('SIGKILL');
  } finally {
    clearTimeout(terminate);
    clearTimeout(force);
    clearTimeout(deadline);
  }
}

export function jsonLines(child, receive, fail) {
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  reader.on('line', line => {
    if (!line.trim()) return;
    try {
      receive(JSON.parse(line));
    } catch (error) {
      fail(error instanceof SyntaxError ? new Error('Подключение вернуло некорректный JSON.') : error);
    }
  });
  child.stderr.resume();
  return reader;
}

export function capture(binary, args, options) {
  return new Promise((resolve, reject) => {
    const { signal } = options;
    if (signal?.aborted) {
      reject(new DOMException('Запуск отменён.', 'AbortError'));
      return;
    }
    const child = launch(binary, args, options);
    let output = '';
    let settled = false;
    const abort = () => finish(new DOMException('Запуск отменён.', 'AbortError'));
    const timeout = setTimeout(() => finish(new Error('Истекло время проверки подключения.')), options.timeoutMs);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      if (!error) resolve(result);
      else stop(child).then(() => reject(error), reject);
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (settled) return;
      output += chunk;
      if (output.length > 64_000) {
        finish(new Error('Подключение вернуло слишком большой ответ.'));
      }
    });
    child.stderr.resume();
    child.on('error', finish);
    child.stdin.on('error', () => {});
    signal?.addEventListener('abort', abort, { once: true });
    child.on('close', code => finish(null, { code, output }));
    child.stdin.end();
  });
}

export function providerError(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return new Error(fallback);
  const redacted = value
    .replace(/\b(?:sk-(?:[\w-]+)|eyJ[\w-]+\.[\w.-]+)\b/g, '[скрыто]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [скрыто]');
  return new Error(redacted.trim().slice(0, 500));
}
