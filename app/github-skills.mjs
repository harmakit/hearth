const API_ORIGIN = 'https://api.github.com';
const WEB_ORIGIN = 'https://github.com';
const DEFAULT_MIN_STARS = 10_000;
const MAX_TOPICS = 3;
const MAX_REPOSITORIES = 5;
const MAX_BLOBS_PER_REPO = 3;
const MAX_BLOBS = 10;
const MAX_SKILL_BYTES = 128 * 1024;
const MAX_BLOB_RESPONSE_BYTES = 256 * 1024;
const MAX_TREE_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_RESPONSE_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 8_000;
const SHA = /^[a-f0-9]{40}$/;
const REPO_NAME = /^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100}$/i;
const TOPIC = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}-]*(?: [\p{L}\p{N}][\p{L}\p{M}\p{N}-]*)*$/u;
const GENERAL_TOPICS = new Set(['skill', 'skills', 'agent skill', 'agent skills']);
const utf8 = new TextDecoder('utf-8', { fatal: true });

class GitHubReadError extends Error {
  constructor(message, stop = false) {
    super(message);
    this.stop = stop;
  }
}

function normalizeTopics(topics) {
  const normalized = new Set();
  if (!Array.isArray(topics)) return { safeTopics: [], ignoredTopics: topics != null };
  let ignoredTopics = topics.length > 20;
  for (const topic of topics.slice(0, 20)) {
    if (typeof topic !== 'string' || topic.length > 48) {
      ignoredTopics = true;
      continue;
    }
    const value = topic.trim().toLowerCase().normalize('NFC').replace(/ +/g, ' ');
    if (!value || normalized.has(value)) continue;
    if (!TOPIC.test(value) || normalized.size === MAX_TOPICS) {
      ignoredTopics = true;
      continue;
    }
    normalized.add(value);
  }
  return { safeTopics: [...normalized], ignoredTopics };
}

function buildSearchUrl(query, minStars) {
  const url = new URL('/search/repositories', API_ORIGIN);
  url.search = new URLSearchParams({
    q: `${query} stars:>=${minStars} is:public archived:false`,
    sort: 'stars',
    order: 'desc',
    per_page: '12',
  });
  return url;
}

async function readJson(response, limit, signal) {
  if (Number(response.headers.get('content-length')) > limit) {
    void response.body?.cancel().catch(() => {});
    throw new GitHubReadError('response was too large');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new GitHubReadError('response was empty');
  const chunks = [];
  let size = 0;
  let finished = false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new GitHubReadError('response was too large');
      chunks.push(value);
    }
    finished = true;
    return JSON.parse(utf8.decode(Buffer.concat(chunks, size)));
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!finished) cancel();
    reader.releaseLock();
  }
}

function publicRepository(repo, minStars) {
  if (!REPO_NAME.test(repo?.full_name ?? '') || repo.private !== false || repo.archived || repo.disabled) return false;
  if (repo.visibility && repo.visibility !== 'public') return false;
  const [, name] = repo.full_name.split('/');
  const branch = repo.default_branch;
  return name !== '.' && name !== '..'
    && Number.isSafeInteger(repo.stargazers_count) && repo.stargazers_count >= minStars
    && typeof branch === 'string' && branch.length > 0 && branch.length <= 255
    && branch.split('/').every(part => part && part !== '.' && part !== '..')
    && !/[\u0000-\u001f\u007f]/.test(branch);
}

function validSkill(entry) {
  return entry?.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755')
    && typeof entry.path === 'string' && entry.path.length <= 1024 && SHA.test(entry.sha ?? '')
    && !/[\\\u0000-\u001f\u007f]/.test(entry.path)
    && entry.path.split('/').every(part => part && part !== '.' && part !== '..')
    && entry.path.split('/').at(-1) === 'SKILL.md'
    && !(entry.size > MAX_SKILL_BYTES);
}

function normalizedSearchText(value) {
  const text = typeof value === 'string' ? value : '';
  return ` ${text.toLowerCase().normalize('NFC').replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim()} `;
}

function relevance(value, topics) {
  const normalized = normalizedSearchText(value);
  return topics.reduce((score, topic) => score + Number(normalized.includes(topic)), 0);
}

function repositoryRelevance(repo, topics) {
  const terms = [repo.full_name.split('/')[1], repo.description];
  if (Array.isArray(repo.topics)) terms.push(...repo.topics.slice(0, 20));
  return Math.max(...terms.map(term => relevance(term, topics)));
}

function relevantContent(content, title, topics) {
  if (relevance(title, topics)) return true;
  const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
  const headings = content.match(/^#{1,6}[ \t]+[^\r\n]+/gm) ?? [];
  if (relevance(frontMatter, topics) || headings.some(heading => relevance(heading, topics))) return true;
  const body = normalizedSearchText(content);
  return topics.some(topic => {
    const match = body.indexOf(topic);
    if (match < 0) return false;
    // A single word in passing is weak evidence for the skill's domain.
    return topic.trim().includes(' ') || body.includes(topic, match + topic.length - 1);
  });
}

function readSkill(blob, expectedSha) {
  if (blob?.sha !== expectedSha || blob?.encoding !== 'base64' || typeof blob.content !== 'string') {
    throw new GitHubReadError('invalid skill blob');
  }
  const base64 = blob.content.replace(/[\r\n]/g, '');
  const decoded = Buffer.from(base64, 'base64');
  if (decoded.length > MAX_SKILL_BYTES) throw new GitHubReadError('skill file was too large');
  if (decoded.toString('base64') !== base64) throw new GitHubReadError('invalid skill blob');
  const content = utf8.decode(decoded);
  if (!content.trim() || content.includes('\0')) throw new GitHubReadError('skill file was empty or invalid');
  return content;
}

function skillTitle(content, path, repo) {
  const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
  const name = /^name:[ \t]*([^\r\n]+)$/m.exec(frontMatter ?? '')?.[1]?.trim().replace(/^['"]|['"]$/g, '');
  const heading = /^#[ \t]+([^\r\n]+)$/m.exec(content)?.[1]?.trim();
  return (name || heading || path.split('/').at(-2) || repo).slice(0, 120);
}

export function createGitHubSkillFinder({ fetchImpl = globalThis.fetch } = {}) {
  return {
    async findSkills({ topics, minStars = DEFAULT_MIN_STARS, signal } = {}) {
      signal?.throwIfAborted();
      const threshold = Number.isSafeInteger(minStars) && minStars >= 0 ? minStars : DEFAULT_MIN_STARS;
      const { safeTopics, ignoredTopics } = normalizeTopics(topics);
      const specificTopics = safeTopics.map(normalizedSearchText).filter(topic => !GENERAL_TOPICS.has(topic.trim()));
      const candidates = [];
      const warnings = [];
      const repositories = new Map();
      if (ignoredTopics && !safeTopics.length) {
        return { candidates, warnings: ['No usable GitHub search topics were supplied. Use short terms with letters, numbers, spaces or hyphens.'] };
      }
      if (ignoredTopics) warnings.push('Some GitHub search topics were ignored because they were invalid or exceeded the search limits.');

      function results() {
        candidates.sort((a, b) => b.stars - a.stars || a.repo.localeCompare(b.repo));
        return { candidates, warnings };
      }

      async function request(url, limit) {
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const response = await fetchImpl(url, {
          headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
          credentials: 'omit',
          redirect: 'error',
          signal: requestSignal,
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          if (response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')) {
            throw new GitHubReadError('rate limit reached', true);
          }
          if (response.status === 403) throw new GitHubReadError('request blocked or rate limited (HTTP 403)', true);
          throw new GitHubReadError(`HTTP ${response.status}`);
        }
        return readJson(response, limit, requestSignal);
      }

      function reportFailure(action, error) {
        signal?.throwIfAborted();
        const detail = error instanceof GitHubReadError ? error.message : 'request could not be completed';
        const warning = `GitHub ${action} failed (${detail}).`;
        if (!warnings.includes(warning)) warnings.push(warning);
        return error instanceof GitHubReadError && error.stop;
      }

      const queries = safeTopics.map(topic => `"agent skills" "${topic}" in:name,description,readme`);
      queries.push('topic:agent-skills');
      for (const query of queries) {
        try {
          const search = await request(buildSearchUrl(query, threshold), MAX_SEARCH_RESPONSE_BYTES);
          if (!Array.isArray(search?.items)) throw new GitHubReadError('invalid repository search results');
          if (search.incomplete_results) {
            const warning = 'GitHub returned incomplete repository search results.';
            if (!warnings.includes(warning)) warnings.push(warning);
          }
          for (const repo of search.items) {
            if (!publicRepository(repo, threshold)) continue;
            const key = repo.full_name.toLowerCase();
            const metadataMatch = repositoryRelevance(repo, specificTopics);
            const targeted = query !== 'topic:agent-skills' || repositories.get(key)?.targeted;
            repositories.set(key, { repo, metadataMatch, targeted });
          }
        } catch (error) {
          if (reportFailure('repository search', error)) return results();
        }
      }

      const selected = [...repositories.values()]
        .sort((a, b) => b.metadataMatch - a.metadataMatch || Number(Boolean(b.targeted)) - Number(Boolean(a.targeted))
          || b.repo.stargazers_count - a.repo.stargazers_count || a.repo.full_name.localeCompare(b.repo.full_name))
        .slice(0, MAX_REPOSITORIES);
      let blobRequests = 0;
      for (const { repo, metadataMatch } of selected) {
        if (blobRequests >= MAX_BLOBS) break;
        const repoUrl = `${API_ORIGIN}/repos/${repo.full_name}`;
        let commit;
        let files;
        let singleSkill;
        try {
          const head = await request(`${repoUrl}/commits/${encodeURIComponent(repo.default_branch)}`, MAX_SEARCH_RESPONSE_BYTES);
          const treeSha = head?.commit?.tree?.sha;
          commit = head?.sha;
          if (!SHA.test(commit ?? '') || !SHA.test(treeSha ?? '')) throw new GitHubReadError('invalid commit or tree ID');
          const tree = await request(`${repoUrl}/git/trees/${treeSha}?recursive=1`, MAX_TREE_RESPONSE_BYTES);
          if (!Array.isArray(tree?.tree)) throw new GitHubReadError('invalid Git tree');
          if (tree.truncated) warnings.push(`GitHub returned an incomplete Git tree for ${repo.full_name}.`);
          const skillEntries = tree.tree.filter(validSkill);
          singleSkill = skillEntries.length === 1 && !tree.truncated;
          files = skillEntries
            .map(entry => ({ entry, relevance: relevance(entry.path, specificTopics) }))
            .sort((a, b) => b.relevance - a.relevance || a.entry.path.localeCompare(b.entry.path))
            .slice(0, Math.min(MAX_BLOBS_PER_REPO, MAX_BLOBS - blobRequests));
        } catch (error) {
          if (reportFailure(`commit or tree read for ${repo.full_name}`, error)) return results();
          continue;
        }

        for (const { entry: { path, sha }, relevance: pathMatch } of files) {
          blobRequests++;
          try {
            const blob = await request(`${repoUrl}/git/blobs/${sha}`, MAX_BLOB_RESPONSE_BYTES);
            const content = readSkill(blob, sha);
            const title = skillTitle(content, path, repo.full_name);
            if (specificTopics.length && !pathMatch && !(metadataMatch && (singleSkill || path === 'SKILL.md'))
              && !relevantContent(content, title, specificTopics)) continue;
            const license = repo.license?.spdx_id;
            candidates.push({
              id: `${repo.full_name}@${commit}:${path}`,
              repo: repo.full_name,
              commit,
              path,
              title,
              stars: repo.stargazers_count,
              license: typeof license === 'string' && license !== 'NOASSERTION' ? license : repo.license?.name ?? null,
              url: `${WEB_ORIGIN}/${repo.full_name}/blob/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`,
              content,
            });
          } catch (error) {
            if (reportFailure(`skill read for ${repo.full_name}`, error)) return results();
          }
        }
      }
      return results();
    },
  };
}
