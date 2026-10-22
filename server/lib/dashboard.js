'use strict';
// Net working minutes per day, as in the NEWAYS schedule reports:
// 08:30-17:30 less the 12:15-13:30 break.
const MINUTES_PER_DAY = 465;

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

  const lowStock = all(`SELECT pl.material, pl.thickness, pl.sheet_size, pl.qty, pl.min_qty, COALESCE(p.code, 'General stock') AS project
    FROM plates pl LEFT JOIN projects p ON p.id = pl.project_id WHERE pl.qty <= pl.min_qty ORDER BY p.code, pl.material, pl.thickness`);
  // Plate stock per project; plates with no project are general stock.
  const plates = all(`SELECT pl.project_id, COALESCE(p.code, 'General stock') AS project, p.name,
      COUNT(pl.id) AS sizes, COALESCE(SUM(pl.qty), 0) AS sheets, SUM(CASE WHEN pl.qty <= pl.min_qty THEN 1 ELSE 0 END) AS low,
      group_concat(DISTINCT pl.material) AS materials
    FROM plates pl LEFT JOIN projects p ON p.id = pl.project_id
    GROUP BY pl.project_id ORDER BY pl.project_id IS NULL, p.code`);
  const lowItems = all(`SELECT id, code, name, item_group, location, qty_on_hand, min_qty, unit, status FROM inventory_items
    WHERE status IN ('Low', 'Out') ORDER BY status DESC, code`);
  // Work still open per shop process, from Job Traveller routing and Operator output.
  const processes = all(`
    SELECT p.id, p.name, p.seq,
      COUNT(s.id) AS steps,
      COALESCE(SUM(s.target_qty), 0) AS target,
      COALESCE(SUM(o.good), 0) AS good,
      COALESCE(SUM(o.reject), 0) AS reject,
      COALESCE(SUM(MAX(COALESCE(s.target_qty, 0) - COALESCE(o.good, 0), 0) * COALESCE(s.cycle_min, 0)), 0) AS remaining_min
    FROM shop_processes p
    LEFT JOIN jt_steps s ON s.process_id = p.id
      AND s.job_traveller_id IN (SELECT id FROM job_travellers WHERE status NOT IN ('Completed','Cancelled'))
    LEFT JOIN (SELECT job_traveller_id, process_id, SUM(good_qty) AS good, SUM(reject_qty) AS reject
               FROM operator_outputs GROUP BY job_traveller_id, process_id) o
      ON o.job_traveller_id = s.job_traveller_id AND o.process_id = s.process_id
    WHERE COALESCE(p.active, 'Yes') != 'No'
    GROUP BY p.id ORDER BY p.seq, p.name`).map((p) => ({
    ...p,
    balance: Math.max(p.target - p.good, 0),
    completion: p.target ? Math.round((p.good / p.target) * 1000) / 10 : 0,
    yield: p.good + p.reject ? Math.round((p.good / (p.good + p.reject)) * 1000) / 10 : 100,
    remaining_min: Math.round(p.remaining_min * 10) / 10,
    remaining_days: Math.round((p.remaining_min / MINUTES_PER_DAY) * 100) / 100,
  }));
  const busiest = processes.reduce((a, p) => (p.remaining_min > (a ? a.remaining_min : 0) ? p : a), null);
  for (const p of processes) p.bottleneck = !!busiest && p.id === busiest.id;
  const sum = (k) => processes.reduce((n, p) => n + p[k], 0);
  const production = {
    target: sum('target'), good: sum('good'), reject: sum('reject'), balance: sum('balance'),
    completion: sum('target') ? Math.round((sum('good') / sum('target')) * 1000) / 10 : 0,
    yield: sum('good') + sum('reject') ? Math.round((sum('good') / (sum('good') + sum('reject'))) * 1000) / 10 : 100,
    remaining_min: Math.round(sum('remaining_min') * 10) / 10,
  };

  const recentNcrs = all('SELECT id, ncr_no, date, part_no, status FROM ncrs ORDER BY id DESC LIMIT 5');

  return { kpi, production, processes, issues, projects, workflow, load, downtime, lowStock, plates, lowItems, recentNcrs, minutesPerDay: MINUTES_PER_DAY };
}

module.exports = { buildDashboard, MINUTES_PER_DAY };
