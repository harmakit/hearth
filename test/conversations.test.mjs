import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversations, prepareInboxAnswer } from '../core/conversations.mjs';

function setup(saved = {}) {
  const records = Object.assign({
    studios: [{ id: 's', agents: [{ id: 'a' }] }],
    tasks: [{ id: 't', studioId: 's' }],
    conversations: [],
    conversationMessages: [],
  }, saved);
  const wakes = [];
  const conversations = createConversations({
    read(table, id) {
      const row = records[table].find((row) => row.id === id);
      if (!row) throw new Error('Запись не найдена.');
      return row;
    },
    list: (table) => records[table],
    insert(table, value) { records[table].push(value); return value; },
    update(table, value) {
      records[table][records[table].findIndex(({ id }) => id === value.id)] = value;
      return value;
    },
    transaction: (write) => write(),
    changed: (value) => value,
    now: () => '2026-11-18T00:00:00.000Z',
    queue: (id) => wakes.push(id),
  });
  return { conversations, records, wakes };
}

test('notes are queued without altering active work, survive restart and receive one reply', () => {
  const { conversations, records, wakes } = setup();
  const input = { studioId: 's', taskId: 't', text: 'Записка', attachmentIds: ['attachment-a'], operationId: 'request-1' };
  const note = conversations.postStudioMessage(input);
  assert.equal(note.kind, 'note');
  assert.equal(note.status, 'queued');
  assert.deepEqual(wakes, ['s']);
  assert.deepEqual(conversations.postStudioMessage(input), note);
  assert.deepEqual(wakes, ['s']);
  const restarted = setup(records).conversations;
  assert.deepEqual(restarted.pendingMessages('s'), [note]);
  assert.equal(restarted.receiveMessage({ messageId: note.id, attemptId: 'attempt' }).status, 'received');
  assert.throws(() => restarted.replyToMessage({ messageId: note.id, attemptId: 'other', text: 'Неверная попытка' }));
  const result = { messageId: note.id, attemptId: 'attempt', text: 'Принято', outcome: 'acknowledged' };
  const reply = restarted.replyToMessage(result);
  assert.equal(reply.replyTo, note.id);
  assert.deepEqual(restarted.replyToMessage(result), reply);
  const [processed, savedReply] = restarted.conversationHistory({ studioId: 's', taskId: 't' });
  assert.equal(processed.status, 'processed');
  assert.equal(processed.outcome, 'acknowledged');
  assert.deepEqual(processed.attachmentIds, ['attachment-a']);
  assert.deepEqual(savedReply, reply);
  assert.deepEqual(restarted.pendingMessages('s'), []);
  assert.throws(() => restarted.postStudioMessage({ ...input, text: 'Другая записка' }), /Операция уже использована/);
  assert.throws(() => restarted.postStudioMessage({ ...input, attachmentIds: ['/private/file'] }));
});

test('agent conversation scope stays isolated and histories are bounded', () => {
  const { conversations } = setup();
  const first = conversations.postStudioMessage({ studioId: 's', agentId: 'a', taskId: 't', text: 'Начало' });
  assert.equal(first.kind, 'chat');
  assert.throws(() => conversations.postStudioMessage({ studioId: 's', agentId: 'missing', text: 'Проверка' }));
  const resumed = conversations.postStudioMessage({ studioId: 's', conversationId: first.conversationId, text: 'Продолжение' });
  assert.equal(resumed.conversationId, first.conversationId);
  assert.equal(conversations.conversationHistory({ studioId: 's', taskId: 't' }).length, 0);
  for (let n = 0; n < 40; n++) {
    conversations.postStudioMessage({ studioId: 's', conversationId: first.conversationId, text: String(n) });
  }
  assert.equal(conversations.conversationHistory({ studioId: 's', conversationId: first.conversationId }).length, 24);
  assert.equal(conversations.conversationHistory({ studioId: 's', conversationId: first.conversationId }).at(-1).text, '39');
});

test('versioned answers enforce freshness, choices and attachment IDs', () => {
  const question = { status: 'open', kind: 'question', version: 2, choices: [{ id: 'go', label: 'Продолжить' }] };
  assert.throws(() => prepareInboxAnswer(question, { version: 1, answer: 'Да' }), /версия|Версия/);
  assert.throws(() => prepareInboxAnswer(question, { version: 2, choiceId: 'missing' }), /вариант/);
  const prepared = prepareInboxAnswer(question, { version: 2, choiceId: 'go', attachmentIds: ['att-1'], operationId: 'request-2' });
  assert.equal(prepared.answer, 'Продолжить');
  assert.deepEqual(prepared.response.attachmentIds, ['att-1']);
  const closed = { ...question, ...prepared.response, status: 'resolved', answer: prepared.answer };
  assert.equal(prepareInboxAnswer(closed, { version: 2, choiceId: 'go', attachmentIds: ['att-1'], operationId: 'request-2' }).duplicate, true);
  assert.throws(() => prepareInboxAnswer(closed, { version: 2, choiceId: 'go', answer: 'Уточнение', attachmentIds: ['att-1'], operationId: 'request-2' }), /Операция уже использована/);
  assert.throws(() => prepareInboxAnswer(closed, { version: 2, answer: 'Нет', operationId: 'request-3' }), /закрыт/);
  assert.equal(prepareInboxAnswer({ status: 'open', kind: 'question' }, { attachmentIds: ['att-2'] }).answer, 'Вложения');
});
