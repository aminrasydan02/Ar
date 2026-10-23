'use strict';
// Working time set by Admin: shifts (hours and break), the days they run, and holidays.
// Used for the hourly output slots, the minutes in a working day and the auto plan.

const DAY_SETS = { 'Mon-Fri': [1, 2, 3, 4, 5], 'Mon-Sat': [1, 2, 3, 4, 5, 6], 'Mon-Sun': [0, 1, 2, 3, 4, 5, 6] };
const DEFAULT_MINUTES = 465;

const toMin = (t) => { const m = /^(\d{2}):(\d{2})$/.exec(t || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const toTime = (n) => `${String(Math.floor((n % 1440) / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

// A shift's span in minutes from midnight; an end before the start runs past midnight.
function span(s) {
  const a = toMin(s.start_time), b0 = toMin(s.end_time);
  if (a === null || b0 === null) return null;
  return [a, b0 <= a ? b0 + 1440 : b0];
}
function breakSpan(s, [a]) {
  const x = toMin(s.break_start), y0 = toMin(s.break_end);
  if (x === null || y0 === null) return null;
  let x1 = x < a ? x + 1440 : x, y1 = y0 < a ? y0 + 1440 : y0;
  if (y1 <= x1) y1 += 1440;
  return [x1, y1];
}
const overlap = ([a, b], [c, d]) => Math.max(0, Math.min(b, d) - Math.max(a, c));

function netMinutes(s) {
  const sp = span(s);
  if (!sp) return 0;
  const br = breakSpan(s, sp);
  return sp[1] - sp[0] - (br ? overlap(sp, br) : 0);
}

// One slot per clock hour from the shift start; a slot that is all break is left out.
function hourSlots(s) {
  const sp = span(s);
  if (!sp) return [];
  const br = breakSpan(s, sp);
  const out = [];
  for (let t = sp[0]; t < sp[1]; t += 60) {
    const end = Math.min(t + 60, sp[1]);
    const minutes = end - t - (br ? overlap([t, end], br) : 0);
    if (minutes > 0) out.push({ label: `${toTime(t)}-${toTime(end)}`, minutes });
  }
  return out;
}

function load(db) {
  const shifts = db.prepare("SELECT * FROM shifts WHERE COALESCE(active, 'Yes') = 'Yes' ORDER BY start_time").all()
    .map((s) => ({ ...s, net_min: netMinutes(s), slots: hourSlots(s) }));
  const holidays = db.prepare('SELECT date, name, kind FROM holidays ORDER BY date').all();
  return { shifts, holidays, minutes_per_day: shifts.reduce((n, s) => n + s.net_min, 0) || DEFAULT_MINUTES };
}

function minutesPerDay(db) { return load(db).minutes_per_day; }

// A working day: some active shift runs on that weekday and it is not a holiday.
function workDayCheck(db) {
  const { shifts, holidays } = load(db);
  const days = new Set(shifts.flatMap((s) => DAY_SETS[s.days] || DAY_SETS['Mon-Sat']));
  if (!days.size) DAY_SETS['Mon-Sat'].forEach((d) => days.add(d));
  const off = new Set(holidays.map((x) => x.date));
  return (iso) => days.has(new Date(`${iso}T00:00:00Z`).getUTCDay()) && !off.has(iso);
}

// The n-th working day from iso (n = 0 is iso itself or the next working day).
function addWorkDays(isWork, iso, n) {
  let d = iso;
  const next = (x) => new Date(Date.parse(`${x}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  let guard = 0;
  while (!isWork(d) && guard++ < 400) d = next(d);
  for (let i = 0; i < n; i++) { d = next(d); while (!isWork(d) && guard++ < 4000) d = next(d); }
  return d;
}

function seedDefaultShift(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM shifts').get().n) return;
  // As in the NEWAYS schedule reports: 08:30-17:30 less the 12:15-13:30 break = 465 min.
  const s = { start_time: '08:30', end_time: '17:30', break_start: '12:15', break_end: '13:30' };
  db.prepare("INSERT INTO shifts (name, start_time, end_time, break_start, break_end, days, active, net_min) VALUES ('Day', ?, ?, ?, ?, 'Mon-Sat', 'Yes', ?)")
    .run(s.start_time, s.end_time, s.break_start, s.break_end, netMinutes(s));
}

module.exports = { load, minutesPerDay, workDayCheck, addWorkDays, netMinutes, hourSlots, seedDefaultShift, DAY_SETS, DEFAULT_MINUTES };
