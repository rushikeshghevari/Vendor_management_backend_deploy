import jwt from 'jsonwebtoken';
import request from 'supertest';

import { createApp } from '@/app';
import { env } from '@/config/env';
import { RefreshToken } from '@/modules/auth/refreshToken.model';
import { createTestUser } from '@/test/factories';

const app = createApp();

describe('POST /api/v1/auth/login', () => {
  it('logs in with valid credentials and returns tokens + user', async () => {
    await createTestUser({ email: 'admin@vms.local', password: 'CorrectPass1!' });

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@vms.local', password: 'CorrectPass1!' });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeDefined();
    expect(res.body.data.refreshToken).toBeDefined();
    expect(res.body.data.user.email).toBe('admin@vms.local');
    expect(res.body.data.user.password).toBeUndefined();
  });

  it('rejects an invalid password with 401 and a generic message', async () => {
    await createTestUser({ email: 'admin@vms.local', password: 'CorrectPass1!' });

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@vms.local', password: 'WrongPassword!' });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('Invalid email or password');
  });

  it('rejects an unknown email with 401', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@vms.local', password: 'WhateverPass1!' });

    expect(res.status).toBe(401);
  });

  it('rejects a deactivated user with 401', async () => {
    await createTestUser({ email: 'inactive@vms.local', password: 'CorrectPass1!', isActive: false });

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'inactive@vms.local', password: 'CorrectPass1!' });

    expect(res.status).toBe(401);
  });

  it('returns 400 for a malformed request body', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'not-an-email' });

    expect(res.status).toBe(400);
    expect(res.body.errors).toHaveProperty('email');
    expect(res.body.errors).toHaveProperty('password');
  });
});

describe('GET /api/v1/auth/me', () => {
  it('returns the current user for a valid access token', async () => {
    await createTestUser({ email: 'admin@vms.local', password: 'CorrectPass1!' });
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@vms.local', password: 'CorrectPass1!' });

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${login.body.data.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe('admin@vms.local');
  });

  it('rejects a request with no Authorization header', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });

  it('rejects a malformed/garbage token', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer not-a-real-token');

    expect(res.status).toBe(401);
  });

  it('rejects an expired access token', async () => {
    const user = await createTestUser({ email: 'admin@vms.local' });
    const expiredToken = jwt.sign(
      { sub: user.id, role: user.role },
      env.jwtAccessSecret,
      { expiresIn: -10 },
    );

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${expiredToken}`);

    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/expired/i);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const tampered = jwt.sign({ sub: 'whoever', role: 'super_admin' }, 'wrong-secret');

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${tampered}`);

    expect(res.status).toBe(401);
  });
});

describe('POST /api/v1/auth/refresh', () => {
  it('rotates a valid refresh token into a new token pair', async () => {
    await createTestUser({ email: 'admin@vms.local', password: 'CorrectPass1!' });
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@vms.local', password: 'CorrectPass1!' });

    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: login.body.data.refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeDefined();
    expect(res.body.data.refreshToken).not.toBe(login.body.data.refreshToken);
  });

  it('rejects reuse of an already-rotated refresh token', async () => {
    await createTestUser({ email: 'admin@vms.local', password: 'CorrectPass1!' });
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@vms.local', password: 'CorrectPass1!' });

    const originalRefreshToken = login.body.data.refreshToken;

    // First use rotates it...
    await request(app).post('/api/v1/auth/refresh').send({ refreshToken: originalRefreshToken });

    // ...so a second use of the same token must fail.
    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: originalRefreshToken });

    expect(res.status).toBe(401);
  });

  it('rejects a garbage refresh token', async () => {
    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: 'not-a-real-token' });

    expect(res.status).toBe(401);
  });

  it('rejects a refresh token whose user no longer exists', async () => {
    const user = await createTestUser({ email: 'admin@vms.local', password: 'CorrectPass1!' });
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@vms.local', password: 'CorrectPass1!' });

    await user.deleteOne();

    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: login.body.data.refreshToken });

    expect(res.status).toBe(401);
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('revokes the refresh token so it can no longer be used to refresh', async () => {
    await createTestUser({ email: 'admin@vms.local', password: 'CorrectPass1!' });
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@vms.local', password: 'CorrectPass1!' });
    const refreshToken = login.body.data.refreshToken;

    const logoutRes = await request(app).post('/api/v1/auth/logout').send({ refreshToken });
    expect(logoutRes.status).toBe(200);

    const stored = await RefreshToken.findOne({});
    expect(stored?.revokedAt).toBeDefined();

    const refreshRes = await request(app).post('/api/v1/auth/refresh').send({ refreshToken });
    expect(refreshRes.status).toBe(401);
  });

  it('is a no-op (still 200) when called with an already-invalid token', async () => {
    const res = await request(app)
      .post('/api/v1/auth/logout')
      .send({ refreshToken: 'not-a-real-token' });

    expect(res.status).toBe(200);
  });
});
