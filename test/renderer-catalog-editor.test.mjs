import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createModelCatalogEditor,
  filterModelCatalog,
  modelCatalogGroups,
} from '../renderer/model-catalog-editor.mjs';

const connected = {
  codex: {
    available: true,
    authenticated: true,
    models: [
      { id: 'starter', name: 'Базовая', efforts: ['low', 'medium'] },
      { id: 'empty', name: 'Стандартная', efforts: [] },
    ],
  },
  claude: {
    available: true,
    authenticated: true,
    models: [{ id: 'separate', name: 'Выбор', efforts: ['high'] }],
  },
};

test('catalog search covers display name, model ID and provider name', () => {
  const groups = modelCatalogGroups(connected, []);
  const found = query => filterModelCatalog(groups, query).flatMap(group => group.models.map(row => row.model));

  assert.deepEqual(found('БАЗОВАЯ'), ['starter']);
  assert.deepEqual(found('  EMP  '), ['empty']);
  assert.deepEqual(found('claude code'), ['separate']);
});

test('an inactive provider only contributes previously selected entries', () => {
  const allowed = [{ runtime: 'codex', model: 'starter', efforts: ['high'] }];
  for (const change of [{ available: false }, { authenticated: false }, { enabled: false }, { status: 'loading' }]) {
    const groups = modelCatalogGroups({ ...connected, codex: { ...connected.codex, ...change } }, allowed);

    assert.deepEqual(groups[0].models.map(({ model, catalog }) => [model, catalog]), [['starter', false]]);
    assert.deepEqual(groups[1].models.map(({ model, catalog }) => [model, catalog]), [['separate', true]]);
  }
});

test('automatic app policy displays discovered models as selected and saves the automatic mode', () => {
  const editor = createModelCatalogEditor({ providers: connected, policy: { configured: false, allowed: [] } });

  assert.equal([...editor.markup.matchAll(/data-model-choice=.*? checked/g)].length, 3);
  assert.deepEqual(editor.value(), { mode: 'all' });
});

test('a refreshed catalog preserves explicit offline entries and their saved efforts', () => {
  const allowed = [
    { runtime: 'codex', model: 'starter', efforts: ['high'] },
    { runtime: 'claude', model: 'manual', efforts: [] },
  ];
  const editor = createModelCatalogEditor({ providers: connected, policy: { configured: true, allowed } });
  editor.updateProviders({ codex: { enabled: false }, claude: { available: false } });

  assert.deepEqual(editor.value(), { mode: 'custom', allowed });
  assert.match(editor.markup, /data-model-choice=.*? checked[^>]*>[\s\S]*?starter/);
  assert.match(editor.markup, /data-model-choice=.*? checked[^>]*>[\s\S]*?manual/);
  assert.doesNotMatch(editor.markup, /Стандартная/);
});

test('legacy empty policies are preserved through an explicit director option', () => {
  const app = createModelCatalogEditor({ policy: { configured: true, allowed: [] } });
  const studio = createModelCatalogEditor({ studio: { allowedMode: 'studio', allowed: [] } });
  const inherited = createModelCatalogEditor({ studio: { allowedMode: 'app', allowed: [] } });

  assert.deepEqual(app.value(), { mode: 'director' });
  assert.deepEqual(studio.value(), { allowedMode: 'studio', allowed: [] });
  assert.deepEqual(inherited.value(), { allowedMode: 'app' });
});

test('empty custom selection fails validation', () => {
  const editor = createModelCatalogEditor({ policy: { mode: 'custom', allowed: [] } });
  assert.throws(() => editor.value(), /выберите.*модель/i);
});

test('provider text is escaped wherever it is included in the editor markup', () => {
  const source = '<script>alert("item")</script>';
  const editor = createModelCatalogEditor({
    providers: { codex: { available: true, authenticated: true, models: [{ id: source, name: source, efforts: [source] }] } },
  });
  assert.doesNotMatch(editor.markup, /<script>/i);
  assert.match(editor.markup, /&lt;script&gt;/i);
});
