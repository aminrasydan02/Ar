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

    // One day of work passed from process to process, and one problem raised on the floor.
    const log = db.prepare(`INSERT INTO daily_logs (date, process, project_id, part_no, activity, hours, status, handover_to, handover_note, logged_by)
      VALUES (date('now','localtime'), ?, ?, ?, ?, ?, ?, ?, ?, 'admin')`);
    log.run('Designer', projectId, '606118901_PART_1', 'Released drawing Rev C with updated bend relief.', 3, 'Done', 'Planner', 'Rev C uploaded. Hole positions unchanged.');
    log.run('Planner', projectId, '606118901_PART_1', 'Routing and laser nesting for 91 sets.', 2, 'Done', 'Engineer', 'SS-N1 to SS-N3 ready for programming check.');
    log.run('Engineer', projectId, '606118901_PART_1', 'Checked bending sequence and tooling for 1.5 mm SS.', 1.5, 'In progress', null, null);
    log.run('Operator', projectId, '606072702_PART_1', 'Laser cutting AL-N1, 120 of 375 pcs.', 7.5, 'In progress', 'Supervisor', 'Burr on edge after sheet 4, see issue.');
    db.prepare(`INSERT INTO issues (issue_no, title, from_process, to_process, project_id, part_no, priority, status, opened, details, raised_by)
      VALUES (?, ?, 'Operator', 'Technician', ?, '606072702_PART_1', 'High', 'Open', date('now','localtime'), ?, 'admin')`)
      .run(`ISS-${new Date().getFullYear()}-0001`, 'Burr on laser-cut edge, AL-N1', projectId, 'Heavy burr from sheet 4 onward. Nozzle or focus may need checking.');
    db.exec('COMMIT');
    return true;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { seedDemo };
