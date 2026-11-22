import { createHash, randomUUID } from 'node:crypto';

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/;
const historyLimit = 24;
const historyTextLimit = 24_000;

function identifier(value, label, required = false) {
  if (!required && (value === undefined || value === null)) return null;
  if (typeof value !== 'string' || !idPattern.test(value)) throw new Error(`Недопустимый идентификатор (${label}).`);
  return value;
}

function messageText(value) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > 12_000) throw new Error('Недопустимый текст сообщения.');
  return value.trim();
}

function attachments(value = []) {
  if (!Array.isArray(value) || value.length > 20) throw new Error('Недопустимый список вложений.');
  return [...new Set(value.map((id) => identifier(id, 'вложение', true)))];
}

function keyFor(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function prepareInboxAnswer(item, input) {
  const version = item.version ?? 1;
  const answerVersion = input.version ?? 1;
  const answerOperationId = identifier(input.operationId, 'операция');
  const choiceId = identifier(input.choiceId, 'вариант ответа');
  const attachmentIds = attachments(input.attachmentIds);
  const freeText = messageText(input.answer);
  const requestedDecision = identifier(input.decision, 'решение');
  const answerKey = keyFor([answerVersion, choiceId, attachmentIds, freeText, requestedDecision,...(input.reworkTaskId ? [input.reworkTaskId] : [])]);
  if (!Number.isSafeInteger(answerVersion) || answerVersion < 1 || answerVersion !== version) {
    throw new Error('Версия вопроса изменилась. Откройте его заново.');
  }
  if (answerOperationId && item.answerOperationId === answerOperationId) {
    if (item.answerKey !== answerKey) throw new Error('Операция уже использована для другого ответа.');
    return { duplicate: true, answer: item.answer, decision: item.answerDecision, response: {} };
  }
  if (item.status !== 'open') throw new Error('Сообщение уже закрыто.');

  const choices = item.choices ?? item.options;
  const choice = choiceId && Array.isArray(choices) && choices.find((entry) => entry?.id === choiceId);
  if (choiceId && !choice) throw new Error('Выбранный вариант ответа недоступен.');
  const decision = choice?.decision ?? requestedDecision ?? undefined;
  const answer = freeText || choice?.answer || choice?.label || choice?.title || choice?.text || choiceId || (attachmentIds.length ? 'Вложения' : '');
  if (item.kind === 'question' && !answer) throw new Error('Укажите ответ, вариант или вложение.');
  return {
    duplicate: false, answer, decision,
    response: { version, choiceId, attachmentIds, answerVersion, answerOperationId, answerKey, answerDecision: decision },
  };
}

export function createConversations({
  read, list, insert, update, transaction, changed = (value) => value,
  now = () => new Date().toISOString(), queue = () => {},
}) {
  function postStudioMessage(input, directorInbox) {
    const studio = read('studios', input.studioId, 'Студия');
    const text = messageText(input.text);
    const attachmentIds = attachments(input.attachmentIds);
    const operationId = identifier(input.operationId, 'операция');
    if (!text && !attachmentIds.length) throw new Error('Введите сообщение или добавьте вложение.');

    const conversationId = identifier(input.conversationId, 'беседа');
    const existing = conversationId ? read('conversations', conversationId, 'Беседа') : null;
    const agentId = input.agentId === undefined ? existing?.agentId ?? null : identifier(input.agentId, 'агент');
    const taskId = input.taskId === undefined ? existing?.taskId ?? null : identifier(input.taskId, 'задача');
    if (existing && (existing.studioId !== studio.id || existing.agentId !== agentId || existing.taskId !== taskId ||
      existing.inboxId !== directorInbox?.inboxId)) {
      throw new Error('Беседа относится к другому адресату или задаче.');
    }
    const kind = input.kind ?? (agentId ? 'chat' : 'note');
    if (!['chat', 'note','comment'].includes(kind) || (kind === 'note' && agentId) || (kind === 'comment' && (!taskId || agentId))) {
      throw new Error('Записку можно адресовать директору.');
    }
    const operationKey = keyFor([agentId, taskId, kind, text, attachmentIds, ...(directorInbox ? [directorInbox] : [])]);
    const messageId = operationId ? keyFor([studio.id, operationId]) : randomUUID();

    const { message, created } = transaction(() => {
      const saved = operationId && list('conversationMessages').find(({ id }) => id === messageId);
      if (saved) {
        if (saved.operationKey !== operationKey || (conversationId && saved.conversationId !== conversationId)) {
          throw new Error('Операция уже использована для другого сообщения.');
        }
        return { message: saved, created: false };
      }

      if (agentId && !studio.agents.some(({ id }) => id === agentId)) throw new Error('Агент не найден.');
      if (taskId && read('tasks', taskId, 'Задача').studioId !== studio.id) throw new Error('Задача относится к другой студии.');
      const createdAt = now();
      const conversation = existing ?? list('conversations').find((row) =>
        row.studioId === studio.id && row.agentId === agentId && row.taskId === taskId && row.inboxId === directorInbox?.inboxId)
        ?? insert('conversations', { id: randomUUID(), studioId: studio.id, agentId, taskId, createdAt,
          ...(directorInbox ? {inboxId:directorInbox.inboxId} : {}),
        });
      const message = insert('conversationMessages', {
        id: messageId, studioId: studio.id, conversationId: conversation.id, author: 'owner',
        kind, status: kind==='comment' ? 'processed' : 'queued', text, attachmentIds, operationId, operationKey, createdAt,
        ...(directorInbox ? {directorInbox} : {}),
      });
      return { message, created: true };
    });

    if (created) {
      changed(message);
      if (kind!=='comment') queue(studio.id);
    }
    return message;
  }

  function conversationHistory({ studioId, conversationId, agentId = null, taskId = null }) {
    const conversation = conversationId
      ? read('conversations', conversationId, 'Беседа')
      : list('conversations').find((row) => row.studioId === studioId && row.agentId === agentId && row.taskId === taskId && !row.inboxId);
    if (!conversation || conversation.studioId !== studioId) return [];
    const recent = list('conversationMessages').filter((row) => row.conversationId === conversation.id).slice(-historyLimit);
    let remaining = historyTextLimit;
    const bounded = [];
    for (const message of recent.reverse()) {
      remaining -= message.text.length;
      if (remaining < 0) break;
      bounded.push(message);
    }
    return bounded.reverse();
  }

  function pendingMessages(studioId) {
    return list('conversationMessages').filter((message) =>
      message.studioId === studioId && message.author === 'owner' && message.status === 'queued');
  }

  function receiveMessage({ messageId, attemptId }) {
    identifier(attemptId, 'попытка', true);
    const { message, received } = transaction(() => {
      const current = read('conversationMessages', messageId, 'Сообщение');
      if (current.author !== 'owner') throw new Error('Сообщение уже обработано.');
      if (current.status === 'received' && current.attemptId === attemptId) return { message: current };
      if (current.status !== 'queued') throw new Error('Сообщение уже принято.');
      const message = update('conversationMessages', { ...current, status: 'received', attemptId, receivedAt: now() });
      return { message, received: true };
    });
    return received ? changed(message) : message;
  }

  function replyToMessage({ messageId, attemptId, text: rawText, attachmentIds: rawAttachments, outcome }) {
    identifier(attemptId, 'попытка', true);
    const text = messageText(rawText);
    const attachmentIds = attachments(rawAttachments);
    const processedOutcome = identifier(outcome ?? 'answered', 'результат', true);
    if (!text && !attachmentIds.length) throw new Error('Укажите результат обработки сообщения.');
    const { reply, created } = transaction(() => {
      const message = read('conversationMessages', messageId, 'Сообщение');
      if (message.author !== 'owner' || message.attemptId !== attemptId || message.status === 'queued') {
        throw new Error('Эта попытка не получала сообщение.');
      }
      if (message.status === 'processed') return { reply: read('conversationMessages', message.replyId, 'Ответ') };
      const conversation = read('conversations', message.conversationId, 'Беседа');
      const createdAt = now();
      const reply = insert('conversationMessages', {
        id: randomUUID(), studioId: message.studioId, conversationId: conversation.id,
        author: conversation.agentId ? 'agent' : 'director', kind: 'reply', status: 'processed',
        text, attachmentIds, replyTo: messageId, attemptId, outcome: processedOutcome, createdAt,
      });
      update('conversationMessages', {
        ...message, status: 'processed', replyId: reply.id, outcome: processedOutcome, processedAt: createdAt,
      });
      return { reply, created: true };
    });
    return created ? changed(reply) : reply;
  }

  return { postStudioMessage, conversationHistory, pendingMessages, receiveMessage, replyToMessage };
}
