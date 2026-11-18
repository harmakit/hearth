import { normalizeSchedule, withinSchedule } from '../core/schedule.mjs';

export const powerModes = ['normal', 'active', 'window'];

export function createPowerController(blocker) {
  let blockerId;
  let closed = false;

  function release() {
    if (blockerId === undefined) return;
    blocker.stop(blockerId);
    blockerId = undefined;
  }

  function refresh(studios, date = new Date()) {
    if (closed) return;
    const required = studios.some(({ powerMode, activeAttempts, schedule }) => (
      (powerMode === 'active' && (Array.isArray(activeAttempts) ? activeAttempts.length : activeAttempts) > 0)
      || (powerMode === 'window' && schedule?.enabled && withinSchedule(normalizeSchedule(schedule), date))
    ));
    if (!required) release();
    else if (blockerId === undefined) blockerId = blocker.start('prevent-app-suspension');
  }

  function close() {
    closed = true;
    release();
  }

  return { refresh, close };
}
