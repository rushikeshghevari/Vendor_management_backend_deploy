import request from 'supertest';

import { createApp } from '@/app';
import { ROLES } from '@/constants/roles';
import { notificationService } from '@/modules/notification/notification.service';
import { createTestUser } from '@/test/factories';

const app = createApp();

async function loginAs(email: string, password = 'Password123!') {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  return res.body.data.accessToken as string;
}

describe('GET /api/v1/notifications/unread-count', () => {
  it('counts only the caller own unread notifications', async () => {
    const userA = await createTestUser({ email: 'notifA@vms.local', role: ROLES.DEPARTMENT_USER });
    const userB = await createTestUser({ email: 'notifB@vms.local', role: ROLES.DEPARTMENT_USER });

    await notificationService.notifyUser(
      { id: userA.id, role: ROLES.DEPARTMENT_USER },
      { title: 'Hello A', message: 'msg', module: 'system', relatedRecord: userA.id, notificationType: 'system_announcement' },
    );
    await notificationService.notifyUser(
      { id: userB.id, role: ROLES.DEPARTMENT_USER },
      { title: 'Hello B', message: 'msg', module: 'system', relatedRecord: userB.id, notificationType: 'system_announcement' },
    );

    const tokenA = await loginAs('notifA@vms.local');
    const res = await request(app).get('/api/v1/notifications/unread-count').set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(1);
  });
});

describe('PATCH /api/v1/notifications/:id/read', () => {
  it('marks the caller own notification as read', async () => {
    const user = await createTestUser({ email: 'notifC@vms.local', role: ROLES.DEPARTMENT_USER });
    await notificationService.notifyUser(
      { id: user.id, role: ROLES.DEPARTMENT_USER },
      { title: 'Hello', message: 'msg', module: 'system', relatedRecord: user.id, notificationType: 'system_announcement' },
    );

    const token = await loginAs('notifC@vms.local');
    const list = await request(app).get('/api/v1/notifications').set('Authorization', `Bearer ${token}`);
    const notifId = list.body.data[0].id ?? list.body.data[0]._id;

    const res = await request(app).patch(`/api/v1/notifications/${notifId}/read`).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.isRead).toBe(true);
  });

  it('returns 404 when trying to mark another user notification as read', async () => {
    const owner = await createTestUser({ email: 'notifOwner@vms.local', role: ROLES.DEPARTMENT_USER });
    const intruder = await createTestUser({ email: 'notifIntruder@vms.local', role: ROLES.DEPARTMENT_USER });

    await notificationService.notifyUser(
      { id: owner.id, role: ROLES.DEPARTMENT_USER },
      { title: 'Private', message: 'msg', module: 'system', relatedRecord: owner.id, notificationType: 'system_announcement' },
    );

    const ownerToken = await loginAs('notifOwner@vms.local');
    const list = await request(app).get('/api/v1/notifications').set('Authorization', `Bearer ${ownerToken}`);
    const notifId = list.body.data[0].id ?? list.body.data[0]._id;

    const intruderToken = await loginAs('notifIntruder@vms.local');
    const res = await request(app).patch(`/api/v1/notifications/${notifId}/read`).set('Authorization', `Bearer ${intruderToken}`);

    expect(res.status).toBe(404);
  });
});

describe('GET /api/v1/notifications list scoping', () => {
  it('a regular user only sees their own notifications, Super Admin sees all', async () => {
    const user = await createTestUser({ email: 'notifD@vms.local', role: ROLES.DEPARTMENT_USER });
    const admin = await createTestUser({ email: 'notifAdmin@vms.local', role: ROLES.SUPER_ADMIN });

    await notificationService.notifyUser(
      { id: user.id, role: ROLES.DEPARTMENT_USER },
      { title: 'For User', message: 'msg', module: 'system', relatedRecord: user.id, notificationType: 'system_announcement' },
    );

    const userToken = await loginAs('notifD@vms.local');
    const adminToken = await loginAs('notifAdmin@vms.local');

    const asUser = await request(app).get('/api/v1/notifications').set('Authorization', `Bearer ${userToken}`);
    const asAdmin = await request(app).get('/api/v1/notifications').set('Authorization', `Bearer ${adminToken}`);

    expect(asUser.body.data.every((n: { receiver: string }) => n.receiver === user.id)).toBe(true);
    expect(asAdmin.body.data.length).toBeGreaterThanOrEqual(asUser.body.data.length);
  });
});
