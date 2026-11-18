import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

const MAX_METADATA_FILE_BYTES = 4 * 1024 * 1024;
const MAX_METADATA_BYTES = 32 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 20_000;
const MAX_ARTIFACT_DEPTH = 24;
const MAX_GITDIR_BYTES = 4096;
const MAX_WORKTREE_DEPTH = 32;

const isMissing = error => error.code === 'ENOENT' || error.code === 'ENOTDIR';
const sameEntry = (a, b) => a.dev === b.dev && a.ino === b.ino;

export function createInspector(warn) {
  let metadataBytes = 0;

  async function inspect(path, label, missing = null) {
    try {
      const entry = await lstat(path);
      if (entry.isSymbolicLink() || await realpath(path) !== path) {
        warn(`Пропущена символическая ссылка в разделе «${label}».`);
        return null;
      }
      return entry;
    } catch (error) {
      if (isMissing(error)) return missing;
      warn(`Не удалось проверить доступ к разделу «${label}».`);
      return null;
    }
  }

  async function inspectDirectory(path, label) {
    const entry = await inspect(path, label);
    if (!entry || entry.isDirectory()) return entry;
    warn(`Раздел «${label}» должен быть папкой.`);
    return null;
  }

  async function* entries(path, entry, label, budget = { remaining: MAX_DIRECTORY_ENTRIES }) {
    if (!entry) return;
    try {
      const directory = await opendir(path);
      try {
        const current = await inspect(path, label);
        if (!current || !sameEntry(entry, current)) {
          warn(`Раздел «${label}» изменился во время проверки.`);
          return;
        }
        while (budget.remaining > 0) {
          const item = await directory.read();
          if (!item) return;
          budget.remaining--;
          if (item.isSymbolicLink()) {
            warn(`Пропущена символическая ссылка в разделе «${label}».`);
          } else {
            yield item;
          }
        }
        warn(`Достигнут лимит обхода раздела «${label}». Показана часть данных.`);
      } finally {
        await directory.close();
      }
    } catch {
      warn(`Не удалось прочитать папку «${label}». Проверьте права доступа.`);
    }
  }

  async function readMetadata(path, entry, label, byteLimit) {
    if (!entry) return null;
    if (!entry.isFile()) {
      warn(`Раздел «${label}» должен быть обычным файлом.`);
      return null;
    }
    if (entry.size > byteLimit || metadataBytes + entry.size > MAX_METADATA_BYTES) {
      warn(`Достигнут лимит чтения раздела «${label}». Показана часть данных.`);
      return null;
    }

    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const current = await file.stat();
        const pathEntry = await inspect(path, label);
        if (!current.isFile() || !pathEntry || !sameEntry(entry, current) ||
            !sameEntry(current, pathEntry) || current.size !== entry.size) {
          warn(`Файл «${label}» изменился во время проверки.`);
          return null;
        }
        const content = Buffer.alloc(entry.size);
        metadataBytes += content.length;
        const { bytesRead } = await file.read({ buffer: content, position: 0 });
        const afterRead = await file.stat();
        if (bytesRead !== content.length || afterRead.mtimeMs !== current.mtimeMs || afterRead.size !== current.size) {
          warn(`Файл «${label}» изменился во время проверки.`);
          return null;
        }
        return content;
      } finally {
        await file.close();
      }
    } catch {
      warn(`Не удалось прочитать файл в разделе «${label}». Проверьте права доступа.`);
      return null;
    }
  }

  async function tasks(path, entry, label, isBoard = false) {
    const content = await readMetadata(path, entry, label, MAX_METADATA_FILE_BYTES);
    if (!content) return null;
    let data;
    try {
      data = JSON.parse(content.toString('utf8'));
    } catch {
      warn(`Повреждён JSON в разделе «${label}». Проверьте формат файла.`);
      return null;
    }

    if (!Array.isArray(data?.tasks)) {
      warn(`В разделе «${label}» отсутствует массив tasks.`);
      return null;
    }
    if (isBoard && data.schema !== undefined && data.schema !== 1 && data.schema !== 2) {
      warn('Версия схемы studio/board.json не поддерживается. Выберите источник с доской версии 1 или 2.');
      return null;
    }
    const recognized = data.tasks.filter(task => typeof task?.id === 'string' && task.id.length > 0);
    if (recognized.length !== data.tasks.length) warn(`В разделе «${label}» пропущены задачи без идентификатора.`);
    return recognized;
  }

  async function worktreeState(root, registration, label) {
    const recordPath = join(registration, 'gitdir');
    const record = await readMetadata(recordPath, await inspect(recordPath, label), label, MAX_GITDIR_BYTES);
    if (!record) return 'unverified';

    let pointer;
    try {
      pointer = new TextDecoder('utf-8', { fatal: true }).decode(record).replace(/\r?\n$/, '');
    } catch {
      return 'unverified';
    }
    if (!pointer || /[\r\n\0]/.test(pointer) || basename(pointer) !== '.git') return 'unverified';

    const target = relative(root, resolve(registration, pointer));
    // Classify external paths lexically, without opening their parent directories.
    if (target === '..' || target.startsWith('..' + sep) || isAbsolute(target)) return 'external';
    const components = target.split(sep);
    if (components.length > MAX_WORKTREE_DEPTH) return 'unverified';
    let path = root;
    for (const [index, component] of components.entries()) {
      path = join(path, component);
      const entry = await inspect(path, label, 'missing');
      if (entry === 'missing') return 'missing';
      if (!entry) return 'unverified';
      if (index === components.length - 1) return entry.isFile() ? 'existing' : 'unverified';
      if (!entry.isDirectory()) return 'unverified';
    }
    return 'unverified';
  }

  return { inspect, inspectDirectory, entries, readMetadata, tasks, worktreeState };
}

export async function previewImport({ root } = {}) {
  const report = {
    root: '',
    valid: false,
    counts: { tasks: 0, archivedTasks: 0, roles: 0, openQuestions: 0, worktrees: 0, artifacts: 0 },
    artifactBytes: 0,
    projectCandidates: [],
    worktreeStatus: { existing: 0, missing: 0, external: 0, unverified: 0 },
    warnings: [],
  };
  const warnings = new Set();
  const warn = message => warnings.add(message);
  const result = () => ({ ...report, warnings: [...warnings] });

  if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0')) {
    warn('Выберите папку старой студии по абсолютному локальному пути.');
    return result();
  }
  try {
    const selected = await realpath(root);
    if (selected === parse(selected).root || !(await lstat(selected)).isDirectory()) {
      warn('Выберите папку старой студии, в которой находится studio/board.json.');
      return result();
    }
    report.root = selected;
  } catch {
    warn('Выбранная папка недоступна. Проверьте путь и права доступа.');
    return result();
  }

  const { inspect, inspectDirectory, entries, tasks, worktreeState } = createInspector(warn);
  const studio = join(report.root, 'studio');
  const studioEntry = await inspectDirectory(studio, 'studio');
  const boardLabel = 'studio/board.json';
  const boardPath = join(studio, 'board.json');
  const boardEntry = studioEntry && await inspect(boardPath, boardLabel);
  const board = await tasks(boardPath, boardEntry, boardLabel, true);
  if (!boardEntry) warn('Выберите папку старой студии с доступным файлом studio/board.json.');
  if (board) {
    report.valid = true;
    report.counts.tasks = board.length;
    report.counts.openQuestions = board.filter(task => task.type === 'question' && task.status !== 'done').length;
  }

  const archive = join(studio, 'archive');
  const archiveLabel = 'архив задач studio/archive';
  const archivedIds = new Set();
  const archiveEntry = studioEntry && await inspectDirectory(archive, archiveLabel);
  for await (const entry of entries(archive, archiveEntry, archiveLabel)) {
    if (!/^sprint-\d+\.json$/.test(entry.name)) continue;
    const path = join(archive, entry.name);
    const archived = await tasks(path, await inspect(path, archiveLabel), archiveLabel);
    for (const task of archived ?? []) archivedIds.add(task.id);
  }
  report.counts.archivedTasks = archivedIds.size;

  const rolesLabel = '.claude/agents';
  const roles = join(report.root, rolesLabel);
  const claudeEntry = await inspectDirectory(join(report.root, '.claude'), '.claude');
  const rolesEntry = claudeEntry && await inspectDirectory(roles, rolesLabel);
  for await (const entry of entries(roles, rolesEntry, rolesLabel)) {
    if (entry.isFile() && entry.name.endsWith('.md')) report.counts.roles++;
  }

  const git = join(report.root, '.git');
  const gitEntry = await inspect(git, '.git');
  if (gitEntry?.isDirectory()) {
    const worktrees = join(git, 'worktrees');
    const label = '.git/worktrees';
    for await (const entry of entries(worktrees, await inspectDirectory(worktrees, label), label)) {
      if (!entry.isDirectory()) continue;
      const state = await worktreeState(report.root, join(worktrees, entry.name), label);
      report.counts.worktrees++;
      report.worktreeStatus[state]++;
    }
    const { external, missing, unverified } = report.worktreeStatus;
    if (external) warn(`Рабочие деревья вне выбранной папки: ${external}. Проверьте их перед переносом.`);
    if (missing) warn(`Связанные файлы .git внутри выбранной папки отсутствуют у ${missing} рабочих деревьев.`);
    if (unverified) warn(`Требуется проверить вручную ${unverified} записей рабочих деревьев в .git/worktrees.`);
  } else if (gitEntry) {
    warn('Для проверки рабочих деревьев выберите основной клон с папкой .git.');
  }

  const game = join(report.root, 'game');
  const candidates = [report.root];
  if (await inspectDirectory(game, 'game')) candidates.push(game);
  for (const candidate of candidates) {
    const marker = await inspect(join(candidate, 'project.godot'), 'project.godot');
    if (marker?.isFile()) report.projectCandidates.push(candidate);
  }
  if (report.projectCandidates.length === 0) {
    warn('Проверьте расположение игры. Файл project.godot ожидается в выбранной папке или в папке game.');
  }

  const artifactsLabel = 'studio/artifacts';
  const artifacts = join(report.root, artifactsLabel);
  const artifactBudget = { remaining: MAX_DIRECTORY_ENTRIES };
  async function countArtifacts(path, stat, depth) {
    for await (const entry of entries(path, stat, artifactsLabel, artifactBudget)) {
      if ((!entry.isFile() && !entry.isDirectory()) || entry.name === '.DS_Store') continue;
      const child = join(path, entry.name);
      const childStat = await inspect(child, artifactsLabel);
      if (childStat?.isFile()) {
        report.counts.artifacts++;
        const sum = report.artifactBytes + childStat.size;
        if (!Number.isSafeInteger(sum)) warn('Суммарный размер артефактов превышает точность счётчика.');
        report.artifactBytes = Math.min(sum, Number.MAX_SAFE_INTEGER);
      } else if (childStat?.isDirectory() && depth < MAX_ARTIFACT_DEPTH) {
        await countArtifacts(child, childStat, depth + 1);
      } else if (childStat?.isDirectory()) {
        warn('Достигнут лимит глубины папок studio/artifacts. Показана часть данных.');
      }
    }
  }
  const artifactsEntry = studioEntry && await inspectDirectory(artifacts, artifactsLabel);
  await countArtifacts(artifacts, artifactsEntry, 0);
  return result();
}
