import assert from 'node:assert/strict';
import test from 'node:test';
import { createMaterialFinder } from '../app/materials.mjs';

const article = (overrides = {}) => ({
  ns: 0, pageid: 12, title: 'Code review', lastrevid: 34, index: 1,
  extract: 'Code review is a software quality assurance activity.',
  ...overrides,
});
const responseWith = (pages) => Response.json({ query: { pages } });

test('finds public introductions and constructs pinned attribution independently of the response URLs', async () => {
  const calls = [];
  const findMaterials = createMaterialFinder({ fetchImpl: async (url, options) => {
    calls.push([new URL(url), options]);
    return responseWith([
      article({ pageid: 13, lastrevid: 99, index: 2, title: 'Inspection', extract: 'a'.repeat(1500) }),
      article({ fullurl: 'https://example.test/forged', extract: 'Code review\n is a software quality activity.' }),
      article({ pageid: 14, lastrevid: undefined, index: 3 }),
      article({ pageid: 15, ns: 2, index: 4 }),
    ]);
  } });

  const { candidates, warnings } = await findMaterials({
    topics: [' Code review ', 'CODE  REVIEW', 'file:///private/session.log', 'git review\nprivate notes', 'x'.repeat(300)],
    language: 'Русский',
  });
  assert.equal(calls.length, 1);
  const [[endpoint, init]] = calls;
  assert.equal(endpoint.origin, 'https://ru.wikipedia.org');
  assert.equal(endpoint.pathname, '/w/api.php');
  assert.equal(endpoint.searchParams.get('generator'), 'search');
  assert.equal(endpoint.searchParams.get('gsrsearch'), 'Code review');
  assert.equal(endpoint.searchParams.get('gsrnamespace'), '0');
  assert.ok(endpoint.searchParams.has('explaintext'));
  assert.equal(init.redirect, 'error');
  assert.equal(init.credentials, 'omit');
  assert.deepEqual(warnings, []);
  assert.deepEqual(candidates[0], {
    id: 'wikipedia:ru:12', title: 'Code review', source: 'Wikipedia',
    url: 'https://ru.wikipedia.org/w/index.php?oldid=34', revision: '34', license: 'CC BY-SA 4.0',
    excerpt: 'Code review is a software quality activity.',
  });
  assert.equal(candidates.length, 2);
  assert.ok(candidates[1].excerpt.length <= 600);
});

test('still recognizes a Russian locale code', async () => {
  const findMaterials = createMaterialFinder({ fetchImpl: async (url) => {
    assert.equal(new URL(url).host, 'ru.wikipedia.org');
    return responseWith([article()]);
  } });
  const { candidates, warnings } = await findMaterials({ topics: ['Ревью кода'], language: 'ru-RU' });
  assert.equal(candidates.length, 1);
  assert.deepEqual(warnings, []);
});

test('keeps partial results and emits a stable warning without remote error text', async () => {
  let calls = 0;
  const findMaterials = createMaterialFinder({ fetchImpl: async (url) => {
    assert.equal(new URL(url).host, 'en.wikipedia.org');
    calls++;
    if (calls === 1) return Response.json({ error: { info: 'external instructions' } });
    return responseWith([article(), article()]);
  } });
  const { candidates, warnings } = await findMaterials({
    topics: ['Source control', 'Code review', 'Software testing', 'Observability'], language: 'fr',
  });
  assert.equal(calls, 3);
  assert.equal(candidates.length, 1);
  assert.deepEqual(warnings, ['Не удалось проверить часть учебных материалов в Википедии.']);
});

test('bounds streamed response bodies before JSON parsing', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(50_000)); },
    cancel() { cancelled = true; },
  });
  const findMaterials = createMaterialFinder({ fetchImpl: async () => new Response(body) });
  assert.deepEqual(await findMaterials({ topics: ['Code review'] }), {
    candidates: [], warnings: ['Не удалось проверить часть учебных материалов в Википедии.'],
  });
  assert.equal(cancelled, true);
});

test('propagates caller cancellation and never fetches unsafe-only input', async () => {
  const controller = new AbortController();
  let calls = 0;
  const findMaterials = createMaterialFinder({ fetchImpl: async () => {
    calls++;
    controller.abort();
    return responseWith([article()]);
  } });
  assert.deepEqual(await findMaterials({ topics: ['../../private', 'email@example.test', 'project:secret'] }), {
    candidates: [], warnings: [],
  });
  await assert.rejects(findMaterials({ topics: ['Code review'], signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(findMaterials({ topics: ['Code review'], signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
});
