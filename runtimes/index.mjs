import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { capture } from './process.mjs';
import { inspectCodex, runCodex } from './codex.mjs';
import { inspectClaude, runClaude } from './claude.mjs';

const providers = {
  codex: {
    label: 'Codex', minimum: '0.169.0', inspect: inspectCodex, run: runCodex,
    efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  },
  claude: {
    label: 'Claude Code', minimum: '2.1.326', inspect: inspectClaude, run: runClaude,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
};
const nativeIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const environmentKeys = [
  'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PATH', 'TMPDIR', 'XDG_CONFIG_HOME',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'CODEX_HOME', 'OPENAI_API_KEY', 'CODEX_API_KEY',
  'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
];

function providerFor(runtime) {
  if (!Object.hasOwn(providers, runtime)) throw new Error('Неизвестное подключение.');
  return providers[runtime];
}

function electronEnvironment(source, runtime) {
  const env = Object.fromEntries(environmentKeys.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
  if (runtime === 'codex') {
    delete env.ANTHROPIC_API_KEY;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  } else {
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
  }
  const home = source.HOME ?? homedir();
  const paths = (source.PATH ?? '').split(':').filter(isAbsolute);
  env.PATH = [...new Set([...paths, join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])].join(':');
  return env;
}

function atLeast(version, required) {
  const parts = version.split('.').map(Number);
  const minimum = required.split('.').map(Number);
  const different = parts.findIndex((value, index) => value !== minimum[index]);
  return different === -1 || parts[different] > minimum[different];
}

function decodeSession(sessionId, runtime, cwd) {
  if (sessionId == null) return undefined;
  try {
    const [provider, root, id] = JSON.parse(Buffer.from(sessionId, 'base64url').toString('utf8'));
    if (provider === runtime && root === cwd && typeof id === 'string' && nativeIdPattern.test(id)) return id;
  } catch {
    // A malformed handle should never be passed to the provider.
  }
  throw new Error('Сессия относится к другому подключению или рабочей папке.');
}

export function createRuntimes({ binaries = {}, env: sourceEnv = process.env, timeoutMs = 240_000, inspectTimeoutMs = 8000 } = {}) {
  const cwd = homedir();

  async function locate(runtime, env) {
    if (binaries[runtime]) return binaries[runtime];
    for (const folder of env.PATH.split(':')) {
      const command = join(folder, runtime);
      try {
        await access(command, constants.X_OK);
        if ((await stat(command)).isFile()) return { command };
      } catch {
        // Continue searching the executable path.
      }
    }
    throw new Error(`${providers[runtime].label} не найден в PATH.`);
  }

  async function checkVersion(binary, provider, options) {
    const { code, output } = await capture(binary, ['--version'], options);
    const version = output.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
    if (code !== 0 || !version) throw new Error(`Не удалось определить версию ${provider.label}.`);
    if (!atLeast(version, provider.minimum)) {
      throw new Error(`${provider.label} ${version} требуется обновить до ${provider.minimum} или новее.`);
    }
    return version;
  }

  async function inspect({ runtime }) {
    const provider = providerFor(runtime);
    const options = { cwd, env: electronEnvironment(sourceEnv, runtime), timeoutMs: inspectTimeoutMs };
    let result = { runtime, available: false };
    try {
      const binary = await locate(runtime, options.env);
      const version = await checkVersion(binary, provider, options);
      result = { runtime, available: true, version };
      return { ...result, ...await provider.inspect(binary, options) };
    } catch (error) {
      const detail = error.code === 'ENOENT' ? `${provider.label} не найден.` : error.message;
      return { ...result, detail };
    }
  }

  async function run({ runtime, projectRoot, prompt, model, effort, signal, onEvent, sessionId }) {
    const provider = providerFor(runtime);
    const emit = (type, fields = {}) => onEvent?.({ runtime, type, ...fields });
    try {
      signal?.throwIfAborted();
      if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot)) throw new Error('Нужен абсолютный путь к рабочей папке.');
      const root = await realpath(projectRoot);
      if (!(await stat(root)).isDirectory()) throw new Error('Рабочий путь должен вести к папке.');
      if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Запрос для подключения пуст.');
      if (model != null && (typeof model !== 'string' || !/^[a-z\d][a-z\d._:/-]*$/i.test(model))) {
        throw new Error(`Некорректная модель ${provider.label}.`);
      }
      if (effort != null && !provider.efforts.includes(effort)) {
        throw new Error(`Усилие «${effort}» не поддерживается подключением ${provider.label}.`);
      }
      const nativeId = decodeSession(sessionId, runtime, root);
      const env = electronEnvironment(sourceEnv, runtime);
      const binary = await locate(runtime, env);
      await checkVersion(binary, provider, { cwd, env, timeoutMs: inspectTimeoutMs, signal });
      signal?.throwIfAborted();
      const result = await provider.run(binary, { cwd: root, env, timeoutMs, prompt, model, effort, nativeId, signal, emit });
      const text = typeof result.text === 'string' ? result.text.trim() : '';
      if (!text) throw new Error(`${provider.label} вернул пустой ответ.`);
      emit('completed');
      if (!nativeIdPattern.test(result.nativeId ?? '')) return { text };
      const handle = Buffer.from(JSON.stringify([runtime, root, result.nativeId])).toString('base64url');
      return { text, sessionId: handle };
    } catch (error) {
      const failure = error.code === 'ENOENT' ? new Error(`${provider.label}: исполняемый файл или рабочая папка не найдены.`) : error;
      emit(failure.name === 'AbortError' ? 'interrupted' : 'failed', { message: failure.message });
      throw failure;
    }
  }

  return { run, inspect };
}

export const { run, inspect } = createRuntimes();
