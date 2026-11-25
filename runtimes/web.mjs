import { isIP } from 'node:net';

export function publicWebUrl(value) {
  if (typeof value !== 'string' || value.length > 2000) return;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    if (!url.hostname.includes('.') || isIP(url.hostname) || /(?:^|\.)(?:localhost|local|internal)\.?$/iu.test(url.hostname)) return;
    return url.href;
  } catch {
    return undefined;
  }
}

export function recordWebPage(pages, candidate, status, reason) {
  const url = publicWebUrl(candidate);
  if (!url || !pages.has(url) && pages.size >= 16) return;
  if (pages.has(url) && (status === 'attempted' || pages.get(url).status === 'read')) return;
  pages.set(url, { url, status, ...(reason ? { reason } : {}) });
}

export function recordWebLinks(links, content) {
  const records = Array.isArray(content) ? content : [content];
  for (const record of records) {
    const text = typeof record === 'string' ? record : record?.text;
    const candidates = [record?.url, ...(typeof text === 'string'
      ? text.slice(0, 80_000).match(/https?:\/\/[^\s<>"'()[\]{}]+/giu) ?? [] : [])];
    for (const candidate of candidates) {
      const url = publicWebUrl(candidate);
      if (url) links.add(url);
      if (links.size >= 16) return;
    }
  }
}
