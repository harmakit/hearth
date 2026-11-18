const json = (value) => ({ text: JSON.stringify(value) });

export function trainingReply({ purpose, prompt }) {
  if (prompt.startsWith('Prepare a studio agent')) return json({ summary: 'Prepared', selectedSkillIds: [], guide: 'Practice the assignment.' });
  if (prompt.startsWith('Review the studio agent')) return json({ pass: true, summary: 'Verified' });
  if (purpose === 'training-exercise') return json({ summary: 'Practice complete' });
  if (purpose === 'select-model') {
    const { purpose: target, allowed } = JSON.parse(prompt.split('\n\n').at(-1));
    if (target === 'training-exercise') return json(allowed[0]);
  }
}

export function productionSnapshot(snapshot) {
  const trainingIds = new Set(snapshot.training.map(({ id }) => id));
  return {
    ...snapshot,
    tasks: snapshot.tasks.filter(({ kind }) => kind !== 'train').map((task) => ({ ...task, dependencies: task.dependencies.filter((id) => !trainingIds.has(id)) })),
  };
}
