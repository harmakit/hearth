import assert from 'node:assert/strict';
import test from 'node:test';
import { createGitHubSkillFinder } from '../app/github-skills.mjs';

const commit = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const blob = 'c'.repeat(40);
const content = '---\nname: react-review\n---\n# Review React\n\nCheck component state.';
const path = '.agents/skills/react review/SKILL.md';

function repo(name, stars, overrides = {}) {
  return {
    full_name: `coach/${name}`,
    stargazers_count: stars,
    private: false,
    archived: false,
    default_branch: 'release/stable',
    license: { spdx_id: 'MIT' },
    html_url: 'https://not-github.example/repository',
    ...overrides,
  };
}

function fixture(repositories, { treeEntries, blobResponse } = {}) {
  const calls = [];
  const fetchImpl = async (target, options) => {
    const url = new URL(target);
    calls.push({ url, options });
    if (url.pathname === '/search/repositories') return Response.json({ items: repositories });
    if (url.pathname.endsWith('/commits/release%2Fstable')) {
      return Response.json({ sha: commit, commit: { tree: { sha: tree } } });
    }
    if (url.pathname.endsWith(`/git/trees/${tree}`)) {
      return Response.json({ tree: treeEntries ?? [{ path, sha: blob, type: 'blob', mode: '100644', size: Buffer.byteLength(content), url: 'https://not-github.example/raw' }] });
    }
    if (url.pathname.endsWith(`/git/blobs/${blob}`)) {
      return blobResponse?.() ?? Response.json({ sha: blob, encoding: 'base64', content: Buffer.from(content).toString('base64') });
    }
    return new Response(null, { status: 404 });
  };
  return { calls, fetchImpl };
}

test('finds sorted, public skills using safe search terms and immutable Git objects', async () => {
  const { calls, fetchImpl } = fixture([
    repo('smaller', 13_000), repo('larger', 25_000), repo('below', 9999),
    repo('private', 50_000, { private: true }), repo('archive', 60_000, { archived: true }),
  ]);
  const finder = createGitHubSkillFinder({ fetchImpl });
  const result = await finder.findSkills({ topics: ['react', 'ui design', 'stars:<2', 'https://evil.example'] });

  assert.deepEqual(result.candidates.map(candidate => candidate.repo), ['coach/larger', 'coach/smaller']);
  assert.deepEqual(result.candidates[0], {
    id: `coach/larger@${commit}:${path}`, repo: 'coach/larger', commit, path,
    title: 'react-review', stars: 25_000, license: 'MIT',
    url: `https://github.com/coach/larger/blob/${commit}/.agents/skills/react%20review/SKILL.md`, content,
  });
  assert.ok(calls.filter(({ url }) => url.pathname.startsWith('/repos/')).every(({ url }) => /\/coach\/(larger|smaller)\//.test(url.pathname)));
  for (const { url, options } of calls) {
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(new Headers(options.headers).has('authorization'), false);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    if (url.pathname !== '/search/repositories') continue;
    assert.equal(url.searchParams.get('sort'), 'stars');
    assert.equal(url.searchParams.get('order'), 'desc');
    const query = url.searchParams.get('q');
    assert.match(query, /stars:>=10000 is:public archived:false/);
    assert.match(query, /"agent skills"|topic:agent-skills/);
    assert.doesNotMatch(query, /stars:<2|evil\.example/);
  }
  assert.ok(calls.some(({ url }) => url.searchParams.get('q')?.includes('"ui design"')));
});

test('caps repository and blob inspection and uses a supplied star minimum', async () => {
  const repositories = Array.from({ length: 30 }, (_, index) => repo(`skills-${index}`, 90 + index));
  const treeEntries = Array.from({ length: 30 }, (_, index) => ({
    path: `skills/react-${index}/SKILL.md`, type: 'blob', mode: '100644', sha: blob,
  }));
  const { calls, fetchImpl } = fixture(repositories, { treeEntries });
  const finder = createGitHubSkillFinder({ fetchImpl });
  const { candidates } = await finder.findSkills({ topics: ['react'], minStars: 100 });
  assert.ok(candidates.length > 0 && candidates.length <= 10);
  assert.ok(candidates.every(candidate => candidate.stars >= 100));
  assert.ok(calls.filter(({ url }) => url.pathname.includes('/git/trees/')).length < 10);
  assert.ok(calls.filter(({ url }) => url.pathname.includes('/git/blobs/')).length <= 10);
});

test('keeps focused skills when popular collections contain unrelated Markdown', async () => {
  const reported = fixture([
    ...Array.from({ length: 6 }, (_, index) => repo(`general-${index}`, 50_000 - index)),
    repo('react-manual', 12_000),
  ]);
  const unrelated = '---\nname: Brainstorming\n---\n# General planning\n\nConsider alternatives and react when they change.';
  const finder = createGitHubSkillFinder({ fetchImpl: async (target, options) => {
    const url = new URL(target);
    const genericRepo = url.pathname.includes('/general-');
    if (url.pathname === '/search/repositories') {
      const response = await reported.fetchImpl(target, options);
      const { items } = await response.json();
      return Response.json({ items: url.searchParams.get('q').includes('"react"') ? [items[0], items.at(-1)] : items });
    }
    if (genericRepo && url.pathname.includes('/git/trees/')) {
      return Response.json({ tree: [{ path: 'skills/brainstorming/SKILL.md', sha: blob, type: 'blob', mode: '100644' }] });
    }
    if (genericRepo && url.pathname.includes('/git/blobs/')) {
      return Response.json({ sha: blob, encoding: 'base64', content: Buffer.from(unrelated).toString('base64') });
    }
    return reported.fetchImpl(target, options);
  } });

  const { candidates, warnings } = await finder.findSkills({ topics: ['react'] });
  assert.deepEqual(candidates.map(candidate => candidate.repo), ['coach/react-manual']);
  assert.deepEqual(warnings, []);
});

test('returns an empty successful search when GitHub has no candidates', async () => {
  const finder = createGitHubSkillFinder(fixture([]));
  assert.deepEqual(await finder.findSkills(), { candidates: [], warnings: [] });
});

test('searches and matches Cyrillic terms while reporting rejected qualifiers', async () => {
  const { calls, fetchImpl } = fixture([repo('mixed-skills', 12_000)], {
    treeEntries: [
      { path: 'skills/brainstorming/SKILL.md', sha: blob, type: 'blob', mode: '100644' },
      { path: 'skills/Проектирование-интерфейсов/SKILL.md', sha: blob, type: 'blob', mode: '100644' },
    ],
  });
  const finder = createGitHubSkillFinder({ fetchImpl });
  const { candidates, warnings } = await finder.findSkills({ topics: ['  Проектирование интерфейсов ', 'stars:<1'] });

  assert.deepEqual(candidates.map(candidate => candidate.path), ['skills/Проектирование-интерфейсов/SKILL.md']);
  assert.ok(calls.some(({ url }) => url.searchParams.get('q')?.includes('"проектирование интерфейсов"')));
  assert.ok(calls.every(({ url }) => !url.searchParams.get('q')?.includes('stars:<1')));
  assert.match(warnings.join(' '), /topic.*ignored/i);
});

test('does not run a generic search when every supplied topic is unusable', async () => {
  const { calls, fetchImpl } = fixture([repo('general', 12_000)]);
  const finder = createGitHubSkillFinder({ fetchImpl });
  for (const topics of [['repo:example/example', 'д'.repeat(49)], 'react']) {
    const { candidates, warnings } = await finder.findSkills({ topics });
    assert.deepEqual(candidates, []);
    assert.match(warnings.join(' '), /no usable.*topic/i);
  }
  assert.deepEqual(calls, []);
});

test('stops at the rate limit and surfaces a warning without the response text', async () => {
  let requests = 0;
  const finder = createGitHubSkillFinder({ fetchImpl: async () => {
    requests++;
    return new Response('secret from GitHub', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
  } });
  const result = await finder.findSkills({ topics: ['react', 'typescript'] });
  assert.equal(requests, 1);
  assert.deepEqual(result.candidates, []);
  assert.match(result.warnings.join(' '), /rate limit/i);
  assert.doesNotMatch(result.warnings.join(' '), /secret/);
});

test('distinguishes network failures from empty search results', async () => {
  const finder = createGitHubSkillFinder({ fetchImpl: async () => { throw new Error('secret'); } });
  const result = await finder.findSkills();
  assert.deepEqual(result.candidates, []);
  assert.match(result.warnings.join(' '), /GitHub.*search.*failed/i);
  assert.doesNotMatch(result.warnings.join(' '), /secret/);
});

test('rejects a cancelled search without continuing to other queries', async () => {
  const controller = new AbortController();
  let requests = 0;
  const finder = createGitHubSkillFinder({ fetchImpl: async (_url, { signal }) => {
    requests++;
    controller.abort();
    signal.throwIfAborted();
  } });
  await assert.rejects(finder.findSkills({ topics: ['react', 'typescript'], signal: controller.signal }), { name: 'AbortError' });
  assert.equal(requests, 1);
});

test('cancels oversized response streams and skips symlinks and invalid paths', async () => {
  let streamCancelled = false;
  const { calls, fetchImpl } = fixture([repo('skills', 12_000)], {
    treeEntries: [
      { path: 'react/SKILL.md', type: 'blob', mode: '120000', sha: commit },
      { path: '../SKILL.md', type: 'blob', mode: '100644', sha: tree },
      { path, type: 'blob', mode: '100644', sha: blob },
    ],
    blobResponse: () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(300_000)); },
      cancel() { streamCancelled = true; },
    })),
  });
  const finder = createGitHubSkillFinder({ fetchImpl });
  const result = await finder.findSkills({ topics: ['react'] });
  assert.equal(streamCancelled, true);
  assert.deepEqual(result.candidates, []);
  assert.match(result.warnings.join(' '), /too large/i);
  assert.equal(calls.filter(({ url }) => url.pathname.includes('/git/blobs/')).length, 1);
});
