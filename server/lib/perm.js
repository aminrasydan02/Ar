'use strict';
// Role rules, checked by the server on every request.
//   admin   - everything, including users and deletes
//   planner - read all; create/update planning data; upload drawings; export. Never deletes.
//   viewer  - read and export only
const { resources } = require('./resources');

const ROLES = ['admin', 'planner', 'viewer'];

function can(role, action, resourceName) {
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
      return !res.noCreate && res.write.includes(role);
    case 'update':
      return res.write.includes(role);
    case 'upload':
      return (res.upload || []).includes(role);
    case 'delete':
      return false;
    default:
      return false;
  }
}

// What the browser needs to show or hide buttons for the signed-in user.
function rightsFor(role) {
  const out = {};
  for (const name of Object.keys(resources)) {
    out[name] = {};
    for (const action of ['read', 'export', 'create', 'update', 'delete', 'upload']) {
      out[name][action] = can(role, action, name);
    }
  }
  out.users = { manage: role === 'admin' };
  return out;
}

module.exports = { ROLES, can, rightsFor };
