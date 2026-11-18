import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWork } from '../renderer/work-view.mjs';

test('debt policy shows its thresholds and director feedback', async () => {
  const { renderDebtSettings } = await import('../renderer/debt-view.mjs');
  const defaults = renderDebtSettings({});
  assert.match(defaults, /Выключен[^]*?4[^]*?60[^]*?1/);
  assert.match(defaults, /числу рабочих задач/);
  assert.match(defaults, /Оценить и настроить/);
  const policy = { enabled: true, every: 3, minShare: 65, minOpenTasks: 4 };
  const html = renderDebtSettings({ debtPolicy: policy, debtAssessment: { reason: '<текст>' } });
  assert.match(html, /Включён[^]*?3[^]*?65[^]*?4[^]*?&lt;текст&gt;/);
  assert.match(renderDebtSettings({ debtPolicy: policy }, { pending: true }), /aria-busy="true"[^]*?Директор оценивает/);
  assert.match(renderDebtSettings({ debtPolicy: policy }, { error: '<ошибка>' }), /role="alert"[^]*?&lt;ошибка&gt;/);
});

test('work view identifies debt tasks, runs and sprint proposals explicitly', () => {
  const tasks = [
    { id: 'normal', title: 'Обычная задача' },
    { id: 'debt', title: 'Убрать дублирование', kind: 'debt', sprintId: 's1' },
  ];
  const work = {
    tasks,
    sprints: [{ id: 's1', title: 'Завершение миграции', debtSprint: true }],
    plans: [{ id: 'p1', kind: 'sprint', title: 'Новый спринт', debtSprint: true }],
  };
  const board = renderWork(work);
  assert.match(board, /data-task-kind="debt"[^]*?Убрать дублирование[^]*?Техдолг/);
  assert.equal((board.match(/Техдолг/g) ?? []).length, 1);
  const sprints = renderWork({ ...work, tab: 'sprints' });
  assert.match(sprints, /Новый спринт[^]*?Спринт техдолга[^]*?Завершение миграции[^]*?Спринт техдолга/);
});
