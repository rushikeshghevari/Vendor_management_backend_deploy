import request from 'supertest';

import { createApp } from '@/app';
import { ROLES } from '@/constants/roles';
import { OCR_STATUS } from '@/constants/status';
import { Quotation } from '@/modules/quotation/quotation.model';
import type { IUser } from '@/modules/user/user.model';
import { createTestDepartment, createTestUser } from '@/test/factories';
import { signAccessToken } from '@/utils/jwt';

const app = createApp();

async function loginAs(email: string, password = 'Password123!') {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  return res.body.data.accessToken as string;
}

// Signs a token directly instead of a real /auth/login round-trip — used only by the tests
// below that create several users in one go, to avoid tripping the 20-req/window
// authRateLimiter this whole file's heavy use of loginAs() otherwise stays under (same
// technique documented in directorReview.test.ts/purchaseOrder.test.ts).
function tokenFor(user: IUser): string {
  return signAccessToken({ sub: String(user._id), role: user.role, department: user.department?.toString() });
}

const sampleItems = [
  { itemName: 'Laptop', quantity: 5, unit: 'pcs', estimatedRate: 60000 },
];

describe('POST /api/v1/requirements', () => {
  it('creates a requirement (Draft) as a Department User', async () => {
    const admin = await createTestUser({ email: 'admin@vms.local', role: ROLES.SUPER_ADMIN });
    const dept = await createTestDepartment({ name: 'Procurement', code: 'PUR', createdBy: admin.id });
    await createTestUser({ email: 'du@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
    const token = await loginAs('du@vms.local');

    const res = await request(app)
      .post('/api/v1/requirements')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Office laptops',
        budget: 300000,
        requiredDate: '2026-08-01',
        items: sampleItems,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('draft');
    expect(res.body.data.requirementNumber).toMatch(/-REQ\d+$/);
  });

  it('rejects a role with no create permission (e.g. Accounts)', async () => {
    const admin = await createTestUser({ email: 'admin@vms.local', role: ROLES.SUPER_ADMIN });
    const dept = await createTestDepartment({ name: 'Finance', code: 'FIN', createdBy: admin.id });
    await createTestUser({ email: 'acc@vms.local', role: ROLES.ACCOUNTS, department: dept._id.toString() });
    const token = await loginAs('acc@vms.local');

    const res = await request(app)
      .post('/api/v1/requirements')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Office laptops', budget: 300000, requiredDate: '2026-08-01', items: sampleItems });

    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/v1/requirements/:id/submit', () => {
  it('submits own draft and transitions status', async () => {
    const admin = await createTestUser({ email: 'admin@vms.local', role: ROLES.SUPER_ADMIN });
    const dept = await createTestDepartment({ name: 'Procurement', code: 'PUR', createdBy: admin.id });
    await createTestUser({ email: 'du@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
    const token = await loginAs('du@vms.local');

    const created = await request(app)
      .post('/api/v1/requirements')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Office laptops', budget: 300000, requiredDate: '2026-08-01', items: sampleItems });

    const res = await request(app)
      .patch(`/api/v1/requirements/${created.body.data._id}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('submitted');
  });

  it('cannot submit another Department User\'s requirement', async () => {
    const admin = await createTestUser({ email: 'admin@vms.local', role: ROLES.SUPER_ADMIN });
    const dept = await createTestDepartment({ name: 'Procurement', code: 'PUR', createdBy: admin.id });
    await createTestUser({ email: 'du1@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
    await createTestUser({ email: 'du2@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
    const token1 = await loginAs('du1@vms.local');
    const token2 = await loginAs('du2@vms.local');

    const created = await request(app)
      .post('/api/v1/requirements')
      .set('Authorization', `Bearer ${token1}`)
      .send({ title: 'Office laptops', budget: 300000, requiredDate: '2026-08-01', items: sampleItems });

    const res = await request(app)
      .patch(`/api/v1/requirements/${created.body.data._id}/submit`)
      .set('Authorization', `Bearer ${token2}`)
      .send();

    expect(res.status).toBe(404);
  });
});

describe('GET /api/v1/requirements', () => {
  it('scopes visibility: a Department User only sees their own requirements', async () => {
    const admin = await createTestUser({ email: 'admin@vms.local', role: ROLES.SUPER_ADMIN });
    const dept = await createTestDepartment({ name: 'Procurement', code: 'PUR', createdBy: admin.id });
    await createTestUser({ email: 'du1@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
    await createTestUser({ email: 'du2@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
    const token1 = await loginAs('du1@vms.local');
    const token2 = await loginAs('du2@vms.local');

    await request(app)
      .post('/api/v1/requirements')
      .set('Authorization', `Bearer ${token1}`)
      .send({ title: 'DU1 requirement', budget: 1000, requiredDate: '2026-08-01', items: sampleItems });

    const res = await request(app)
      .get('/api/v1/requirements')
      .set('Authorization', `Bearer ${token2}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('lets an HOD see every requirement in their department', async () => {
    const admin = await createTestUser({ email: 'admin@vms.local', role: ROLES.SUPER_ADMIN });
    const dept = await createTestDepartment({ name: 'Procurement', code: 'PUR', createdBy: admin.id });
    await createTestUser({ email: 'du@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
    await createTestUser({ email: 'hod@vms.local', role: ROLES.HOD, department: dept._id.toString() });
    const duToken = await loginAs('du@vms.local');
    const hodToken = await loginAs('hod@vms.local');

    await request(app)
      .post('/api/v1/requirements')
      .set('Authorization', `Bearer ${duToken}`)
      .send({ title: 'DU requirement', budget: 1000, requiredDate: '2026-08-01', items: sampleItems });

    const res = await request(app)
      .get('/api/v1/requirements')
      .set('Authorization', `Bearer ${hodToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('includes an accurate quotationCount per item, excluding soft-deleted quotations', async () => {
    const admin = await createTestUser({ email: 'admin-qc@vms.local', role: ROLES.SUPER_ADMIN });
    const dept = await createTestDepartment({ name: 'Procurement QC', code: 'PQC', createdBy: admin.id });
    await createTestUser({ email: 'du-qc@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
    const token = await loginAs('du-qc@vms.local');

    const noQuotationReq = await request(app)
      .post('/api/v1/requirements')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'No quotations yet', budget: 1000, requiredDate: '2026-08-01', items: sampleItems });

    const multiQuotationReq = await request(app)
      .post('/api/v1/requirements')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Several quotations', budget: 500000, requiredDate: '2026-08-01', items: sampleItems });
    const multiQuotationReqId = multiQuotationReq.body.data._id;

    await request(app)
      .patch(`/api/v1/requirements/${multiQuotationReqId}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send();

    const quotationPayload = {
      quotationDate: '2026-07-17',
      amount: 100000,
      gst: 18,
      currency: 'INR',
      paymentTerms: 'Net 30',
      deliveryTerms: 'Within 2 Weeks',
      priority: 'medium',
    };

    const firstQuotation = await request(app)
      .post(`/api/v1/requirements/${multiQuotationReqId}/quotations`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ...quotationPayload, temporaryVendor: { name: 'Alpha Meditech' } });
    await request(app)
      .post(`/api/v1/requirements/${multiQuotationReqId}/quotations`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ...quotationPayload, temporaryVendor: { name: 'Beta Surgicals' } });
    const thirdQuotation = await request(app)
      .post(`/api/v1/requirements/${multiQuotationReqId}/quotations`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ...quotationPayload, temporaryVendor: { name: 'Gamma Vendors (soft-deleted)' } });

    // Soft-delete one of the three quotations — it must not count.
    await Quotation.updateOne({ _id: thirdQuotation.body.data._id }, { isDeleted: true });

    const res = await request(app)
      .get('/api/v1/requirements')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const noQuotationItem = res.body.data.find((item: { _id: string }) => item._id === noQuotationReq.body.data._id);
    const multiQuotationItem = res.body.data.find((item: { _id: string }) => item._id === multiQuotationReqId);

    expect(noQuotationItem.quotationCount).toBe(0);
    expect(multiQuotationItem.quotationCount).toBe(2);
    expect(firstQuotation.status).toBe(201);
  });
});

describe('Requirement-linked quotations', () => {
  it('creates and lists multiple temporary-vendor quotations without creating Vendor records', async () => {
    const admin = await createTestUser({ email: 'admin@vms.local', role: ROLES.SUPER_ADMIN });
    const dept = await createTestDepartment({ name: 'Procurement', code: 'PUR', createdBy: admin.id });
    await createTestUser({ email: 'du@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
    const token = await loginAs('du@vms.local');

    const createdRequirement = await request(app)
      .post('/api/v1/requirements')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Diagnostic equipment', budget: 500000, requiredDate: '2026-08-01', items: sampleItems });

    await request(app)
      .patch(`/api/v1/requirements/${createdRequirement.body.data._id}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send();

    const firstQuotation = await request(app)
      .post(`/api/v1/requirements/${createdRequirement.body.data._id}/quotations`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        temporaryVendor: { name: 'Alpha Meditech', contactPerson: 'Asha' },
        quotationDate: '2026-07-17',
        amount: 100000,
        gst: 18,
        currency: 'INR',
        paymentTerms: 'Net 30',
        deliveryTerms: 'Within 2 Weeks',
        priority: 'medium',
      });

    const secondQuotation = await request(app)
      .post(`/api/v1/requirements/${createdRequirement.body.data._id}/quotations`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        temporaryVendor: { name: 'Beta Surgicals', contactPerson: 'Rohan' },
        quotationDate: '2026-07-17',
        amount: 110000,
        gst: 18,
        currency: 'INR',
        paymentTerms: 'Net 45',
        deliveryTerms: 'Within 3 Weeks',
        priority: 'high',
      });

    const listRes = await request(app)
      .get(`/api/v1/requirements/${createdRequirement.body.data._id}/quotations`)
      .set('Authorization', `Bearer ${token}`);

    expect(firstQuotation.status).toBe(201);
    expect(secondQuotation.status).toBe(201);
    expect(firstQuotation.body.data.vendor).toBeUndefined();
    expect(firstQuotation.body.data.temporaryVendor.name).toBe('Alpha Meditech');
    expect(listRes.status).toBe(200);
    expect(listRes.body.data).toHaveLength(2);
    expect(listRes.body.data.every((item: { requirement: { _id: string } }) => item.requirement._id === createdRequirement.body.data._id)).toBe(true);
  });

  it('notifies the department HOD and Super Admin, and records an activity log entry, when a quotation is added', async () => {
    const admin = await createTestUser({ email: 'admin2@vms.local', role: ROLES.SUPER_ADMIN });
    const hod = await createTestUser({ email: 'hod-quote@vms.local', role: ROLES.HOD });
    const dept = await createTestDepartment({ name: 'Radiology', code: 'RAD', createdBy: admin.id, hod: hod.id });
    await createTestUser({ email: 'du2@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });

    const duToken = await loginAs('du2@vms.local');

    const createdRequirement = await request(app)
      .post('/api/v1/requirements')
      .set('Authorization', `Bearer ${duToken}`)
      .send({ title: 'MRI Scanner', budget: 800000, requiredDate: '2026-08-01', items: sampleItems });
    const requirementId = createdRequirement.body.data._id;

    await request(app)
      .patch(`/api/v1/requirements/${requirementId}/submit`)
      .set('Authorization', `Bearer ${duToken}`)
      .send();

    const quotationRes = await request(app)
      .post(`/api/v1/requirements/${requirementId}/quotations`)
      .set('Authorization', `Bearer ${duToken}`)
      .send({
        temporaryVendor: { name: 'Gamma Imaging' },
        quotationDate: '2026-07-17',
        amount: 750000,
        gst: 18,
        currency: 'INR',
        paymentTerms: 'Net 30',
        deliveryTerms: 'Within 4 Weeks',
        priority: 'high',
      });
    expect(quotationRes.status).toBe(201);

    const hodToken = await loginAs('hod-quote@vms.local');
    const adminToken = await loginAs('admin2@vms.local');

    const hodNotifications = await request(app)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${hodToken}`);
    const adminNotifications = await request(app)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${adminToken}`);

    const hodEntry = hodNotifications.body.data.find((n: { notificationType: string }) => n.notificationType === 'quotation_added');
    const adminEntry = adminNotifications.body.data.find((n: { notificationType: string }) => n.notificationType === 'quotation_added');

    expect(hodEntry).toBeDefined();
    expect(hodEntry.message).toContain(createdRequirement.body.data.requirementNumber);
    expect(hodEntry.message).toContain(quotationRes.body.data.quotationCode);
    expect(hodEntry.message).toContain('Radiology');
    expect(adminEntry).toBeDefined();

    const activityLogs = await request(app)
      .get('/api/v1/activity-logs')
      .set('Authorization', `Bearer ${adminToken}`);
    const logEntry = activityLogs.body.data.find(
      (l: { action: string; targetId: string }) => l.action === 'quotation_created' && l.targetId === quotationRes.body.data._id,
    );
    expect(logEntry).toBeDefined();
    expect(logEntry.department).toBeDefined();
  });

  it('notifies Directors on quotation upload (informational) and again, separately, on Submit to Director', async () => {
    const admin = await createTestUser({ email: 'admin3@vms.local', role: ROLES.SUPER_ADMIN });
    const director = await createTestUser({ email: 'director-quote@vms.local', role: ROLES.DIRECTOR });
    const dept = await createTestDepartment({ name: 'Cardiology', code: 'CAR', createdBy: admin.id });
    await createTestUser({ email: 'du3@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });

    const duToken = await loginAs('du3@vms.local');

    const createdRequirement = await request(app)
      .post('/api/v1/requirements')
      .set('Authorization', `Bearer ${duToken}`)
      .send({ title: 'ECG Machines', budget: 500000, requiredDate: '2026-08-01', items: sampleItems });
    const requirementId = createdRequirement.body.data._id;

    await request(app)
      .patch(`/api/v1/requirements/${requirementId}/submit`)
      .set('Authorization', `Bearer ${duToken}`)
      .send();

    const quotationPayload = {
      quotationDate: '2026-07-17',
      amount: 450000,
      gst: 18,
      currency: 'INR',
      paymentTerms: 'Net 30',
      deliveryTerms: 'Within 4 Weeks',
      priority: 'high',
    };

    const firstQuotationRes = await request(app)
      .post(`/api/v1/requirements/${requirementId}/quotations`)
      .set('Authorization', `Bearer ${duToken}`)
      .send({ ...quotationPayload, temporaryVendor: { name: 'Cardio Supplies' } });
    expect(firstQuotationRes.status).toBe(201);

    const secondQuotationRes = await request(app)
      .post(`/api/v1/requirements/${requirementId}/quotations`)
      .set('Authorization', `Bearer ${duToken}`)
      .send({ ...quotationPayload, temporaryVendor: { name: 'Second Vendor' } });
    expect(secondQuotationRes.status).toBe(201);

    const directorToken = await loginAs('director-quote@vms.local');
    const adminToken = await loginAs('admin3@vms.local');

    // Directors now get an informational "Quotation Added" notification on every upload
    // (re-added per explicit end-user request — see
    // docs/WORKFLOW_ENHANCEMENT_DIRECTOR_SUBMISSION.md) — one per quotation uploaded so far.
    // This is purely informational: it does NOT advance Requirement.status or unlock/lock
    // anything — that gating still only changes via the explicit Submit to Director action
    // below, which is what "requirement_ready_for_review" continues to represent.
    const directorNotificationsBeforeSubmit = await request(app)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${directorToken}`);
    const directorQuotationAddedBeforeSubmit = directorNotificationsBeforeSubmit.body.data.filter(
      (n: { notificationType: string }) => n.notificationType === 'quotation_added',
    );
    expect(directorQuotationAddedBeforeSubmit).toHaveLength(2);
    expect(
      directorNotificationsBeforeSubmit.body.data.some(
        (n: { notificationType: string }) => n.notificationType === 'requirement_ready_for_review',
      ),
    ).toBe(false);

    // Comparison must exist before the Director can be handed the requirement (getReviewPackage
    // requires it) — generated here the same way the mobile app would before pressing the button.
    await Quotation.updateOne(
      { _id: firstQuotationRes.body.data._id },
      { ocr: { status: OCR_STATUS.COMPLETED, attachmentVersion: 1, provider: 'test-fixture', startedAt: new Date(), completedAt: new Date(), confidence: 90, extractedText: 'seeded', structuredData: { vendorName: 'Cardio Supplies', currency: 'INR', discount: 0, grandTotal: 450000, items: [{ description: 'Laptop', quantity: 5, unit: 'pcs', unitPrice: 90000, amount: 450000 }] } } },
    );
    await request(app).post(`/api/v1/requirements/${requirementId}/comparison`).set('Authorization', `Bearer ${duToken}`).send();

    const submitted = await request(app)
      .patch(`/api/v1/requirements/${requirementId}/submit-to-director`)
      .set('Authorization', `Bearer ${duToken}`)
      .send();
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.status).toBe('quotation_comparison');

    const directorNotificationsAfter = await request(app)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${directorToken}`);
    const directorEntriesAfter = directorNotificationsAfter.body.data.filter(
      (n: { notificationType: string }) => n.notificationType === 'requirement_ready_for_review',
    );
    expect(directorEntriesAfter).toHaveLength(1);
    expect(directorEntriesAfter[0].message).toContain(createdRequirement.body.data.requirementNumber);

    const adminNotifications = await request(app)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(
      adminNotifications.body.data.some(
        (n: { notificationType: string }) => n.notificationType === 'requirement_ready_for_review',
      ),
    ).toBe(true);
    expect(director.role).toBe(ROLES.DIRECTOR);
  });
});

describe('GET /api/v1/requirements/:id/quotations — visibility (regression)', () => {
  it('shows every quotation to a Director/HOD/owner regardless of amount or DRAFT status', async () => {
    // Requirement-linked quotations are never individually decided — they stay at DRAFT
    // forever (the Requirement's own status tracks progress instead) — and their `amount`
    // has nothing to do with the CEO Approval Limit routing used by the standalone Quotation
    // module. quotationService.list()'s scopeToOwner previously applied that routing here too
    // (DRAFT excluded, amount vs CEO limit split for Director/CEO), which hid every single
    // Requirement-linked quotation from a Director opening the Requirement they were just
    // notified about. See docs/WORKFLOW_ENHANCEMENT_DIRECTOR_SUBMISSION.md.
    const admin = await createTestUser({ email: 'rq-vis-admin@vms.local', role: ROLES.SUPER_ADMIN });
    const dept = await createTestDepartment({ name: 'Quotation Visibility Dept', code: 'RQVIS', createdBy: admin.id });
    // The HOD's own `department` field (used by requirementService's scopeToOwner) is a
    // separate link from Department.hod — both must be set, same gotcha documented in
    // vendorRegistration.test.ts's setup.
    const hod = await createTestUser({ email: 'rq-vis-hod@vms.local', role: ROLES.HOD, department: dept._id.toString() });
    const du = await createTestUser({ email: 'rq-vis-du@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
    const director = await createTestUser({ email: 'rq-vis-director@vms.local', role: ROLES.DIRECTOR });

    const duToken = tokenFor(du);
    const hodToken = tokenFor(hod);
    const directorToken = tokenFor(director);

    const created = await request(app)
      .post('/api/v1/requirements')
      .set('Authorization', `Bearer ${duToken}`)
      .send({ title: 'Visibility Test', budget: 500000, requiredDate: '2026-08-01', items: sampleItems });
    const requirementId = created.body.data._id;

    await request(app).patch(`/api/v1/requirements/${requirementId}/submit`).set('Authorization', `Bearer ${duToken}`).send();

    // One quotation well under the default ₹50,000 CEO Approval Limit, one well above it —
    // both must be visible to every role that can see the requirement, since neither amount
    // routes anywhere in this flow.
    const lowAmountQuotation = await request(app)
      .post(`/api/v1/requirements/${requirementId}/quotations`)
      .set('Authorization', `Bearer ${duToken}`)
      .send({
        temporaryVendor: { name: 'Low Amount Vendor' },
        quotationDate: '2026-07-17', amount: 20000, gst: 18, currency: 'INR',
        paymentTerms: 'Net 30', deliveryTerms: 'Within 2 Weeks', priority: 'medium',
      });
    const highAmountQuotation = await request(app)
      .post(`/api/v1/requirements/${requirementId}/quotations`)
      .set('Authorization', `Bearer ${duToken}`)
      .send({
        temporaryVendor: { name: 'High Amount Vendor' },
        quotationDate: '2026-07-17', amount: 450000, gst: 18, currency: 'INR',
        paymentTerms: 'Net 30', deliveryTerms: 'Within 2 Weeks', priority: 'high',
      });
    expect(lowAmountQuotation.status).toBe(201);
    expect(highAmountQuotation.status).toBe(201);
    expect(lowAmountQuotation.body.data.status).toBe('draft');
    expect(highAmountQuotation.body.data.status).toBe('draft');

    for (const token of [duToken, hodToken, directorToken]) {
      const res = await request(app)
        .get(`/api/v1/requirements/${requirementId}/quotations`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      const codes = res.body.data.map((q: { quotationCode: string }) => q.quotationCode).sort();
      expect(codes).toEqual([lowAmountQuotation.body.data.quotationCode, highAmountQuotation.body.data.quotationCode].sort());
    }
  });

  it('still 404s for a Director-only endpoint scoping check — a Department User cannot list another department\'s requirement quotations', async () => {
    const admin = await createTestUser({ email: 'rq-vis2-admin@vms.local', role: ROLES.SUPER_ADMIN });
    const dept = await createTestDepartment({ name: 'Owner Dept', code: 'RQVIS2', createdBy: admin.id });
    const otherDept = await createTestDepartment({ name: 'Other Dept', code: 'RQVIS3', createdBy: admin.id });
    const du = await createTestUser({ email: 'rq-vis2-du@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
    const otherDu = await createTestUser({ email: 'rq-vis2-otherdu@vms.local', role: ROLES.DEPARTMENT_USER, department: otherDept._id.toString() });

    const duToken = tokenFor(du);
    const otherToken = tokenFor(otherDu);

    const created = await request(app)
      .post('/api/v1/requirements')
      .set('Authorization', `Bearer ${duToken}`)
      .send({ title: 'Private Requirement', budget: 100000, requiredDate: '2026-08-01', items: sampleItems });
    const requirementId = created.body.data._id;

    const res = await request(app)
      .get(`/api/v1/requirements/${requirementId}/quotations`)
      .set('Authorization', `Bearer ${otherToken}`);
    expect(res.status).toBe(404);
  });
});
