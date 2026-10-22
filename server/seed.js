'use strict';
// NEWAYS demo project from the schedule reports: 6 parts (1,339 pcs), 4 machines,
// 8 laser nesting programs, and a Job Traveller per part with its process routing
// and standard cycle times (Polishing -> Bending -> Clinching, as in the combined dashboard).

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
      .run('1,339 physical pcs = 2,471 process pcs across Polishing, Bending and Clinching. Net 465 min/day.').lastInsertRowid);

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

    // Cycle times in minutes per piece, from the Polishing, Bending and Clinching reports.
    const proc = (code) => db.prepare('SELECT id FROM shop_processes WHERE code = ?').get(code).id;
    const jt = db.prepare(`INSERT INTO job_travellers (jt_no, project_id, customer, part_no, drawing_no, material, thickness, qty, status)
      VALUES (?, ?, 'NEWAYS', ?, ?, ?, 1.5, ?, 'Planned')`);
    const step = db.prepare('INSERT INTO jt_steps (job_traveller_id, process_id, seq, cycle_min, target_qty, details) VALUES (?, ?, ?, ?, ?, ?)');
    const year = new Date().getFullYear();
    [
      ['606072702_PART_1', '4022-472-84231-v8', 'Aluminium', 375, [['POLISH', 4 / 3, 'Grit 120'], ['BEND', 2.5, '4 bends'], ['CLINCH', 35 / 60 * 5, '5 PEM nut & stud']]],
      ['606118901_PART_1', '4022-726-08611-Item 1', 'SS', 91, [['POLISH', 4 / 3, 'Grit 80'], ['BEND', 4.5, '8 bends']]],
      ['606118901_PART_2', '4022-631-82485-Item 2', 'SS', 182, [['POLISH', 5 / 6, 'Grit 80']]],
      ['606118901_PART_3', '4022-726-08611-Item 3', 'SS', 91, [['POLISH', 5 / 6, 'Grit 80'], ['BEND', 2.5, '6 bends']]],
      ['606072501_PART_1', '4022-631-82485-Item 1', 'SS', 200, [['POLISH', 4 / 3, 'Grit 80'], ['BEND', 4.5, '8 bends']]],
      ['606072501_PART_2', '4022-726-08611-Item 2', 'SS', 400, [['POLISH', 55 / 60, 'Grit 80']]],
    ].forEach(([partNo, drawing, material, qty, route], i) => {
      const id = Number(jt.run(`JT-${year}-${String(i + 1).padStart(4, '0')}`, projectId, partNo, drawing, material, qty).lastInsertRowid);
      step.run(id, proc('LASER'), 10, null, qty, 'Fiber laser, see nesting programs');
      route.forEach(([code, cycle, details], j) => step.run(id, proc(code), (j + 2) * 10, Math.round(cycle * 1000) / 1000, qty, details));
    });

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
