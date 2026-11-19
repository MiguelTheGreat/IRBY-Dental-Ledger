'use strict';
// FR-7 role-based access control. `npm run test:critical` requires 100% coverage of server/lib/rbac.js.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ROLES, PERMISSIONS, isRole, can, permissionsFor, roleLabel } = require('../server/lib/rbac');

// Expected matrix, written out independently of the module under test.
const MATRIX = {
  'patients.read': ['admin', 'dentist', 'frontdesk'],
  'patients.write': ['admin', 'dentist', 'frontdesk'],
  'patients.delete': ['admin', 'dentist'],
  'chart.read': ['admin', 'dentist', 'frontdesk'],
  'chart.write': ['dentist'],
  'ledger.read': ['admin', 'dentist', 'frontdesk'],
  'ledger.write': ['admin', 'dentist', 'frontdesk'],
  'appointments.read': ['admin', 'dentist', 'frontdesk'],
  'appointments.write': ['admin', 'dentist', 'frontdesk'],
  'ocr.scan': ['admin', 'dentist', 'frontdesk'],
  'audit.read': ['admin', 'dentist'],
  'trash.read': ['admin', 'dentist'],
  'trash.restore': ['admin', 'dentist'],
  'data.export': ['admin', 'dentist'],
  'data.import': ['admin'],
  'backup.manage': ['admin'],
  'users.manage': ['admin'],
};

describe('rbac', () => {
  it('FR-7: defines exactly the three clinic roles', () => {
    assert.deepEqual(Object.keys(ROLES).sort(), ['admin', 'dentist', 'frontdesk']);
    assert.ok(Object.isFrozen(ROLES));
    assert.ok(Object.isFrozen(PERMISSIONS));
  });

  it('FR-7: isRole accepts known roles only (no prototype keys)', () => {
    assert.equal(isRole('admin'), true);
    assert.equal(isRole('dentist'), true);
    assert.equal(isRole('frontdesk'), true);
    assert.equal(isRole('superuser'), false);
    assert.equal(isRole('toString'), false);
    assert.equal(isRole(undefined), false);
  });

  it('FR-7: front desk cannot edit the clinical chart; dentists can', () => {
    assert.equal(can('frontdesk', 'chart.write'), false);
    assert.equal(can('dentist', 'chart.write'), true);
    assert.equal(can('admin', 'chart.write'), false);
    assert.equal(can('frontdesk', 'chart.read'), true);
  });

  it('FR-7: front desk manages demographics and billing', () => {
    for (const p of ['patients.read', 'patients.write', 'ledger.read', 'ledger.write', 'appointments.write', 'ocr.scan']) {
      assert.equal(can('frontdesk', p), true, p);
    }
    assert.equal(can('frontdesk', 'patients.delete'), false);
    assert.equal(can('frontdesk', 'audit.read'), false);
  });

  it('FR-7: unknown permissions and unknown roles are denied', () => {
    assert.equal(can('admin', 'nuke.everything'), false);
    assert.equal(can('admin', 'constructor'), false);
    assert.equal(can('ghost', 'patients.read'), false);
    assert.equal(can(undefined, 'patients.read'), false);
  });

  it('FR-7: permission matrix matches the specification', () => {
    assert.deepEqual(Object.keys(PERMISSIONS).sort(), Object.keys(MATRIX).sort());
    for (const [perm, roles] of Object.entries(MATRIX)) {
      for (const role of Object.keys(ROLES)) {
        assert.equal(can(role, perm), roles.includes(role), `${role} / ${perm}`);
      }
    }
  });

  it('FR-7: permissionsFor lists every granted permission', () => {
    const expected = (role) => Object.keys(MATRIX).filter((p) => MATRIX[p].includes(role));
    assert.deepEqual(permissionsFor('admin'), expected('admin'));
    assert.deepEqual(permissionsFor('dentist'), expected('dentist'));
    assert.deepEqual(permissionsFor('frontdesk'), expected('frontdesk'));
    assert.ok(!permissionsFor('frontdesk').includes('chart.write'));
    assert.ok(permissionsFor('admin').includes('users.manage'));
    assert.deepEqual(permissionsFor('ghost'), []);
  });

  it('roleLabel gives display names and a fallback', () => {
    assert.equal(roleLabel('admin'), 'Administrator');
    assert.equal(roleLabel('dentist'), 'Dentist');
    assert.equal(roleLabel('frontdesk'), 'Front Desk');
    assert.equal(roleLabel('hacker'), 'Unknown role');
  });
});
