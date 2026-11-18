import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerPayload, renderDelivery, renderDiagnostic, renderQuestionDetails, renderUsageReport } from '../renderer/legacy-view.mjs';
import { renderWork } from '../renderer/work-view.mjs';

test('versioned answers preserve the explicitly selected option and attachment references', () => {
  assert.deepEqual(answerPayload({ id: 'q', version: 3, kind: 'question' }, {
    answer: 'Уточнение', choiceId: 'yes', attachmentIds: ['a'], operationId: 'op',
  }), { inboxId: 'q', version: 3, answer: 'Уточнение', choiceId: 'yes', attachmentIds: ['a'], operationId: 'op' });
});

test('question details show safe labels and context for linked choices', () => {
  const details = renderQuestionDetails({ version: 2, context: '<script>', options: [{ id: 'a', label: 'Сначала проверить', description: 'Критерий' }] });
  assert.match(details, /Версия 2/);
  assert.match(details, /Сначала проверить/);
  assert.match(details, /Критерий/);
  assert.ok(!details.includes('<script>'));
});

test('delivery shows a failed check, its revision and a saved evidence action', () => {
  const result = renderDelivery({ checks: [{ checkId: 'build', status: 'failed', revision: { headOid: 'abc012' } }], evidence: [{ id: 'e', name: 'report.txt', size: 18, digest: '789' }] });
  assert.match(result, /build/);
  assert.match(result, /Не пройдена/);
  assert.match(result, /abc012/);
  assert.match(result, /data-evidence="e"/);
  assert.match(result, /report\.txt/);
});

test('planning surfaces backlog priority, grooming state and evidence-based phase decisions', () => {
  const result = renderWork({ tab: 'planning',
    studio: { backlogVersion: 5, grooming: { id: 'g', status: 'open', readyTasks: 2, threshold: 4 } },
    tasks: [
      { id: 'low', title: 'Низкий приоритет', stage: 'backlog', priority: 10 },
      { id: 'high', title: 'Высокий приоритет', stage: 'backlog', priority: 80 },
    ],
    phases: [{ id: 'p', title: 'Макет', criteria: [{ description: 'Отчёт принят' }], transition: { status: 'pending' } }],
  });
  assert.match(result, /Версия 5[^]*?Высокий приоритет[^]*?Низкий приоритет/);
  assert.match(result, /data-resolve-grooming="g"/);
  assert.match(result, /Отчёт принят[^]*?data-phase-transition="p"/);
});

test('the next sprint action appears only after a completed sprint and without current planning', () => {
  const completed = { id: 's', status: 'completed' };
  const render = props => renderWork({ tab: 'sprints', sprints: [completed], ...props });
  assert.match(render(), /data-open="next-sprint"/);
  assert.doesNotMatch(render({ sprints: [] }), /data-open="next-sprint"/);
  assert.doesNotMatch(render({ sprints: [completed, { id: 'working', status: 'active' }] }), /data-open="next-sprint"/);
  assert.doesNotMatch(render({ plans: [{ id: 'next', kind: 'sprint', status: 'pending' }] }), /data-open="next-sprint"/);
  assert.doesNotMatch(render({ studio: { lifecycle: 'planning' } }), /data-open="next-sprint"/);
});

test('usage distinguishes zero tokens, missing data and the confirmed subscription limit', () => {
  const result = renderUsageReport({
    events: [{ attemptId: 'try', runtime: 'codex', role: 'writer', model: 'model-test', input: 0, output: 3 }],
    byAttempt: [{ attemptId: 'try', input: 0, output: 3, cacheRead: null }],
    byProvider: [{ provider: 'OpenAI', input: 0, output: 3 }],
    totals: { input: 0, output: 3, cacheRead: null },
    subscription: { usedPercent: 23 },
  });
  assert.match(result, /Всего по студии[^]*?<td>0<\/td>[^]*?<td>Нет данных<\/td>/);
  assert.match(result, /writer · codex · model-test · try/);
  assert.match(result, /OpenAI/);
  assert.match(result, /23 % использовано/);
});

test('diagnostics use the persisted queue counters and render an actionable error category', () => {
  const result = renderDiagnostic({ queue: { pending: 2, active: 1 },
    schedule: { waiting: true }, lastError: { kind: 'git-conflict' }, action: 'resume' });
  assert.match(result, /В очереди<\/dt><dd>2/);
  assert.match(result, /В работе<\/dt><dd>1/);
  assert.match(result, /Ждёт рабочего окна/);
  assert.match(result, /Конфликт Git/);
  assert.match(result, /Возобновить/);
});
