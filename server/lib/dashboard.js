'use strict';
// Net working minutes per day: 08:00-17:30 less cleaning 08:00-08:15,
// break 12:15-13:15 and setup 13:15-13:30.
const MINUTES_PER_DAY = 480;

function buildDashboard(db) {
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);

  const kpi = {
    active_projects: one("SELECT COUNT(*) AS n FROM projects WHERE status IN ('Planned','In progress')").n,
    parts: one('SELECT COUNT(*) AS n FROM parts').n,
    total_pcs: one('SELECT COALESCE(SUM(COALESCE(qty_per_set,1) * COALESCE(sets,1)), 0) AS n FROM parts').n,
    open_ncrs: one("SELECT COUNT(*) AS n FROM ncrs WHERE status = 'Open'").n,
    open_work_orders: one("SELECT COUNT(*) AS n FROM maint_orders WHERE status != 'Closed'").n,
    machines_down: one("SELECT COUNT(*) AS n FROM machines WHERE status IN ('Down','Maintenance')").n,
    low_stock: one('SELECT COUNT(*) AS n FROM plates WHERE qty <= min_qty').n,
    drawings: one("SELECT COUNT(*) AS n FROM drawings WHERE status = 'Current'").n,
    logs_today: one("SELECT COUNT(*) AS n FROM daily_logs WHERE date = date('now','localtime')").n,
    open_issues: one("SELECT COUNT(*) AS n FROM issues WHERE status IN ('Open','In progress')").n,
  };

  // Open problems, most urgent first, so each process sees what is waiting on it.
  const issues = all(`
    SELECT id, issue_no, title, from_process, to_process, priority, status, opened, due_date
    FROM issues WHERE status IN ('Open','In progress')
    ORDER BY CASE priority WHEN 'Urgent' THEN 0 WHEN 'High' THEN 1 WHEN 'Normal' THEN 2 ELSE 3 END, opened
    LIMIT 20`);

  const projects = all(`
    SELECT p.id, p.code, p.name, p.customer, p.due_date, p.status,
      (SELECT COUNT(*) FROM parts x WHERE x.project_id = p.id) AS parts,
      (SELECT COUNT(*) FROM wf_steps w JOIN parts x ON x.id = w.part_id WHERE x.project_id = p.id) AS steps,
      (SELECT COUNT(*) FROM wf_steps w JOIN parts x ON x.id = w.part_id WHERE x.project_id = p.id AND w.status = 'Done') AS steps_done
    FROM projects p WHERE p.status NOT IN ('Completed','Cancelled') ORDER BY p.due_date IS NULL, p.due_date`);

  const stepRows = all(`
    SELECT w.part_id, w.step, w.status, w.seq, x.part_no, p.code AS project
    FROM wf_steps w JOIN parts x ON x.id = w.part_id JOIN projects p ON p.id = x.project_id
    WHERE p.status NOT IN ('Completed','Cancelled')
    ORDER BY x.part_no, w.seq`);
  const board = new Map();
  for (const r of stepRows) {
    if (!board.has(r.part_id)) board.set(r.part_id, { part_id: r.part_id, part_no: r.part_no, project: r.project, steps: [] });
    board.get(r.part_id).steps.push({ step: r.step, status: r.status });
  }
  const workflow = [...board.values()].map((b) => {
    const current = b.steps.find((s) => s.status !== 'Done');
    return { ...b, current: current ? current.step : 'Completed', done: b.steps.filter((s) => s.status === 'Done').length };
  });

  // Planned load per machine from routing: setup + cycle x pieces.
  const load = all(`
    SELECT m.code, m.name, m.machine_type, m.status,
      COALESCE(SUM(CASE WHEN p.id IS NULL THEN 0 ELSE
        COALESCE(r.setup_min,0) + COALESCE(r.cycle_min,0) * COALESCE(x.qty_per_set,1) * COALESCE(x.sets,1) END), 0) AS load_min
    FROM machines m
    LEFT JOIN routings r ON r.machine_id = m.id
    LEFT JOIN parts x ON x.id = r.part_id
    LEFT JOIN projects p ON p.id = x.project_id AND p.status NOT IN ('Completed','Cancelled')
    GROUP BY m.id ORDER BY m.code`).map((m) => ({ ...m, load_days: Math.round((m.load_min / MINUTES_PER_DAY) * 100) / 100 }));

  const downtime = all(`
    SELECT m.code, COUNT(o.id) AS breakdowns, COALESCE(SUM(o.downtime_min),0) AS downtime_min
    FROM machines m LEFT JOIN maint_orders o ON o.machine_id = m.id AND o.kind = 'Breakdown'
      AND COALESCE(o.opened, substr(o.created_at,1,10)) >= date('now','-30 day')
    GROUP BY m.id ORDER BY m.code`).map((d) => {
    const available = 30 * MINUTES_PER_DAY;
    const uptime = Math.max(available - d.downtime_min, 0);
    return {
      ...d,
      availability: Math.round((uptime / available) * 1000) / 10,
      mtbf_min: d.breakdowns ? Math.round(uptime / d.breakdowns) : null,
      mttr_min: d.breakdowns ? Math.round(d.downtime_min / d.breakdowns) : null,
    };
  });

  const lowStock = all('SELECT material, thickness, sheet_size, qty, min_qty FROM plates WHERE qty <= min_qty ORDER BY material, thickness');
  const recentNcrs = all('SELECT id, ncr_no, date, part_no, status FROM ncrs ORDER BY id DESC LIMIT 5');

  return { kpi, issues, projects, workflow, load, downtime, lowStock, recentNcrs, minutesPerDay: MINUTES_PER_DAY };
}

module.exports = { buildDashboard, MINUTES_PER_DAY };
