const weekdays = [1, 2, 3, 4, 5];
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function normalizeSchedule(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Некорректное расписание студии.');
  const { enabled = false, days = weekdays, start = '09:00', end = '18:00' } = value;
  if (typeof enabled !== 'boolean' || !Array.isArray(days) || (enabled && days.length === 0)
    || [...days].some((day) => !Number.isInteger(day) || day < 0 || day > 6)
    || typeof start !== 'string' || !timePattern.test(start) || typeof end !== 'string' || !timePattern.test(end)
    || (enabled && start === end)) {
    throw new Error('Укажите дни и разное время начала и окончания расписания студии.');
  }
  return { enabled, days: [...new Set(days)].sort((a, b) => a - b), start, end };
}

function minutes(time) {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

export function withinSchedule({ enabled, days, start, end }, date) {
  if (!enabled) return true;
  const day = date.getDay();
  const time = date.getHours() * 60 + date.getMinutes();
  const from = minutes(start);
  const to = minutes(end);
  if (from < to) return days.includes(day) && time >= from && time < to;
  return (days.includes(day) && time >= from) || (days.includes((day + 6) % 7) && time < to);
}

export function nextScheduleWindow(schedule, date = new Date()) {
  if (!schedule.enabled) return null;
  if (withinSchedule(schedule, date)) return new Date(date);
  const { days, start } = schedule;
  const opening = minutes(start);
  for (let offset = 0; offset <= 14; offset += 1) {
    const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset);
    const endOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset + 1);
    if (endOfDay - midnight === 24 * 60 * 60_000) {
      if (!days.includes(midnight.getDay())) continue;
      const nominal = new Date(midnight);
      nominal.setHours(Math.floor(opening / 60), opening % 60);
      if (nominal > date) return nominal;
      continue;
    }
    // Daylight-saving changes can move or repeat a local opening time.
    for (let time = midnight.getTime(); time < endOfDay.getTime(); time += 60_000) {
      const candidate = new Date(time);
      if (candidate > date && withinSchedule(schedule, candidate)) return candidate;
    }
  }
  return null;
}
