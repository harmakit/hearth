const roomNames = {
  director: 'Кабинет директора', library: 'Библиотека', workshop: 'Разработка',
  atelier: 'Ателье', common: 'Общая комната',
};

export const roleNames = {
  director: 'Директор', library: 'Библиотекарь', engineer: 'Инженер',
  editor: 'Редактор', artist: 'Художник', other: 'Другая роль',
};

const workspaces = {
  director: ['director', 'plan'], library: ['library', 'books'],
  editor: ['library', 'paper'], engineer: ['workshop', 'terminal'],
  artist: ['atelier', 'easel'], other: ['common', 'notebook'],
};

const taskPriority = { running: 3, waiting: 2, queued: 1 };

export function buildRooms(studio) {
  const rooms = Object.entries(roomNames).map(([id, name]) => ({ id, name, desks: [] }));
  rooms[0].desks.push({ agent: { id: null, name: 'Директор', role: 'director', ...studio.director }, props: 'plan' });

  for (const agent of studio.agents ?? []) {
    const [roomId, props] = Object.hasOwn(workspaces, agent.role) ? workspaces[agent.role] : workspaces.other;
    rooms.find(room => room.id === roomId).desks.push({ agent, props });
  }

  return rooms.filter(room => room.desks.length > 0);
}

export function taskForAgent(tasks, studioId, agentId) {
  return tasks.filter(task => task.studioId === studioId && (task.agentId ?? null) === agentId)
    .sort((a, b) => (taskPriority[b.status] ?? 0) - (taskPriority[a.status] ?? 0)
      || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))[0];
}
