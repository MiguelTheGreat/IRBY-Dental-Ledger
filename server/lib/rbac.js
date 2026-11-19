'use strict';
// FR-7: role-based access control. Front Desk manages demographics and billing;
// Dentists edit clinical charts. This module must keep 100% test coverage.

const ROLES = Object.freeze({
  admin: 'Administrator',
  dentist: 'Dentist',
  frontdesk: 'Front Desk',
});

const ALL = ['admin', 'dentist', 'frontdesk'];

const PERMISSIONS = Object.freeze({
  'patients.read': ALL,
  'patients.write': ALL,
  'patients.delete': ['admin', 'dentist'],
  'chart.read': ALL,
  'chart.write': ['dentist'],
  'ledger.read': ALL,
  'ledger.write': ALL,
  'appointments.read': ALL,
  'appointments.write': ALL,
  'ocr.scan': ALL,
  'audit.read': ['admin', 'dentist'],
  'trash.read': ['admin', 'dentist'],
  'trash.restore': ['admin', 'dentist'],
  'data.export': ['admin', 'dentist'],
  'data.import': ['admin'],
  'backup.manage': ['admin'],
  'users.manage': ['admin'],
});

function isRole(role) {
  return Object.prototype.hasOwnProperty.call(ROLES, role);
}

function can(role, permission) {
  const allowed = PERMISSIONS[permission];
  return Array.isArray(allowed) && allowed.includes(role);
}

function permissionsFor(role) {
  return Object.keys(PERMISSIONS).filter((p) => can(role, p));
}

function roleLabel(role) {
  return isRole(role) ? ROLES[role] : 'Unknown role';
}

module.exports = { ROLES, PERMISSIONS, isRole, can, permissionsFor, roleLabel };
