import { reportLink } from './report-link.mjs';

export const escapeMarkup = value => String(value ?? '').replace(/[&<>"']/g,
  char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

function destinationAt(text, start) {
  if (text[start] === '<') {
    const end = text.indexOf('>', start + 1);
    return end !== -1 && text[end + 1] === ')' ? { value: text.slice(start + 1, end), end: end + 2 } : null;
  }
  let depth = 0;
  for (let index = start; index < text.length && index - start < 2049; index++) {
    if (text[index] === '(') depth++;
    if (text[index] === ')' && depth-- === 0) return { value: text.slice(start, index), end: index + 1 };
    if (/\s/u.test(text[index])) break;
  }
  return null;
}

function webAnchor(url, title) {
  return `<a href="${escapeMarkup(url)}" data-report-link="${escapeMarkup(url)}">${title}</a>`;
}

export function renderWebLink(text) {
  const url=reportLink(text)?.url;
  return url ? webAnchor(url,escapeMarkup(text)) : escapeMarkup(text);
}

function inline(text, links = true, depth = 0) {
  if (depth >= 4) return escapeMarkup(text);
  const tokens = /\\([\\`*_[\]()>#!|\-])|(`+)([^\n]+?)\2|(\*\*|__|~~|\*|_)(?=\S)([^\n]+?)(?<=\S)\4|\[([^\]\n]+)\]\(|(<[^>\n]*>)|(https?:\/\/[^\s<>\[\]`"']+)/gu;
  let markup = '', offset = 0;
  for (let match; (match = tokens.exec(text));) {
    markup += escapeMarkup(text.slice(offset, match.index));
    offset = tokens.lastIndex;
    const [, escaped, ticks, code, marker, emphasis, label, angle, bare] = match;
    if (escaped) markup += escapeMarkup(escaped);
    else if (ticks) markup += `<code>${escapeMarkup(code)}</code>`;
    else if (marker) {
      const tag = marker === '~~' ? 'del' : marker.length === 2 ? 'strong' : 'em';
      markup += `<${tag}>${inline(emphasis, links, depth + 1)}</${tag}>`;
    } else if (angle) {
      const url=links&&reportLink(angle.slice(1,-1))?.url;
      markup += url ? webAnchor(url,escapeMarkup(angle.slice(1,-1))) : escapeMarkup(angle);
    } else if (bare) {
      let value=bare.replace(/[.,;:!?]+$/u,'');
      while (value.endsWith(')') && value.split(')').length>value.split('(').length) value=value.slice(0,-1);
      const url=links&&reportLink(value)?.url;
      markup += url ? webAnchor(url,escapeMarkup(value))+escapeMarkup(bare.slice(value.length)) : escapeMarkup(bare);
    } else {
      const destination = destinationAt(text, offset);
      const link = links && destination && reportLink(destination.value);
      if (!link) {
        if (destination) offset = tokens.lastIndex = destination.end;
        markup += escapeMarkup(text.slice(match.index, offset));
        continue;
      }
      offset = tokens.lastIndex = destination.end;
      const title = inline(label, false, depth + 1);
      markup += link.url
        ? webAnchor(link.url,title)
        : `<button type="button" class="report-link" data-report-link="${escapeMarkup(destination.value)}">${title}</button>`;
    }
  }
  return markup + escapeMarkup(text.slice(offset));
}

const heading = /^\s{0,3}(#{1,6})\s+(.+)$/u;
const list = /^\s{0,3}([-*+]|\d{1,8}[.)])\s+(.+)$/u;
const quote = /^\s{0,3}>\s?(.*)$/u;
const fence = /^\s{0,3}(`{3,}|~{3,})/u;
const rule = /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/u;
const startsBlock = line => !line.trim() || heading.test(line) || list.test(line) || quote.test(line) || fence.test(line) || rule.test(line);
const cells = line => line.trim().replace(/^\||(?<!\\)\|$/gu,'').split(/(?<!\\)\|/u).map(cell=>cell.trim());
function tableColumns(header, divider) {
  if (!header.includes('|') || !divider?.includes('|')) return [];
  const columns=cells(header);
  const markers=cells(divider);
  return columns.length>1 && columns.length===markers.length && markers.every(cell=>/^:?-{3,}:?$/u.test(cell)) ? columns : [];
}

export function renderReportMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/gu, '\n').split('\n');
  const blocks = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index++];
    if (!line.trim()) continue;
    const codeFence = line.match(fence);
    if (codeFence) {
      const marker = codeFence[1];
      const end = new RegExp(`^\\s{0,3}${marker[0]}{${marker.length},}\\s*$`, 'u');
      const code = [];
      while (index < lines.length && !end.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index++;
      blocks.push(`<pre><code>${escapeMarkup(code.join('\n'))}</code></pre>`);
      continue;
    }
    const title = line.match(heading);
    if (title) {
      const level = Math.min(title[1].length + 3, 6);
      blocks.push(`<h${level}>${inline(title[2].replace(/\s+#+\s*$/u, ''))}</h${level}>`);
      continue;
    }
    if (rule.test(line)) { blocks.push('<hr>'); continue; }
    const columns=tableColumns(line,lines[index]);
    if (columns.length) {
      index++;
      const rows=[];
      while (lines[index]?.includes('|')&&!startsBlock(lines[index])) {
        const values=cells(lines[index++]);
        rows.push(`<tr>${columns.map((_,column)=>`<td>${inline(values[column]??'')}</td>`).join('')}</tr>`);
      }
      blocks.push(`<table><thead><tr>${columns.map(column=>`<th scope="col">${inline(column)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`);
      continue;
    }
    const first = line.match(list);
    if (first) {
      const order = Number.parseInt(first[1], 10);
      const tag = Number.isNaN(order) ? 'ul' : 'ol';
      const items = [first[2]];
      for (let next; (next = lines[index]?.match(list)) && /^\d/u.test(next[1]) === (tag === 'ol'); index++) items.push(next[2]);
      blocks.push(`<${tag}${tag === 'ol' && order !== 1 ? ` start="${order}"` : ''}>${items.map(item => `<li>${inline(item)}</li>`).join('')}</${tag}>`);
      continue;
    }
    const citation = line.match(quote);
    if (citation) {
      const rows = [citation[1]];
      for (let next; (next = lines[index]?.match(quote)); index++) rows.push(next[1]);
      blocks.push(`<blockquote>${rows.map(row => inline(row)).join('<br>')}</blockquote>`);
      continue;
    }
    const rows = [line];
    while (index < lines.length && !startsBlock(lines[index]) && !tableColumns(lines[index],lines[index+1]).length) rows.push(lines[index++]);
    blocks.push(`<p>${rows.map(row => inline(row)).join('<br>')}</p>`);
  }
  return `<div class="report-text">${blocks.join('')}</div>`;
}
