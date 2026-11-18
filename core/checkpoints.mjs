const text = (value, length) => typeof value === 'string' && value.length ? value.slice(0, length) : undefined;
const tail = (value, limit) => Array.isArray(value) ? value.slice(-limit) : [];
const defined = (fields) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));

export function buildTaskContext({ studioId, taskId, attemptId, task = {}, decisions, materials, operations, activeAttempts }) {
  const artifactPath = text(task.artifactPath, 480);
  const summary = text(task.summary, 2_000);
  const artifact = text(task.artifact, artifactPath ? 1_000 : 4_000);
  const priorDraft = summary || artifact || artifactPath ? defined({ summary, artifact, artifactPath }) : undefined;
  return defined({
    studioId, taskId, attemptId,
    priorDraft,
    review: text(task.review, 1_500),
    directorDecision: text(task.directorDecision, 1_500),
    decisions: tail(decisions, 8).filter(({ answer }) => typeof answer === 'string' && answer.length).map(({ question, body, answer }) => defined({
      question: text(question ?? body, 500), answer: text(answer, 700),
    })),
    artifactVersions: tail(task.artifactVersions, 10).map((path) => text(path, 480)).filter(Boolean),
    materials: tail(materials, 6).filter(({ sourceRef, path }) => sourceRef || path).map(({ sourceRef, path, excerpt }) => defined({
      sourceRef: text(sourceRef, 500), path: text(path, 480), excerpt: text(excerpt, 800),
    })),
    operations: tail(operations, 8).map(({ operationId, path, status }) => defined({
      operationId: text(operationId, 600), path: text(path, 480), status: text(status, 40),
    })),
    activeAttempts: tail(activeAttempts, 16).map(({ id, taskId, purpose, expiresAt }) => defined({
      id: text(id, 128), taskId: text(taskId, 128), purpose: text(purpose, 80), expiresAt: text(expiresAt, 40),
    })),
  });
}

export function createCheckpointStore({ list, insert, update, now = () => new Date() }) {
  const table = 'checkpoints';
  function get(studioId, taskId) {
    return list(table).find((entry) => entry.studioId === studioId && entry.taskId === taskId);
  }
  function save(input) {
    const { studioId, taskId, attemptId } = input;
    if (!studioId || !taskId) throw new Error('Контрольной точке нужны студия и задача.');
    const previous = get(studioId, taskId);
    const context = buildTaskContext(input);
    const entry = {
      id: JSON.stringify([studioId, taskId]), studioId, taskId, attemptId, updatedAt: now().toISOString(),
      context,
    };
    return previous ? update(table, entry) : insert(table, entry);
  }
  return { get, save };
}
