'use strict';
// NEWAYS demo project: the 6 parts, 4 machines and 8 laser nesting programs from
// the integrated production schedule. Routing times are left for the planner.

function seedDemo(db) {
  if (db.prepare("SELECT id FROM projects WHERE code = 'NEWAYS'").get()) return false;
  db.exec('BEGIN');
  try {
    const machine = db.prepare('INSERT OR IGNORE INTO machines (code, name, machine_type, status) VALUES (?, ?, ?, ?)');
    machine.run('LC-01', 'Fiber laser', 'Fiber laser', 'Running');
    machine.run('CL-01', 'Clinching press', 'Clinching/PEM press', 'Running');
    machine.run('BD-01', 'Press brake', 'Press brake', 'Running');
    machine.run('PL-01', 'Polishing', 'Polishing/grinding', 'Running');

    const projectId = Number(db.prepare(`INSERT INTO projects (code, name, customer, status, notes)
      VALUES ('NEWAYS', 'NEWAYS integrated production', 'NEWAYS', 'In progress', ?)`)
      .run('Clinching cycle: report says 2.92 min, 5 x 20 s + 15 s = 1.92 min. Confirm before planning.').lastInsertRowid);

    const part = db.prepare(`INSERT INTO parts (project_id, part_no, parent_no, material, thickness, qty_per_set, sets)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    part.run(projectId, '606072702_PART_1', null, 'Aluminium', 1.5, 1, 375);
    part.run(projectId, '606118901_PART_1', null, 'SS', 1.5, 1, 91);
    part.run(projectId, '606118901_PART_2', '606118901_PART_1', 'SS', 1.5, 2, 91);
    part.run(projectId, '606118901_PART_3', '606118901_PART_1', 'SS', 1.5, 1, 91);
    part.run(projectId, '606072501_PART_1', null, 'SS', 1.5, 1, 200);
    part.run(projectId, '606072501_PART_2', '606072501_PART_1', 'SS', 1.5, 2, 200);

    const nest = db.prepare('INSERT INTO nestings (project_id, program, material, thickness) VALUES (?, ?, ?, ?)');
    for (const p of ['AL-N1', 'AL-N2']) nest.run(projectId, p, 'Aluminium', 1.5);
    for (let i = 1; i <= 6; i++) nest.run(projectId, `SS-N${i}`, 'SS', 1.5);
    db.exec('COMMIT');
    return true;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { seedDemo };
