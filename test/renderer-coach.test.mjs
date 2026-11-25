import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWork } from '../renderer/work-view.mjs';
import { renderSkillLibrary, renderTrainingDetails, roleReadiness } from '../renderer/coach-view.mjs';

const trainee = { id: 'editor', name: 'Редактор <мира>', trainingStatus: 'pending', skillIds: ['skill'] };
const coach = { id: 'coach', name: 'Прежний библиотекарь', role: 'library', systemRole: 'coach', trainingStatus: 'ready' };
const train = { id: 'train-editor', kind: 'train', stage: 'review', status: 'completed', agentId: coach.id,
  title: 'Знакомство с проектом', training: { targetAgentId: trainee.id, objective: 'Освоить карту', topics: ['карты'],
    warnings: ['Ограничение GitHub'], guide: 'Проверить масштаб', exercise: 'Масштаб проверен' } };
const production = { id: 'work', title: 'Составить карту', agentId: trainee.id, dependencies: [train.id], stage: 'backlog' };

test('board shows the coach and a compact training prerequisite until approval', () => {
  const render = training => renderWork({ studio: { agents: [coach, trainee] }, tasks: [production, training] });
  const pending = render(train);
  assert.match(pending, /data-task-kind="train"[^]*?Коуч агентов/);
  assert.match(pending, /Составить карту[^]*?work-wait-mark[^]*?data-task="train-editor"/);
  assert.doesNotMatch(pending,/Ждёт обучения/);
  assert.doesNotMatch(render({ ...train, stage: 'done' }), /work-wait-mark/);
});

test('training details show evidence and dependencies are linked with a clear reason', () => {
  const studio = { agents: [coach, trainee] };
  const all = [production, train];
  assert.match(renderTrainingDetails(train, studio, all), /Обучение[^]*?Редактор &lt;мира&gt;[^]*?Освоить карту[^]*?карты[^]*?Ограничение GitHub/);
  assert.match(renderTrainingDetails(train, studio, all), /Руководство[^]*?Проверить масштаб[^]*?Упражнение[^]*?Масштаб проверен/);
  assert.match(renderTrainingDetails(production, studio, all), /Запуск ждёт завершения обучения[^]*?data-task="train-editor"/);
  assert.match(roleReadiness(trainee, all), /data-training-status="pending"[^]*?Ждёт ревью обучения[^]*?data-task="train-editor"/);
  assert.match(roleReadiness(coach, all), /data-training-status="ready"[^]*?Готов к работе/);
});

test('task details show the proposed knowledge and selected materials before approval', () => {
  const task = { ...train, training: { ...train.training, knowledge: '<b>Заметка</b>', selectedMaterialIds: ['used'],
    materialWarnings: ['Поиск выполнен частично'],
    materials: [{ id: 'used', title: 'Карта', revision: 'rev' }, { id: 'unused', title: 'Лишний кандидат' }],
    customSkills: [{ key: 'map', title: 'Картография', content: '<script>Текст навыка</script>' }],
  } };
  const render = task => renderTrainingDetails(task, { agents: [trainee, coach] }, [task]);
  assert.match(render(task), /Поиск выполнен частично[^]*?На утверждении[^]*?&lt;b&gt;Заметка&lt;\/b&gt;[^]*?Карта[^]*?rev[^]*?Картография[^]*?&lt;script&gt;/);
  assert.doesNotMatch(render(task), /Лишний кандидат|<script>/);
  assert.doesNotMatch(render({ ...task, stage: 'done' }), /На утверждении/);
});

test('library separates approved versions and GitHub metadata and reports the search outcome', () => {
  const skill = { id: 'skill', title: 'Карты', repo: 'world/maps', commit: 'abcdef1234567890',
    path: 'tools/maps/SKILL.md', license: 'MIT', content: 'НЕ ВЫВОДИТЬ' };
  const html = renderSkillLibrary({ studio: { agents: [trainee] }, skills: [skill], preview: {
    status: 'done', candidates: [{ ...skill, repo: 'world/unapproved' }], warnings: ['Часть репозиториев недоступна'],
  } });
  assert.match(html, /10\s000/);
  assert.match(html, /data-skill-id="skill"[^]*?world\/maps[^]*?tools\/maps\/SKILL\.md[^]*?abcdef1234567890[^]*?MIT[^]*?Редактор &lt;мира&gt;/);
  assert.match(html, /data-skill-preview[^]*?Найдено кандидатов: 1[^]*?Часть репозиториев недоступна[^]*?world\/unapproved/);
  assert.equal((html.match(/data-skill-id=/g) ?? []).length, 1);
  assert.doesNotMatch(html, /НЕ ВЫВОДИТЬ/);
  assert.match(renderSkillLibrary({ studio: { skillMinStars: 42 }, preview: { status: 'done', candidates: [] } }), /42[^]*?Подходящих навыков не найдено/);
  assert.match(renderSkillLibrary({ preview: { status: 'done', candidates: [], warnings: ['Ошибка API'] } }), /Поиск выполнен частично[^]*?Ошибка API/);
  assert.match(renderSkillLibrary({ preview: { status: 'error', error: 'Ошибка API' } }), /role="alert"[^]*?Ошибка API/);
});

test('library groups approved notes and original skill versions by role with source metadata and provenance', () => {
  const html = renderSkillLibrary({
    studio: { id: 's', agents: [trainee, coach] }, tasks: [train],
    knowledge: [{ id: 'note', agentId: trainee.id, trainingTaskId: train.id, notes: '<b>Проверить масштаб</b>',
      sources: [{ title: 'Карты', source: 'Open Maps', url: 'https://example.com/maps', revision: 'rev-1',
        license: 'CC BY', excerpt: '<img src=x>' }] }],
    customSkills: [
      { id: 'v1', agentId: trainee.id, key: 'map', title: 'Картография', version: 1, content: 'Первая версия' },
      { id: 'v2', agentId: trainee.id, key: 'map', title: 'Картография', version: 2, content: 'Вторая версия' },
      { id: 'hidden', agentId: 'other', key: 'map', title: 'Чужая студия', version: 1, content: 'Не виден' },
    ],
  });
  assert.match(html, /Редактор &lt;мира&gt;[^]*?data-task="train-editor"[^]*?<details[^]*?&lt;b&gt;Проверить масштаб&lt;\/b&gt;/);
  assert.match(html, /Open Maps[^]*?https:\/\/example\.com\/maps[^]*?rev-1[^]*?CC BY[^]*?&lt;img src=x&gt;/);
  assert.match(html, /Картография[^]*?Версия 2[^]*?Вторая версия[^]*?Версия 1[^]*?Первая версия/);
  assert.doesNotMatch(html, /<img|Прежний библиотекарь|Не виден/);
});

test('registered update shows a pinned version, candidate and distinct owner actions',()=>{
  const pinned={id:'skill',repo:'world/maps',path:'SKILL.md',title:'Maps',commit:'a'.repeat(40),license:'MIT'};
  const historical={...pinned,id:'prior',commit:'b'.repeat(40)};
  const candidate={...pinned,commit:'c'.repeat(40),content:'New <unsafe> instructions'};
  const render=status=>renderSkillLibrary({studio:{agents:[trainee]},skills:[pinned,historical],
    skillChecks:[{id:pinned.id,status,candidate}]});
  const available=render('available');
  assert.match(available,/Доступно обновление[^]*?a{40}[^]*?Доступная версия[^]*?c{40}/);
  assert.match(available,/New &lt;unsafe&gt; instructions/);
  assert.match(available,/data-skill-apply="skill"[^]*?data-skill-decline="skill"/);
  assert.match(available,/История версий[^]*?data-skill-id="prior"/);
  assert.doesNotMatch(render('approved'),/data-skill-apply/);
  assert.match(render('approved'),/Активные продолжают со старой/);
});
