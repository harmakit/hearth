import {copy as uiCopy} from './copy.mjs';
import { modelKey } from './model-policy.mjs';

const labels = { codex: 'Codex', claude: 'Claude Code' };
const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const safe = value => String(value ?? '').replace(/[&<>"']/g, symbol => entities[symbol]);
const eligible = info => info?.available === true && info.authenticated === true && info.enabled !== false &&
  !info.loading && info.status !== 'loading';
const option = (value, label, mode) => `<option value="${value}"${value === mode ? ' selected' : ''}>${label}</option>`;
const keyOf = (runtime, model) => modelKey({ runtime, model });
const effortsOf = row => Array.isArray(row.efforts) ? [...new Set(row.efforts.filter(effort => typeof effort === 'string' && effort.trim()))] : [];

export function modelCatalogGroups(providers, allowed) {
  return Object.keys(labels).map(runtime => {
    const provider = providers[runtime];
    const rows = new Map();
    const models = eligible(provider) && Array.isArray(provider.models) ? provider.models : [];
    for (const model of models) {
      if (typeof model?.id === 'string' && model.id.trim()) {
        rows.set(model.id, { runtime, model: model.id, name: model.name || model.id, efforts: effortsOf(model), catalog: true });
      }
    }
    for (const entry of allowed) {
      if (entry.runtime === runtime && !rows.has(entry.model)) {
        rows.set(entry.model, { runtime, model: entry.model, name: entry.model, efforts: effortsOf(entry), catalog: false });
      }
    }
    return { runtime, label: labels[runtime], models: [...rows.values()] };
  });
}

export function filterModelCatalog(groups, query) {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return groups.map(group => ({
    ...group, models: group.models.filter(row => {
      const text = `${group.label} ${row.name} ${row.model}`.toLocaleLowerCase();
      return words.every(word => text.includes(word));
    }),
  }));
}

const choices = groups => new Map(groups.flatMap(({ models }) =>
  models.map(({ runtime, model, efforts }) => [keyOf(runtime, model), { runtime, model, efforts }])));
const appMode = policy => policy?.mode || (policy?.configured ? (policy.allowed.length ? 'custom' : 'director') : 'all');
const copy = allowed => new Map((allowed ?? []).map(row => [modelKey(row), { ...row, efforts: effortsOf(row) }]));

export function createModelCatalogEditor({ providers = {}, policy, appPolicy, studio } = {}) {
  let mode = studio ? (studio.allowedMode !== 'studio' ? 'app' : studio.allowed.length ? 'custom' : 'director') : appMode(policy);
  let selected = copy(studio ? studio.allowed : policy?.allowed);
  const manual = new Map();
  let root;
  let error = '';
  let open = new Set();
  const activeSelection = () => {
    if (mode === 'all' || (mode === 'app' && appMode(appPolicy) === 'all')) return choices(modelCatalogGroups(providers, []));
    if (mode === 'app') return copy(appPolicy?.allowed);
    if (mode === 'director') return new Map();
    return selected;
  };
  const visibleGroups = () => filterModelCatalog(modelCatalogGroups(providers, [...activeSelection().values(), ...manual.values()]),
    root?.querySelector('[data-model-search]').value ?? '');
  const countMarkup = () => {
    const count = activeSelection().size;
    const modeLabel = {
      all: uiCopy('Все обнаруженные модели разрешены'),
      app: uiCopy('Действует политика приложения'),
      custom: uiCopy('Свой список разрешённых моделей'),
      director: uiCopy('Действуют модель и усилие директора'),
    }[mode];
    return uiCopy`${modeLabel}. Выбрано моделей: ${count}.`;
  };

  function listMarkup() {
    const groups = visibleGroups();
    const active = activeSelection();
    if (mode === 'director') return uiCopy('<p class="muted">Агенты с автоматическим выбором используют настройки директора.</p>');
    if (!groups.some(group => group.models.length)) {
      if (Object.values(providers).some(info => info?.loading)) return uiCopy('<p class="muted">Подгружаем каталоги подключений…</p>');
      return `<p class="muted">${root?.querySelector('[data-model-search]').value.trim()
        ? uiCopy('По этому запросу моделей нет.') : uiCopy('Каталог пока недоступен. Можно добавить идентификатор вручную.')}</p>`;
    }
    return groups.filter(group => group.models.length).map(group => uiCopy`<section class="catalog-group panel">
      <header class="row"><h3>${group.label}</h3><div class="actions">
        <button class="text-button" type="button" data-model-bulk="select" data-model-group="${group.runtime}">Выбрать</button>
        <button class="text-button" type="button" data-model-bulk="clear" data-model-group="${group.runtime}">Снять выбор</button>
      </div></header>
      <ul class="catalog-models">${group.models.map(row => {
        const key = modelKey(row);
        const chosen = active.get(key);
        const levels = [...new Set([...row.efforts, ...(chosen?.efforts ?? [])])];
        return `<li class="catalog-model">
          <label class="checkbox-field catalog-choice"><input type="checkbox" data-model-choice="${safe(key)}" data-model-runtime="${row.runtime}" data-model-id="${safe(row.model)}"${chosen ? ' checked' : ''}>
          <span><strong>${safe(row.name)}</strong>${row.name !== row.model ? `<small>${safe(row.model)}</small>` : ''}
          ${row.catalog ? '' : uiCopy('<small>Сохранённый идентификатор</small>')}</span></label>
          ${chosen && levels.length ? uiCopy`<details data-model-detail="${safe(key)}"${open.has(key) ? ' open' : ''}><summary>Усилие · ${safe(chosen.efforts.join(', ') || uiCopy('По умолчанию'))}</summary>
            <div class="policy-efforts">${levels.map(level => `<label class="checkbox-field"><input type="checkbox" data-model-effort="${safe(key)}" value="${safe(level)}"${chosen.efforts.includes(level) ? ' checked' : ''}> <span>${safe(level)}</span></label>`).join('')}</div>
          </details>` : ''}
        </li>`;
      }).join('')}</ul></section>`).join('');
  }

  function markup() {
    return uiCopy`<div class="policy-editor" data-model-catalog-editor>
      <label class="field"><span>Как выбирать модели</span><select data-model-mode>
        ${studio ? option('app', uiCopy('Настройки приложения'), mode) : option('all', uiCopy('Все доступные модели'), mode)}
        ${option('custom', uiCopy('Свой список'), mode)}${option('director', uiCopy('Как у директора'), mode)}</select></label>
      <p class="muted" role="status" data-model-count>${countMarkup()}</p>
      <div class="policy-editor" data-model-controls${mode === 'director' ? ' hidden' : ''}>
        <label class="field"><span>Поиск моделей</span><input type="search" data-model-search placeholder="Название, идентификатор или провайдер"></label>
        <div class="actions"><button class="action secondary" type="button" data-model-bulk="select">Выбрать найденные</button>
          <button class="action secondary" type="button" data-model-bulk="clear">Снять выбор найденных</button></div>
      </div>
      <div class="policy-editor" data-model-list>${listMarkup()}</div>
      <details class="advanced"><summary>Добавить модель по идентификатору</summary>
        <div class="policy-controls">
          <label class="field"><span>Провайдер</span><select data-model-manual-runtime><option value="codex">Codex</option><option value="claude">Claude Code</option></select></label>
          <label class="field"><span>Идентификатор модели</span><input type="text" data-model-manual-id maxlength="200"></label>
        </div>
        <div class="actions"><button class="action secondary" type="button" data-model-add>Добавить в свой список</button></div>
        <p class="error" data-model-error role="status" hidden></p>
      </details>
    </div>`;
  }

  function render() {
    if (!root) return;
    const focused = root.ownerDocument.activeElement;
    const marker = ['modelChoice', 'modelEffort', 'modelDetail', 'modelBulk'].find(name => focused?.dataset[name] != null);
    const focusKey = marker && [focused.dataset[marker], focused.value, focused.dataset.modelGroup];
    open = new Set([...root.querySelectorAll('[data-model-detail][open]')].map(el => el.dataset.modelDetail));
    root.querySelector('[data-model-mode]').value = mode;
    root.querySelector('[data-model-controls]').hidden = mode === 'director';
    root.querySelector('[data-model-count]').textContent = countMarkup();
    root.querySelector('[data-model-list]').innerHTML = listMarkup();
    const note = root.querySelector('[data-model-error]');
    note.textContent = error;
    note.hidden = !error;
    if (marker && !focused.isConnected) {
      const replacement = [...root.querySelectorAll('button, input, summary')].find(el =>
        el.dataset[marker] === focusKey[0] && el.value === focusKey[1] && el.dataset.modelGroup === focusKey[2]);
      (replacement ?? root.querySelector('[data-model-search]')).focus();
    }
  }

  function custom() {
    if (mode === 'custom') return;
    selected = activeSelection();
    mode = 'custom';
  }

  function mount(container) {
    root = container;
    root.addEventListener('input', event => {
      if (event.target.matches('[data-model-search]')) render();
    });
    root.addEventListener('change', ({ target }) => {
      if (target.matches('[data-model-mode]')) {
        if (target.value === 'custom') custom();
        else mode = target.value;
      } else if (target.matches('[data-model-choice]')) {
        const key = target.dataset.modelChoice;
        const row = choices(visibleGroups()).get(key);
        if (!row) return;
        custom();
        if (target.checked) selected.set(key, row);
        else selected.delete(key);
      } else if (target.matches('[data-model-effort]')) {
        custom();
        const entry = selected.get(target.dataset.modelEffort);
        if (entry) entry.efforts = target.checked ? [...new Set([...entry.efforts, target.value])] : entry.efforts.filter(level => level !== target.value);
      } else return;
      render();
    });
    root.addEventListener('click', ({ target }) => {
      const bulk = target.closest('[data-model-bulk]');
      if (bulk) {
        const found = choices(visibleGroups().filter(group => !bulk.dataset.modelGroup || group.runtime === bulk.dataset.modelGroup));
        if (!found.size) return;
        custom();
        for (const [key, row] of found) {
          if (bulk.dataset.modelBulk === 'clear') selected.delete(key);
          else if (!selected.has(key)) selected.set(key, row);
        }
      } else if (target.closest('[data-model-add]')) {
        const field = root.querySelector('[data-model-manual-id]');
        const model = field.value.trim();
        if (!model) { error = uiCopy('Введите идентификатор модели.'); field.focus(); render(); return; }
        const runtime = root.querySelector('[data-model-manual-runtime]').value;
        const key = keyOf(runtime, model);
        const row = choices(modelCatalogGroups(providers, [])).get(key) ?? { runtime, model, efforts: [] };
        custom();
        manual.set(key, row);
        selected.set(key, row);
        error = '';
        field.value = '';
        root.querySelector('[data-model-search]').value = '';
      } else return;
      render();
    });
  }

  function value() {
    if (mode === 'custom' && !selected.size) throw new Error(uiCopy('Выберите хотя бы одну модель или смените режим.'));
    const allowed = mode === 'custom' ? [...selected.values()].map(row => ({ ...row, efforts: [...row.efforts] })) : [];
    if (studio) return mode === 'app' ? { allowedMode: 'app' } : { allowedMode: 'studio', allowed };
    return mode === 'custom' ? { mode, allowed } : { mode };
  }

  return { get markup() { return markup(); }, mount, value, updateProviders(next) { providers = next; render(); } };
}
