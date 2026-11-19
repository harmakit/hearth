import { createHash } from 'node:crypto';

const counters = ['input', 'output', 'cacheRead', 'cacheWrite'];
const providers = new Map([['codex', 'OpenAI'], ['claude', 'Anthropic']]);

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function identifier(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(value) ? value : null;
}

function label(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null;
}

function timestamp(value) {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) ? time.toISOString() : null;
}

function tokenTotals(events) {
  const totals = Object.fromEntries(counters.map((key) => [key, null]));
  for (const event of events) {
    for (const key of counters) {
      const measured = count(event[key]);
      if (measured !== null) totals[key] = (totals[key] ?? 0) + measured;
    }
  }
  return totals;
}

function usageBy(events, keys) {
  const groups = new Map();
  for (const event of events) {
    const group = Object.fromEntries(keys.map((key) => [key, event[key]]));
    const id = JSON.stringify(group);
    if (!groups.has(id)) groups.set(id, { group, events: [] });
    groups.get(id).events.push(event);
  }
  return [...groups.values()].map(({ group, events }) => ({ ...group, ...tokenTotals(events), events: events.length }));
}

function estimatedCost(events, tariffs) {
  if (!events.length || !Array.isArray(tariffs)) return null;
  let amount = 0;
  let currency;
  for (const event of events) {
    const rate = tariffs.find((rate) => rate?.runtime === event.runtime && rate.model === event.model);
    if (!rate || !/^[A-Z]{3}$/.test(rate.currency) || (currency && currency !== rate.currency)) return null;
    currency = rate.currency;
    let input = count(event.input);
    if (input !== null) {
      if (count(event.cacheRead) !== null) input -= event.cacheRead;
      if (count(event.cacheWrite) !== null) input -= event.cacheWrite;
      if (input < 0) return null;
    }
    const billable = { ...event, input };
    for (const key of counters) {
      const unitRate = rate[key];
      const tokens = count(billable[key]);
      if (unitRate === undefined && key.startsWith('cache')) {
        if (tokens > 0) return null;
        continue;
      }
      if (!Number.isFinite(unitRate) || unitRate < 0 || tokens === null) return null;
      amount += tokens * unitRate / 1_000_000;
    }
  }
  return { amount, currency, estimated: true };
}

function subscriptionUsage(value) {
  if (!value || !Number.isFinite(value.usedPercent) || value.usedPercent < 0 || value.usedPercent > 100) return null;
  return { usedPercent: value.usedPercent, resetsAt: timestamp(value.resetsAt) };
}

export function createUsage({ list, insert, now = () => new Date().toISOString() }) {
  function recordUsage(event, context = {}) {
    const studioId = identifier(context.studioId ?? event?.studioId);
    const attemptId = identifier(event?.attemptId ?? context.attemptId);
    const eventId = identifier(event?.eventId);
    const runtime = identifier(event?.runtime ?? context.runtime);
    if (!studioId || !attemptId || !eventId || !runtime) throw new Error('Не указан источник события расхода.');
    const id = createHash('sha256').update(JSON.stringify([studioId, attemptId, eventId])).digest('hex');
    const saved = list('usageEvents').find((row) => row.id === id);
    if (saved) return saved;
    return insert('usageEvents', {
      id, studioId, attemptId, eventId, runtime, provider: providers.get(runtime) ?? runtime,
      model: label(event.model ?? context.model), role: label(context.role ?? event.role),
      ...Object.fromEntries(counters.map((key) => [key, count(event[key])])),
      capturedAt: timestamp(event.capturedAt) ?? timestamp(now()),
    });
  }

  function studioUsage(studioId, { tariffs, subscription } = {}) {
    const events = list('usageEvents').filter((event) => event.studioId === studioId);
    return {
      studioId, events, totals: tokenTotals(events),
      byRole: usageBy(events, ['role']),
      byModel: usageBy(events, ['runtime', 'provider', 'model']),
      byProvider: usageBy(events, ['runtime', 'provider']),
      byAttempt: usageBy(events, ['attemptId']),
      estimatedCost: estimatedCost(events, tariffs),
      subscription: subscriptionUsage(subscription),
    };
  }

  return { recordUsage, studioUsage };
}

const lifecycles = ['draft', 'planning', 'active', 'idle', 'paused', 'error', 'stopped'];
const connectionStatuses = ['available', 'unavailable', 'unknown', 'connected', 'disconnected', 'needs-auth'];
const processStatuses = ['idle', 'running', 'waiting', 'stopping', 'interrupted', 'unknown'];
const errorKinds = ['authorization', 'rate-limit', 'git-conflict', 'transient', 'interrupted', 'unknown', 'configuration', 'provider'];
const actions = ['reconnect', 'retry', 'reconcile', 'wait', 'inspect', 'resolve-conflict', 'restart', 'resume'];

function oneOf(value, choices, fallback = null) {
  return choices.includes(value) ? value : fallback;
}

export function diagnoseStudioState({ studio, connection, process, schedule, queue, error, action }) {
  return {
    studioId: identifier(studio?.id),
    lifecycle: oneOf(studio?.lifecycle, lifecycles),
    manualPaused: studio?.manualPaused === true,
    connection: {
      runtime: oneOf(connection?.runtime, [...providers.keys()]),
      status: oneOf(connection?.status, connectionStatuses, 'unknown'),
    },
    process: {
      status: oneOf(process?.status, processStatuses, 'unknown'),
      pid: count(process?.pid),
      attemptId: identifier(process?.attemptId),
      startedAt: timestamp(process?.startedAt),
    },
    schedule: {
      waiting: schedule?.waiting === true,
      nextAt: timestamp(schedule?.nextAt),
    },
    queue: {
      pending: count(queue?.pending),
      active: count(queue?.active),
    },
    lastError: error ? {
      kind: oneOf(error.kind, errorKinds, 'unknown'),
      at: timestamp(error.at),
      retryAt: timestamp(error.retryAt),
    } : null,
    action: oneOf(action, actions),
  };
}
