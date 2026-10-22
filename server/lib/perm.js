'use strict';
// Role rules, checked by the server on every request.
//   admin   - everything, including users and deletes
//   planner - read all; create/update planning data; upload drawings; export. Never deletes.
//   viewer  - read and export only
// A user with a process (Designer, Planner, ...) may only create, update or upload the
// data that process owns (resource.processes). Everyone can read, to share information.
// Manager owns no shop data: reads everything, exports, approves Job Travellers, closes issues.
const { resources } = require('./resources');

const ROLES = ['admin', 'planner', 'viewer'];

// Process -> modules it may change, loaded from the process_rights table (setProcessRights).
let processRights = null;
function setProcessRights(rows) {
  processRights = {};
  for (const r of rows) (processRights[r.resource] = processRights[r.resource] || []).push(r.process);
}
const ownersOf = (name, res) => (processRights ? processRights[name] || null : res.processes || null);

const userProcs = (u) => [u.process, ...(Array.isArray(u.extra_processes) ? u.extra_processes : String(u.extra_processes || '').split(','))].filter(Boolean);

function mayWrite(who, name, res, roles) {
  const role = who.role;
  if (who.full_edit && role !== 'viewer') return true; // appointed by Admin
  const mine = userProcs(who);
  const owners = ownersOf(name, res);
  if (mine.length && owners) return mine.some((p) => owners.includes(p)) && (role !== 'viewer' || res.write.includes(role));
  return roles.includes(role);
}

function can(who, action, resourceName) {
  if (typeof who === 'string') who = { role: who };
  const role = who && who.role;
  if (!ROLES.includes(role)) return false;
  if (role === 'admin') return true;
  if (resourceName === 'users') return false;
  const res = resources[resourceName];
  if (!res) return false;
  switch (action) {
    case 'read':
    case 'export':
      return true;
    case 'create':
      return !res.noCreate && mayWrite(who, resourceName, res, res.write);
    case 'update':
      return !res.noUpdate && mayWrite(who, resourceName, res, res.write);
    case 'upload':
      return mayWrite(who, resourceName, res, res.upload || []);
    case 'delete':
      return false;
    default:
      return false;
  }
}

// What the browser needs to show or hide buttons for the signed-in user.
function rightsFor(who) {
  const role = typeof who === 'string' ? who : who.role;
  const out = {};
  for (const name of Object.keys(resources)) {
    out[name] = {};
    for (const action of ['read', 'export', 'create', 'update', 'delete', 'upload']) {
      out[name][action] = can(who, action, name);
    }
  }
  out.users = { manage: role === 'admin' };
  out.layout = { edit: canEditLayout(typeof who === 'string' ? { role } : who) };
  out.job_travellers.approve = canApprove(typeof who === 'string' ? { role } : who);
  return out;
}

// Approving a Job Traveller: Manager (any role but viewer) or Admin.
const canApprove = (u) => !!u && (u.role === 'admin' || (u.role !== 'viewer' && (u.full_edit || u.process === 'Manager')));

// Editing the shop-floor layout: Admin, or Planner / Supervisor / Technician / Manager.
const LAYOUT_PROCESSES = ['Planner', 'Supervisor', 'Technician', 'Manager'];
const canEditLayout = (u) => !!u && (u.role === 'admin' || (u.role === 'planner' &&
  (u.full_edit || !u.process || userProcs(u).some((p) => LAYOUT_PROCESSES.includes(p)))));

module.exports = { ROLES, can, rightsFor, canApprove, canEditLayout, setProcessRights };
