import request from 'supertest';

import { createApp } from '@/app';
import { ROLES } from '@/constants/roles';
import { createTestDepartment, createTestUser } from '@/test/factories';

const app = createApp();

async function loginAs(email: string, password = 'Password123!') {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  return res.body.data.accessToken as string;
}

async function setupDepartmentWithHod(deptCode: string, hodEmail: string) {
  const admin = await createTestUser({ email: `admin-${deptCode}@vms.local`, role: ROLES.SUPER_ADMIN });
  const dept = await createTestDepartment({ name: `Dept ${deptCode}`, code: deptCode, createdBy: admin.id });
  const hod = await createTestUser({ email: hodEmail, role: ROLES.HOD, department: dept._id.toString() });
  dept.hod = hod._id as typeof dept.hod;
  await dept.save();
  return { admin, dept, hod };
}

describe('HOD login and own-department scope', () => {
  it('logs in as HOD and can fetch their own department', async () => {
    const { dept } = await setupDepartmentWithHod('HD1', 'hod1@vms.local');
    const token = await loginAs('hod1@vms.local');

    const res = await request(app).get('/api/v1/hod/department').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.code).toBe(dept.code);
  });
});

describe('POST /api/v1/hod/users', () => {
  it('creates a department user scoped to the HOD own department', async () => {
    const { dept } = await setupDepartmentWithHod('HD2', 'hod2@vms.local');
    const token = await loginAs('hod2@vms.local');

    const res = await request(app)
      .post('/api/v1/hod/users')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'New Dept User', email: 'newdu@vms.local', password: 'Password123!' });

    expect(res.status).toBe(201);
    expect(res.body.data.role).toBe(ROLES.DEPARTMENT_USER);
    expect(res.body.data.department).toBe(dept._id.toString());
  });

  it('rejects a client-supplied role/department via the strict schema (400)', async () => {
    await setupDepartmentWithHod('HD3', 'hod3@vms.local');
    const token = await loginAs('hod3@vms.local');

    const res = await request(app)
      .post('/api/v1/hod/users')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Sneaky User',
        email: 'sneaky@vms.local',
        password: 'Password123!',
        role: ROLES.SUPER_ADMIN,
        department: '000000000000000000000000',
      });

    expect(res.status).toBe(400);
  });
});

describe('GET /api/v1/hod/users', () => {
  it('only returns department users belonging to the HOD own department', async () => {
    const { dept: deptA } = await setupDepartmentWithHod('HDA', 'hodA@vms.local');
    const { dept: deptB } = await setupDepartmentWithHod('HDB', 'hodB@vms.local');

    await createTestUser({ email: 'userA@vms.local', role: ROLES.DEPARTMENT_USER, department: deptA._id.toString() });
    await createTestUser({ email: 'userB@vms.local', role: ROLES.DEPARTMENT_USER, department: deptB._id.toString() });

    const tokenA = await loginAs('hodA@vms.local');
    const res = await request(app).get('/api/v1/hod/users').set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    const emails = res.body.data.map((u: { email: string }) => u.email);
    expect(emails).toContain('usera@vms.local');
    expect(emails).not.toContain('userb@vms.local');
  });
});

describe('Cross-department access is forbidden', () => {
  it('rejects HOD-A managing a Department User that belongs to HOD-B (403)', async () => {
    const { dept: deptA } = await setupDepartmentWithHod('HXA', 'hodXA@vms.local');
    const { dept: deptB } = await setupDepartmentWithHod('HXB', 'hodXB@vms.local');
    void deptA;

    const userB = await createTestUser({ email: 'userXB@vms.local', role: ROLES.DEPARTMENT_USER, department: deptB._id.toString() });

    const tokenA = await loginAs('hodXA@vms.local');
    const res = await request(app)
      .patch(`/api/v1/hod/users/${userB.id}/status`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ isActive: false });

    expect(res.status).toBe(403);
  });
});

describe('Active HOD cannot be deactivated (409)', () => {
  it('rejects Super Admin deactivating a user who is the active HOD of a department', async () => {
    const { hod } = await setupDepartmentWithHod('HD9', 'hod9@vms.local');
    const admin = await createTestUser({ email: 'sa9@vms.local', role: ROLES.SUPER_ADMIN });
    void admin;
    const token = await loginAs('sa9@vms.local');

    const res = await request(app)
      .patch(`/api/v1/users/${hod.id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ isActive: false });

    expect(res.status).toBe(409);
  });
});
