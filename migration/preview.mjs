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

export function legacyLanguage(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > 120) return '';
  if (/^[a-z]{2,3}(?:-[a-z\d]{2,8})*$/i.test(text)) {
    try { if (Intl.DisplayNames.supportedLocalesOf([text]).length) return text; }
    catch { return ''; }
  }
  const labels = new Set(['русский', 'russian', 'english', 'английский', 'español', 'spanish', 'deutsch', 'german',
    'français', 'french', 'português', 'portuguese', 'українська', 'ukrainian', '中文', 'chinese', '日本語', 'japanese',
    'italiano', 'italian', 'polski', 'polish', '한국어', 'korean', 'العربية', 'arabic', 'हिन्दी', 'हिंदी', 'hindi',
    'türkçe', 'turkish', 'nederlands', 'dutch', 'čeština', 'czech', 'svenska', 'swedish', 'suomi', 'finnish']);
  return labels.has(text.toLowerCase()) ? text : '';
}

export async function readLegacyLanguages(root, io, warn) {
  for (const label of ['studio/config.json', 'config.json']) {
    const path = join(root, label);
    const entry = await io.inspect(path, label);
    if (!entry) continue;
    const raw = await io.readMetadata(path, entry, label, 256 * 1024);
    if (!raw) return {};
    try {
      const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
      return { ownerLanguage: legacyLanguage(config?.owner_language), projectLanguage: legacyLanguage(config?.project_language) };
    } catch {
      warn(`Повреждён JSON в разделе «${label}».`);
      return {};
    }
  }
  return {};
}

export const legacyReferenceKinds = Object.freeze({ task: 'tasks', epic: 'epics', story: 'stories', sprint: 'sprints', meeting: 'meetings', agent: 'agents' });

export function legacyReferenceId(value) {
  if (value && typeof value === 'object') value = value.id ?? value.targetId ?? value.target_id ?? value.taskId ?? value.task_id ?? value.number;
  const result = Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
  return result && result.length <= 256 && !/[\x00-\x1f]/.test(result) ? result : '';
}

export function legacyItems(value, collection) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value[collection])) return value[collection];
  if (value.id || value.number) return [value];
  return Object.entries(value).filter(([, item]) => item && typeof item === 'object')
    .map(([name, item]) => ({ id: name, ...item }));
}

export const legacySprintId = value => legacyReferenceId(value).toLowerCase().replace(/^(?:sprint[-_ ]*)?0*(\d+)$/i, '$1');

export const legacyTaskLinkTypes = new Set(['blocks', 'origin', 'replaces', 'debt']);

export function legacyDependency(value) {
  let kind = value?.kind ?? value?.type ?? 'task';
  if (kind === 'user_story') kind = 'story';
  if (kind === 'role') kind = 'agent';
  if (legacyTaskLinkTypes.has(kind)) kind = 'task';
  const id = legacyReferenceId(value);
  return id && Object.hasOwn(legacyReferenceKinds, kind) ? { kind, id } : null;
}

export function legacyRoleHeader(markdown) {
  const header = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return {
    body: header ? markdown.slice(header[0].length) : markdown,
    get(field) {
      const match = header?.[1].match(new RegExp(`^${field}:[ \\t]*([^\\r\\n]*)([\\s\\S]*)`, 'm'));
      const value = match?.[1].trim().replace(/^(['"])(.*)\1$/, '$2') ?? '';
      if (value || !match) return value;
      const entries = match[2].match(/^(?:\r?\n[ \t]+-[ \t]+[^\r\n]+)+/)?.[0];
      return entries?.trim().split(/\r?\n/).map(entry => entry.trim().replace(/^- +/, '')).join(', ') ?? '';
    },
  };
}

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

  async function readMetadata(path, entry, label, byteLimit, { singleLink = false } = {}) {
    if (!entry) return null;
    if (!entry.isFile() || singleLink && entry.nlink !== 1) {
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
            !sameEntry(current, pathEntry) || current.size !== entry.size || singleLink && current.nlink !== 1) {
          warn(`Файл «${label}» изменился во время проверки.`);
          return null;
        }
        const content = Buffer.alloc(entry.size);
        metadataBytes += content.length;
        let offset = 0;
        while (offset < content.length) {
          const { bytesRead } = await file.read(content, offset, content.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        const afterRead = await file.stat();
        const finalEntry = await inspect(path, label);
        if (offset !== content.length || !finalEntry || !sameEntry(current, finalEntry) ||
            afterRead.mtimeMs !== current.mtimeMs || afterRead.ctimeMs !== current.ctimeMs || afterRead.size !== current.size) {
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

  async function tasks(path, entry, label, isBoard = false, collect) {
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
    collect?.(data);
    const recognized = data.tasks.flatMap(task => {
      const id = task && typeof task === 'object' && !Array.isArray(task) ? legacyReferenceId(task) : '';
      return id ? [{ ...task, id }] : [];
    });
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
    ownerLanguage: 'Русский',
    ownerLanguageSource: 'fallback',
    unresolvedReferences: [],
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

  const io = createInspector(warn);
  const { inspect, inspectDirectory, entries, tasks, worktreeState } = io;
  const studio = join(report.root, 'studio');
  const studioEntry = await inspectDirectory(studio, 'studio');
  const boardLabel = 'studio/board.json';
  const boardPath = join(studio, 'board.json');
  const boardEntry = studioEntry && await inspect(boardPath, boardLabel);
  const known = Object.fromEntries(Object.keys(legacyReferenceKinds).map(kind => [kind, new Set()]));
  function collect(data) {
    for (const kind of ['epic', 'story', 'sprint', 'meeting']) {
      for (const row of legacyItems(data[legacyReferenceKinds[kind]], legacyReferenceKinds[kind])) {
        known[kind].add(kind === 'sprint' ? legacySprintId(row) : legacyReferenceId(row));
        if (kind === 'epic') for (const story of legacyItems(row?.stories, 'stories')) known.story.add(legacyReferenceId(story));
      }
    }
    if (data.sprint) known.sprint.add(legacySprintId(data.sprint));
  }
  const board = await tasks(boardPath, boardEntry, boardLabel, true, collect);
  if (!boardEntry) warn('Выберите папку старой студии с доступным файлом studio/board.json.');
  if (board) {
    const language = await readLegacyLanguages(report.root, io, warn);
    if (language.ownerLanguage) {
      report.ownerLanguage = language.ownerLanguage;
      report.ownerLanguageSource = 'config';
    }
    report.valid = true;
    report.counts.tasks = board.length;
    report.counts.openQuestions = board.filter(task => task.type === 'question' && task.status !== 'done').length;
  }

  const archive = join(studio, 'archive');
  const archiveLabel = 'архив задач studio/archive';
  const archivedIds = new Set();
  const archivedTasks = [];
  const archiveEntry = studioEntry && await inspectDirectory(archive, archiveLabel);
  for await (const entry of entries(archive, archiveEntry, archiveLabel)) {
    if (!/^sprint-\d+\.json$/.test(entry.name)) continue;
    const path = join(archive, entry.name);
    const archived = await tasks(path, await inspect(path, archiveLabel), archiveLabel, false, collect);
    if (archived) known.sprint.add(legacySprintId(entry.name.slice(0, -5)));
    for (const task of archived ?? []) {
      archivedIds.add(task.id);
      archivedTasks.push(task);
    }
  }
  report.counts.archivedTasks = archivedIds.size;

  const rolesLabel = '.claude/agents';
  const roles = join(report.root, rolesLabel);
  const claudeEntry = await inspectDirectory(join(report.root, '.claude'), '.claude');
  const rolesEntry = claudeEntry && await inspectDirectory(roles, rolesLabel);
  const knownRoles = known.agent;
  for await (const entry of entries(roles, rolesEntry, rolesLabel)) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    report.counts.roles++;
    knownRoles.add(basename(entry.name, '.md').toLowerCase());
    const path = join(roles, entry.name);
    const raw = await io.readMetadata(path, await inspect(path, rolesLabel), rolesLabel, 256 * 1024);
    const name = legacyRoleHeader(raw?.toString('utf8') ?? '').get('name');
    if (name) knownRoles.add(name.toLowerCase());
  }
  const allTasks = [...(board ?? []), ...archivedTasks];
  for (const task of allTasks) {
    known.task.add(task.id);
    const sprint = legacySprintId(task.sprintId ?? task.sprint_id ?? task.sprint);
    if (sprint) known.sprint.add(sprint);
  }
  for (const kind of ['epic', 'story', 'sprint', 'meeting']) {
    const collection = legacyReferenceKinds[kind];
    const label = `studio/${collection}.json`;
    const path = join(report.root, label);
    const raw = studioEntry && await io.readMetadata(path, await inspect(path, label), label, MAX_METADATA_FILE_BYTES);
    if (!raw) continue;
    try { collect({ [collection]: JSON.parse(raw.toString('utf8')) }); }
    catch { warn(`Повреждён JSON в разделе «${label}».`); }
  }
  const safeId = value => /^[\p{L}\p{M}\d_. -]{1,120}$/u.test(value);
  const sourceRefs = new Set();
  const checkedArtifacts = new Map();
  function addUnresolved(sourceId, kind, targetId) {
    if (report.unresolvedReferences.length >= 100 || !safeId(sourceId)) return;
    const signature = JSON.stringify([sourceId, kind, targetId]);
    if (sourceRefs.has(signature)) return;
    sourceRefs.add(signature);
    report.unresolvedReferences.push({ sourceId, kind, targetId });
  }
  for (const task of allTasks) {
    if (report.unresolvedReferences.length >= 100) break;
    const references = [];
    for (const value of [task.agentId ?? task.agent_id ?? task.assignee ?? task.role, task.reviewerId ?? task.reviewer_id ?? task.reviewer]) {
      const id = legacyReferenceId(value);
      if (id) references.push({ kind: 'agent', id });
    }
    const dependencies = task.dependencies ?? task.depends_on ?? task.dependsOn ?? task.deps;
    const edges = [...(Array.isArray(dependencies) ? dependencies : []), ...(Array.isArray(task.links) ? task.links : [])];
    for (const entry of edges) {
      const link = legacyDependency(entry);
      if (link) references.push(link);
    }
    for (const { kind, id } of references) {
      const key = kind === 'agent' ? id.toLowerCase() : kind === 'sprint' ? legacySprintId(id) : id;
      if (safeId(id) && !known[kind].has(key)) addUnresolved(task.id, kind, id);
    }
    const outputPaths = [task.artifactPath, task.artifact_path, task.artifact, ...(Array.isArray(task.outputs) ? task.outputs : [])];
    for (const value of outputPaths) {
      const path = typeof value === 'object' ? value?.path : value;
      if (typeof path !== 'string' || !path.startsWith('studio/artifacts/') || path.length > 512 ||
          path.split('/').some(part => !safeId(part) || part.startsWith('.'))) continue;
      if (!checkedArtifacts.has(path) && checkedArtifacts.size < 200) {
        const entry = await inspect(join(report.root, path), 'studio/artifacts');
        checkedArtifacts.set(path, entry?.isFile() && entry.nlink === 1 || false);
      }
      if (checkedArtifacts.get(path) === false) addUnresolved(task.id, 'artifact', path);
    }
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
