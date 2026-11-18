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
