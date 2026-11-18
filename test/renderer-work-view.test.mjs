import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWork } from '../renderer/work-view.mjs';

test('board shows every workflow stage and keeps attempt status separate', () => {
  const html = renderWork({ tab: 'board', tasks: [
    { id: 'reviewed', title: 'Эскиз карты', stage: 'review', status: 'completed' },
    { id: 'legacy', title: 'Старая задача', status: 'completed' },
  ] });

  const stages = [...html.matchAll(/data-stage="([a-z_]+)"/g)].map(match => match[1]);
  assert.deepEqual(stages, ['backlog', 'ready', 'in_progress', 'review', 'qa', 'done', 'blocked']);
  assert.match(html, /data-stage="review"[^]*?data-task="reviewed"[^]*?Попытка[^]*?Завершена/);
  assert.match(html, /data-stage="done"[^]*?data-task="legacy"/);
});

test('epics include linked stories, acceptance criteria, tasks and dependencies', () => {
  const html = renderWork({
    tab: 'epics',
    epics: [{ id: 'epic', title: 'Подготовить мир' }],
    stories: [{ id: 'story', epicId: 'epic', title: 'Создать карту', acceptance: ['Есть легенда'] }],
    tasks: [
      { id: 'map', title: 'Эскиз карты', storyId: 'story', dependencies: ['palette'] },
      { id: 'palette', title: 'Цветовая схема', stage: 'done' },
    ],
  });
  assert.match(html, /Подготовить мир[^]*?Создать карту[^]*?Есть легенда[^]*?data-task="map"/);
  assert.match(html, /Зависимости[^]*?data-task="palette"[^]*?Цветовая схема/);
});

test('sprints join plans and tasks, and show pending plans before a sprint is created', () => {
  const html = renderWork({
    tab: 'sprints',
    sprints: [{
      id: 'sprint', title: 'Первый спринт', goal: 'Карта мира', planId: 'approved',
      status: 'active', taskIds: ['one', 'two'],
    }],
    plans: [
      { id: 'approved', kind: 'initial', status: 'approved', title: 'Первый план' },
      { id: 'pending', kind: 'sprint', status: 'pending', title: 'Готовим продолжение' },
    ],
    tasks: [
      { id: 'one', sprintId: 'sprint', stage: 'done', title: 'Легенда', artifactPath: 'map.md' },
      { id: 'two', stage: 'review', status: 'completed', title: 'Макет' },
    ],
  });
  assert.match(html, /Готовим продолжение[^]*?Ждёт согласования[^]*?data-plan="pending"/);
  assert.match(html, /Первый спринт[^]*?Карта мира[^]*?1 из 2[^]*?data-task="one"[^]*?map\.md/);
  assert.equal([...html.matchAll(/data-plan="approved"/g)].length, 1);
});

test('meeting outcomes and user-provided text are escaped in content and attributes', () => {
  const html = renderWork({
    tab: 'meetings',
    meetings: [{
      title: '<script>alert(1)</script>',
      kind: 'retrospective',
      summary: 'Ок & <img onerror="alert(2)">',
      taskIds: ['" autofocus'],
    }],
    tasks: [{ id: '" autofocus', title: "'Проверка'" }],
  });
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /Ок &amp; &lt;img onerror=&quot;alert\(2\)&quot;&gt;/);
  assert.match(html, /data-task="&quot; autofocus"[^]*?&#39;Проверка&#39;/);
  assert.doesNotMatch(html, /<(?:script|img)\b|data-task="" autofocus/);
});
