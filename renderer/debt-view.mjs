import {copy, onCopyLocale , getCopyLocale} from './copy.mjs';
const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const safe = value => String(value ?? '').replace(/[&<>"']/g, character => entities[character]);

const makeDebtPolicyFields = () => ([
  { name: 'every', label: copy('Проверять очередь каждые N спринтов'), min: 1, max: 52 },
  { name: 'minShare', label: copy('Доля работы на улучшения, %'), min: 1, max: 100 },
  { name: 'minOpenTasks', label: copy('Минимум открытых улучшений для спринта'), min: 0, max: 40 },
]);
export let debtPolicyFields = makeDebtPolicyFields();
onCopyLocale(() => { debtPolicyFields = makeDebtPolicyFields(); });

export const debtPolicyFor = studio => ({
  enabled: false, every: 4, minShare: 60, minOpenTasks: 1, measure: 'taskCount', ...studio.debtPolicy,
});

const makeDebtPolicyHint = () => (copy('На каждой указанной итерации после онбординга директор проверяет очередь. Если открытых улучшений достаточно, он выделяет им заданную долю спринта. Доля считается по числу рабочих задач или по баллам, без обучения.'));
export let debtPolicyHint = makeDebtPolicyHint();
onCopyLocale(() => { debtPolicyHint = makeDebtPolicyHint(); });
const makeImprovementsHelp = () => (copy('Улучшения устраняют препятствия для будущей работы. Например, обновляют устаревшую инструкцию, убирают дубли материалов или чинят ненадёжную проверку. Агент может указать находку в отчёте. После принятия работы Hearth добавит её в очередь со ссылкой на исходную задачу.'));
export let improvementsHelp = makeImprovementsHelp();
onCopyLocale(() => { improvementsHelp = makeImprovementsHelp(); });

export function renderDebtSettings(studio, { pending = false, error = '' } = {}) {
  const policy = debtPolicyFor(studio);
  const assessment = studio.debtAssessment;
  const date = new Date(assessment?.assessedAt);
  const time = Number.isFinite(date.getTime()) ? ` · <time datetime="${date.toISOString()}">${date.toLocaleString(getCopyLocale())}</time>` : '';
  return copy`<section class="stack compact"><h2>Улучшения проекта</h2>
    <div class="panel padded stack compact">
      <p class="muted">${improvementsHelp}</p>
      <div class="row settings-row"><h3>Спринты улучшений ${policy.enabled ? copy('включены') : copy('выключены')}</h3>
        <button type="button" class="action secondary" data-open="debt-policy"${pending ? ' disabled' : ''}>Настроить вручную</button></div>
      <dl class="studio-meta">
        <dt>Единица измерения доли</dt><dd>${policy.measure === 'points' ? copy('Баллы') : copy('Число задач')}</dd>
        ${debtPolicyFields.map(({ name, label }) => `<dt>${label}</dt><dd>${safe(policy[name])}</dd>`).join('')}
      </dl>
      <p class="muted">${debtPolicyHint}</p>
      <div class="inline-result stack compact">
        <div class="row allowed-row"><h3>Оценка директора</h3>
          <button type="button" class="action secondary" data-assess-debt aria-disabled="${pending}">Оценить и настроить</button>
        </div>
        <p class="muted">Директор оценит очередь задач и сохранит параметры с пояснением.</p>
        <div role="status" aria-busy="${pending}">
          ${pending ? copy('<p>Директор оценивает очередь улучшений…</p>') :
            assessment?.reason ? copy`<p class="muted">Последняя оценка${time}</p><p class="long-text">${safe(assessment.reason)}</p>` : ''}
        </div>
        ${error ? `<p class="error" role="alert">${safe(error)}</p>` : ''}
      </div>
    </div>
  </section>`;
}
