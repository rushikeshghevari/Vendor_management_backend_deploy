import request from 'supertest';

import { createApp } from '@/app';
import { ROLES } from '@/constants/roles';
import { createTestDepartment, createTestUser } from '@/test/factories';

const app = createApp();

async function loginAs(email: string, password = 'Password123!') {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  return res.body.data.accessToken as string;
}

describe('POST /api/v1/departments', () => {
  it('creates a department with an inline new HOD', async () => {
    await createTestUser({ email: 'admin@vms.local', role: ROLES.SUPER_ADMIN });
    const token = await loginAs('admin@vms.local');

    const res = await request(app)
      .post('/api/v1/departments')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Procurement',
        code: 'PUR',
        createHod: true,
        hod: { name: 'HOD One', email: 'hod1@vms.local', password: 'Password123!' },
      });

    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('Procurement');
    expect(res.body.data.hod).toBeDefined();
  });

  it('creates a department with no HOD assigned', async () => {
    await createTestUser({ email: 'admin@vms.local', role: ROLES.SUPER_ADMIN });
    const token = await loginAs('admin@vms.local');

    const res = await request(app)
      .post('/api/v1/departments')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Finance', code: 'FIN' });

    expect(res.status).toBe(201);
    expect(res.body.data.hod).toBeUndefined();
  });

  it('rejects a non-Super-Admin from creating a department', async () => {
    await createTestUser({ email: 'du@vms.local', role: ROLES.DEPARTMENT_USER });
    const token = await loginAs('du@vms.local');

    const res = await request(app)
      .post('/api/v1/departments')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Finance', code: 'FIN' });

    expect(res.status).toBe(403);
  });
});

describe('PUT/PATCH /api/v1/departments/:id', () => {
  it('updates a department', async () => {
    const admin = await createTestUser({ email: 'admin@vms.local', role: ROLES.SUPER_ADMIN });
    const token = await loginAs('admin@vms.local');
    const dept = await createTestDepartment({ name: 'Procurement', code: 'PUR', createdBy: admin.id });

    const res = await request(app)
      .patch(`/api/v1/departments/${dept._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ description: 'Handles all vendor procurement' });

    expect(res.status).toBe(200);
    expect(res.body.data.description).toBe('Handles all vendor procurement');
  });
});

describe('PUT /api/v1/departments/:id/transfer-hod', () => {
  it('assigns a new HOD and demotes the previous one when requested', async () => {
    const admin = await createTestUser({ email: 'admin@vms.local', role: ROLES.SUPER_ADMIN });
    const token = await loginAs('admin@vms.local');
    const dept = await createTestDepartment({ name: 'Procurement', code: 'PUR', createdBy: admin.id });

    const oldHod = await createTestUser({ email: 'oldhod@vms.local', role: ROLES.HOD, department: dept._id.toString() });
    dept.hod = oldHod._id as typeof dept.hod;
    await dept.save();

    const newHod = await createTestUser({ email: 'newhod@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });

    const res = await request(app)
      .put(`/api/v1/departments/${dept._id}/transfer-hod`)
      .set('Authorization', `Bearer ${token}`)
      .send({ newHodId: newHod.id, demoteOldHod: true });

    expect(res.status).toBe(200);
    expect(res.body.data.hod._id ?? res.body.data.hod).toBeTruthy();

    const { User } = await import('@/modules/user/user.model');
    const refreshedOld = await User.findById(oldHod.id);
    const refreshedNew = await User.findById(newHod.id);
    expect(refreshedOld?.role).toBe(ROLES.DEPARTMENT_USER);
    expect(refreshedNew?.role).toBe(ROLES.HOD);
  });

  it('moves a HOD from another department without demoting unless asked', async () => {
    const admin = await createTestUser({ email: 'admin@vms.local', role: ROLES.SUPER_ADMIN });
    const token = await loginAs('admin@vms.local');

    const deptA = await createTestDepartment({ name: 'Procurement', code: 'PUA', createdBy: admin.id });
    const deptB = await createTestDepartment({ name: 'Finance', code: 'FIB', createdBy: admin.id });

    const roamingHod = await createTestUser({ email: 'roaming@vms.local', role: ROLES.HOD, department: deptA._id.toString() });
    deptA.hod = roamingHod._id as typeof deptA.hod;
    await deptA.save();

    const res = await request(app)
      .put(`/api/v1/departments/${deptB._id}/transfer-hod`)
      .set('Authorization', `Bearer ${token}`)
      .send({ newHodId: roamingHod.id });

    expect(res.status).toBe(200);

    const { Department } = await import('@/modules/department/department.model');
    const refreshedA = await Department.findById(deptA._id);
    expect(refreshedA?.hod).toBeUndefined();
  });
});

describe('GET /api/v1/departments/:id/analytics', () => {
  it('returns the expected analytics shape', async () => {
    const admin = await createTestUser({ email: 'admin@vms.local', role: ROLES.SUPER_ADMIN });
    const token = await loginAs('admin@vms.local');
    const dept = await createTestDepartment({ name: 'Procurement', code: 'PUR', createdBy: admin.id });

    const res = await request(app)
      .get(`/api/v1/departments/${dept._id}/analytics`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      activeUsers: 0,
      inactiveUsers: 0,
      pendingApprovals: 0,
      rejected: 0,
      completed: 0,
    });
    expect(Array.isArray(res.body.data.weeklyActivity)).toBe(true);
    expect(Array.isArray(res.body.data.monthlyTrend)).toBe(true);
    expect(Array.isArray(res.body.data.vendorGrowth)).toBe(true);
    expect(Array.isArray(res.body.data.quotationStatusBreakdown)).toBe(true);
    expect(Array.isArray(res.body.data.billStatusBreakdown)).toBe(true);
  });

  it('rejects a Department User from viewing analytics', async () => {
    const admin = await createTestUser({ email: 'admin@vms.local', role: ROLES.SUPER_ADMIN });
    const dept = await createTestDepartment({ name: 'Procurement', code: 'PUR', createdBy: admin.id });
    await createTestUser({ email: 'du@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
    const token = await loginAs('du@vms.local');

    const res = await request(app)
      .get(`/api/v1/departments/${dept._id}/analytics`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});
