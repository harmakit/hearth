import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, parse, relative, sep } from 'node:path';

const seatbelt = '/usr/bin/sandbox-exec';

export function isolationError(message) {
  return Object.assign(new Error(message), { code: 'ISOLATION_UNAVAILABLE' });
}

function directory(path, label) {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\u0000-\u001f]/u.test(path)) {
    throw isolationError(`Нужен абсолютный путь к папке «${label}».`);
  }
  try {
    const fullPath = realpathSync(path);
    if (!statSync(fullPath).isDirectory() || /[\u0000-\u001f]/u.test(fullPath)) throw new Error();
    return fullPath;
  } catch {
    throw isolationError(`Папка «${label}» недоступна. Проверьте настройки рабочей копии.`);
  }
}

function contains(parent, path) {
  const subpath = relative(parent, path);
  return subpath === '' || (!isAbsolute(subpath) && subpath !== '..' && !subpath.startsWith(`..${sep}`));
}

function inspectWriteRoot(root) {
  const directories = [root];
  const device = statSync(root).dev;
  while (directories.length > 0) {
    const directoryPath = directories.pop();
    for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
      const path = join(directoryPath, entry.name);
      const details = lstatSync(path);
      if (entry.name.toLowerCase() === '.git' && directoryPath !== root) {
        throw isolationError('Изоляция записи недоступна для дерева с вложенными Git-метаданными.');
      }
      if (details.dev !== device || (details.isFile() && details.nlink > 1) ||
          !(details.isDirectory() || details.isFile() || details.isSymbolicLink())) {
        throw isolationError(`Не удалось изолировать рабочую копию. Проверьте тип и жёсткие ссылки файла «${entry.name}».`);
      }
      if (details.isDirectory() && entry.name.toLowerCase() !== '.git') directories.push(path);
    }
  }
}

export function executionScope(request, { requireScratch = true, projectRoot } = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw isolationError('Нужна область доступа к рабочей копии.');
  const { root, scratch, access } = request;
  if (access !== 'read' && access !== 'worktree-write') throw isolationError('Неизвестный режим доступа к рабочей копии.');
  const workspace = directory(root, 'рабочая копия');
  if (scratch == null && access === 'read' && !requireScratch) return { root: workspace, access };
  const temporary = directory(scratch, 'временная область попытки');
  if (projectRoot && [access === 'worktree-write' ? workspace : undefined, temporary].some(path => path && contains(path, projectRoot))) {
    throw isolationError('Для записи нужна отдельная рабочая копия вне исходной папки проекта.');
  }
  if (contains(workspace, temporary) || contains(temporary, workspace) ||
      [workspace, temporary].some(path => path === parse(path).root || path.split(sep).some(part => part.toLowerCase() === '.git'))) {
    throw isolationError('Рабочая копия и временная область должны быть отдельными папками вне Git-метаданных.');
  }
  return { root: workspace, scratch: temporary, access };
}

export function verifyWriteRoots({ root, scratch, access }) {
  try {
    if (access === 'worktree-write') inspectWriteRoot(root);
    if (scratch) inspectWriteRoot(scratch);
  } catch (error) {
    if (error.code === 'ISOLATION_UNAVAILABLE') throw error;
    throw isolationError('Не удалось проверить содержимое рабочей и временной папок. Повторите запуск после сверки файлов.');
  }
}

function seatbeltProfile(paths, network, privateProject, workspace) {
  const portalServices = [
    'com.apple.system.opendirectoryd.libinfo', 'com.apple.bsd.dirhelper',
  ];
  if (network) portalServices.push(
    'com.apple.SecurityServer', 'com.apple.trustd.agent', 'com.apple.TrustEvaluationAgent',
    'com.apple.SystemConfiguration.DNSConfiguration', 'com.apple.SystemConfiguration.configd',
  );
  const writable = paths.map(path => `(subpath ${JSON.stringify(path)})`).join(' ');
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec process-fork)',
    '(allow signal process-info* (target same-sandbox))',
    '(allow file-read* sysctl-read)',
    ...(privateProject?[
      `(deny file-read* (subpath ${JSON.stringify(privateProject.state)}))`,
      `(deny file-read* (require-all (subpath ${JSON.stringify(privateProject.worktrees)}) (require-not (subpath ${JSON.stringify(workspace)}))))`,
      `(deny file-read* (subpath ${JSON.stringify(join(privateProject.root,'.git'))}))`,
    ]:[]),
    '(allow file-write-data (require-all (path "/dev/null") (vnode-type CHARACTER-DEVICE)))',
    `(allow file-write* ${writable})`,
    '(deny file-link)',
    '(deny file-write* (regex #"/\\.[gG][iI][tT](/|$)"))',
    `(deny file-write-unlink ${paths.map(path => `(literal ${JSON.stringify(path)})`).join(' ')})`,
    `(allow mach-lookup ${portalServices.map(service => `(global-name ${JSON.stringify(service)})`).join(' ')})`,
    ...(network ? [
      '(allow network-outbound (remote tcp "*:443") (remote udp "*:53") (remote tcp "*:53"))',
      '(allow system-socket (socket-domain AF_UNIX))',
      '(allow network-outbound (remote unix-socket (literal "/private/var/run/mDNSResponder")))',
    ] : []),
  ].join('\n');
}

export function scopedCommand(command, args, { root, scratch, access, network = false, env = process.env, privateProject }) {
  if (process.platform !== 'darwin') {
    throw isolationError('Изоляция процесса доступна на macOS. Выполните проверку или запись на поддерживаемой системе.');
  }
  const scope = executionScope({ root, scratch, access });
  verifyWriteRoots(scope);
  const paths = scope.access === 'worktree-write' ? [scope.root, scope.scratch] : [scope.scratch];
  const profile = ['-p', seatbeltProfile(paths, network === true, privateProject, scope.root)];
  const scopedEnv = { ...env, TMPDIR: scope.scratch, TMP: scope.scratch, TEMP: scope.scratch };
  const probe = spawnSync(seatbelt, [...profile, '/usr/bin/true'], {
    cwd: scope.root, env: scopedEnv, stdio: 'ignore', timeout: 3000,
  });
  if (probe.error || probe.status !== 0) {
    throw isolationError('macOS не включила изоляцию процесса. Запустите Hearth Studio вне другой песочницы и повторите.');
  }
  return { command: seatbelt, args: [...profile, command, ...args], env: scopedEnv };
}
