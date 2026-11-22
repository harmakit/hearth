import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWork } from '../renderer/work-view.mjs';

test('board hides empty lanes by default and can show all seven stages', () => {
  const html = renderWork({ tab: 'board', tasks: [
    { id: 'reviewed', title: 'Эскиз карты', stage: 'review', status: 'completed' },
    { id: 'legacy', title: 'Старая задача', status: 'completed' },
  ] });

  const stages = [...html.matchAll(/data-stage="([a-z_]+)"/g)].map(match => match[1]);
  assert.deepEqual(stages, ['review', 'done']);
  assert.match(html, /data-stage="review"[^]*?data-task="reviewed"/);
  assert.doesNotMatch(html,/Попытка/);
  assert.match(html, /data-stage="done"[^]*?data-task="legacy"/);
  const all=renderWork({tab:'board',tasks:[{id:'x',stage:'ready'}],boardShowEmpty:true});
  assert.equal([...all.matchAll(/data-stage="/g)].length,7);
});

test('epics show typed stories and compact task rows without repeating task criteria', () => {
  const html = renderWork({
    tab: 'epics',
    epics: [{ id: 'epic', title: 'Подготовить мир' }],
    stories: [{ id: 'story', epicId: 'epic', title: 'Создать карту', acceptance: ['Есть легенда'] }],
    tasks: [
      { id: 'map', title: 'Эскиз карты', storyId: 'story', criteria:'Секрет критерия задачи',dependencies: ['palette'] },
      { id: 'palette', title: 'Цветовая схема', stage: 'blocked' },
    ],
  });
  assert.match(html, /Подготовить мир[^]*?История[^]*?Создать карту[^]*?data-task="map"/);
  assert.match(html, /data-owner-story="story"/);
  assert.doesNotMatch(html,/Секрет критерия задачи|Есть легенда/);
  assert.match(html, /data-task="palette"[^]*?Цветовая схема/);
});

test('epics start collapsed and open the requested section with a compact summary', () => {
  const input = {
    tab: 'epics',
    epics: [{ id: 'world', title: 'Мир' }, { id: 'other', title: 'Другое' }],
    stories: [{ id: 'map', epicId: 'world' }],
    tasks: [{ id: 'one', storyId: 'map' }, { id: 'two', epicId: 'world' }],
  };

  const collapsed = renderWork(input);
  assert.match(collapsed, /<details[^>]+data-epic-section="world">\s*<summary>[^]*?Мир[^]*?Историй: 1[^]*?Задач: 2[^]*?<\/summary>/);
  assert.equal((collapsed.match(/name="studio-epics"/g) ?? []).length, 2);
  assert.doesNotMatch(collapsed, /<details[^>]+\sopen(?:\s|>)/);

  const expanded = renderWork({ ...input, expandedEpics: new Set(['world']) });
  assert.match(expanded, /<details[^>]+data-epic-section="world" open>/);
  assert.match(expanded, /<details[^>]+data-epic-section="other">/);
});

test('artifacts link to task files, inline reports and published plan files', () => {
  const html = renderWork({
    tab: 'artifacts',
    tasks: [
      { id: 'file', title: 'Карта', artifactPath: 'maps/<world>.md' },
      { id: 'inline', title: 'Сводка', summary: 'Результат', artifact: { done: true } },
      { id: 'unpublished', title: 'В работе', artifactTarget: 'not-yet.md' },
    ],
    plans: [{
      id: 'plan', title: 'Спринт', files: [{ path: 'draft.md' }],
      publishedFiles: ['rules.md', { path: 'notes/"pilot".md' }, null, { path: 'rules.md' }],
    }],
  });

  assert.match(html, /data-work-tab="artifacts" aria-pressed="true">Артефакты/);
  assert.match(html, /data-artifact="file">maps\/&lt;world&gt;\.md<\/button>/);
  assert.match(html, /data-task="inline"[^>]*>[^]*?Сводка/);
  assert.match(html, /data-plan-file="rules\.md" data-plan-id="plan"/);
  assert.match(html, /data-plan-file="notes\/&quot;pilot&quot;\.md" data-plan-id="plan"/);
  assert.equal([...html.matchAll(/data-plan-file="rules\.md"/g)].length, 1);
  assert.doesNotMatch(html, /not-yet\.md|draft\.md|data-task="unpublished"/);
});

test('artifacts show an empty state before results are published', () => {
  assert.match(renderWork({ tab: 'artifacts' }), /Артефактов пока нет/);
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
