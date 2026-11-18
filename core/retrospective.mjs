import { hasPoints } from './debt.mjs';

export const RETROSPECTIVE_METHOD_VERSION = 1;

function measurement(tasks) {
  const taskIds = tasks.map(({ id }) => id);
  const missingPointTaskIds = tasks.filter(({ points }) => !hasPoints(points)).map(({ id }) => id);
  const knownPoints = tasks.reduce((total, { points }) => total + (hasPoints(points) ? points : 0), 0);
  return { count: tasks.length, taskIds, points: missingPointTaskIds.length ? null : knownPoints, knownPoints, missingPointTaskIds };
}

function delta(task, keys) {
  const prior = task.carryoverHistory?.at(-1);
  const number = (record) => keys.map((key) => record?.[key]).find(Number.isFinite) ?? 0;
  return Math.max(0, number(task) - number(prior));
}

export function retrospectiveFacts({ sprint, tasks, attempts, carryovers = [] }) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const membership = [...new Set(sprint.taskIds ?? [])];
  const members = membership.flatMap((id) => byId.has(id) ? [byId.get(id)] : []);
  const work = members.filter(({ kind }) => kind !== 'train');
  const plannedById = new Map((sprint.plannedWork ?? []).map((task) => [task.id, task]));
  const originalWork = work.map((task) => plannedById.get(task.id) ?? task);
  const accepted = work.filter(({ stage }) => stage === 'done');
  const carried = new Set(carryovers.map(({ taskId }) => taskId));
  const reviewAttempts = attempts.filter(({ taskId, purpose }) => membership.includes(taskId) && purpose === 'review');
  const workIds = new Set(work.map(({ id }) => id));
  const qaAttempts = reviewAttempts.filter(({ taskId }) => workIds.has(taskId));
  const evidence = work.filter(({ review, failedReviews }) => review || failedReviews !== undefined);
  const taskChecks = new Map(work.map((task) => [task.id, (task.gitDelivery?.checks ?? []).filter(({ finishedAt }) =>
    !sprint.createdAt || !finishedAt || finishedAt >= sprint.createdAt)]));
  const checks = [...taskChecks.values()].flat();
  return {
    methodVersion: RETROSPECTIVE_METHOD_VERSION,
    studioId: sprint.studioId,
    sprintId: sprint.id,
    planned: measurement(originalWork),
    accepted: measurement(accepted),
    carried: measurement(work.filter(({ id }) => carried.has(id))),
    blocked: measurement(work.filter(({ stage }) => stage === 'blocked')),
    replaced: measurement(work.filter(({ stage }) => stage === 'replaced')),
    training: { count: members.length - work.length, accepted: members.filter(({ kind, stage }) => kind === 'train' && stage === 'done').length },
    rework: { cycles: work.reduce((sum, task) => sum + delta(task, ['revision', 'failedReviews']), 0) },
    debt: measurement(tasks.filter(({ kind, stage, status }) => kind === 'debt' && !['done', 'replaced'].includes(stage) && !['cancelled', 'canceled'].includes(status))),
    qa: {
      reviewAttempts: qaAttempts.length,
      completedReviewAttempts: qaAttempts.filter(({ status }) => status === 'completed').length,
      failedReviewAttempts: qaAttempts.filter(({ status }) => status === 'failed').length,
      rejectedReviews: evidence.length ? evidence.reduce((sum, task) => sum + delta(task, ['failedReviews']), 0) : null,
      missingReviewTaskIds: work.filter((task) => !evidence.includes(task) && !qaAttempts.some(({ taskId }) => taskId === task.id)).map(({ id }) => id),
      checks: checks.length ? {
        total: checks.length,
        passed: checks.filter(({ status }) => status === 'PASS').length,
        failed: checks.filter(({ status }) => status === 'FAIL').length,
        notAssessed: checks.filter(({ status }) => status === 'NOT ASSESSED').length,
      } : null,
      missingCheckTaskIds: work.filter(({ id }) => !taskChecks.get(id).length).map(({ id }) => id),
    },
    missingTaskIds: membership.filter((id) => !byId.has(id)),
  };
}
