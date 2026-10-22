'use strict';
// Shop-floor layout of the sheet metal area. A layout is plain data (boxes on a grid),
// never code. 1 grid unit = 0.5 m.
const TYPES = ['machine', 'cell', 'storage', 'walkway', 'office', 'wall', 'label'];
const MAX_ITEMS = 500;

// Returns { floor, items } or throws a message.
function checkLayout(input, noCode) {
  const floor = input && input.floor;
  const fw = Math.trunc(Number(floor && floor.w)), fh = Math.trunc(Number(floor && floor.h));
  if (!(fw >= 10 && fw <= 400 && fh >= 10 && fh <= 400)) throw new Error('Floor size must be 10 to 400 grid units');
  const list = Array.isArray(input.items) ? input.items : [];
  if (list.length > MAX_ITEMS) throw new Error(`At most ${MAX_ITEMS} items`);
  const items = list.map((it, i) => {
    const n = (v, min, max) => { const x = Math.round(Number(v)); if (!(x >= min && x <= max)) throw new Error(`Item ${i + 1}: position or size out of the floor`); return x; };
    if (!TYPES.includes(it.type)) throw new Error(`Item ${i + 1}: type must be one of ${TYPES.join(', ')}`);
    const label = String(it.label ?? '').trim().slice(0, 60);
    const location = String(it.location ?? '').trim().slice(0, 80);
    noCode(`Item ${i + 1} label`, label);
    noCode(`Item ${i + 1} location`, location);
    const w = n(it.w, 1, fw), h = n(it.h, 1, fh);
    return {
      id: String(it.id ?? i + 1).replace(/[^\w-]/g, '').slice(0, 20) || String(i + 1),
      type: it.type, label, x: n(it.x, 0, fw - w), y: n(it.y, 0, fh - h), w, h,
      machine_id: it.type === 'machine' && Number(it.machine_id) ? Math.trunc(Number(it.machine_id)) : null,
      location: it.type === 'storage' ? location : '',
    };
  });
  return { floor: { w: fw, h: fh }, items };
}

// First layout when nothing is saved yet: machines in a row, a walkway and one store per location.
function starterLayout(machines, locations) {
  const items = machines.map((m, i) => ({ id: `m${m.id}`, type: 'machine', label: m.code, x: 2 + i * 9, y: 2, w: 7, h: 6, machine_id: m.id, location: '' }));
  items.push({ id: 'walk', type: 'walkway', label: 'Walkway', x: 0, y: 10, w: 60, h: 3, machine_id: null, location: '' });
  locations.forEach((loc, i) => items.push({ id: `s${i + 1}`, type: 'storage', label: loc, x: 2 + i * 8, y: 15, w: 6, h: 4, machine_id: null, location: loc }));
  return { floor: { w: Math.max(60, items.reduce((a, it) => Math.max(a, it.x + it.w + 2), 0)), h: 30 }, items };
}

module.exports = { TYPES, checkLayout, starterLayout };
