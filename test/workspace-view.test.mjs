import assert from 'node:assert/strict';
import test from 'node:test';
import { renderWorkspaceHome } from '../renderer/workspace-view.mjs';

test('the empty workspace offers a single way to create the first studio', () => {
  const html = renderWorkspaceHome({ studios: [], tasks: [], inbox: [] });

  assert.match(html, /<h1>Все студии<\/h1>/);
  assert.match(html, /Студий пока нет/);
  assert.equal(Array.from(html.matchAll(/data-open="studio"/g)).length, 1);
  assert.doesNotMatch(html, /data-enter-studio|data-workspace-inbox/);
});

test('the workspace counts running tasks and open inbox items for each studio', () => {
  const html = renderWorkspaceHome({
    studios: [{ id: 1, name: 'Первая' }, { id: '2', name: 'Вторая' }],
    tasks: [
      { studioId: '1', status: 'running' },
      { studioId: '1', status: 'queued' },
      { studioId: 2, status: 'running' },
      { studioId: 3, status: 'running' },
    ],
    inbox: [
      { studioId: 1, kind: 'question', status: 'open' },
      { studioId: 1, kind: 'acceptance', status: 'open' },
      { studioId: 1, kind: 'question', status: 'resolved' },
      { studioId: 2, kind: 'question', status: 'resolved' },
      { studioId: 3, kind: 'question', status: 'open' },
    ],
  });

  const [summary, first, second] = html.split(/<article\b[^>]*>/);
  assert.match(summary, /<dt>Студии<\/dt>\s*<dd>2<\/dd>/);
  assert.match(summary, /<dt>Задачи в работе<\/dt>\s*<dd>2<\/dd>/);
  assert.match(summary, /<dt>Открытые входящие<\/dt>\s*<dd>2<\/dd>/);
  assert.match(first, /data-enter-studio="1"/);
  assert.match(first, /<dt>Задачи в работе<\/dt>\s*<dd>1<\/dd>/);
  assert.match(first, /<dt>Открытые входящие<\/dt>\s*<dd>2<\/dd>/);
  assert.match(first, /data-workspace-inbox="1"/);
  assert.match(second, /data-enter-studio="2"/);
  assert.match(second, /<dt>Задачи в работе<\/dt>\s*<dd>1<\/dd>/);
  assert.match(second, /<dt>Открытые входящие<\/dt>\s*<dd>0<\/dd>/);
  assert.doesNotMatch(second, /data-workspace-inbox/);
});

test('studio names, paths, and action identifiers are escaped', () => {
  const html = renderWorkspaceHome({
    studios: [{ id: 'a"<', name: '<img>&"', root: '/folder/<studio>' }],
    inbox: [{ studioId: 'a"<', status: 'open' }],
  });

  assert.match(html, /data-enter-studio="a&quot;&lt;"/);
  assert.match(html, /data-workspace-inbox="a&quot;&lt;"/);
  assert.match(html, /&lt;img&gt;&amp;&quot;/);
  assert.match(html, /\/folder\/&lt;studio&gt;/);
  assert.doesNotMatch(html, /<img>/);
});
test('workspace opens the oldest blocking decision before other unread items', () => {
  const html = renderWorkspaceHome({ studios: [{ id: 's', name: 'Docs' }], inbox: [
    { id: 'first', studioId: 's', status: 'open', title: 'Other', createdAt: '2026-01-10' },
    { id: 'later', studioId: 's', status: 'open', title: 'Later', blockedTaskIds: ['b'], createdAt: '2026-01-12' },
    { id: 'block', studioId: 's', status: 'open', title: 'Missing example', blockedTaskIds: ['a'], createdAt: '2026-01-11' },
  ] });
  assert.match(html, /data-decision="block"/);
  assert.match(html, /Missing example/);
});
