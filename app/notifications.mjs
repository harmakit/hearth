export function createNotifications({
  readDelivery, saveDelivery, readPreferences, deliver, now = () => new Date().toISOString(),
}) {
  function notify(event) {
    const { studioId, inboxId, kind, title, body } = event;
    const version = event.version ?? 1;
    const id = event.eventId ?? (inboxId && JSON.stringify([studioId, inboxId, version]));
    if (!id || !Number.isSafeInteger(version) || version < 1) return false;

    const preferences = readPreferences();
    if (preferences?.enabled === false || preferences?.studios?.[studioId] === false || readDelivery(id)) return false;
    const saved = saveDelivery({ id, studioId, inboxId, version, kind, deliveredAt: now() });
    if (saved === false) return false;
    deliver({ eventId: id, studioId, inboxId, version, kind, title, body });
    return true;
  }

  return { notify };
}
