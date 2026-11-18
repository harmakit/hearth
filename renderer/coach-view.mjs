const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const safe = value => String(value ?? '').replace(/[&<>"']/g, character => entities[character]);
const number = new Intl.NumberFormat('ru-RU');

export const coachTitle = 'Коуч агентов';
export const skillMinStars = studio => studio?.skillMinStars ?? 10_000;
export const skillStarLabel = studio => number.format(skillMinStars(studio));
export const parseSkillTopics = value => [...new Set(value.split(',').map(topic => topic.trim()).filter(Boolean))];
const agentName = agent => agent?.systemRole === 'coach' ? coachTitle : agent?.name || agent?.roleTitle || 'Агент';
const taskLink = task => `<button type="button" class="text-button training-link" data-task="${safe(task.id)}">${safe(task.title || 'Открыть задачу')}</button>`;
const stageLabels = { review: 'Ждёт ревью обучения', qa: 'Проходит проверку', in_progress: 'Проходит обучение', blocked: 'Обучение заблокировано' };

export function pendingDependencies(task, byTask) {
  return (task.dependencies ?? []).map(id => byTask.get(id) ?? { id, missing: true })
    .filter(dependency => dependency.stage !== 'done');
}

export function trainingTrainee(task, agents) {
  return agentName(agents.get(task.training?.targetAgentId));
}

export function roleReadiness(agent, tasks, { showTask = true } = {}) {
  if (agent.id == null) return '';
  const training = tasks.find(task => task.id === agent.trainingTaskId && task.stage !== 'done') ??
    tasks.findLast(task => task.kind === 'train' && task.training?.targetAgentId === agent.id && task.stage !== 'done');
  const pending = agent.trainingStatus === 'pending' || training;
  const label = pending ? (Object.hasOwn(stageLabels, training?.stage) ? stageLabels[training.stage] : 'Ждёт обучения') : 'Готов к работе';
  return `<span class="training-readiness" data-training-status="${pending ? 'pending' : 'ready'}">${label}</span>${showTask && training ? taskLink(training) : ''}`;
}

function renderDependencies(dependencies, compact) {
  if (!dependencies.length) return '';
  const waitsForTraining = dependencies.some(dependency => dependency.kind === 'train');
  const reason = waitsForTraining
    ? (compact ? 'Ждёт обучения' : 'Запуск ждёт завершения обучения')
    : (compact ? 'Ждёт зависимостей' : 'Запуск ждёт завершения связанных задач');
  return `<div class="training-dependencies"><strong>${reason}</strong><ul>${dependencies.map(task =>
    `<li data-task-dependency="${safe(task.id)}">${task.missing ? 'Задача недоступна' : taskLink(task)}</li>`).join('')}</ul></div>`;
}

export function renderBoardTraining(task, agents, byTask) {
  return (task.kind === 'train' ? `<p class="training-trainee"><strong>Обучение</strong> · ${safe(trainingTrainee(task, agents))}</p>` : '') +
    renderDependencies(pendingDependencies(task, byTask), true);
}

export function renderTrainingDetails(task, studio, tasks) {
  const dependencies = pendingDependencies(task, new Map(tasks.map(item => [item.id, item])));
  const training = task.training;
  const topics = training?.topics?.length ? `<p>Темы · ${safe(training.topics.join(', '))}</p>` : '';
  const warnings = training?.warnings?.length ? `<ul class="skill-warnings">${training.warnings.map(warning => `<li>${safe(warning)}</li>`).join('')}</ul>` : '';
  const projectGuide = training?.searchOutcome === 'no-match' ? '<p>Подходящих навыков на GitHub не найдено. Коуч подготовил руководство под задачу.</p>' : '';
  const guide = training?.guide ? `<details class="advanced"><summary>Руководство</summary><p class="long-text">${safe(training.guide)}</p></details>` : '';
  const exercise = training?.exercise ? `<details class="advanced"><summary>Упражнение</summary><p class="long-text">${safe(training.exercise)}</p></details>` : '';
  return (task.kind === 'train' ? `<section class="inline-result" data-task-kind="train"><h3>Обучение</h3>
    <p>Обучается · ${safe(trainingTrainee(task, new Map((studio?.agents ?? []).map(agent => [agent.id, agent]))))}</p>
    ${training?.objective ? `<p>${safe(training.objective)}</p>` : ''}${topics}${warnings}${projectGuide}${guide}${exercise}</section>` : '') +
    renderDependencies(dependencies, false);
}

function skillSource(skill) {
  return `<dl class="skill-source studio-meta">
    <dt>Репозиторий GitHub</dt><dd>${safe(skill.repo)}</dd>
    <dt>Файл</dt><dd><code>${safe(skill.path)}</code></dd>
    <dt>Коммит</dt><dd><code>${safe(skill.commit)}</code></dd>
    <dt>Лицензия</dt><dd>${safe(skill.license || 'Не указана')}</dd>
    ${Number.isFinite(skill.stars) ? `<dt>Звёзды</dt><dd>${number.format(skill.stars)}</dd>` : ''}
  </dl>`;
}

export function renderSkillPreview(preview) {
  if (preview.status === 'pending') return '<p>Ищем навыки на GitHub…</p>';
  if (preview.status === 'error') return `<p class="error" role="alert">${safe(preview.error)}</p>`;
  if (preview.status !== 'done') return '';
  const candidates = preview.candidates ?? [];
  const warnings = preview.warnings ?? [];
  const result = candidates.length ? `Найдено кандидатов: ${candidates.length}` : warnings.length
    ? 'Поиск выполнен частично. В доступных репозиториях навыки не найдены.' : 'Подходящих навыков не найдено. Попробуйте другие темы.';
  return `<p>${result}</p>
    ${warnings.length ? `<ul class="skill-warnings">${warnings.map(warning => `<li>${safe(warning)}</li>`).join('')}</ul>` : ''}
    ${candidates.length ? `<ul class="skill-candidates">${candidates.map(candidate => `<li><strong>${safe(candidate.title || candidate.path)}</strong>${skillSource(candidate)}</li>`).join('')}</ul>` : ''}`;
}

export function renderSkillLibrary({ studio, skills = [], topics = '', preview = {} } = {}) {
  const busy = preview.status === 'pending';
  return `<div class="stack skill-library">
    <section class="stack compact"><h2>Утверждённые навыки</h2>
      ${skills.length ? skills.map(skill => `<article class="panel padded stack compact" data-skill-id="${safe(skill.id)}">
        <h3>${safe(skill.title || skill.path)}</h3>${skillSource(skill)}
        <p>Роли · ${safe((studio?.agents ?? []).filter(agent => agent.skillIds?.includes(skill.id)).map(agentName).join(', ') || 'Пока нет')}</p>
      </article>`).join('') : '<p class="panel padded muted">Утверждённых навыков пока нет. Они появляются после ревью обучения.</p>'}
    </section>
    <section class="panel padded stack compact"><div class="row"><div><h2>Поиск на GitHub</h2>
      <p class="muted">Минимум звёзд · ${skillStarLabel(studio)}</p></div>
      <button type="button" class="action secondary" data-open="skill-settings">Настроить порог</button></div>
      <form class="stack compact" data-skill-search><label class="field"><span>Темы через запятую</span>
        <input name="topics" value="${safe(topics)}" placeholder="Например, documentation, accessibility" required></label>
        <div><button type="submit" class="action" aria-disabled="${busy}">Найти навыки</button></div>
      </form>
      <div class="skill-preview" data-skill-preview aria-live="polite">${renderSkillPreview(preview)}</div>
    </section>
  </div>`;
}
