import {copy, onCopyLocale , getCopyLocale} from './copy.mjs';
const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const safe = value => String(value ?? '').replace(/[&<>"']/g, character => entities[character]);
let number = new Intl.NumberFormat(getCopyLocale());
onCopyLocale(()=>{ number=new Intl.NumberFormat(getCopyLocale()); });

const makeCoachTitle = () => (copy('Коуч агентов'));
export let coachTitle = makeCoachTitle();
onCopyLocale(() => { coachTitle = makeCoachTitle(); });
export const skillMinStars = studio => studio?.skillMinStars ?? 10_000;
export const skillStarLabel = studio => number.format(skillMinStars(studio));
export const parseSkillTopics = value => [...new Set(value.split(',').map(topic => topic.trim()).filter(Boolean))];
const agentName = agent => agent?.systemRole === 'coach' ? coachTitle : agent?.name || agent?.roleTitle || copy('Агент');
const taskLink = task => `<button type="button" class="text-button training-link" data-task="${safe(task.id)}">${safe(task.title || copy('Открыть задачу'))}</button>`;
const makeStageLabels = () => ({ review: copy('Ждёт ревью обучения'), qa: copy('Проходит проверку'), in_progress: copy('Проходит обучение'), blocked: copy('Обучение заблокировано') });
let stageLabels = makeStageLabels();
onCopyLocale(() => { stageLabels = makeStageLabels(); });

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
  const label = pending ? (Object.hasOwn(stageLabels, training?.stage) ? stageLabels[training.stage] : copy('Ждёт обучения')) : copy('Готов к работе');
  return `<span class="training-readiness" data-training-status="${pending ? 'pending' : 'ready'}">${label}</span>${showTask && training ? taskLink(training) : ''}`;
}

function renderDependencies(dependencies, compact) {
  if (!dependencies.length) return '';
  const waitsForTraining = dependencies.some(dependency => dependency.kind === 'train');
  const reason = waitsForTraining
    ? (compact ? copy('Ждёт обучения') : copy('Запуск ждёт завершения обучения'))
    : (compact ? copy('Ждёт зависимостей') : copy('Запуск ждёт завершения связанных задач'));
  return `<div class="training-dependencies"><strong>${reason}</strong><ul>${dependencies.map(task =>
    `<li data-task-dependency="${safe(task.id)}">${task.missing ? copy('Задача недоступна') : taskLink(task)}</li>`).join('')}</ul></div>`;
}

export function renderBoardTraining(task, agents, byTask) {
  return (task.kind === 'train' ? copy`<p class="training-trainee"><strong>Обучение</strong> · ${safe(trainingTrainee(task, agents))}</p>` : '') +
    renderDependencies(pendingDependencies(task, byTask), true);
}

export function renderTrainingDetails(task, studio, tasks) {
  const dependencies = pendingDependencies(task, new Map(tasks.map(item => [item.id, item])));
  const training = task.training;
  const topics = training?.topics?.length ? copy`<p>Темы · ${safe(training.topics.join(', '))}</p>` : '';
  const warningList = [...(training?.warnings ?? []), ...(training?.materialWarnings ?? [])];
  const warnings = warningList.length ? `<ul class="skill-warnings">${warningList.map(warning => `<li>${safe(warning)}</li>`).join('')}</ul>` : '';
  const projectGuide = training?.searchOutcome === 'no-match' ? copy('<p>Подходящих навыков на GitHub не найдено. Коуч подготовил руководство под задачу.</p>') : '';
  const guide = training?.guide ? copy`<details class="advanced"><summary>Руководство</summary><p class="long-text">${safe(training.guide)}</p></details>` : '';
  const exercise = training?.exercise ? copy`<details class="advanced"><summary>Упражнение</summary><p class="long-text">${safe(training.exercise)}</p></details>` : '';
  const visibleMaterials = (training?.materials ?? []).filter(material => training.selectedMaterialIds?.includes(material.id));
  const proposedSkills = task.stage === 'done' ? [] : (training?.customSkills ?? []);
  const dossier = training?.knowledge || visibleMaterials.length || proposedSkills.length ? copy`<details class="advanced">
    <summary>Пакет знаний${task.stage === 'done' ? '' : task.stage === 'review' ? copy(' · На утверждении') : copy(' · Черновик')}</summary>
    <div class="stack compact">
      ${training.knowledge ? `<p class="long-text">${safe(training.knowledge)}</p>` : ''}
      ${visibleMaterials.length ? `<ul class="skill-candidates">${visibleMaterials.map(knowledgeSource).join('')}</ul>` : ''}
      ${proposedSkills.map(skill => `<div class="inline-result"><strong>${safe(skill.title || skill.key)}</strong>
        <p class="long-text">${safe(skill.content)}</p></div>`).join('')}
    </div></details>` : '';
  return (task.kind === 'train' ? copy`<section class="inline-result" data-task-kind="train"><h3>Обучение</h3>
    <p>Обучается · ${safe(trainingTrainee(task, new Map((studio?.agents ?? []).map(agent => [agent.id, agent]))))}</p>
    ${training?.objective ? `<p>${safe(training.objective)}</p>` : ''}${topics}${warnings}${projectGuide}${guide}${exercise}${dossier}</section>` : '') +
    renderDependencies(dependencies, false);
}

function skillSource(skill) {
  return copy`<dl class="skill-source studio-meta">
    <dt>Репозиторий GitHub</dt><dd>${safe(skill.repo)}</dd>
    <dt>Файл</dt><dd><code>${safe(skill.path)}</code></dd>
    <dt>Коммит</dt><dd><code>${safe(skill.commit)}</code></dd>
    <dt>Лицензия</dt><dd>${safe(skill.license || copy('Не указана'))}</dd>
    ${Number.isFinite(skill.stars) ? copy`<dt>Звёзды</dt><dd>${number.format(skill.stars)}</dd>` : ''}
  </dl>`;
}

function knowledgeSource({ title, source, url, revision, license, excerpt }) {
  return copy`<li class="stack compact"><strong>${safe(title || source)}</strong>
    <dl class="skill-source studio-meta">
      ${source ? copy`<dt>Источник</dt><dd>${safe(source)}</dd>` : ''}
      ${url ? copy`<dt>Адрес</dt><dd><code>${safe(url)}</code></dd>` : ''}
      ${revision ? copy`<dt>Ревизия</dt><dd><code>${safe(revision)}</code></dd>` : ''}
      <dt>Лицензия</dt><dd>${safe(license || copy('Не указана'))}</dd>
    </dl>
    ${excerpt ? copy`<details class="advanced"><summary>Выдержка</summary><p class="long-text">${safe(excerpt)}</p></details>` : ''}
  </li>`;
}

function roleKnowledge({ studio, tasks, knowledge, customSkills, knowledgeEvents }) {
  const trainingTasks = new Map(tasks.filter(task => task.kind === 'train').map(task => [task.id, task]));
  const knowledgeByAgent = Map.groupBy(knowledge, entry => entry.agentId);
  const skillsByAgent = Map.groupBy(customSkills, entry => entry.agentId);
  const layers = { reference: copy('Общая справка'), decision: copy('Решение студии'), memory: copy('Рабочая память'), role: copy('База роли') };
  const scope = ({ agentId, layer, key }, kind) => JSON.stringify([kind, agentId ?? null, layer ?? 'role', key ?? 'role-notes']);
  const current = (record, entries, kind) => {
    const key = scope(record, kind);
    const change = knowledgeEvents.findLast(event => scope(event, event.kind) === key);
    if (change) return change.versionId === record.id;
    return entries.filter(entry => scope(entry, kind) === key).toSorted((a, b) => (b.version ?? 1) - (a.version ?? 1))[0]?.id === record.id;
  };
  const provenance = ({ trainingTaskId, createdAt }) => {
    const task = trainingTasks.get(trainingTaskId);
    const date = new Date(createdAt);
    const time = Number.isFinite(date.getTime()) ? `<time datetime="${date.toISOString()}">${date.toLocaleDateString(getCopyLocale())}</time>` : '';
    return task || time ? `<p class="knowledge-provenance muted">${task ? taskLink(task) : ''}${time}</p>` : '';
  };
  const agents = (studio?.agents ?? []).filter(agent => knowledgeByAgent.has(agent.id) || skillsByAgent.has(agent.id));
  const shared = (knowledgeByAgent.get(null) ?? []).filter(note => current(note, knowledge, 'knowledge'));
  return copy`<section class="stack compact"><h2>База знаний по ролям</h2>
    ${shared.length ? copy`<article class="panel padded stack compact"><h3>Общие записи студии</h3>${shared.map(note =>
      copy`<details class="advanced" data-library-detail="shared-${safe(note.id)}"><summary>${safe(layers[note.layer] ?? copy('Запись'))} · ${safe(note.key)} · Версия ${safe(note.version)}</summary>
        ${provenance(note)}<p class="long-text">${safe(note.notes)}</p>${note.sources?.length ? `<ul class="skill-candidates">${note.sources.map(knowledgeSource).join('')}</ul>` : ''}</details>`).join('')}</article>` : ''}
    ${agents.length ? agents.map(agent => {
      const notes = knowledgeByAgent.get(agent.id) ?? [];
      const skills = Map.groupBy(skillsByAgent.get(agent.id) ?? [], skill => skill.key);
      return `<article class="panel padded stack" data-knowledge-role="${safe(agent.id)}">
        <h3>${safe(agentName(agent))}${agent.roleTitle && agent.roleTitle !== agentName(agent)
          ? ` <small class="muted">· ${safe(agent.roleTitle)}</small>` : ''}</h3>
        ${notes.length ? copy`<section class="stack compact"><h4>Утверждённые заметки</h4>
          ${notes.toReversed().map(note => copy`<div class="inline-result stack compact">${provenance(note)}
            <details class="advanced" data-library-detail="note-${safe(note.id)}"><summary>Читать заметку · ${safe(layers[note.layer] ?? copy('База роли'))}${note.version ? copy` · Версия ${safe(note.version)}` : ''}${current(note, notes, 'knowledge') ? copy(' · текущая') : ''}</summary><p class="long-text">${safe(note.notes)}</p>
              ${note.sources?.length ? `<ul class="skill-candidates">${note.sources.map(knowledgeSource).join('')}</ul>` : ''}
            </details></div>`).join('')}
        </section>` : ''}
        ${skills.size ? copy`<section class="stack compact"><h4>Собственные навыки</h4>
          ${[...skills.values()].map(versions => {
            const ordered = versions.toSorted((first, second) => second.version - first.version);
            return `<div class="inline-result stack compact"><strong>${safe(ordered[0].title || ordered[0].key)}</strong>
              ${ordered.map(skill => copy`<details class="advanced" data-library-detail="skill-${safe(skill.id)}">
                <summary>Версия ${safe(skill.version)}${current(skill, ordered, 'customSkill') ? copy(' · текущая') : ''}</summary>
                ${provenance(skill)}<p class="long-text">${safe(skill.content)}</p>
              </details>`).join('')}</div>`;
          }).join('')}
        </section>` : ''}
      </article>`;
    }).join('') : copy('<p class="panel padded muted">Заметки и собственные навыки появятся после утверждения обучения директором.</p>')}
  </section>`;
}

export function renderSkillPreview(preview) {
  if (preview.status === 'pending') return copy('<p>Ищем навыки на GitHub…</p>');
  if (preview.status === 'error') return `<p class="error" role="alert">${safe(preview.error)}</p>`;
  if (preview.status !== 'done') return '';
  const candidates = preview.candidates ?? [];
  const warnings = preview.warnings ?? [];
  const result = candidates.length ? copy`Найдено кандидатов: ${candidates.length}` : warnings.length
    ? copy('Поиск выполнен частично. В доступных репозиториях навыки не найдены.') : copy('Подходящих навыков не найдено. Попробуйте другие темы.');
  return `<p>${result}</p>
    ${warnings.length ? `<ul class="skill-warnings">${warnings.map(warning => `<li>${safe(warning)}</li>`).join('')}</ul>` : ''}
    ${candidates.length ? `<ul class="skill-candidates">${candidates.map(candidate => `<li><strong>${safe(candidate.title || candidate.path)}</strong>${skillSource(candidate)}</li>`).join('')}</ul>` : ''}`;
}

export function renderSkillLibrary({ studio, skills = [], tasks = [], knowledge = [], customSkills = [], knowledgeEvents = [], topics = '', preview = {} } = {}) {
  const busy = preview.status === 'pending';
  return copy`<div class="stack skill-library">
    ${roleKnowledge({ studio, tasks, knowledge, customSkills, knowledgeEvents })}
    <section class="stack compact"><h2>Утверждённые навыки</h2>
      ${skills.length ? skills.map(skill => copy`<details class="panel padded work-fold" data-skill-id="${safe(skill.id)}" data-library-detail="imported-${safe(skill.id)}">
        <summary><strong>${safe(skill.title || skill.path)}</strong></summary>${skillSource(skill)}
        <p>Роли · ${safe((studio?.agents ?? []).filter(agent => agent.skillIds?.includes(skill.id)).map(agentName).join(', ') || copy('Пока нет'))}</p>
      </details>`).join('') : copy('<p class="panel padded muted">Утверждённых навыков пока нет. Они появляются после ревью обучения.</p>')}
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
