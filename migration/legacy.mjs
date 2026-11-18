import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInspector, legacyDependency, legacyItems as items, legacyLanguage, legacyReferenceId, legacyRoleHeader,
  legacySprintId as sprintKey, legacyTaskLinkTypes, previewImport, readLegacyLanguages } from './preview.mjs';

const maxMetadataFileBytes = 4 * 1024 * 1024;
const roles = new Set(['library', 'engineer', 'editor', 'artist', 'other']);
const textArtifacts = new Set(['.md', '.txt', '.json', '.csv', '.rst', '.yaml', '.yml', '.toml']);
const evidenceKinds = { '.mp4': 'video', '.webm': 'video', '.mov': 'video', '.png': 'image', '.jpg': 'image',
  '.jpeg': 'image', '.wav': 'audio', '.mp3': 'audio', '.ogg': 'audio', '.zip': 'build', '.pdf': 'report' };
const stageAliases = new Map([
  ['todo', 'backlog'], ['backlog', 'backlog'], ['ready', 'ready'], ['queued', 'ready'],
  ['in-progress', 'in_progress'], ['doing', 'in_progress'], ['active', 'in_progress'], ['running', 'in_progress'],
  ['review', 'review'], ['in-review', 'review'], ['qa', 'qa'], ['testing', 'qa'],
  ['done', 'done'], ['completed', 'done'], ['resolved', 'done'], ['closed', 'done'],
  ['blocked', 'blocked'], ['cancelled', 'blocked'], ['waiting', 'blocked'],
]);

const string = value => typeof value === 'string' ? value : '';
const firstText = (...values) => values.map(string).find(value => value.trim()) ?? '';
const sequence = value => Array.isArray(value) ? value : [];
const id = legacyReferenceId;
const key = value => id(value).toLowerCase();

function baseFields(record) {
  return {
    title: firstText(record.title, record.name, 'Без названия'),
    description: firstText(record.description, record.body, record.notes),
    goal: firstText(record.goal, record.objective),
    status: string(record.status),
    createdAt: firstText(record.createdAt, record.created_at, record.created, record.date),
    updatedAt: firstText(record.updatedAt, record.updated_at, record.updated),
  };
}

function addUnique(target, value, identify = id) {
  const identifier = identify(value);
  if (identifier && !target.has(identifier)) {
    target.set(identifier, { ...value, id: identifier, legacyId: id(value) || identifier });
  }
  return identifier;
}

async function loadData(source, warn) {
  const io = createInspector(warn);
  const studio = join(source, 'studio');
  const studioEntry = await io.inspectDirectory(studio, 'studio');
  async function readJson(path, label) {
    const entry = studioEntry && await io.inspect(path, label);
    const raw = await io.readMetadata(path, entry, label, maxMetadataFileBytes);
    if (!raw) return null;
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    } catch {
      warn(`Повреждён JSON в разделе «${label}».`);
      return null;
    }
  }
  const board = await readJson(join(studio, 'board.json'), 'studio/board.json');
  if (!Array.isArray(board?.tasks) || (board.schema !== undefined && ![1, 2].includes(board.schema))) {
    throw new Error('В выбранном источнике нет доступной доски studio/board.json версии 1 или 2.');
  }
  const extras = {};
  for (const collection of ['epics', 'stories', 'sprints', 'meetings', 'decisions']) {
    const label = `studio/${collection}.json`;
    extras[collection] = items(await readJson(join(source, label), label), collection);
  }
  const meetingsLabel = 'studio/meetings.jsonl';
  const meetingsPath = join(source, meetingsLabel);
  const meetingsLog = await io.readMetadata(meetingsPath, await io.inspect(meetingsPath, meetingsLabel), meetingsLabel, maxMetadataFileBytes);
  if (meetingsLog) {
    try {
      const lines = new TextDecoder('utf-8', { fatal: true }).decode(meetingsLog).split(/\r?\n/, 20_001);
      if (lines.length > 20_000) warn('Достигнут лимит записей журнала встреч.');
      for (const line of lines.slice(0, 20_000)) {
        if (!line.trim()) continue;
        try {
          extras.meetings.push(JSON.parse(line));
        } catch {
          warn('В журнале встреч пропущена повреждённая запись.');
        }
      }
    } catch {
      warn('Журнал встреч должен быть в кодировке UTF-8.');
    }
  }
  const archives = [];
  const archivePath = join(studio, 'archive');
  const archive = await io.inspectDirectory(archivePath, 'studio/archive');
  for await (const entry of io.entries(archivePath, archive, 'studio/archive')) {
    const number = entry.name.match(/^sprint-(\d+)\.json$/i)?.[1];
    if (number === undefined) continue;
    const file = await readJson(join(archivePath, entry.name), 'studio/archive');
    if (file) archives.push({ ...file, number });
  }

  const agents = [];
  const rolesPath = join(source, '.claude', 'agents');
  const claude = await io.inspectDirectory(join(source, '.claude'), '.claude');
  const rolesEntry = claude && await io.inspectDirectory(rolesPath, '.claude/agents');
  for await (const entry of io.entries(rolesPath, rolesEntry, '.claude/agents')) {
    if (!entry.name.endsWith('.md') || !entry.isFile()) continue;
    const path = join(rolesPath, entry.name);
    const raw = await io.readMetadata(path, await io.inspect(path, '.claude/agents'), '.claude/agents', 256 * 1024);
    if (!raw) continue;
    const { get, body } = legacyRoleHeader(raw.toString('utf8'));
    const name = firstText(get('name'), basename(entry.name, '.md'));
    const category = key(name) === 'librarian' ? 'library' : key(name);
    const role = roles.has(category) ? category : 'other';
    const legacyContract = Object.fromEntries(Object.entries({
      instructions: body.trim(), tools: get('tools'), disallowedTools: get('disallowedTools'), skills: get('skills'),
      memory: get('memory'), scope: get('scope'),
    }).filter(([, value]) => value));
    agents.push({ id: basename(entry.name, '.md'), name, description: get('description'), role, mode: 'inherit', legacyContract });
  }
  const registrations = new Map();
  const gitPath = join(source, '.git');
  const label = '.git/worktrees';
  const worktreesPath = join(gitPath, 'worktrees');
  const gitEntry = await io.inspect(gitPath, '.git');
  const worktrees = gitEntry?.isDirectory() && await io.inspectDirectory(worktreesPath, label);
  for await (const entry of io.entries(worktreesPath, worktrees, label)) {
    if (!entry.isDirectory()) continue;
    const head = join(worktreesPath, entry.name, 'HEAD');
    const data = await io.readMetadata(head, await io.inspect(head, label), label, 4096);
    const branch = data?.toString('utf8').match(/^ref: refs\/heads\/([^\s]+)\r?\n?$/)?.[1] ?? '';
    for (const ref of `${entry.name} ${branch}`.match(/\bT-\d+(?!\d)/gi) ?? []) {
      registrations.set(key(ref), branch);
    }
  }
  return { io, board, extras, archives, agents, registrations, languages: await readLegacyLanguages(source, io, warn) };
}

function buildSnapshot({ board, extras, archives, agents, registrations, languages, language, artifactOwners, source, warn }) {
  const studio = {
    id: 'legacy', root: source, name: firstText(board.studio?.name, board.name, basename(source)),
    brief: firstText(board.studio?.brief, board.brief, board.goal),
    language: language || languages.ownerLanguage || 'Русский',
    projectLanguage: firstText(languages.projectLanguage, legacyLanguage(board.studio?.projectLanguage), legacyLanguage(board.projectLanguage)),
    director: { runtime: 'claude', model: '', effort: '' }, agents,
  };
  const own = record => ({ ...record, studioId: studio.id });
  const epics = new Map();
  const stories = new Map();
  const sprints = new Map();
  const meetings = new Map();
  const tasks = new Map();
  const decisions = new Map();
  for (const record of [board, extras, ...archives]) {
    for (const epic of items(record.epics, 'epics')) {
      addUnique(epics, epic);
      for (const story of items(epic?.stories, 'stories')) addUnique(stories, { epicId: id(epic), ...story });
    }
    for (const story of items(record.stories, 'stories')) addUnique(stories, story);
    for (const sprint of items(record.sprints, 'sprints')) addUnique(sprints, sprint, sprintKey);
    for (const meeting of items(record.meetings, 'meetings')) {
      addUnique(meetings, { sprint: record.number, ...meeting });
    }
    for (const decision of items(record.decisions, 'decisions')) addUnique(decisions, decision);
    for (const task of sequence(record.tasks)) addUnique(tasks, { sprint: record.number, ...task });
  }
  for (const archive of archives) {
    addUnique(sprints, { ...archive.sprint, number: archive.number, status: 'archived' }, sprintKey);
  }
  if (sprintKey(board.sprint) && !sprints.has(sprintKey(board.sprint))) {
    addUnique(sprints, { number: board.sprint, status: 'active' }, sprintKey);
  }
  for (const task of tasks.values()) {
    const sprint = task.sprintId ?? task.sprint_id ?? task.sprint;
    if (sprintKey(sprint) && !sprints.has(sprintKey(sprint))) addUnique(sprints, { number: sprint }, sprintKey);
  }

  function foreign(target, label, value) {
    const identifier = target === sprints ? sprintKey(value) : id(value);
    if (!identifier) return null;
    if (target.has(identifier)) return identifier;
    warn(`Ссылка «${label}» на отсутствующую запись «${identifier}» пропущена.`);
    return null;
  }
  const agentIds = new Map(agents.flatMap(agent => [[key(agent.id), agent.id], [key(agent.name), agent.id]]));
  const targets = { task: tasks, epic: epics, story: stories, sprint: sprints, meeting: meetings };
  function agentLink(value) {
    return agentIds.get(key(value)) ?? null;
  }
  const inbox = [];
  const mappedTasks = Array.from(tasks.values(), task => {
    const legacyStatus = string(task.status);
    const stage = stageAliases.get(legacyStatus.toLowerCase().replace(/[ _]/g, '-')) ?? 'backlog';
    const branch = firstText(task.branch, task.git_branch, task.git?.branch, task.worktree?.branch, registrations.get(key(task.id)));
    const worktree = firstText(task.worktree, task.worktreePath, task.worktree_path, task.worktree?.path);
    const needsReview = stage !== 'done' && Boolean(branch || worktree || task.dirty || task.worktree?.dirty || registrations.has(key(task.id)));
    if (needsReview) {
      const details = branch ? ` (ветка ${branch})` : '';
      warn(`Задача ${task.id}${details} приостановлена до сверки рабочего дерева и изменений.`);
    }
    const outputs = sequence(task.outputs).map(value => firstText(value, value?.path));
    const outputPath = outputs.find(value => value.startsWith('studio/artifacts/') && textArtifacts.has(extname(value).toLowerCase()));
    const artifactPath = firstText(task.artifactPath, task.artifact_path, task.artifact?.path, outputPath,
      string(task.artifact).startsWith('studio/artifacts/') ? task.artifact : '');
    for (const path of new Set([...outputs, artifactPath])) {
      if (!path.startsWith('studio/artifacts/')) continue;
      const owners = artifactOwners.get(path) ?? [];
      owners.push(task.id);
      artifactOwners.set(path, owners);
    }
    const title = firstText(task.title, task.name, task.id);
    const kind = firstText(task.type, task.kind);
    const dependencies = [...sequence(task.dependencies ?? task.depends_on ?? task.dependsOn ?? task.deps), ...sequence(task.links)].flatMap(value => {
      const reference = legacyDependency(value);
      if (!reference) return [];
      const { kind, id } = reference;
      const target = kind === 'agent' ? agentLink(id) : foreign(targets[kind], 'зависимость задачи', id);
      const relation = value?.type ?? value?.kind;
      const type = kind === 'task' && legacyTaskLinkTypes.has(relation) ? relation : undefined;
      return target ? [{ kind, id: target, ...(type && { type }) }] : [];
    });
    const references = dependencies.filter(({ kind }) => kind !== 'task');
    const links = dependencies.filter(({ type }) => type).map(({ type, id }) => ({ type, taskId: id }));
    if (kind === 'question') {
      inbox.push(own({ id: `question-${task.id}`, taskId: task.id, kind: 'question', title,
        body: firstText(task.body, task.description, task.prompt, title),
        status: stage === 'done' ? 'resolved' : 'open',
        answer: firstText(task.answer, task.resolution, task.decision), createdAt: baseFields(task).createdAt }));
    }
    return own({
      ...baseFields(task), id: task.id, legacyId: task.legacyId, legacyStatus, title, kind,
      prompt: firstText(task.prompt, task.description, task.body, title), summary: firstText(task.summary, task.result?.summary),
      artifact: firstText(task.result?.artifact, artifactPath ? '' : task.artifact), artifactPath,
      status: stage === 'done' ? 'completed' : kind === 'question' ? 'waiting' : 'queued',
      stage: needsReview ? 'blocked' : stage === 'in_progress' ? 'ready' : stage,
      agentId: agentLink(task.agentId ?? task.agent_id ?? task.assignee) ?? agentLink(task.role),
      reviewerId: agentLink(task.reviewerId ?? task.reviewer_id ?? task.reviewer),
      epicId: foreign(epics, 'эпик', task.epicId ?? task.epic_id ?? task.epic),
      storyId: foreign(stories, 'история', task.storyId ?? task.story_id ?? task.story ?? task.user_story),
      sprintId: foreign(sprints, 'спринт', task.sprintId ?? task.sprint_id ?? task.sprint),
      dependencies: [...new Set(dependencies.filter(({ kind, type }) => kind === 'task' && (!type || type === 'blocks')).map(({ id }) => id))],
      ...(references.length && { references }),
      ...(links.length && { links }),
      criteria: typeof task.criteria === 'string' ? task.criteria : sequence(task.criteria ?? task.acceptance_criteria ?? task.acceptance).filter(value => typeof value === 'string'),
      legacyBranch: branch,
      ...(needsReview && { legacyWorktreeReview: true }),
    });
  });
  for (const decision of decisions.values()) {
    const taskId = foreign(tasks, 'задача для решения', decision.taskId ?? decision.task_id ?? decision.task);
    if (taskId) {
      inbox.push(own({ id: `decision-${decision.id}`, legacyId: decision.legacyId, kind: 'question', taskId, status: 'resolved',
        title: firstText(decision.title, 'Решение'), body: firstText(decision.body, decision.question, decision.title),
        answer: firstText(decision.answer, decision.decision, decision.resolution), createdAt: baseFields(decision).createdAt }));
    } else {
      addUnique(meetings, { ...decision, id: `decision-${decision.id}`, kind: 'decision' });
    }
  }
  return {
    studios: [studio], tasks: mappedTasks, inbox,
    epics: Array.from(epics.values(), epic => own({ ...baseFields(epic), id: epic.id, legacyId: epic.legacyId })),
    stories: Array.from(stories.values(), story => own({ ...baseFields(story), id: story.id, legacyId: story.legacyId,
      epicId: foreign(epics, 'эпик истории', story.epicId ?? story.epic) })),
    sprints: Array.from(sprints.values(), sprint => own({ ...baseFields(sprint), id: sprint.id, legacyId: sprint.legacyId,
      title: firstText(sprint.title, sprint.name, `Спринт ${sprint.id}`),
      epicId: foreign(epics, 'эпик спринта', sprint.epicId ?? sprint.epic),
      storyId: foreign(stories, 'история спринта', sprint.storyId ?? sprint.story) })),
    meetings: Array.from(meetings.values(), meeting => own({ ...baseFields(meeting), id: meeting.id, legacyId: meeting.legacyId,
      title: firstText(meeting.title, meeting.name, meeting.agenda, meeting.id),
      createdAt: firstText(baseFields(meeting).createdAt, meeting.opened),
      updatedAt: firstText(baseFields(meeting).updatedAt, meeting.closed),
      kind: firstText(meeting.kind, meeting.type, 'meeting'), summary: firstText(meeting.summary, meeting.notes, meeting.body, meeting.agenda),
      decision: firstText(meeting.decision, meeting.resolution, meeting.answer, meeting.decisions_md),
      decisions: sequence(meeting.decisions).filter(value => typeof value === 'string'),
      participants: sequence(meeting.participants).filter(value => typeof value === 'string'),
      messages: [...sequence(meeting.positions), ...sequence(meeting.rebuttals)]
        .filter(message => typeof message?.text === 'string')
        .map(message => ({ role: string(message.role), text: message.text, createdAt: firstText(message.createdAt, message.ts) })),
      taskIds: [...new Set(sequence(meeting.taskIds ?? meeting.actions).map(ref => id(ref)).filter(ref => tasks.has(ref)))],
      taskId: foreign(tasks, 'задача встречи', meeting.taskId ?? meeting.task_id ?? meeting.task),
      sprintId: foreign(sprints, 'спринт встречи', meeting.sprintId ?? meeting.sprint) })),
  };
}

export async function prepareLegacySnapshot({ source, root, paths, maxArtifactBytes, maxEvidenceBytes, language }) {
  if (typeof source !== 'string' || !isAbsolute(source) || source.includes('\0')) throw new Error('Выберите папку старой студии.');
  const sourceEntry = await lstat(resolve(source)).catch(() => null);
  if (!sourceEntry?.isDirectory()) throw new Error('Выберите доступную папку старой студии без символической ссылки.');
  const report = await previewImport({ root: source });
  if (!report.valid) throw new Error(report.warnings.join('\n') || 'Не удалось прочитать старую студию.');
  const destination = await realpath(root).catch(() => null);
  if (!destination || !(await lstat(destination)).isDirectory()) throw new Error('Выберите доступную папку нового проекта.');
  const contains = (parent, child) => {
    const path = relative(parent, child);
    return !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep);
  };
  if (contains(report.root, destination) || contains(destination, report.root)) {
    throw new Error('Выберите отдельную папку проекта вне исходной студии.');
  }
  const warnings = new Set(report.warnings);
  const warn = message => warnings.add(message);
  const data = await loadData(report.root, warn);
  if (language !== undefined && !legacyLanguage(language)) throw new Error('Укажите допустимый язык владельца.');
  const artifactOwners = new Map();
  const snapshot = buildSnapshot({ ...data, language: legacyLanguage(language), artifactOwners, source: report.root, warn });
  const artifacts = [];
  const evidence = [];
  const evidenceFiles = [];
  let bytes = 0;
  let evidenceBytes = 0;
  for (const path of paths) {
    if (!path.startsWith('studio/artifacts/')) throw new Error('Выберите путь внутри studio/artifacts.');
    const nativePath = join(report.root, path);
    const label = 'выбранный артефакт';
    const extension = extname(path).toLowerCase();
    const isText = textArtifacts.has(extension);
    const content = await data.io.readMetadata(nativePath, await data.io.inspect(nativePath, label), label,
      isText ? maxArtifactBytes : maxEvidenceBytes, { singleLink: true });
    if (!content) throw new Error('Выбранный артефакт недоступен, является ссылкой или превышает лимит размера.');
    if (!isText) {
      evidenceBytes += content.length;
      if (evidenceBytes > maxEvidenceBytes) throw new Error('Превышен допустимый размер выбранных доказательств.');
      const owners = artifactOwners.get(path) ?? [];
      if (owners.length !== 1) throw new Error('Выбранный бинарный артефакт должен ссылаться на одну задачу старой студии.');
      const id = `legacy-evidence-${evidence.length + 1}`;
      const digest = createHash('sha256').update(content).digest('hex');
      evidence.push({ id, studioId: snapshot.studios[0].id, taskId: owners[0], attemptId: `legacy-${owners[0]}`,
        revision: { digest }, sourcePath: path, size: content.length, digest, contentType: 'application/octet-stream',
        kind: evidenceKinds[extension] ?? 'file' });
      evidenceFiles.push({ id, bytes: content });
      continue;
    }
    bytes += content.length;
    if (bytes > 8 * maxArtifactBytes) throw new Error('Превышен допустимый размер артефактов.');
    try {
      artifacts.push({ path, content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content) });
    } catch {
      throw new Error('Можно перенести только текстовый артефакт в UTF-8.');
    }
  }
  return { snapshot: { ...snapshot, evidence }, artifacts, evidenceFiles, warnings: [...warnings] };
}
