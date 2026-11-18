const presets = {
  codex: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
};

export function catalogEfforts(runtime, model, provider) {
  const match = provider?.models?.find(entry => entry.id === model);
  if (Array.isArray(match?.efforts)) return match.efforts;
  return provider?.efforts ?? presets[runtime] ?? [];
}

export function modelKey({ runtime, model }) {
  return JSON.stringify([runtime, model]);
}

export function fixedModelChoices(allowed) {
  const choices = new Map();
  for (const { runtime, model, efforts } of allowed ?? []) {
    if (!model) continue;
    const key = modelKey({ runtime, model });
    if (!choices.has(key)) choices.set(key, { runtime, model, efforts: [] });
    const choice = choices.get(key);
    choice.efforts = [...new Set([...choice.efforts, ...(efforts?.length ? efforts : [''])])];
  }
  return [...choices.values()];
}

export function readPolicyRows(rows) {
  const seen = new Set();
  return rows.map(({ runtime, model, efforts }) => {
    const entry = { runtime, model: model.trim(), efforts };
    if (!entry.model) throw new Error('Укажите модель или уберите незаполненную строку.');
    const key = modelKey(entry);
    if (seen.has(key)) throw new Error('Укажите каждую модель подключения только один раз.');
    seen.add(key);
    return entry;
  });
}
