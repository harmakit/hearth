const ORIGINS = Object.freeze({
  en: 'https://en.wikipedia.org',
  ru: 'https://ru.wikipedia.org',
});
const MAX_QUERIES = 3;
const MAX_RESULTS_PER_QUERY = 3;
const MAX_CANDIDATES = 6;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_EXCERPT = 600;
const MAX_TITLE = 160;
const TIMEOUT_MS = 8_000;

function publicQueries(topics) {
  if (!Array.isArray(topics)) return [];
  const queries = new Map();
  for (const topic of topics.slice(0, 16)) {
    if (typeof topic !== 'string' || topic.length > 120 || /[\p{C}\p{Zl}\p{Zp}]/u.test(topic)) continue;
    const query = topic.normalize('NFKC').trim().replace(/\s+/gu, ' ');
    if (query.length < 3 || query.length > 100 || query.split(' ').length > 10
      || !/^[\p{L}\p{N}][\p{L}\p{M}\p{N} .+#&-]*$/u.test(query)
      || /\S{41}|\.\./u.test(query) || !/\p{L}/u.test(query)) continue;
    const key = query.toLowerCase();
    if (!queries.has(key)) queries.set(key, query);
    if (queries.size === MAX_QUERIES) break;
  }
  return [...queries.values()];
}

async function readBoundedJson(response, signal) {
  if (!response.ok || response.redirected || !response.body
    || Number(response.headers.get('content-length')) > MAX_BODY_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Invalid Wikipedia response');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let json = '';
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new Error('Wikipedia response exceeded limit');
      json += decoder.decode(value, { stream: true });
    }
    signal.throwIfAborted();
    return JSON.parse(json + decoder.decode());
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function toCandidate(page, language, origin) {
  if (page?.ns !== 0 || page.missing || page.invalid || page.redirect
    || !Number.isSafeInteger(page.pageid) || page.pageid <= 0
    || !Number.isSafeInteger(page.lastrevid) || page.lastrevid <= 0) return null;
  const normalize = (value) => typeof value === 'string'
    ? value.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim()
    : '';
  const title = normalize(page.title);
  const rawExcerpt = normalize(page.extract);
  if (!title || title.length > MAX_TITLE || !rawExcerpt) return null;
  const excerpt = rawExcerpt.length <= MAX_EXCERPT
    ? rawExcerpt
    : rawExcerpt.slice(0, MAX_EXCERPT - 1).replace(/[\uD800-\uDBFF]$/u, '').trimEnd() + '…';
  const revision = String(page.lastrevid);
  return {
    id: `wikipedia:${language}:${page.pageid}`,
    title,
    source: 'Wikipedia',
    url: `${origin}/w/index.php?oldid=${revision}`,
    revision,
    license: 'CC BY-SA 4.0',
    excerpt,
  };
}

export function createMaterialFinder({ fetchImpl = fetch } = {}) {
  return async function findMaterials({ topics, language, signal } = {}) {
    signal?.throwIfAborted();
    const queries = publicQueries(topics);
    if (!queries.length) return { candidates: [], warnings: [] };
    const reportLanguage = typeof language === 'string' ? language.trim() : '';
    const locale = /^(?:русский$|ru(?:[-_]|$))/iu.test(reportLanguage) ? 'ru' : 'en';
    const origin = ORIGINS[locale];
    const deadline = AbortSignal.timeout(TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const candidates = new Map();
    const warnings = new Set();

    for (const query of queries) {
      const endpoint = new URL('/w/api.php', origin);
      endpoint.search = new URLSearchParams({
        action: 'query',
        format: 'json',
        formatversion: '2',
        generator: 'search',
        gsrsearch: query,
        gsrnamespace: '0',
        gsrlimit: String(MAX_RESULTS_PER_QUERY),
        prop: 'extracts|info',
        exintro: '1',
        explaintext: '1',
        exchars: String(MAX_EXCERPT),
        exlimit: String(MAX_RESULTS_PER_QUERY),
      });
      try {
        const response = await fetchImpl(endpoint, {
          credentials: 'omit',
          redirect: 'error',
          signal: requestSignal,
          headers: { Accept: 'application/json', 'User-Agent': 'HearthStudio-MaterialFinder/1.0 (local desktop research)' },
        });
        const data = await readBoundedJson(response, requestSignal);
        if (!data || typeof data !== 'object' || Array.isArray(data) || data.error || data.errors
          || (data.query?.pages === undefined ? data.batchcomplete !== true : !Array.isArray(data.query.pages))) {
          throw new Error('Invalid Wikipedia response data');
        }
        const pages = (data.query?.pages ?? [])
          .sort((a, b) => (a?.index ?? Infinity) - (b?.index ?? Infinity))
          .slice(0, MAX_RESULTS_PER_QUERY);
        for (const page of pages) {
          const candidate = toCandidate(page, locale, origin);
          if (candidate && !candidates.has(candidate.id)) candidates.set(candidate.id, candidate);
          if (candidates.size === MAX_CANDIDATES) break;
        }
        if (candidates.size === MAX_CANDIDATES) break;
      } catch {
        signal?.throwIfAborted();
        if (deadline.aborted) {
          warnings.add('Поиск учебных материалов в Википедии не успел завершиться.');
          break;
        }
        warnings.add('Не удалось проверить часть учебных материалов в Википедии.');
      }
    }
    signal?.throwIfAborted();
    return { candidates: [...candidates.values()], warnings: [...warnings] };
  };
}
