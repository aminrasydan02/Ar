'use strict';
// Every data module is described here once. The server builds tables, validation
// and the REST API from these definitions, and the browser builds forms and lists
// from the same definitions (served at /api/meta).

const MACHINE_TYPES = ['Fiber laser', 'Press brake', 'Clinching/PEM press', 'Polishing/grinding',
  'Shearing', 'Turret punch', 'Welding', 'General'];
const MATERIALS = ['Aluminium', 'SS', 'SPCC', 'SECC', 'GI', 'Copper', 'Other'];

const resources = {
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
};

const SYSTEM_TYPES = { number: 'REAL', ref: 'INTEGER' };

function columnType(field) {
  return SYSTEM_TYPES[field.type] || 'TEXT';
}

module.exports = { resources, columnType, MACHINE_TYPES, MATERIALS };
