import request from 'supertest';

import { createApp } from '@/app';
import { ROLES } from '@/constants/roles';
import { ActivityLog } from '@/modules/activityLog/activityLog.model';
import { createTestDepartment, createTestUser } from '@/test/factories';

const app = createApp();

async function loginAs(email: string, password = 'Password123!') {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  return res.body.data.accessToken as string;
}

// activityLogService.record() is fire-and-forget (never awaited by the controller, by design,
// so a logging failure can never block/break the business response) — poll briefly instead of
// asserting immediately after the HTTP response resolves.
async function waitForActivityLogs(filter: Record<string, unknown>, expectedCount = 1) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const entries = await ActivityLog.find(filter);
    if (entries.length >= expectedCount) return entries;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return ActivityLog.find(filter);
}

const validVendorPayload = (name: string) => ({
  name,
  contactPerson: 'Contact Person',
  phone: '9876543210',
  email: `${name.toLowerCase().replace(/\s+/g, '')}@vendor.local`,
  address: '123 Vendor Street',
  state: 'Gujarat',
  district: 'Ahmedabad',
  city: 'Ahmedabad',
  pincode: '380001',
  bankDetails: {
    bankName: 'Test Bank',
    accountHolderName: name,
    accountNumber: '1234567890',
    ifscCode: 'TEST0123456',
  },
  category: 'Materials',
});

describe('Department/HOD/user actions each produce exactly one ActivityLog entry', () => {
  it('logs department_created when Super Admin creates a department', async () => {
    await createTestUser({ email: 'sa1@vms.local', role: ROLES.SUPER_ADMIN });
    const token = await loginAs('sa1@vms.local');

    await request(app)
      .post('/api/v1/departments')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Logged Dept', code: 'LOG' });

    const entries = await waitForActivityLogs({ action: 'department_created' });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.performedByRole).toBe(ROLES.SUPER_ADMIN);
  });

  it('logs vendor_created when a Department User registers a vendor', async () => {
    const admin = await createTestUser({ email: 'sa2@vms.local', role: ROLES.SUPER_ADMIN });
    const dept = await createTestDepartment({ name: 'Vendor Dept', code: 'VND', createdBy: admin.id });
    await createTestUser({ email: 'du-vendor@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
    const token = await loginAs('du-vendor@vms.local');

    await request(app)
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${token}`)
      .send(validVendorPayload('Logged Vendor'));

    const entries = await waitForActivityLogs({ action: 'vendor_created' });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.targetType).toBe('Vendor');
  });

  it('logs department_user_created when a HOD creates a department user', async () => {
    const admin = await createTestUser({ email: 'sa3@vms.local', role: ROLES.SUPER_ADMIN });
    const dept = await createTestDepartment({ name: 'HOD Dept', code: 'HDX', createdBy: admin.id });
    const hod = await createTestUser({ email: 'hod-log@vms.local', role: ROLES.HOD, department: dept._id.toString() });
    dept.hod = hod._id as typeof dept.hod;
    await dept.save();
    const token = await loginAs('hod-log@vms.local');

    await request(app)
      .post('/api/v1/hod/users')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Logged DeptUser', email: 'logged-du@vms.local', password: 'Password123!' });

    const entries = await waitForActivityLogs({ action: 'department_user_created' });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.performedByRole).toBe(ROLES.HOD);
    expect(String(entries[0]?.department)).toBe(String(dept._id));
  });
});

describe('GET /api/v1/activity-logs scoping', () => {
  it('HOD only sees their own department entries; Super Admin sees everything', async () => {
    const admin = await createTestUser({ email: 'sa4@vms.local', role: ROLES.SUPER_ADMIN });
    const deptA = await createTestDepartment({ name: 'Log Dept A', code: 'LDA', createdBy: admin.id });
    const deptB = await createTestDepartment({ name: 'Log Dept B', code: 'LDB', createdBy: admin.id });

    const hodA = await createTestUser({ email: 'hodA-log@vms.local', role: ROLES.HOD, department: deptA._id.toString() });
    deptA.hod = hodA._id as typeof deptA.hod;
    await deptA.save();

    const hodB = await createTestUser({ email: 'hodB-log@vms.local', role: ROLES.HOD, department: deptB._id.toString() });
    deptB.hod = hodB._id as typeof deptB.hod;
    await deptB.save();

    const tokenA = await loginAs('hodA-log@vms.local');
    const tokenB = await loginAs('hodB-log@vms.local');
    const tokenAdmin = await loginAs('sa4@vms.local');

    await request(app)
      .post('/api/v1/hod/users')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'A User', email: 'auser-log@vms.local', password: 'Password123!' });

    await request(app)
      .post('/api/v1/hod/users')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'B User', email: 'buser-log@vms.local', password: 'Password123!' });

    await waitForActivityLogs({ action: 'department_user_created' }, 2);

    const asHodA = await request(app).get('/api/v1/activity-logs').set('Authorization', `Bearer ${tokenA}`);
    const asAdmin = await request(app).get('/api/v1/activity-logs').set('Authorization', `Bearer ${tokenAdmin}`);

    expect(asHodA.status).toBe(200);
    expect(asHodA.body.data.length).toBeGreaterThan(0);
    expect(asHodA.body.data.every((e: { department: { _id: string } | string }) =>
      String(typeof e.department === 'object' ? e.department._id : e.department) === String(deptA._id),
    )).toBe(true);

    expect(asAdmin.body.data.length).toBeGreaterThanOrEqual(asHodA.body.data.length);
  });

  it('rejects a Department User from viewing activity logs', async () => {
    const admin = await createTestUser({ email: 'sa5@vms.local', role: ROLES.SUPER_ADMIN });
    const dept = await createTestDepartment({ name: 'DU Dept', code: 'DUX', createdBy: admin.id });
    await createTestUser({ email: 'du-log@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
    const token = await loginAs('du-log@vms.local');

    const res = await request(app).get('/api/v1/activity-logs').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});
