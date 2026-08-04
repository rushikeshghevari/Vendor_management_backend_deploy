import jwt from 'jsonwebtoken';
import request from 'supertest';

import { createApp } from '@/app';
import { env } from '@/config/env';
import { ROLES } from '@/constants/roles';
import { createTestUser } from '@/test/factories';

const app = createApp();

async function loginAs(email: string, password = 'Password123!') {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  return res.body.data.accessToken as string;
}

describe('Role-gated routes reject the wrong role with 403', () => {
  it('Department User cannot create a department (Super Admin only)', async () => {
    await createTestUser({ email: 'du@vms.local', role: ROLES.DEPARTMENT_USER });
    const token = await loginAs('du@vms.local');

    const res = await request(app)
      .post('/api/v1/departments')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Finance', code: 'FIN' });

    expect(res.status).toBe(403);
  });

  it('Department User cannot access HOD-only routes', async () => {
    await createTestUser({ email: 'du2@vms.local', role: ROLES.DEPARTMENT_USER });
    const token = await loginAs('du2@vms.local');

    const res = await request(app).get('/api/v1/hod/department').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it('HOD cannot access the Super-Admin-only user list', async () => {
    await createTestUser({ email: 'hod@vms.local', role: ROLES.HOD });
    const token = await loginAs('hod@vms.local');

    const res = await request(app).get('/api/v1/users').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});

describe('Missing or invalid tokens are rejected with 401', () => {
  it('rejects a request with no Authorization header', async () => {
    const res = await request(app).get('/api/v1/departments');
    expect(res.status).toBe(401);
  });

  it('rejects an expired access token', async () => {
    const user = await createTestUser({ email: 'expired@vms.local' });
    const expiredToken = jwt.sign({ sub: user.id, role: user.role }, env.jwtAccessSecret, { expiresIn: -10 });

    const res = await request(app).get('/api/v1/departments').set('Authorization', `Bearer ${expiredToken}`);

    expect(res.status).toBe(401);
  });

  it('rejects a token for a user that no longer exists', async () => {
    const forged = jwt.sign({ sub: '000000000000000000000000', role: ROLES.SUPER_ADMIN }, env.jwtAccessSecret, { expiresIn: '15m' });

    const res = await request(app).get('/api/v1/departments').set('Authorization', `Bearer ${forged}`);

    expect(res.status).toBe(401);
  });

  it('rejects a deactivated user even with a well-formed token', async () => {
    const user = await createTestUser({ email: 'disabled@vms.local', isActive: false });
    const validToken = jwt.sign({ sub: user.id, role: user.role }, env.jwtAccessSecret, { expiresIn: '15m' });

    const res = await request(app).get('/api/v1/departments').set('Authorization', `Bearer ${validToken}`);

    expect(res.status).toBe(401);
  });
});
