'use strict';
// Every data module is described here once. The server builds tables, validation
// and the REST API from these definitions, and the browser builds forms and lists
// from the same definitions (served at /api/meta).

const MACHINE_TYPES = ['Fiber laser', 'Press brake', 'Clinching/PEM press', 'Polishing/grinding',
  'Shearing', 'Turret punch', 'Welding', 'General'];
const MATERIALS = ['Aluminium', 'SS', 'SPCC', 'SECC', 'GI', 'Copper', 'Other'];
// The job processes in the department, in the order work flows between them.
const PROCESSES = ['Designer', 'Planner', 'Engineer', 'Technician', 'Supervisor', 'Operator'];
const EVERYONE = ['admin', 'planner', 'viewer'];

const resources = {
  shop_processes: {
    label: 'Shop processes', singular: 'Process', group: 'Production',
    // Admin adds a new process here; the Operator form and Excel import pick it up without code changes.
    write: ['admin'],
    display: 'name',
    fields: [
      { name: 'code', label: 'Code', type: 'text', required: true, unique: true, help: 'Short word found in report titles, e.g. LASER, BEND.' },
      { name: 'name', label: 'Name', type: 'text', required: true, unique: true },
      { name: 'seq', label: 'Order in flow', type: 'number' },
      { name: 'unit', label: 'Output counted per', type: 'select', options: ['Piece', 'Sheet'], default: 'Piece' },
      { name: 'extra_fields', label: 'Extra fields on Operator form', type: 'text', help: 'Comma separated, e.g. Sand disc grit, Program / nesting ID' },
      { name: 'active', label: 'Active', type: 'select', options: ['Yes', 'No'], default: 'Yes' },
    ],
  },
  projects: {
    label: 'Projects', singular: 'Project', group: 'Planning',
    write: ['admin', 'planner'],
    display: 'code',
    fields: [
      { name: 'code', label: 'Project code', type: 'text', required: true, unique: true },
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'customer', label: 'Customer', type: 'text' },
      { name: 'work_order', label: 'Work order', type: 'text' },
      { name: 'start_date', label: 'Start date', type: 'date' },
      { name: 'due_date', label: 'Due date', type: 'date' },
      { name: 'status', label: 'Status', type: 'select', options: ['Planned', 'In progress', 'On hold', 'Completed', 'Cancelled'], default: 'Planned' },
      { name: 'notes', label: 'Notes', type: 'textarea', list: false },
    ],
  },
  parts: {
    label: 'Parts', singular: 'Part', group: 'Planning',
    write: ['admin', 'planner'],
    display: 'part_no',
    fields: [
      { name: 'project_id', label: 'Project', type: 'ref', ref: 'projects', required: true },
      { name: 'part_no', label: 'Part number', type: 'text', required: true, unique: true },
      { name: 'parent_no', label: 'Parent part', type: 'text', help: 'Leave empty for a main part; fill for a child part.' },
      { name: 'description', label: 'Description', type: 'text' },
      { name: 'material', label: 'Material', type: 'select', options: MATERIALS },
      { name: 'thickness', label: 'Thickness (mm)', type: 'number' },
      { name: 'qty_per_set', label: 'Qty / set', type: 'number', default: 1 },
      { name: 'sets', label: 'Sets', type: 'number', default: 1 },
      { name: 'job_sheet', label: 'Job sheet', type: 'text' },
    ],
  },
  routings: {
    label: 'Routing', singular: 'Routing step', group: 'Planning',
    write: ['admin', 'planner'],
    display: 'operation',
    fields: [
      { name: 'part_id', label: 'Part', type: 'ref', ref: 'parts', required: true },
      { name: 'seq', label: 'Seq', type: 'number', required: true },
      { name: 'operation', label: 'Operation', type: 'select', required: true,
        options: ['Drawing review', 'Programming', 'Laser cutting', 'Shearing', 'Punching', 'Clinching', 'Bending', 'Welding', 'Polishing', 'QC', 'Packing', 'Delivery'] },
      { name: 'machine_id', label: 'Machine', type: 'ref', ref: 'machines' },
      { name: 'setup_min', label: 'Setup (min)', type: 'number' },
      { name: 'cycle_min', label: 'Cycle (min/pc)', type: 'number' },
    ],
  },
  nestings: {
    label: 'Laser nesting', singular: 'Nesting program', group: 'Planning',
    write: ['admin', 'planner'],
    display: 'program',
    fields: [
      { name: 'project_id', label: 'Project', type: 'ref', ref: 'projects', required: true },
      { name: 'program', label: 'Program', type: 'text', required: true },
      { name: 'material', label: 'Material', type: 'select', options: MATERIALS },
      { name: 'thickness', label: 'Thickness (mm)', type: 'number' },
      { name: 'sheet_size', label: 'Sheet size', type: 'text' },
      { name: 'sheets', label: 'Sheets', type: 'number' },
      { name: 'cut_min', label: 'Cut time / sheet (min)', type: 'number' },
      { name: 'parts', label: 'Parts on sheet', type: 'text' },
    ],
  },
  wf_steps: {
    label: 'Workflow', singular: 'Workflow step', group: 'Production',
    write: ['admin'],
    display: 'step',
    fields: [
      { name: 'part_id', label: 'Part', type: 'ref', ref: 'parts', required: true },
      { name: 'seq', label: 'Seq', type: 'number' },
      { name: 'step', label: 'Step', type: 'text', required: true },
      { name: 'status', label: 'Status', type: 'select', options: ['Not started', 'In progress', 'Done', 'On hold'], default: 'Not started' },
      { name: 'qty_done', label: 'Qty done', type: 'number', default: 0 },
      { name: 'pic', label: 'PIC', type: 'text' },
      { name: 'due_date', label: 'Due date', type: 'date' },
    ],
  },
  machines: {
    label: 'Machines', singular: 'Machine', group: 'Resources',
    write: ['admin'],
    display: 'code',
    fields: [
      { name: 'code', label: 'Code', type: 'text', required: true, unique: true },
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'machine_type', label: 'Type', type: 'select', options: MACHINE_TYPES, required: true },
      { name: 'location', label: 'Location', type: 'text' },
      { name: 'status', label: 'Status', type: 'select', options: ['Running', 'Idle', 'Down', 'Maintenance'], default: 'Running' },
    ],
  },
  tooling: {
    label: 'Tooling', singular: 'Tool', group: 'Resources',
    write: ['admin'],
    display: 'code',
    fields: [
      { name: 'code', label: 'Code', type: 'text', required: true, unique: true },
      { name: 'description', label: 'Description', type: 'text' },
      { name: 'machine_id', label: 'Machine', type: 'ref', ref: 'machines' },
      { name: 'location', label: 'Location', type: 'text' },
      { name: 'condition', label: 'Condition', type: 'select', options: ['Good', 'Worn', 'Damaged', 'Scrapped'], default: 'Good' },
    ],
  },
  plates: {
    label: 'Plate stock', singular: 'Plate', group: 'Resources',
    write: ['admin'],
    display: 'material',
    fields: [
      { name: 'material', label: 'Material', type: 'select', options: MATERIALS, required: true },
      { name: 'thickness', label: 'Thickness (mm)', type: 'number', required: true },
      { name: 'sheet_size', label: 'Sheet size', type: 'text' },
      { name: 'qty', label: 'Qty (sheets)', type: 'number', default: 0 },
      { name: 'min_qty', label: 'Minimum', type: 'number', default: 0 },
      { name: 'location', label: 'Location', type: 'text' },
    ],
  },
  drawings: {
    label: 'Drawings', singular: 'Drawing', group: 'Engineering',
    // Drawings are created only through the upload endpoint.
    write: ['admin'], upload: ['admin', 'planner'], noCreate: true,
    display: 'filename',
    fields: [
      { name: 'part_no', label: 'Part number', type: 'text', required: true },
      { name: 'rev', label: 'Rev', type: 'text' },
      { name: 'format', label: 'Format', type: 'text', readonly: true },
      { name: 'status', label: 'Status', type: 'select', options: ['Current', 'Superseded'], default: 'Current' },
      { name: 'filename', label: 'File', type: 'text', readonly: true },
      { name: 'size', label: 'Size (bytes)', type: 'number', readonly: true, list: false },
      { name: 'stored_name', label: 'Stored as', type: 'text', readonly: true, list: false, hidden: true },
      { name: 'uploaded_by', label: 'Uploaded by', type: 'text', readonly: true },
    ],
  },
  maint_orders: {
    label: 'Maintenance', singular: 'Work order', group: 'Engineering',
    write: ['admin'],
    display: 'title',
    fields: [
      { name: 'machine_id', label: 'Machine', type: 'ref', ref: 'machines', required: true },
      { name: 'kind', label: 'Kind', type: 'select', options: ['Preventive', 'Breakdown', 'Inspection'], required: true },
      { name: 'title', label: 'Title', type: 'text', required: true },
      { name: 'opened', label: 'Opened', type: 'date' },
      { name: 'closed', label: 'Closed', type: 'date' },
      { name: 'downtime_min', label: 'Downtime (min)', type: 'number', default: 0 },
      { name: 'pic', label: 'PIC', type: 'text' },
      { name: 'status', label: 'Status', type: 'select', options: ['Open', 'In progress', 'Closed'], default: 'Open' },
      { name: 'details', label: 'Details', type: 'textarea', list: false },
    ],
  },
  ncrs: {
    label: 'NCR', singular: 'NCR', group: 'Quality',
    write: ['admin'],
    display: 'ncr_no',
    fields: [
      { name: 'ncr_no', label: 'NCR no.', type: 'text', readonly: true, unique: true },
      { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'project_id', label: 'Project', type: 'ref', ref: 'projects' },
      { name: 'part_no', label: 'Part number', type: 'text' },
      { name: 'qty_affected', label: 'Qty affected', type: 'number' },
      { name: 'defect', label: '1. Nonconformance', type: 'textarea', required: true },
      { name: 'containment', label: '2. Containment', type: 'textarea', list: false },
      { name: 'root_cause', label: '3. Root cause', type: 'textarea', list: false },
      { name: 'corrective', label: '4. Corrective action', type: 'textarea', list: false },
      { name: 'disposition', label: '5. Disposition', type: 'select', options: ['Rework', 'Scrap', 'Use as is', 'Return to supplier'] },
      { name: 'verification', label: '6. Verification', type: 'textarea', list: false },
      { name: 'raised_by', label: 'Raised by', type: 'text' },
      { name: 'status', label: 'Status', type: 'select', options: ['Open', 'Closed'], default: 'Open' },
    ],
  },
  reason_codes: {
    label: 'Reason codes', singular: 'Reason code', group: 'Production',
    write: ['admin'],
    display: 'code',
    fields: [
      { name: 'code', label: 'Code', type: 'text', required: true, unique: true },
      { name: 'kind', label: 'Kind', type: 'select', options: ['Downtime', 'Reject'], required: true },
      { name: 'description', label: 'Description', type: 'text', required: true },
      { name: 'process_id', label: 'Process', type: 'ref', ref: 'shop_processes', help: 'Leave empty to use it for every process.' },
    ],
  },
  job_travellers: {
    label: 'Job Traveller', singular: 'Job Traveller', group: 'Production',
    write: ['admin', 'planner'],
    display: 'jt_no',
    fields: [
      { name: 'jt_no', label: 'JT no.', type: 'text', unique: true, help: 'Leave empty for an automatic number.' },
      { name: 'project_id', label: 'Project', type: 'ref', ref: 'projects' },
      { name: 'customer', label: 'Customer', type: 'text' },
      { name: 'part_no', label: 'Part number', type: 'text', required: true },
      { name: 'drawing_no', label: 'Drawing no.', type: 'text' },
      { name: 'description', label: 'Description', type: 'text' },
      { name: 'material', label: 'Material', type: 'select', options: MATERIALS },
      { name: 'thickness', label: 'Thickness (mm)', type: 'number' },
      { name: 'qty', label: 'Required qty (pcs)', type: 'number', required: true },
      { name: 'due_date', label: 'Due date', type: 'date' },
      { name: 'status', label: 'Status', type: 'select', options: ['Planned', 'In progress', 'Completed', 'On hold', 'Cancelled'], default: 'Planned' },
      { name: 'notes', label: 'Notes', type: 'textarea', list: false },
    ],
  },
  jt_steps: {
    label: 'Job Traveller steps', singular: 'Step', group: 'Production', nav: false,
    write: ['admin', 'planner'],
    display: 'seq',
    fields: [
      { name: 'job_traveller_id', label: 'Job Traveller', type: 'ref', ref: 'job_travellers', required: true },
      { name: 'process_id', label: 'Process', type: 'ref', ref: 'shop_processes', required: true },
      { name: 'seq', label: 'Seq', type: 'number' },
      { name: 'cycle_min', label: 'Cycle time (min)', type: 'number' },
      { name: 'target_qty', label: 'Target qty', type: 'number' },
      { name: 'details', label: 'Details', type: 'text', help: 'e.g. 5 PEM nuts, 8 bends, grit 80' },
    ],
  },
  operator_outputs: {
    label: 'Operator output', singular: 'Output', group: 'Production',
    // One form for every shop process; extra holds that process's own fields.
    write: EVERYONE, ownerField: 'operator',
    display: 'date',
    fields: [
      { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'process_id', label: 'Process', type: 'ref', ref: 'shop_processes', required: true },
      { name: 'job_traveller_id', label: 'Job Traveller', type: 'ref', ref: 'job_travellers', required: true },
      { name: 'slot', label: 'Session / time slot', type: 'text' },
      { name: 'machine', label: 'Machine', type: 'text' },
      { name: 'good_qty', label: 'Good qty', type: 'number', required: true },
      { name: 'reject_qty', label: 'Reject qty', type: 'number', default: 0 },
      { name: 'run_min', label: 'Run time (min)', type: 'number' },
      { name: 'downtime_min', label: 'Downtime (min)', type: 'number', default: 0 },
      { name: 'reject_code', label: 'Reject code', type: 'text' },
      { name: 'downtime_code', label: 'Downtime code', type: 'text' },
      { name: 'extra', label: 'Process fields', type: 'json', list: false },
      { name: 'remark', label: 'Remark', type: 'text' },
      { name: 'operator', label: 'Operator', type: 'text', readonly: true },
    ],
  },
  daily_logs: {
    label: 'Daily log', singular: 'Activity', group: 'Daily work',
    // Everyone records their own work; only Admin can change someone else's entry.
    write: EVERYONE, ownerField: 'logged_by',
    display: 'activity',
    fields: [
      { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'process', label: 'Process', type: 'select', options: PROCESSES, required: true },
      { name: 'project_id', label: 'Project', type: 'ref', ref: 'projects' },
      { name: 'part_no', label: 'Part number', type: 'text' },
      { name: 'activity', label: 'Activity', type: 'textarea', required: true },
      { name: 'hours', label: 'Hours', type: 'number' },
      { name: 'status', label: 'Status', type: 'select', options: ['Planned', 'In progress', 'Done', 'Blocked'], default: 'In progress' },
      { name: 'handover_to', label: 'Hand over to', type: 'select', options: PROCESSES, help: 'The next process that needs this information.' },
      { name: 'handover_note', label: 'Handover note', type: 'textarea', list: false },
      { name: 'logged_by', label: 'Logged by', type: 'text', readonly: true },
    ],
  },
  issues: {
    label: 'Issues', singular: 'Issue', group: 'Daily work',
    write: EVERYONE,
    display: 'issue_no',
    fields: [
      { name: 'issue_no', label: 'Issue no.', type: 'text', readonly: true, unique: true },
      { name: 'title', label: 'Problem', type: 'text', required: true },
      { name: 'from_process', label: 'Raised by process', type: 'select', options: PROCESSES, required: true },
      { name: 'to_process', label: 'Needs action from', type: 'select', options: PROCESSES, required: true },
      { name: 'project_id', label: 'Project', type: 'ref', ref: 'projects' },
      { name: 'part_no', label: 'Part number', type: 'text' },
      { name: 'priority', label: 'Priority', type: 'select', options: ['Low', 'Normal', 'High', 'Urgent'], default: 'Normal' },
      { name: 'status', label: 'Status', type: 'select', options: ['Open', 'In progress', 'Resolved', 'Closed'], default: 'Open' },
      { name: 'opened', label: 'Opened', type: 'date' },
      { name: 'due_date', label: 'Due date', type: 'date' },
      { name: 'resolved', label: 'Resolved', type: 'date' },
      { name: 'details', label: 'What happened', type: 'textarea', list: false },
      { name: 'action_plan', label: 'Action plan', type: 'textarea', list: false },
      { name: 'resolution', label: 'Solution', type: 'textarea', list: false },
      { name: 'raised_by', label: 'Raised by', type: 'text', readonly: true },
    ],
  },
};

const SYSTEM_TYPES = { number: 'REAL', ref: 'INTEGER' };

function columnType(field) {
  return SYSTEM_TYPES[field.type] || 'TEXT';
}

module.exports = { resources, columnType, MACHINE_TYPES, MATERIALS, PROCESSES };
