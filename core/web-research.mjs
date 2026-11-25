import { publicWebUrl } from '../runtimes/web.mjs';

const states = new Set(['available', 'unavailable', 'unknown']);
const safeText = (value, length) => typeof value === 'string' ? value.trim().slice(0, length) : '';

export function normalizeWebCapabilities(value) {
  if (!value || ![value.search, value.read].some(state => states.has(state))) return;
  return { search: states.has(value.search) ? value.search : 'unknown', read: states.has(value.read) ? value.read : 'unknown' };
}

export function summarizeWebResearch(web, proposed) {
  const status = { used: 'completed', unavailable: 'unavailable', failed: 'failed', attempted: 'incomplete' }[web?.search] ?? 'not-run';
  const sources = new Map();
  const unverified = new Set();
  const addUnverified = value => {
    const fact = safeText(value, 320);
    if (fact && unverified.size < 12) unverified.add(fact);
  };
  const reason = safeText(web?.reason, 200);
  if (Array.isArray(proposed?.unverified)) for (const fact of proposed.unverified.slice(0,12)) addUnverified(fact);
  if (status === 'completed') {
    const observations = Array.isArray(web.pages) ? web.pages : [];
    const pages = new Map(observations.flatMap(page => {
      const url = publicWebUrl(page?.url);
      return url ? [[url, page]] : [];
    }));
    const links = Array.isArray(web.links) ? web.links.slice(0,16).map(publicWebUrl).filter(Boolean) : [];
    const found = new Set(links);
    const suggestions = Array.isArray(proposed?.sources) ? proposed.sources.slice(0,12) : [];
    for (const candidate of suggestions) {
      const url = publicWebUrl(candidate?.url);
      if (!url || sources.has(url)) continue;
      const page = pages.get(url);
      const note = safeText(candidate.note,320);
      const failed = page?.status === 'failed' || page?.status === 'attempted' && candidate.status === 'failed';
      const sourceStatus = page?.status === 'read' ? 'read' : failed ? 'failed' : page?.status === 'attempted' ? 'attempted' :
        found.has(url) ? 'found' : 'unverified';
      const failure = safeText(page?.reason, 200) || (failed ? note : '');
      if (sourceStatus !== 'read' && candidate.status === 'read') addUnverified(note || url);
      const detail = sourceStatus === 'read' ? note : sourceStatus === 'failed' ? failure : '';
      sources.set(url, { url, status: sourceStatus, ...(detail ? { note: detail } : {}) });
    }
    for (const [url, page] of pages) {
      if (sources.size >= 12) break;
      if (sources.has(url) || !['read','failed','attempted'].includes(page.status)) continue;
      const note = safeText(page.reason,200);
      sources.set(url,{url,status:page.status,...(note ? {note} : {})});
    }
    for (const url of found) {
      if (sources.size >= 12) break;
      if (!sources.has(url)) sources.set(url,{url,status:'found'});
    }
  }
  return { status, sources: [...sources.values()], unverified: [...unverified], ...(reason ? { reason } : {}) };
}
