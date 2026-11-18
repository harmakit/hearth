import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { capture, jsonLines, launch, providerError, stop } from './process.mjs';
import { isolationError, verifyWriteRoots } from './scope.mjs';

const readProfile = 'hearth-studio-read-only';
const appServerArgs = [
  'app-server', '--listen', 'stdio://',
  '--disable', 'hooks', '--disable', 'plugins', '--disable', 'apps', '--disable', 'computer_use',
  '--disable', 'multi_agent', '--disable', 'multi_agent_v2', '--disable', 'skill_mcp_dependency_install',
  '-c', 'notify=[]', '-c', 'web_search="disabled"',
  '-c', 'shell_environment_policy.inherit="none"',
];

const pathUsesGlob = /[\u0000-\u001f*?\[\]{}]/u;

async function linkedGitDirectory(root) {
  const marker = join(root, '.git');
  try {
    const details = await lstat(marker);
    if (!details.isFile() || details.size > 4096) return undefined;
    const path = (await readFile(marker, 'utf8')).trim().match(/^gitdir: (.+)$/)?.[1];
    if (!path) return undefined;
    const gitdir = await realpath(isAbsolute(path) ? path : resolve(root, path));
    const worktrees = dirname(gitdir);
    const common = dirname(worktrees);
    if (basename(worktrees) === 'worktrees' && basename(common) === '.git' && !pathUsesGlob.test(common)) return common;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function codexConfiguration(binary, scope) {
  // The macOS sandbox helper re-execs the app-server binary. Executing a
  // Homebrew symlink there can fail even if both paths are readable.
  const command = await realpath(binary.command);
  const executableRules = [...new Set([binary.command, command])].map(path => `${JSON.stringify(path)}="read"`);
  const writing = scope?.access === 'worktree-write';
  const profile = writing ? `hearth-studio-write-${randomUUID()}` : readProfile;
  const workspace = writing
    ? '":workspace_roots"={"."="write",".git"="read","*/**/.[gG][iI][tT]"="deny","*/**/.[gG][iI][tT]/**"="deny"}'
    : '":workspace_roots"={"."="read"}';
  const filesystem = ['":root"="deny"', '":minimal"="read"', workspace, ...executableRules];
  if (scope?.scratch) {
    const gitdir = await linkedGitDirectory(scope.root);
    if (gitdir) filesystem.push(`${JSON.stringify(gitdir)}="read"`);
  }
  const config = ['-c', `default_permissions="${profile}"`];
  if (writing) {
    if (process.platform !== 'darwin' || pathUsesGlob.test(scope.scratch)) {
      throw isolationError('Codex не может изолировать запись в эту рабочую копию. Проверьте систему и путь временной области.');
    }
    verifyWriteRoots(scope);
    filesystem.push(`${JSON.stringify(scope.scratch)}={"."="write","**/.[gG][iI][tT]"="deny","**/.[gG][iI][tT]/**"="deny"}`);
    config.push('-c', `shell_environment_policy.set={TMPDIR=${JSON.stringify(scope.scratch)}}`);
    config.push('--disable', 'code_mode', '--disable', 'image_generation', '--disable', 'remote_plugin', '--disable', 'shell_snapshot');
  }
  config.push('-c', `permissions.${profile}={filesystem={${filesystem.join(',')}},network={enabled=false}}`);
  return { executable: { ...binary, command }, config, profile };
}

async function withServer({ executable, config }, options, operate, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = launch(executable, [...appServerArgs, ...config, ...extraArgs], options);
    const pending = new Map();
    let nextId = 0;
    let notify = () => {};
    let interrupt = () => {};
    let interruptionTimer;
    let settled = false;

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(interruptionTimer);
      options.signal?.removeEventListener('abort', abort);
      for (const waiter of pending.values()) waiter.reject(error ?? new Error('Подключение Codex закрыто.'));
      pending.clear();
      reader.close();
      stop(child, { graceful: !error, cleanupGroup: options.cleanupGroup }).then(() => {
        if (error) reject(error);
        else resolve(result);
      }, reject);
    }

    function send(message) {
      if (!settled) child.stdin.write(JSON.stringify(message) + '\n');
    }

    function rpc(method, params) {
      if (settled) return Promise.reject(new Error('Подключение Codex закрыто.'));
      const id = ++nextId;
      return new Promise((resolveReply, rejectReply) => {
        pending.set(id, { resolve: resolveReply, reject: rejectReply });
        send({ id, method, params });
      });
    }

    const reader = jsonLines(child, message => {
      if (message.method && message.id != null) {
        send({ id: message.id, error: { code: -32601, message: 'Hearth Studio cannot authorize this request.' } });
      } else if (message.method) {
        notify(message);
      } else if (pending.has(message.id)) {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) waiter.reject(providerError(message.error.message, 'Запрос Codex завершился ошибкой.'));
        else waiter.resolve(message.result);
      }
    }, finish);

    function abort() {
      const error = new DOMException('Запуск Codex отменён.', 'AbortError');
      interruptionTimer = setTimeout(() => finish(error), 500);
      interrupt(error);
    }

    const timer = setTimeout(() => {
      interrupt(new Error('Истекло время ожидания ответа Codex.'));
      finish(new Error('Истекло время ожидания ответа Codex.'));
    }, options.timeoutMs);
    child.on('error', finish);
    child.stdin.on('error', () => finish(new Error('Поток команд Codex закрыт.')));
    child.on('close', code => finish(new Error(`Codex App Server завершился до ответа (код ${code ?? 'сигнал'}).`)));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();

    const server = {
      rpc,
      onNotify(listener) { notify = listener; },
      onInterrupt(listener) { interrupt = listener; },
    };
    (async () => {
      await rpc('initialize', {
        clientInfo: { name: 'hearth_studio', title: 'Hearth Studio', version: '0.1.0' },
        capabilities: { experimentalApi: true, requestAttestation: false, explicitGatewayOauth: true },
      });
      send({ method: 'initialized' });
      return operate(server);
    })().then(result => finish(null, result), finish);
  });
}

async function disableMcpServers(binary, options) {
  // The text command masks configured environment values. In 0.169, an empty
  // MCP table override merges with inherited settings, making it a no-op.
  const { code, output } = await capture(binary, ['mcp', 'list'], options);
  if (code === 0 && /^No MCP servers configured yet\./.test(output.trim())) return [];
  const servers = new Map();
  let transport;
  let hasRow = false;
  for (const row of output.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
    const header = row.match(/^Name\s{2,}(Command|Url)\b/);
    if (header) {
      transport = header[1];
    } else {
      const [name, ...columns] = row.split(/\s{2,}/);
      const status = columns.at(-2);
      if (!transport || !/^[a-z\d_-]+$/i.test(name) || !['enabled', 'disabled'].includes(status)) {
        throw new Error('Не удалось определить подключённые MCP-серверы Codex.');
      }
      hasRow = true;
      if (status === 'enabled') servers.set(name, transport);
    }
  }
  if (!hasRow || code !== 0) throw new Error('Не удалось проверить MCP-серверы Codex.');
  return [...servers].flatMap(([name, kind]) => {
    // An entry reported by the CLI inventory can be absent from the app
    // server's config layers. A disabled entry still needs a valid transport.
    const transport = kind === 'Command' ? 'command="/usr/bin/false"' : 'url="http://127.0.0.1:0/"';
    const key = `mcp_servers.${name}`;
    return ['-c', `${key}.enabled=false`, '-c', `${key}.${transport}`];
  });
}

export async function inspectCodex(binary, options) {
  return withServer(await codexConfiguration(binary), options, async ({ rpc }) => {
    const [account, catalog] = await Promise.allSettled([
      rpc('account/read', { refreshToken: false }),
      rpc('model/list', { includeHidden: false }),
    ]);
    const result = {};
    if (account.status === 'fulfilled' && account.value.account !== undefined) {
      if (account.value.account !== null) result.authenticated = true;
      else if (account.value.requiresOpenaiAuth) result.authenticated = false;
    }
    if (catalog.status === 'fulfilled' && Array.isArray(catalog.value.data)) {
      result.models = catalog.value.data.filter(model => !model.hidden && model.model).map(model => ({
        id: model.model,
        name: model.displayName || model.model,
        efforts: model.supportedReasoningEfforts?.map(option => option.reasoningEffort) ?? [],
      }));
    }
    if (account.status === 'rejected' || catalog.status === 'rejected') {
      result.detail = 'Codex вернул неполные данные об аккаунте или моделях.';
    }
    return result;
  });
}

export async function runCodex(binary, { cwd, model, effort, prompt, emit, scope: execution, ...options }) {
  const settings = await codexConfiguration(binary, execution);
  const { profile } = settings;
  const probeOptions = { cwd, ...options, timeoutMs: Math.min(options.timeoutMs, 8000) };
  if (execution.access === 'worktree-write') {
    const { code } = await capture(settings.executable, [
      'sandbox', '-P', profile, '-C', cwd, '--include-managed-config', ...settings.config, '/usr/bin/true',
    ], probeOptions);
    if (code !== 0) throw isolationError('Codex не подтвердил изоляцию записи. Проверьте версию Codex и запустите Hearth Studio вне другой песочницы.');
  }
  const mcpOverrides = await disableMcpServers(binary, probeOptions);
  let usage;
  try {
    return await withServer(settings, { cwd, ...options, cleanupGroup: Boolean(execution.scratch) }, async server => {
      const { rpc } = server;
      const { signal } = options;
      if (signal?.aborted) throw new DOMException('Запуск Codex отменён.', 'AbortError');
      const scope = { cwd, runtimeWorkspaceRoots: [cwd], permissions: profile, approvalPolicy: 'never' };
      let thread;
      try {
        thread = await rpc('thread/start', { ...scope, model, ephemeral: true });
      } catch (error) {
        throw new Error(`Не удалось открыть временную сессию Codex. ${error.message}`, { cause: error });
      }
      if (thread?.thread?.ephemeral !== true) {
        throw new Error('Codex не подтвердил временный режим сессии. Проверьте подключение и версию Codex.');
      }
      const threadId = thread.thread?.id;
      if (!threadId || thread.cwd !== cwd ||
          thread.approvalPolicy !== 'never' || thread.activePermissionProfile?.id !== profile ||
          thread.activePermissionProfile.extends != null || thread.runtimeWorkspaceRoots?.length !== 1 ||
          thread.runtimeWorkspaceRoots[0] !== cwd) {
        throw isolationError('Codex не подтвердил изоляцию рабочей папки и запрошенный профиль доступа.');
      }
      if (model && thread.model !== model) throw new Error('Codex не применил выбранную модель.');
      return runTurn(server, {
        ...scope, threadId, effort, prompt, signal, emit,
        onUsage(measured) { usage = measured; },
      });
    }, mcpOverrides);
  } finally {
    if (usage) emit('usage', { usage });
  }
}

const usageFields = {
  inputTokens: 'inputTokens', outputTokens: 'outputTokens',
  cachedInputTokens: 'cacheReadTokens', cacheWriteInputTokens: 'cacheWriteTokens',
};

function codexUsage(total) {
  const usage = Object.fromEntries(Object.entries(usageFields)
    .filter(([field]) => Number.isSafeInteger(total?.[field]) && total[field] >= 0)
    .map(([field, key]) => [key, total[field]]));
  return Object.keys(usage).length ? usage : undefined;
}

function runTurn({ rpc, onNotify, onInterrupt }, { prompt, effort, signal, emit, onUsage, ...scope }) {
  return new Promise((resolve, reject) => {
    const { threadId } = scope;
    let turnId;
    let cancelled;
    let finalText = '';
    let legacyText = '';
    const beforeTurn = [];

    function handle({ method, params }) {
      if (params.threadId !== threadId || (params.turnId ?? params.turn?.id) !== turnId) return;
      if (method === 'thread/tokenUsage/updated') {
        const usage = codexUsage(params.tokenUsage?.total);
        if (usage) onUsage(usage);
        return;
      }
      const item = params.item;
      if (method === 'item/completed' && item?.type === 'agentMessage' && typeof item.text === 'string') {
        if (item.phase === 'final_answer') finalText = item.text;
        else if (item.phase == null) legacyText = item.text;
      }
      if (method !== 'turn/completed') return;
      if (cancelled) reject(cancelled);
      else if (params.turn.status === 'interrupted') reject(new DOMException('Codex прервал выполнение.', 'AbortError'));
      else if (params.turn.status !== 'completed') reject(providerError(params.turn.error?.message, 'Codex завершил задачу с ошибкой.'));
      else resolve({ text: finalText || legacyText });
    }

    onNotify(message => {
      if (!['item/completed', 'turn/completed', 'thread/tokenUsage/updated'].includes(message.method)) return;
      if (turnId) handle(message);
      else if (message.params?.threadId === threadId) beforeTurn.push(message);
    });
    onInterrupt(error => {
      cancelled ??= error;
      if (turnId) rpc('turn/interrupt', { threadId, turnId }).catch(() => reject(cancelled));
    });
    if (signal?.aborted) {
      reject(new DOMException('Запуск Codex отменён.', 'AbortError'));
      return;
    }
    rpc('turn/start', { ...scope, effort, input: [{ type: 'text', text: prompt, text_elements: [] }] })
      .then(result => {
        turnId = result.turn?.id;
        if (!turnId) throw new Error('Codex не вернул идентификатор запуска.');
        if (cancelled) rpc('turn/interrupt', { threadId, turnId }).catch(() => reject(cancelled));
        else emit('started');
        for (const message of beforeTurn) handle(message);
      }).catch(reject);
  });
}
