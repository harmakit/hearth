import assert from 'node:assert/strict';
import test from 'node:test';
import {catalogue} from '../renderer/copy-catalog.mjs';
import { quotaObservationText,quotaPauseText } from '../renderer/quota-view.mjs';
import {copy,setCopyLocale} from '../renderer/copy.mjs';
import {renderWork} from '../renderer/work-view.mjs';
import {renderWorkspaceHome} from '../renderer/workspace-view.mjs';
import {localeNames,tokenCount} from '../renderer/locale.mjs';
import * as presentation from '../renderer/presentation.mjs';

test('reports distinguish actual Hearth checks of the current candidate from an earlier worker summary', () => {
  const revision = {headOid:'h',targetOid:'t',candidateOid:'c'};
  const checks = [
    {phase:'work',revision:{headOid:'h',targetOid:'t'},required:true,status:'FAIL'},
    {phase:'candidate',revision:{...revision,candidateOid:'old'},required:true,status:'FAIL'},
    {phase:'candidate',revision,required:true,status:'PASS'},
    {phase:'candidate',revision,required:false,status:'FAIL'},
  ];
  const current = presentation.renderRecordedChecks({revision,checks});
  assert.match(current,/data-tone="done"/);
  assert.match(current,/1\/1/);
  assert.doesNotMatch(current,/2\/2/);
  assert.equal(presentation.renderRecordedChecks({revision:{...revision,candidateOid:'new'},checks}), '');
  assert.match(presentation.renderRecordedChecks({revision,checks:[...checks,{phase:'candidate',revision,required:true,status:'NOT ASSESSED'}]}), /1\/2/);
  assert.doesNotMatch(presentation.renderRecordedChecks({revision,checks:[...checks,{phase:'candidate',revision,required:true,status:'FAIL'}]}), /data-tone="done"/);
});
test('all locale catalog entries contain four usable translations; literal user input stays untouched',()=>{
  for(const [key,row] of Object.entries(catalogue)) {
    assert.equal(row.length,4,key);
    for(const v of row) assert.ok(v.trim() && !v.includes('▁'),key);
  }
  for(const locale of Object.keys(localeNames)){
    setCopyLocale(locale);
    const input='Отмена';
    assert.equal(copy`${input}`,input);
    const page=renderWork({tab:'registry',tasks:[{id:'qa',title:input}]});
    assert.ok(page.includes('<strong>Отмена</strong>'));
    const home=renderWorkspaceHome({appLocale:locale,studios:[{id:'s',name:input}]});
    assert.ok(home.includes('>Отмена</button>'));
    if(locale!=='ru')assert.notEqual(copy('Остановить'),'Остановить');
  }
  setCopyLocale('en');
  assert.match(copy('» будут удалены из Hearth. Папка проекта и её файлы сохранятся.'),/files will be preserved/);
  setCopyLocale('ru');
  assert.equal(tokenCount('ru',1),'1 токен');
  assert.equal(tokenCount('ru',3),'3 токена');
  assert.equal(tokenCount('ru',12),'12 токенов');
});

test('web research renders escaped sources, distinct page outcomes and pending facts in each locale',()=>{
  const sources=[{url:'https://example.org/record?a=1&b=2',status:'read',note:'<script>unsafe</script>'},
    {url:'https://example.org/index',status:'found'},{url:'https://example.org/missing',status:'failed',note:'HTTP 404'}];
  for(const locale of Object.keys(localeNames)){
    setCopyLocale(locale);
    const html=presentation.renderWebResearch({status:'completed',sources,unverified:['The date of the second entry']});
    for(const key of ['Страница прочитана','Ссылка найдена','Страница не открылась','Осталось проверить']) {
      assert.ok(html.includes(copy(key)),key);
      if(locale!=='ru')assert.notEqual(copy(key),key);
    }
    assert.match(html,/record\?a=1&amp;b=2/);
    assert.match(html,/HTTP 404/);
    assert.match(html,/The date of the second entry/);
    assert.match(html,/&lt;script&gt;unsafe&lt;\/script&gt;/);
    assert.doesNotMatch(html,/<script>/);
    assert.equal(presentation.renderWebResearch(undefined),'');
  }
  setCopyLocale('en');
});

test('saved director replies render bold headings without interpreting HTML',()=>{
  const html=presentation.renderDirectorReplyText('**Что нужно проверить**\n\n<img src=x onerror=alert(1)>');
  assert.match(html,/<strong>Что нужно проверить<\/strong>/u);
  assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/u);
  assert.doesNotMatch(html,/<img/u);
});

test('reports and replies format Markdown and route only web and project text links',()=>{
  const html = presentation.renderDirectorReplyText([
    '## Учебная карточка', '', '- **1912** · *Факт*', '- `a < b`', '',
    '[Событие](https://en.wikipedia.org/wiki/York_(England)) · [Хронология](family-chronology.md)', '',
    'Источник https://example.org/report.', '', '| Период | Статус |', '| --- | :--- |', '| 2080 | Вымысел |', '',
    '[Bad](javascript:alert(1)) [Private](../.hearth/state/studio.sqlite3) <img src="https://example.org/remote">',
  ].join('\n'));
  assert.match(html, /<h\d>Учебная карточка<\/h\d>/u);
  assert.match(html, /<ul><li><strong>1912<\/strong> · <em>Факт<\/em><\/li><li><code>a &lt; b<\/code>/u);
  assert.match(html, /href="https:\/\/en\.wikipedia\.org\/wiki\/York_\(England\)"/u);
  assert.match(html, /data-report-link="family-chronology\.md"/u);
  assert.match(html, /href="https:\/\/example\.org\/report"[\s\S]*<table>[\s\S]*<th scope="col">Период<\/th>[\s\S]*<td>Вымысел<\/td>/u);
  assert.doesNotMatch(html, /href="javascript:|data-report-link="\.\.|<img/u);
});

test('reconciliation choices describe the task and queue outcomes before confirmation',()=>{
  setCopyLocale('ru');
  const item = { kind: 'reconcile', reconciliationState: 'work', taskId: 'task', status: 'open', directorSuggestions: [
    { id: 'retry', label: 'Подтвердить сверку и повторить', text: 'Я проверил сохранённые изменения. Повтори шаг, если это безопасно.' },
    { id: 'discard', label: 'Оставить шаг прерванным', text: 'Я проверил сохранённые изменения. Оставь шаг прерванным.' },
  ] };
  const html = presentation.renderReconciliationDecisions(item);
  assert.match(html, /data-reconcile-choice="retry"[\s\S]*Hearth поставит этот шаг в очередь/u);
  assert.match(html, /data-reconcile-choice="discard"[\s\S]*Задача останется прерванной/u);
  assert.match(html, /data-reconciliation-confirm hidden/u);
  assert.match(html, /type="checkbox" data-reconciliation-check/u);
  assert.equal(presentation.renderReconciliationDecisions({ ...item, reconciliationState: 'active', directorSuggestions: [] }), '');
  setCopyLocale('en');
});

test('conversation pages keep their oldest loaded row as the live context boundary moves',()=>{
  const messages=Array.from({length:66},(_,i)=>({id:String(i+1),status:i===34?'queued':'processed'}));
  const ids=before=>presentation.conversationHistorySlice(messages,'21',before).map(row=>Number(row.id));
  assert.deepEqual(ids('41'),Array.from({length:20},(_,i)=>i+21).filter(id=>id!==35));
  assert.deepEqual(ids('42'),[...ids('41'),41]);
  assert.deepEqual(ids('20'),[]);
  assert.deepEqual(ids('41'),Array.from({length:20},(_,i)=>i+21).filter(id=>id!==35));
  assert.deepEqual(presentation.conversationHistorySlice(messages,null,'41'),[]);
});

test('conversation context labels distinguish active, queued and future replies in each locale',()=>{
  const labels=['Контекст текущего ответа','Контекст ответа в очереди','Контекст следующего ответа','Загрузить предыдущие','Вне текущего ответа','Пока нет сообщений в контексте.'];
  for(const locale of Object.keys(localeNames)){
    setCopyLocale(locale);
    assert.deepEqual(['running','queued','next'].map(presentation.conversationContextHeading),labels.slice(0,3).map(copy));
    if(locale!=='ru')for(const label of labels)assert.notEqual(copy(label),label);
  }
  setCopyLocale('en');
});

test('weekly quota distinguishes missing data, stale pauses and application or studio scope',()=>{
  const pause={scope:'app',runtime:'codex',remainingPercent:5,threshold:10,stale:true,resetAt:'2026-11-26T12:00:00Z'};
  setCopyLocale('ru');
  assert.match(quotaObservationText({status:'unknown'}),/неизвестен/);
  assert.match(quotaObservationText({status:'unsupported'}),/не передаёт/);
  assert.match(quotaPauseText(pause),/Codex · 5% · Общий порог 10%[^]*устарели/);
  assert.match(quotaPauseText({...pause,scope:'studio',stale:false}),/Порог студии 10%[^]*без прерывания/);
  const html=renderWorkspaceHome({studios:[{id:'s',name:'Studio',lifecycle:'active',quotaPause:pause}],quotaPolicy:{pause}});
  assert.match(html,/Новые автоматические запуски на паузе/);
  setCopyLocale('en');
  assert.match(quotaPauseText(pause),/Application threshold 10%/);
});
