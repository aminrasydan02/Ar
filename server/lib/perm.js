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

function mayWrite(res, role, process, roles) {
  if (process && res.processes) return res.processes.includes(process) && (role !== 'viewer' || res.write.includes(role));
  return roles.includes(role);
}

function can(who, action, resourceName) {
  const role = typeof who === 'string' ? who : who && who.role;
  const process = typeof who === 'string' ? null : who && who.process;
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
      return !res.noCreate && mayWrite(res, role, process, res.write);
    case 'update':
      return !res.noUpdate && mayWrite(res, role, process, res.write);
    case 'upload':
      return mayWrite(res, role, process, res.upload || []);
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
  out.job_travellers.approve = canApprove(typeof who === 'string' ? { role } : who);
  return out;
}

// Approving a Job Traveller: Manager (any role but viewer) or Admin.
const canApprove = (u) => !!u && (u.role === 'admin' || (u.process === 'Manager' && u.role !== 'viewer'));

module.exports = { ROLES, can, rightsFor, canApprove };
