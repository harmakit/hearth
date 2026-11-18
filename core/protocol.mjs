import { posix, win32 } from 'node:path';

const roles = ['library', 'engineer', 'editor', 'artist', 'other'];
const keyPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const textExtensions = new Set(['.md', '.txt', '.json', '.csv', '.rst', '.yaml', '.yml', '.toml']);

export function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Ожидается объект «${label}».`);
  return value;
}

export function field(value, label, max = 8_000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`Некорректное поле «${label}».`);
  }
  return value.trim();
}

function collection(value, label, max, min = 0) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`Некорректный список «${label}».`);
  return value;
}

export function relativeArtifactPath(value) {
  const path = field(value, 'путь к файлу', 1000);
  const segments = path.split('/');
  if (path !== value || posix.isAbsolute(path) || win32.isAbsolute(path) || /[\\:\x00-\x1f\x7f]/.test(path)
    || segments.some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    throw new Error(`Недопустимый относительный путь «${path}».`);
  }
  return path;
}

export function publishableArtifactPath(value) {
  const path = relativeArtifactPath(value);
  if (path.length > 480 || !textExtensions.has(posix.extname(path).toLowerCase())
    || path.split('/').some((part) => part.startsWith('.') || part.trim() !== part)) {
    throw new Error(`Нужен путь к текстовому артефакту в обычной папке проекта. Получено «${path}».`);
  }
  return path;
}

function key(value) {
  if (typeof value !== 'string' || !keyPattern.test(value)) throw new Error('Некорректный ключ в плане.');
  return value;
}

function unique(values, label) {
  if (new Set(values).size !== values.length) throw new Error(`Повторы в списке «${label}».`);
}

export function parseResponse(result) {
  const response = field(result?.text, 'ответ рантайма', 1_000_000);
  const json = response.match(/^```(?:json)?\s*\n([\s\S]+?)\n```$/i)?.[1] ?? response;
  try {
    return object(JSON.parse(json), 'ответ рантайма');
  } catch {
    throw new Error('Рантайм вернул некорректный JSON.');
  }
}

export function validatePlan(input, existingAgents) {
  const agents = collection(input.agents, 'роли', 20).map((entry) => {
    const agent = object(entry, 'роль');
    const role = field(agent.role, 'роль', 64);
    if (!roles.includes(role)) throw new Error(`Неизвестная роль «${role}».`);
    return {
      key: key(agent.key), role,
      name: agent.name === undefined || agent.name === '' ? '' : field(agent.name, 'имя', 120),
      description: field(agent.description, 'обязанности'),
    };
  });
  unique(agents.map((agent) => agent.key), 'роли');
  const agentKeys = new Set([...existingAgents.map((agent) => agent.key ?? agent.id), ...agents.map((agent) => agent.key)]);
  const tasks = collection(input.tasks, 'задачи', 40, 1).map((entry) => {
    const task = object(entry, 'задача');
    const { agentKey, reviewerKey } = task;
    if (!agentKeys.has(agentKey) || !agentKeys.has(reviewerKey) || agentKey === reviewerKey) {
      throw new Error('Задаче нужны исполнитель и отдельный проверяющий из команды.');
    }
    const dependsOn = collection(task.dependsOn ?? [], 'зависимости', 39).map(key);
    unique(dependsOn, 'зависимости');
    if (task.requiresAcceptance !== undefined && typeof task.requiresAcceptance !== 'boolean') throw new Error('Некорректная настройка приёмки.');
    return {
      key: key(task.key),
      title: field(task.title, 'название задачи', 200), prompt: field(task.prompt, 'описание задачи'),
      criteria: field(task.criteria, 'критерии приёмки'), agentKey, reviewerKey, dependsOn,
      ...(task.requiresAcceptance ? { requiresAcceptance: true } : {}),
      ...(task.artifactPath != null ? { artifactPath: publishableArtifactPath(task.artifactPath) } : {}),
    };
  });
  unique(tasks.map((task) => task.key), 'задачи');
  const graph = new Map(tasks.map((task) => [task.key, task.dependsOn]));
  const checked = new Set();
  const checking = new Set();
  function visit(taskKey) {
    if (!graph.has(taskKey) || checking.has(taskKey)) throw new Error('Некорректный граф зависимостей задач.');
    if (checked.has(taskKey)) return;
    checking.add(taskKey);
    for (const dependency of graph.get(taskKey)) visit(dependency);
    checking.delete(taskKey);
    checked.add(taskKey);
  }
  for (const task of tasks) visit(task.key);
  const files = collection(input.files ?? [], 'стартовые файлы', 10).map((entry) => {
    const file = object(entry, 'файл');
    if (typeof file.content !== 'string' || file.content.length > 200_000) throw new Error('Некорректное содержимое стартового файла.');
    return { path: publishableArtifactPath(file.path), content: file.content };
  });
  unique([...files.map((file) => file.path), ...tasks.map((task) => task.artifactPath).filter(Boolean)].map((path) => path.normalize('NFC').toLowerCase()), 'пути артефактов');
  const epic = object(input.epic, 'эпик');
  const story = object(input.story, 'история');
  return {
    title: field(input.title, 'название спринта', 200),
    goal: field(input.goal, 'цель'),
    epic: { title: field(epic.title, 'название эпика', 200), description: field(epic.description, 'описание эпика') },
    story: { title: field(story.title, 'название истории', 200), acceptance: field(story.acceptance, 'приёмка истории') },
    agents, tasks, files,
  };
}

export function planPrompt(studio, job, previous) {
  const context = {
    kind: job.kind, language: studio.language, projectLanguage: studio.projectLanguage || studio.language, brief: studio.brief,
    team: studio.agents.map(({ id, key, role, name, description }) => ({ key: key ?? id, role, name, description })),
    feedback: job.feedback, previous,
  };
  return [
    'Propose a studio sprint plan.',
    'Return one JSON object { "title", "goal", "epic": { "title", "description" }, "story": { "title", "acceptance" }, "agents": [{ "key", "name", "role", "description" }], "tasks": [{ "key", "title", "prompt", "criteria", "agentKey", "reviewerKey", "dependsOn": [], "artifactPath" }], "files": [{ "path", "content" }] }.',
    'Use the requested language for human-readable fields. Keys use ASCII letters, digits, underscores or hyphens. Roles: library, engineer, editor, artist, other. Agent names are optional. Use two distinct agent keys for each task. Reuse roles from team when appropriate. List intra-sprint task keys in dependsOn.',
    'Use unused relative project paths for new text artifacts. Allowed extensions are .md, .txt, .json, .csv, .rst, .yaml, .yml, .toml. Only provide artifactPath for a task that should publish a file. Starter files are optional and use projectLanguage. Leave project files unchanged.',
    JSON.stringify(context, null, 2),
  ].join('\n\n');
}

export function reviewPrompt(studio, task) {
  return [
    'Review the studio task artifact.',
    'Assess the result against the acceptance criteria. Return one JSON object {"pass": true or false, "summary": "reason in the requested language"}. Leave project files unchanged.',
    JSON.stringify({
      language: studio.language, title: task.title, criteria: task.criteria, artifact: task.artifact,
      artifactPath: task.artifactPath, previousArtifactPath: task.previousArtifactPath, previousReview: task.review,
    }, null, 2),
  ].join('\n\n');
}

export function directorPrompt(studio, task, ready) {
  return [
    'Decide the studio’s next step.',
    'Return one JSON object {"action": "next" | "nextSprint" | "finish", "taskKey": "key for next", "summary": "decision in the requested language"}. Select next from ready if there is available work. Leave project files unchanged.',
    JSON.stringify({ language: studio.language, brief: studio.brief, task: task.title, result: task.summary, review: task.review, ready }, null, 2),
  ].join('\n\n');
}
