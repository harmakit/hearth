import { randomUUID } from 'node:crypto';
import { field, object } from './protocol.mjs';

const consumerTables = { task: 'tasks', meeting: 'meetings' };

export function createPrerequisites({
  read, list, insert, update, transaction, changed, wake = () => {}, clock = () => new Date(),
}) {
  const now = () => clock().toISOString();

  function consumerFor(type, id) {
    if (!Object.hasOwn(consumerTables, type)) throw new Error('Неизвестный тип потребителя обучения.');
    return read(consumerTables[type], id, 'Потребитель обучения');
  }

  function addWithinTransaction(input) {
    const { consumerType, consumerId, trainTaskId, agentId } = object(input, 'учебный допуск');
    const consumer = consumerFor(consumerType, consumerId);
    const training = read('tasks', trainTaskId, 'Задача обучения');
    if (training.kind !== 'train' || training.studioId !== consumer.studioId
      || training.training?.targetAgentId !== agentId || consumerId === trainTaskId) {
      throw new Error('Задача обучения должна относиться к участнику той же студии.');
    }
    if (consumerType === 'meeting') {
      if (!consumer.participants?.includes(agentId) && consumer.facilitatorId !== agentId) {
        throw new Error('Участник допуска должен участвовать во встрече.');
      }
      if (consumer.activeStep || !['positions', 'held'].includes(consumer.stage) || consumer.positions?.length) {
        throw new Error('Допуск нужно назначить до начала встречи.');
      }
    } else {
      if (consumer.kind === 'train' || ![consumer.agentId, consumer.reviewerId, consumer.activeAgentId].includes(agentId)) {
        throw new Error('Допуск должен относиться к исполнителю или проверяющему рабочей задачи.');
      }
      if (['running', 'completed'].includes(consumer.status) || ['in_progress', 'review', 'done'].includes(consumer.stage)) {
        throw new Error('Допуск нужно назначить до начала выполнения задачи.');
      }
    }
    const skillRef = field(input.skillRef, 'навык или версия навыка', 250);
    const reason = field(input.reason, 'причина обучения', 2_000);
    const criterion = field(input.criterion, 'критерий допуска', 2_000);
    const duplicate = list('prerequisites').find((row) => row.consumerType === consumerType && row.consumerId === consumerId
      && row.trainTaskId === trainTaskId && row.agentId === agentId && row.skillRef === skillRef && !row.retired);
    if (duplicate) {
      if (duplicate.reason === reason && duplicate.criterion === criterion) return duplicate;
      throw new Error('У этого потребителя уже есть допуск для указанного обучения и навыка.');
    }
    return insert('prerequisites', {
      id: randomUUID(), studioId: consumer.studioId, consumerType, consumerId, trainTaskId,
      agentId, skillRef, reason, criterion, createdAt: now(),
    });
  }

  function addPrerequisite(input) {
    const row = transaction(() => addWithinTransaction(input));
    wake(row.studioId);
    return changed(row);
  }

  function pendingPrerequisites(consumerType, consumerId) {
    const training = new Map(list('tasks').filter(({ kind }) => kind === 'train').map((row) => [row.id, row]));
    return list('prerequisites').filter((row) => {
      if (row.consumerType !== consumerType || row.consumerId !== consumerId || row.exception || row.retired) return false;
      const task = training.get(row.trainTaskId);
      return task?.studioId !== row.studioId || task.training?.targetAgentId !== row.agentId
        || task.stage !== 'done' || task.status !== 'completed';
    });
  }

  function waivePrerequisite({ prerequisiteId, author, reason }) {
    const exception = { author: field(author, 'автор исключения', 200), reason: field(reason, 'причина исключения', 2_000) };
    const result = transaction(() => {
      const row = read('prerequisites', prerequisiteId, 'Учебный допуск');
      if (row.retired) throw new Error('Учебный допуск больше не действует.');
      if (row.exception) {
        if (row.exception.author === exception.author && row.exception.reason === exception.reason) return row;
        throw new Error('Исключение для учебного допуска уже записано.');
      }
      return update('prerequisites', { ...row, exception: { ...exception, createdAt: now() } });
    });
    wake(result.studioId);
    return changed(result);
  }

  function retireMeetingParticipant(meetingId, agentId, replacementAgentId) {
    for (const row of list('prerequisites')) {
      if (row.consumerType === 'meeting' && row.consumerId === meetingId && row.agentId === agentId && !row.retired) {
        update('prerequisites', { ...row, retired: { reason: 'replaced', replacementAgentId, createdAt: now() } });
      }
    }
  }

  return { addPrerequisite, addWithinTransaction, pendingPrerequisites, waivePrerequisite, retireMeetingParticipant };
}
