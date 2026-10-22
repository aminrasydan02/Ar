'use strict';
// Every data module is described here once. The server builds tables, validation
// and the REST API from these definitions, and the browser builds forms and lists
// from the same definitions (served at /api/meta).

const MACHINE_TYPES = ['Fiber laser', 'Press brake', 'Clinching/PEM press', 'Polishing/grinding',
  'Shearing', 'Turret punch', 'Welding', 'General'];
const TOOL_TYPES = ['Punch', 'Die', 'Bending punch (upper)', 'Bending die (lower)', 'Clinching / PEM tool', 'Laser nozzle', 'Laser lens', 'Welding torch / tip',
  'Polishing / grinding disc', 'Jig / fixture', 'Measuring', 'Other'];
const MATERIALS = ['Aluminium', 'SS', 'SPCC', 'SECC', 'GI', 'Copper', 'Other'];
// The job processes in the department, in the order work flows between them.
const INVENTORY_GROUPS = ['Operator tools', 'Maintenance spares', 'Equipment'];
// Stock movements: +1 adds to stock, -1 takes from it, 0 = signed qty (Adjust).
const MOVE_SIGN = { 'Receive': 1, 'Issue / use': -1, 'Check out': -1, 'Check in': 1, 'Return': 1, 'Adjust': 0 };
const PROCESSES = ['Designer', 'Planner', 'Engineer', 'Technician', 'Supervisor', 'Operator', 'Manager'];
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
      // BOM details (Sheetmetal BOM template)
      { name: 'category', label: 'Category', type: 'select', options: ['Sheet Metal', 'Hardware', 'Accessory', 'Assembly'] },
      { name: 'make_buy', label: 'Make / Buy', type: 'select', options: ['Make', 'Buy'] },
      { name: 'drawing_no', label: 'Drawing no.', type: 'text', list: false },
      { name: 'flat_size', label: 'Flat pattern (mm)', type: 'text', list: false },
      { name: 'process_flow', label: 'Process workflow', type: 'text', list: false },
      { name: 'finish', label: 'Finishing / coating', type: 'text', list: false },
      { name: 'hardware', label: 'Hardware / fasteners', type: 'text', list: false },
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
      { name: 'part_count', label: 'Part numbers', type: 'number', readonly: true, help: 'Counted from the parts added to this nesting.' },
      { name: 'part_qty', label: 'Total pcs', type: 'number', readonly: true },
      { name: 'parts', label: 'Part numbers in nesting', type: 'text', readonly: true },
    ],
  },
  // The part numbers cut in one nesting program, so each nesting shows how many parts it holds.
  nesting_parts: {
    label: 'Nesting parts', singular: 'Nesting part', group: 'Planning', nav: false,
    write: ['admin', 'planner'],
    display: 'part_no',
    fields: [
      { name: 'nesting_id', label: 'Nesting program', type: 'ref', ref: 'nestings', required: true },
      { name: 'part_no', label: 'Part number', type: 'text', required: true },
      { name: 'description', label: 'Description', type: 'text' },
      { name: 'qty_per_sheet', label: 'Qty / sheet', type: 'number', default: 1 },
      { name: 'total_qty', label: 'Total pcs', type: 'number' },
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
      { name: 'brand', label: 'Brand', type: 'text' },
      { name: 'model', label: 'Model', type: 'text' },
      { name: 'location', label: 'Location', type: 'text' },
      { name: 'status', label: 'Status', type: 'select', options: ['Running', 'Idle', 'Down', 'Maintenance'], default: 'Running' },
      { name: 'notes', label: 'Note', type: 'text' },
    ],
  },
  tooling: {
    label: 'Tooling', singular: 'Tool', group: 'Resources',
    write: ['admin'],
    display: 'code',
    fields: [
      { name: 'code', label: 'Code', type: 'text', required: true, unique: true },
      { name: 'description', label: 'Description', type: 'text' },
      { name: 'tool_type', label: 'Tool type', type: 'select', options: TOOL_TYPES, required: true, default: 'Other' },
      { name: 'machine_type', label: 'Machine type', type: 'select', options: MACHINE_TYPES, help: 'Filled from the machine when left empty.' },
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
      { name: 'project_id', label: 'Project', type: 'ref', ref: 'projects', help: 'Leave empty for general stock.' },
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
      { name: 'project_id', label: 'Project', type: 'ref', ref: 'projects' },
      { name: 'part_no', label: 'Part number', type: 'text', required: true },
      { name: 'rev', label: 'Rev', type: 'text' },
      { name: 'kind', label: 'Type', type: 'text', readonly: true },
      { name: 'format', label: 'Format', type: 'text', readonly: true },
      { name: 'job_traveller_id', label: 'Job Traveller', type: 'ref', ref: 'job_travellers' },
      { name: 'status', label: 'Status', type: 'select', options: ['Current', 'Superseded'], default: 'Current' },
      { name: 'filename', label: 'File', type: 'text', readonly: true },
      { name: 'size', label: 'Size (bytes)', type: 'number', readonly: true, list: false },
      { name: 'stored_name', label: 'Stored as', type: 'text', readonly: true, list: false, hidden: true },
      { name: 'uploaded_by', label: 'Uploaded by', type: 'text', readonly: true },
      { name: 'notes', label: 'Notes', type: 'text', list: false },
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
  pm_tasks: {
    label: 'PM checklist', singular: 'PM task', group: 'Engineering',
    // Preventive maintenance checklist per machine (Laser, Press Brake, Clinching templates).
    write: ['admin'],
    display: 'task',
    fields: [
      { name: 'machine_id', label: 'Machine', type: 'ref', ref: 'machines', required: true },
      { name: 'frequency', label: 'Frequency', type: 'select', options: ['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Semi-Annual', 'Annual'], required: true },
      { name: 'item_no', label: 'Item no.', type: 'text' },
      { name: 'task', label: 'Maintenance item', type: 'text', required: true },
      { name: 'procedure', label: 'Inspection point / procedure', type: 'textarea', list: false },
      { name: 'standard', label: 'Standard / spec', type: 'text', list: false },
      { name: 'status', label: 'Status', type: 'select', options: ['Pending', 'Pass', 'Fail', 'N/A'], default: 'Pending' },
      { name: 'checked_on', label: 'Date checked', type: 'date' },
      { name: 'checked_by', label: 'Checked by', type: 'text' },
      { name: 'remarks', label: 'Remarks', type: 'text', list: false },
    ],
  },
  // One line per PM item checked on a date, so each machine keeps a dated care record.
  pm_logs: {
    label: 'PM log', singular: 'PM check', group: 'Engineering',
    write: EVERYONE, ownerField: 'checked_by',
    display: 'date',
    fields: [
      { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'machine_id', label: 'Machine', type: 'ref', ref: 'machines', readonly: true },
      { name: 'pm_task_id', label: 'PM item', type: 'ref', ref: 'pm_tasks', required: true },
      { name: 'frequency', label: 'Frequency', type: 'text', readonly: true },
      { name: 'result', label: 'Result', type: 'select', options: ['Pass', 'Fail', 'N/A'], required: true },
      { name: 'reading', label: 'Reading / value', type: 'text' },
      { name: 'remarks', label: 'Remarks', type: 'text' },
      { name: 'checked_by', label: 'Checked by', type: 'text', readonly: true },
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
      { name: 'approved_by', label: 'Approved by', type: 'text', readonly: true },
      { name: 'approved_on', label: 'Approved on', type: 'date', readonly: true },
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
      { name: 'project_id', label: 'Project', type: 'ref', ref: 'projects', readonly: true, help: 'Taken from the Job Traveller.' },
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
  inventory_items: {
    label: 'Inventory', singular: 'Item', group: 'Inventory',
    write: ['admin', 'planner'],
    display: 'code',
    fields: [
      { name: 'code', label: 'Item code', type: 'text', required: true, unique: true },
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'status', label: 'Stock', type: 'text', readonly: true },
      { name: 'item_group', label: 'Group', type: 'select', options: INVENTORY_GROUPS, required: true },
      { name: 'category', label: 'Category', type: 'text', help: 'e.g. Punch, Die, Gloves, Disc, Bearing, Oil' },
      { name: 'location', label: 'Location', type: 'text' },
      { name: 'process', label: 'Used by process', type: 'select', options: PROCESSES },
      { name: 'machine_id', label: 'For machine', type: 'ref', ref: 'machines' },
      { name: 'unit', label: 'Unit', type: 'select', options: ['pcs', 'set', 'pair', 'box', 'roll', 'litre', 'kg', 'm'], default: 'pcs' },
      { name: 'qty_on_hand', label: 'Qty on hand', type: 'number', default: 0, help: 'Changing it here records an Adjust in the stock log.' },
      { name: 'min_qty', label: 'Minimum stock', type: 'number', default: 0 },
      { name: 'notes', label: 'Notes', type: 'textarea', list: false },
    ],
  },
  inventory_moves: {
    label: 'Stock log', singular: 'Stock movement', group: 'Inventory',
    // Every use, check-out, return and receipt. Corrections are made with a new Adjust line.
    write: EVERYONE, ownerField: 'moved_by', noUpdate: true,
    display: 'id',
    fields: [
      { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'item_id', label: 'Item', type: 'ref', ref: 'inventory_items', required: true },
      { name: 'move', label: 'Movement', type: 'select', options: Object.keys(MOVE_SIGN), required: true },
      { name: 'qty', label: 'Qty', type: 'number', required: true, help: 'For Adjust: + adds, - removes.' },
      { name: 'process', label: 'Process', type: 'select', options: PROCESSES },
      { name: 'machine_id', label: 'Machine', type: 'ref', ref: 'machines' },
      { name: 'maint_order_id', label: 'Maintenance work order', type: 'ref', ref: 'maint_orders' },
      { name: 'remark', label: 'Remark', type: 'text' },
      { name: 'moved_by', label: 'By', type: 'text', readonly: true },
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
      { name: 'job_traveller_id', label: 'Job Traveller', type: 'ref', ref: 'job_travellers' },
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

// Which process owns (can create and edit) each kind of data. Data not listed is shared.
const OWNERS = {
  shop_processes: ['Planner'], projects: ['Planner', 'Designer'], parts: ['Planner', 'Designer', 'Engineer'],
  routings: ['Planner', 'Engineer'], nestings: ['Planner', 'Engineer'], wf_steps: ['Planner', 'Supervisor'],
  machines: ['Technician'], tooling: ['Technician', 'Engineer'], plates: ['Technician'],
  drawings: ['Designer', 'Engineer', 'Planner'], maint_orders: ['Technician', 'Supervisor'],
  ncrs: ['Supervisor', 'Engineer'], reason_codes: ['Supervisor', 'Planner'],
  job_travellers: ['Planner', 'Supervisor'], jt_steps: ['Planner', 'Engineer'],
  operator_outputs: ['Operator', 'Supervisor'],
  inventory_items: ['Technician', 'Supervisor'],
  pm_tasks: ['Technician', 'Supervisor'], pm_logs: ['Technician', 'Supervisor', 'Operator'],
  nesting_parts: ['Planner', 'Engineer'],
};
for (const [name, list] of Object.entries(OWNERS)) resources[name].processes = list;

// Slicers: the chips under each page title that split a list by project, machine or type.
const SLICERS = {
  projects: ['status', 'customer'], parts: ['project_id', 'make_buy'], nestings: ['project_id', 'material'], nesting_parts: ['nesting_id'],
  routings: ['machine_id'], wf_steps: ['status'], machines: ['machine_type', 'brand'], tooling: ['tool_type', 'machine_type'],
  plates: ['project_id', 'material'], drawings: ['project_id', 'kind'], maint_orders: ['machine_id', 'kind'], pm_tasks: ['machine_id', 'frequency'], pm_logs: ['machine_id', 'result'],
  ncrs: ['project_id', 'status'], reason_codes: ['kind'], job_travellers: ['project_id', 'status'], operator_outputs: ['project_id', 'process_id'],
  daily_logs: ['project_id', 'process'], inventory_items: ['item_group', 'status'], inventory_moves: ['move'], issues: ['to_process', 'status'],
};
for (const [name, list] of Object.entries(SLICERS)) resources[name].slicers = list;

module.exports = { resources, columnType, TOOL_TYPES, MACHINE_TYPES, MATERIALS, PROCESSES, MOVE_SIGN };
