import { randomUUID } from 'node:crypto';

const pendingStatuses = new Set(['queued', 'running', 'waiting', 'reconcile']);
const holds = new Set(['running', 'reconcile']);
const outcomes = new Set(['completed', 'waiting', 'failed', 'reconcile', 'interrupted']);
const providerSteps = new Set(['plan', 'task', 'review', 'director', 'training-exercise']);
const temporaryCodes = new Set(['EAI_AGAIN', 'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENETDOWN', 'ENETUNREACH']);

function date(value) {
  return new Date(typeof value === 'number' && value < 10_000_000_000 ? value * 1000 : value);
}

export function unconfirmedProviderStop(error) {
  for (let cause = error; cause && typeof cause === 'object'; cause = cause.cause) {
    if (cause.processMayBeRunning || /Не удалось завершить процесс подключения/.test(cause.message ?? '')) return cause;
  }
}

function failureDetails(error, now) {
  const details = { message: (error instanceof Error ? error.message : String(error)).slice(0, 2_000) };
  for (let cause = error; cause && typeof cause === 'object'; cause = cause.cause) {
    const status = Number(cause.status ?? cause.statusCode ?? cause.code);
    const text = typeof cause.message === 'string' ? cause.message : '';
    details.effect ??= cause.effect;
    if (status === 401 || status === 403 || /\b(?:unauthorized|authentication required|invalid api key|not logged in)\b/i.test(text)) {
      details.action = 'authenticate';
    } else if (cause.code === 'GIT_CONFLICT' || /\b(?:merge conflict|rebase conflict|unmerged paths)\b/i.test(text)) {
      details.action = 'resolve-git-conflict';
    } else if (status === 429 || cause.code === 'RATE_LIMITED') {
      const retryAt = date(cause.retryAt ?? cause.resumeAt ?? cause.resetsAt);
      details.rateLimited = true;
      if (retryAt > now) details.retryAt = retryAt;
    }
    if (cause.transient === true || temporaryCodes.has(cause.code) || [408, 502, 503, 504].includes(status)
      || /Истекло время (?:проверки подключения|ожидания ответа)|Подключение Codex не ответило/i.test(text)) details.transient = true;
  }
  return details;
}

function occupiesSlot(attempt) {
  return attempt.status === 'running' || (attempt.status === 'reconcile' && attempt.processActive);
}

function sameWork(left, right) {
  return (left.taskId && left.taskId === right.taskId) || (left.worktree && left.worktree === right.worktree);
}

function jobKey({ studioId, taskId, purpose, planId, fileIndex, kind, operationId, targetId }) {
  return JSON.stringify([studioId, taskId, purpose, planId, fileIndex, kind, operationId, targetId]);
}

export function createDispatcher({ list, insert, update, transaction, now = () => new Date(), leaseMs = 5 * 60_000, maxFailures = 3, backoffMs = 1_000 }) {
  const jobTable = 'dispatch_jobs';
  const attemptTable = 'attempts';
  const jobs = (studioId) => list(jobTable).filter((job) => studioId === undefined || job.studioId === studioId);
  const attempts = (studioId) => list(attemptTable).filter((attempt) => attempt.jobId && (studioId === undefined || attempt.studioId === studioId));
  const findJob = (id) => jobs().find((job) => job.id === id);
  const activeAttempts = (studioId) => attempts(studioId).filter(occupiesSlot);

  function enqueue(job) {
    if (!job.studioId || !job.purpose) throw new Error('Запуску нужны студия и назначение.');
    if (job.id !== undefined) {
      const existing = findJob(job.id);
      if (existing) {
        if (jobKey(existing) !== jobKey(job) || existing.worktree !== job.worktree) throw new Error('Идентификатор уже занят другим запуском.');
        return existing;
      }
    }
    const key = jobKey(job);
    const existing = jobs(job.studioId).find((candidate) => pendingStatuses.has(candidate.status) && jobKey(candidate) === key);
    if (existing) return existing;
    const createdAt = now().toISOString();
    return insert(jobTable, {
      ...job, id: job.id ?? randomUUID(), status: 'queued', attemptId: undefined,
      createdAt, updatedAt: createdAt, reason: undefined, error: undefined, failureCount: 0,
    });
  }

  function releaseWaiting(jobId) {
    const job = findJob(jobId);
    if (job?.status !== 'waiting') return;
    return update(jobTable, { ...job, status: 'completed', reason: 'owner-response', updatedAt: now().toISOString() });
  }

  function claimAttempt({ studioId, jobId, taskId, purpose, attemptId = randomUUID(), expiresAt, limit = 1, canClaim = () => true }, onClaim) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Укажите целое положительное число одновременных запусков.');
    return transaction(() => {
      const timestamp = now();
      const startedAt = timestamp.toISOString();
      const until = expiresAt === undefined ? new Date(timestamp.getTime() + leaseMs) : date(expiresAt);
      if (!(until > timestamp)) throw new Error('Срок аренды попытки должен быть в будущем.');
      const allAttempts = attempts();
      const allJobs = jobs();
      const reserved = allAttempts.filter(({ status }) => holds.has(status));
      if (reserved.filter((attempt) => attempt.studioId === studioId && occupiesSlot(attempt)).length >= limit) return;
      const waiting = allJobs.filter(({ status }) => status === 'waiting');
      const job = allJobs.find((item) => item.studioId === studioId && item.status === 'queued'
        && (!jobId || item.id === jobId) && (!taskId || item.taskId === taskId) && (!purpose || item.purpose === purpose)
        && (!item.availableAt || date(item.availableAt) <= timestamp)
        && !reserved.some((attempt) => sameWork(attempt, item))
        && !waiting.some((other) => item.taskId && item.taskId === other.taskId) && canClaim(item));
      if (!job) return;
      const attempt = insert(attemptTable, {
        id: attemptId, jobId: job.id, studioId, taskId: job.taskId ?? null, worktree: job.worktree, purpose: job.purpose,
        operationId: job.operationId, sprintId: job.sprintId, status: 'running', startedAt, observedAt: startedAt, expiresAt: until.toISOString(),
        leaseMs: until.getTime() - timestamp.getTime(),
      });
      const result = { job: update(jobTable, { ...job, status: 'running', attemptId, updatedAt: startedAt }), attempt };
      onClaim?.(result);
      return result;
    });
  }

  function running(attemptId, at) {
    const attempt = attempts().find(({ id, status }) => id === attemptId && status === 'running');
    if (!attempt || (at && date(attempt.expiresAt) <= at)) return;
    const job = findJob(attempt.jobId);
    if (job?.status !== 'running' || job.attemptId !== attemptId) return;
    return { attempt, job };
  }

  function renewAttempt({ attemptId, observedAt, processId, heartbeat = false }) {
    return transaction(() => {
      const timestamp = now();
      const observed = observedAt === undefined ? timestamp : date(observedAt);
      const current = running(attemptId, heartbeat ? null : timestamp);
      if (!current || observed < date(current.attempt.observedAt) || observed > timestamp || Number.isNaN(observed.getTime())) return;
      return update(attemptTable, {
        ...current.attempt, expiresAt: new Date(observed.getTime() + current.attempt.leaseMs).toISOString(),
        ...(!heartbeat ? { observedAt: observed.toISOString() } : {}),
        ...(Number.isSafeInteger(processId) && processId > 0 ? { processId } : {}),
      });
    });
  }

  function transition(current, changes, onFinish) {
    const { status, jobStatus = status, reason, error, action, failureCount, retryAt, outcome, processActive, processUnconfirmed } = changes;
    const finishedAt = now().toISOString();
    const attempt = update(attemptTable, {
      ...current.attempt, status, reason, error, action, outcome, processActive, processUnconfirmed, finishedAt,
      ...(retryAt ? { retryAt: retryAt.toISOString() } : {}),
    });
    const job = update(jobTable, {
      ...current.job, status: jobStatus, reason, error, action, availableAt: retryAt?.toISOString(), updatedAt: finishedAt,
      ...(failureCount === undefined ? {} : { failureCount }),
    });
    const result = { job, attempt };
    onFinish?.(result);
    return result;
  }

  function finishAttempt({ attemptId, status, reason, error, outcome }, onFinish) {
    if (!outcomes.has(status)) throw new Error('Неизвестный исход запуска.');
    return transaction(() => {
      const current = running(attemptId, now());
      if (current) return transition(current, { status, reason, error, outcome }, onFinish);
    });
  }

  function failAttempt({ attemptId, error }, onFinish) {
    return transaction(() => {
      const timestamp = now();
      const current = running(attemptId, timestamp);
      if (!current) return;
      const failure = failureDetails(error, timestamp);
      const fields = { error: failure.message, action: failure.action };
      const shutdown = unconfirmedProviderStop(error);
      if (shutdown) {
        return transition(current, { ...fields, status: 'reconcile', reason: 'unknown-effect',
          processActive: Boolean(shutdown.processExited?.then), processUnconfirmed: true }, onFinish);
      }
      if (current.job.writes && failure.effect !== 'none') {
        return transition(current, { ...fields, status: 'reconcile', reason: 'unknown-effect' }, onFinish);
      }
      if (failure.action) return transition(current, { ...fields, status: 'failed', reason: failure.action }, onFinish);
      if (failure.retryAt) {
        return transition(current, { ...fields, status: 'retry', jobStatus: 'queued', reason: 'rate-limit', retryAt: failure.retryAt }, onFinish);
      }
      if (failure.transient || failure.rateLimited) {
        const failureCount = (current.job.failureCount ?? 0) + 1;
        if (failureCount < maxFailures) {
          const retryAt = new Date(timestamp.getTime() + backoffMs * 2 ** (failureCount - 1));
          return transition(current, { ...fields, status: 'retry', jobStatus: 'queued', reason: 'temporary-failure', failureCount, retryAt }, onFinish);
        }
        return transition(current, { ...fields, status: 'failed', reason: 'retries-exhausted', failureCount }, onFinish);
      }
      return transition(current, { ...fields, status: 'failed', reason: 'failed' }, onFinish);
    });
  }

  function reconcileStudio({ studioId, taskId, restart = false, stop = false, isActive = () => false }, onHold) {
    return transaction(() => {
      const timestamp = now();
      const results = [];
      for (const attempt of attempts(studioId)) {
        if (taskId && attempt.taskId !== taskId) continue;
        if (restart && attempt.status === 'reconcile') {
          const legacyUnknownStop = attempt.processUnconfirmed === undefined &&
            (unconfirmedProviderStop({ message: attempt.error }) || (attempt.processActive && providerSteps.has(attempt.purpose)));
          if (attempt.processActive || legacyUnknownStop) {
            update(attemptTable, { ...attempt, processActive: false, processUnconfirmed: legacyUnknownStop ? true : attempt.processUnconfirmed });
          }
        }
        if (attempt.status !== 'running' || (!restart && !stop && date(attempt.expiresAt) > timestamp)) continue;
        const job = findJob(attempt.jobId);
        if (!job) throw new Error('Не найдена запись прерванного запуска.');
        const reason = stop ? 'stopped' : restart ? 'restart' : 'lease-expired';
        const result = transition({ job, attempt }, { status: 'reconcile', reason, processActive: Boolean(isActive(attempt)) }, onHold);
        results.push(result);
      }
      return results;
    });
  }

  function recordUnconfirmedStop({ attemptId, shutdown }) {
    return transaction(() => {
      const attempt = attempts().find(({ id }) => id === attemptId);
      if (attempt?.status !== 'reconcile') return;
      return update(attemptTable, { ...attempt, processActive: Boolean(shutdown.processExited?.then), processUnconfirmed: true,
        error: failureDetails(shutdown, now()).message });
    });
  }

  function releaseProcess({ attemptId, confirmedExit = false }) {
    return transaction(() => {
      const attempt = attempts().find(({ id }) => id === attemptId);
      if (attempt?.status === 'reconcile' && (attempt.processActive || attempt.processUnconfirmed) && (!attempt.processUnconfirmed || confirmedExit)) {
        return update(attemptTable, { ...attempt, processActive: false, processUnconfirmed: false });
      }
    });
  }

  function resolveReconciliation({ attemptId, decision, reason, confirmProcessExited }, onResolve) {
    if (!['retry', 'complete', 'discard'].includes(decision) || typeof reason !== 'string' || !reason.trim()) {
      throw new Error('Укажите решение сверки и её результат.');
    }
    return transaction(() => {
      const attempt = attempts().find(({ id }) => id === attemptId);
      const job = attempt && findJob(attempt.jobId);
      if (attempt?.status !== 'reconcile' || job?.status !== 'reconcile') throw new Error('Эта сверка уже закрыта.');
      if (attempt.processActive) throw new Error('Прежний запуск ещё выполняется.');
      if (attempt.processUnconfirmed && confirmProcessExited !== true) throw new Error('Подтвердите, что прежний процесс завершился.');
      const stamp = now().toISOString();
      const status = decision === 'retry' ? 'queued' : decision === 'complete' ? 'completed' : 'interrupted';
      const result = {
        attempt: update(attemptTable, { ...attempt, status: decision === 'complete' ? 'completed' : 'interrupted',
          processUnconfirmed: false, reconciliation: { decision, reason: reason.trim(), resolvedAt: stamp,
            ...(attempt.processUnconfirmed ? { processExitConfirmedByOwner: true } : {}) } }),
        job: update(jobTable, { ...job, status, reason: `owner-${decision}`, error: undefined, action: undefined, failureCount: 0, availableAt: undefined, updatedAt: stamp }),
      };
      onResolve?.(result);
      return result;
    });
  }

  function delayUntil(studioId) {
    const timestamp = now();
    return jobs(studioId).filter((job) => job.status === 'queued' && job.availableAt && date(job.availableAt) > timestamp)
      .map(({ availableAt }) => availableAt).sort()[0] ?? null;
  }

  return {
    enqueue, jobs, findJob, releaseWaiting, activeAttempts, claimAttempt, renewAttempt, finishAttempt, failAttempt,
    reconcileStudio, recordUnconfirmedStop, releaseProcess, resolveReconciliation, delayUntil,
  };
}
