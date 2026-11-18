const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const safe = value => String(value ?? '').replace(/[&<>"']/g, character => entities[character]);

export const debtPolicyFields = [
  { name: 'every', label: 'Период в спринтах', min: 1, max: 52 },
  { name: 'minShare', label: 'Минимальная доля задач техдолга, %', min: 1, max: 100 },
  { name: 'minOpenTasks', label: 'Минимум незавершённых задач техдолга', min: 0, max: 40 },
];

export const debtPolicyFor = studio => ({
  enabled: false, every: 4, minShare: 60, minOpenTasks: 1, ...studio.debtPolicy,
});

export const debtPolicyHint = 'Период отсчитывается в спринтах после онбординга. Доля считается по числу рабочих задач в плане. Спринт техдолга планируется, когда в очереди достаточно незавершённых задач техдолга.';

export function renderDebtSettings(studio, { pending = false, error = '' } = {}) {
  const policy = debtPolicyFor(studio);
  const assessment = studio.debtAssessment;
  const date = new Date(assessment?.assessedAt);
  const time = Number.isFinite(date.getTime()) ? ` · <time datetime="${date.toISOString()}">${date.toLocaleString('ru-RU')}</time>` : '';
  return `<section class="stack compact"><h2>Спринты техдолга</h2>
    <div class="panel padded stack compact">
      <div class="row allowed-row"><h3>${policy.enabled ? 'Включён' : 'Выключен'} режим спринтов техдолга</h3>
        <button type="button" class="action secondary" data-open="debt-policy"${pending ? ' disabled' : ''}>Настроить вручную</button></div>
      <dl class="studio-meta">
        ${debtPolicyFields.map(({ name, label }) => `<dt>${label}</dt><dd>${safe(policy[name])}</dd>`).join('')}
      </dl>
      <p class="muted">${debtPolicyHint}</p>
      <div class="inline-result stack compact">
        <div class="row allowed-row"><h3>Оценка директора</h3>
          <button type="button" class="action secondary" data-assess-debt aria-disabled="${pending}">Оценить и настроить</button>
        </div>
        <p class="muted">Директор оценит очередь задач и сохранит параметры с пояснением.</p>
        <div role="status" aria-busy="${pending}">
          ${pending ? '<p>Директор оценивает техдолг…</p>' :
            assessment?.reason ? `<p class="muted">Последняя оценка${time}</p><p class="long-text">${safe(assessment.reason)}</p>` : ''}
        </div>
        ${error ? `<p class="error" role="alert">${safe(error)}</p>` : ''}
      </div>
    </div>
  </section>`;
}
