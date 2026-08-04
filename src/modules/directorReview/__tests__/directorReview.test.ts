import request from 'supertest';

import { createApp } from '@/app';
import { ROLES } from '@/constants/roles';
import { OCR_STATUS } from '@/constants/status';
import { ActivityLog } from '@/modules/activityLog/activityLog.model';
import { DirectorReview } from '@/modules/directorReview/directorReview.model';
import { Notification } from '@/modules/notification/notification.model';
import { Quotation } from '@/modules/quotation/quotation.model';
import { Requirement } from '@/modules/requirement/requirement.model';
import type { IUser } from '@/modules/user/user.model';
import { createTestDepartment, createTestUser } from '@/test/factories';
import { signAccessToken } from '@/utils/jwt';

const app = createApp();

/**
 * Builds a valid access token directly (same technique `authorization.test.ts` uses for its
 * expired-token case) instead of going through `POST /auth/login`. This suite creates far
 * more users than any other test file (multiple roles per scenario, many scenarios), and
 * `/auth/login` is IP-rate-limited to 20 requests/window (`authRateLimiter` in
 * `auth.routes.ts`) — a real login round-trip per user would blow through that limit purely
 * from this file's own volume. `authenticate` only ever trusts the token's `sub` (it
 * re-fetches role/department from the DB on every request), so a directly-signed token is
 * exactly as valid as one issued by `/auth/login`.
 */
function tokenFor(user: IUser): string {
  return signAccessToken({ sub: String(user._id), role: user.role, department: user.department?.toString() });
}

const sampleItems = [{ itemName: 'Laptop', quantity: 5, unit: 'pcs', estimatedRate: 60000 }];

async function waitFor<T>(check: () => Promise<T | null | undefined>, maxAttempts = 20, intervalMs = 100): Promise<T> {
  for (let i = 0; i < maxAttempts; i++) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Condition was not met within the polling window');
}

/** Bypasses the real OCR pipeline (already covered by requirementOcr.test.ts) so the AI
 *  comparison this suite depends on can be generated deterministically. */
async function seedOcrResult(quotationId: string, grandTotal: number) {
  await Quotation.updateOne(
    { _id: quotationId },
    {
      ocr: {
        status: OCR_STATUS.COMPLETED,
        attachmentVersion: 1,
        provider: 'test-fixture',
        startedAt: new Date(),
        completedAt: new Date(),
        confidence: 90,
        extractedText: 'seeded for test',
        structuredData: {
          vendorName: 'Seeded Vendor',
          currency: 'INR',
          discount: 0,
          grandTotal,
          items: [{ description: 'Laptop', quantity: 5, unit: 'pcs', unitPrice: 60000, amount: 300000 }],
        },
      },
    },
  );
}

interface Setup {
  duToken: string;
  directorToken: string;
  superAdminToken: string;
  hodToken: string;
  requirementId: string;
  quotationId: string;
  dept: { _id: { toString(): string } };
}

async function setupRequirementWithComparison(deptCode: string): Promise<Setup> {
  const admin = await createTestUser({ email: `dr-admin-${deptCode}@vms.local`, role: ROLES.SUPER_ADMIN });
  const hod = await createTestUser({ email: `dr-hod-${deptCode}@vms.local`, role: ROLES.HOD });
  const dept = await createTestDepartment({ name: `Director Review Dept ${deptCode}`, code: deptCode, createdBy: admin.id, hod: hod.id });
  const du = await createTestUser({ email: `dr-du-${deptCode}@vms.local`, role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
  const director = await createTestUser({ email: `dr-director-${deptCode}@vms.local`, role: ROLES.DIRECTOR });

  const duToken = tokenFor(du);
  const directorToken = tokenFor(director);
  const superAdminToken = tokenFor(admin);
  const hodToken = tokenFor(hod);

  const created = await request(app)
    .post('/api/v1/requirements')
    .set('Authorization', `Bearer ${duToken}`)
    .send({ title: 'Director Review Test Requirement', budget: 500000, requiredDate: '2026-08-01', items: sampleItems });
  const requirementId = created.body.data._id as string;

  await request(app).patch(`/api/v1/requirements/${requirementId}/submit`).set('Authorization', `Bearer ${duToken}`).send();

  const quotationRes = await request(app)
    .post(`/api/v1/requirements/${requirementId}/quotations`)
    .set('Authorization', `Bearer ${duToken}`)
    .send({
      temporaryVendor: { name: 'Vendor A' },
      quotationDate: '2026-07-18',
      amount: 300000,
      gst: 18,
      currency: 'INR',
      paymentTerms: 'Net 30',
      deliveryTerms: 'Within 2 Weeks',
      priority: 'medium',
    });
  const quotationId = quotationRes.body.data._id as string;
  await seedOcrResult(quotationId, 300000);

  await request(app).post(`/api/v1/requirements/${requirementId}/comparison`).set('Authorization', `Bearer ${duToken}`).send();

  // Explicit hand-off — the only way a requirement reaches Director Review now (see
  // requirementService.submitToDirector). Leaves the requirement at quotation_comparison,
  // ready for a Director to open — not yet director_review (that only happens once a
  // Director/Super Admin actually views it, unchanged from before).
  const submitted = await request(app).patch(`/api/v1/requirements/${requirementId}/submit-to-director`).set('Authorization', `Bearer ${duToken}`).send();
  expect(submitted.status).toBe(200);
  expect(submitted.body.data.status).toBe('quotation_comparison');

  return { duToken, directorToken, superAdminToken, hodToken, requirementId, quotationId, dept };
}

describe('GET /api/v1/requirements/:id/director-review', () => {
  it('returns the review package with comparison: null when no AI comparison has been generated (manual review workflow)', async () => {
    const admin = await createTestUser({ email: 'dr-nocomp-admin@vms.local', role: ROLES.SUPER_ADMIN });
    const dept = await createTestDepartment({ name: 'No Comparison Dept', code: 'DRNC', createdBy: admin.id });
    const du = await createTestUser({ email: 'dr-nocomp-du@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
    const director = await createTestUser({ email: 'dr-nocomp-director@vms.local', role: ROLES.DIRECTOR });
    const duToken = tokenFor(du);
    const directorToken = tokenFor(director);

    const created = await request(app)
      .post('/api/v1/requirements')
      .set('Authorization', `Bearer ${duToken}`)
      .send({ title: 'No Comparison Yet', budget: 100000, requiredDate: '2026-08-01', items: sampleItems });
    const requirementId = created.body.data._id as string;
    await request(app).patch(`/api/v1/requirements/${requirementId}/submit`).set('Authorization', `Bearer ${duToken}`).send();

    const quotationRes = await request(app)
      .post(`/api/v1/requirements/${requirementId}/quotations`)
      .set('Authorization', `Bearer ${duToken}`)
      .send({
        temporaryVendor: { name: 'Manual Vendor' },
        quotationDate: '2026-07-20',
        amount: 40000,
        gst: 18,
        currency: 'INR',
        paymentTerms: 'Net 30',
        deliveryTerms: 'Within 1 Week',
        priority: 'medium',
      });
    expect(quotationRes.status).toBe(201);

    // No AI comparison generated — the whole point of this test — yet Submit to Director
    // still only requires a quotation, unchanged (requirementService.submitToDirector).
    const submitted = await request(app).patch(`/api/v1/requirements/${requirementId}/submit-to-director`).set('Authorization', `Bearer ${duToken}`).send();
    expect(submitted.status).toBe(200);

    const res = await request(app)
      .get(`/api/v1/requirements/${requirementId}/director-review`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.data.requirement.status).toBe('director_review');
    expect(res.body.data.comparison).toBeNull();
    expect(res.body.data.quotations).toHaveLength(1);
    expect(res.body.data.quotations[0].amount).toBe(40000);

    // Approve must work with no comparison at all — the manual-review path end to end.
    const approved = await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send({
        decision: 'approved',
        remarks: 'Reviewed manually, terms are acceptable.',
        selectedQuotationId: quotationRes.body.data._id,
      });
    expect(approved.status).toBe(200);
    expect(approved.body.data.requirement.status).toBe('approved');
  });

  it('advances the requirement into Director Review and logs a viewed event when a Director opens it', async () => {
    const { directorToken, requirementId } = await setupRequirementWithComparison('DR1');

    const res = await request(app)
      .get(`/api/v1/requirements/${requirementId}/director-review`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.data.requirement.status).toBe('director_review');
    expect(res.body.data.comparison).toBeDefined();
    expect(Array.isArray(res.body.data.quotations)).toBe(true);
    expect(Array.isArray(res.body.data.activityLogs)).toBe(true);
    expect(res.body.data.review.history.length).toBeGreaterThan(0);

    const log = await waitFor(() => ActivityLog.findOne({ action: 'director_review_viewed', targetId: requirementId }));
    expect(log).not.toBeNull();

    const review = await DirectorReview.findOne({ requirement: requirementId });
    expect(review).not.toBeNull();
    expect(review!.history.some((h) => h.action === 'viewed')).toBe(true);
  });

  it('does not advance the status or log a viewed event when the Department User (read only) views it', async () => {
    const { duToken, requirementId } = await setupRequirementWithComparison('DR2');

    const res = await request(app)
      .get(`/api/v1/requirements/${requirementId}/director-review`)
      .set('Authorization', `Bearer ${duToken}`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.data.requirement.status).toBe('quotation_comparison');

    const log = await ActivityLog.findOne({ action: 'director_review_viewed', targetId: requirementId });
    expect(log).toBeNull();
  });

  it('returns 404 for a Department User who does not own the requirement', async () => {
    const { requirementId, dept } = await setupRequirementWithComparison('DR3');
    const otherDu = await createTestUser({ email: 'dr-other-du-DR3@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
    const otherToken = tokenFor(otherDu);

    const res = await request(app)
      .get(`/api/v1/requirements/${requirementId}/director-review`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send();

    expect(res.status).toBe(404);
  });
});

describe('POST /api/v1/requirements/:id/director-review/decision', () => {
  it('forbids a Department User from deciding (read only)', async () => {
    const { duToken, directorToken, requirementId } = await setupRequirementWithComparison('DR4');
    await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${directorToken}`).send();

    const res = await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${duToken}`)
      .send({ decision: 'approved' });

    expect(res.status).toBe(403);
  });

  it('forbids an HOD from deciding (read only)', async () => {
    const { directorToken, hodToken, requirementId } = await setupRequirementWithComparison('DR5');
    await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${directorToken}`).send();

    const res = await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${hodToken}`)
      .send({ decision: 'approved' });

    expect(res.status).toBe(403);
  });

  it('rejects a decide call before the requirement has entered Director Review', async () => {
    const { directorToken, requirementId, quotationId } = await setupRequirementWithComparison('DR6');
    // Deliberately skip the GET step that advances status — requirement is still quotation_comparison
    // (submitted to the Director, but not yet actually opened/viewed by one).

    const res = await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ decision: 'approved', selectedQuotationId: quotationId });

    expect(res.status).toBe(404);
  });

  it('rejects an approve decision with no selected quotation — a Director must explicitly pick one', async () => {
    const { directorToken, requirementId } = await setupRequirementWithComparison('DR6B');
    await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${directorToken}`).send();

    const res = await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ decision: 'approved' });

    expect(res.status).toBe(400);
  });

  it('approves and notifies the Department User, HOD, and Super Admins', async () => {
    const { directorToken, requirementId, quotationId } = await setupRequirementWithComparison('DR7');
    await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${directorToken}`).send();

    const res = await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ decision: 'approved', selectedQuotationId: quotationId });

    expect(res.status).toBe(200);
    expect(res.body.data.requirement.status).toBe('approved');
    expect(res.body.data.review.decision).toBe('approved');

    // notifyUsers() creates one row per receiver sequentially — wait for all three
    // (Department User, HOD, Super Admin) rather than just the first to avoid a false
    // negative from reading mid-way through that in-flight fire-and-forget loop.
    const notifications = await waitFor(async () => {
      const found = await Notification.find({ notificationType: 'director_review_approved', relatedRecord: requirementId });
      return found.length >= 3 ? found : null;
    });
    const roles = notifications.map((n) => n.receiverRole);
    expect(roles).toContain(ROLES.DEPARTMENT_USER);
    expect(roles).toContain(ROLES.HOD);
    expect(roles).toContain(ROLES.SUPER_ADMIN);

    const log = await ActivityLog.findOne({ action: 'director_review_approved', targetId: requirementId });
    expect(log).not.toBeNull();
  });

  it('rejects without remarks (validation) and requires them for a rejected decision', async () => {
    const { directorToken, requirementId } = await setupRequirementWithComparison('DR8');
    await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${directorToken}`).send();

    const missingRemarks = await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ decision: 'rejected' });
    expect(missingRemarks.status).toBe(400);

    const res = await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ decision: 'rejected', remarks: 'Budget exceeds what was approved.' });

    expect(res.status).toBe(200);
    expect(res.body.data.requirement.status).toBe('rejected');

    // Reject only notifies Department User + HOD — never Super Admin. Wait for both rows
    // (sequential fire-and-forget inserts) before asserting.
    const notifications = await waitFor(async () => {
      const found = await Notification.find({ notificationType: 'director_review_rejected', relatedRecord: requirementId });
      return found.length >= 2 ? found : null;
    });
    const roles = notifications.map((n) => n.receiverRole);
    expect(roles).toContain(ROLES.DEPARTMENT_USER);
    expect(roles).toContain(ROLES.HOD);
    expect(roles).not.toContain(ROLES.SUPER_ADMIN);
  });

  it('sends the requirement back to Quotation Collection and notifies only the Department User', async () => {
    const { directorToken, requirementId } = await setupRequirementWithComparison('DR9');
    await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${directorToken}`).send();

    const res = await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ decision: 'sent_back', remarks: 'Please renegotiate delivery timeline.' });

    expect(res.status).toBe(200);
    expect(res.body.data.requirement.status).toBe('quotation_collection');
    expect(res.body.data.review.decision).toBe('sent_back');

    const notifications = await waitFor(async () => {
      const found = await Notification.find({ notificationType: 'director_review_sent_back', relatedRecord: requirementId });
      return found.length > 0 ? found : null;
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.receiverRole).toBe(ROLES.DEPARTMENT_USER);
  });

  it('allows a Super Admin to decide (RBAC override)', async () => {
    const { directorToken, superAdminToken, requirementId, quotationId } = await setupRequirementWithComparison('DR10');
    await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${directorToken}`).send();

    const res = await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ decision: 'approved', selectedQuotationId: quotationId });

    expect(res.status).toBe(200);
    expect(res.body.data.requirement.status).toBe('approved');
  });

  it('rejects a second decision once the requirement has already left Director Review', async () => {
    const { directorToken, requirementId, quotationId } = await setupRequirementWithComparison('DR11');
    await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${directorToken}`).send();
    await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ decision: 'approved', selectedQuotationId: quotationId });

    const res = await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ decision: 'rejected', remarks: 'Too late' });

    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/v1/requirements/:id/director-review/remarks', () => {
  it('updates remarks without changing the decision, incrementing the version', async () => {
    const { directorToken, requirementId } = await setupRequirementWithComparison('DR12');
    await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${directorToken}`).send();

    const res = await request(app)
      .patch(`/api/v1/requirements/${requirementId}/director-review/remarks`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ remarks: 'Still verifying vendor references.' });

    expect(res.status).toBe(200);
    expect(res.body.data.remarks).toBe('Still verifying vendor references.');
    expect(res.body.data.decision).toBe('pending');
    expect(res.body.data.version).toBe(1);

    const log = await waitFor(() => ActivityLog.findOne({ action: 'director_review_remarks_updated', targetId: requirementId }));
    expect(log).not.toBeNull();
  });

  it('forbids a Department User from updating remarks', async () => {
    const { duToken, directorToken, requirementId } = await setupRequirementWithComparison('DR13');
    await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${directorToken}`).send();

    const res = await request(app)
      .patch(`/api/v1/requirements/${requirementId}/director-review/remarks`)
      .set('Authorization', `Bearer ${duToken}`)
      .send({ remarks: 'Trying to edit remarks' });

    expect(res.status).toBe(403);
  });
});

describe('Full workflow — Send Back then re-review to Approve', () => {
  it('accumulates history and version across a Send Back and a subsequent Approve', async () => {
    const { duToken, directorToken, requirementId } = await setupRequirementWithComparison('DR14');

    await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${directorToken}`).send();
    const sentBack = await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ decision: 'sent_back', remarks: 'Add a second quotation for comparison.' });
    expect(sentBack.status).toBe(200);
    expect(sentBack.body.data.requirement.status).toBe('quotation_collection');

    // Department User revises — requirement is editable again since it's back in
    // quotation_collection — then a fresh comparison is generated for the re-review.
    const secondQuotation = await request(app)
      .post(`/api/v1/requirements/${requirementId}/quotations`)
      .set('Authorization', `Bearer ${duToken}`)
      .send({
        temporaryVendor: { name: 'Vendor B' },
        quotationDate: '2026-07-20',
        amount: 280000,
        gst: 18,
        currency: 'INR',
        paymentTerms: 'Net 45',
        deliveryTerms: 'Within 3 Weeks',
        priority: 'medium',
      });
    expect(secondQuotation.status).toBe(201);
    await seedOcrResult(secondQuotation.body.data._id, 280000);
    await request(app).post(`/api/v1/requirements/${requirementId}/comparison`).set('Authorization', `Bearer ${duToken}`).send();

    // Unlimited Send Back cycles — submitting to the Director a second time must notify
    // Directors again (no dedupKey on this notification; see requirementController.submitToDirector).
    const resubmitted = await request(app).patch(`/api/v1/requirements/${requirementId}/submit-to-director`).set('Authorization', `Bearer ${duToken}`).send();
    expect(resubmitted.status).toBe(200);
    expect(resubmitted.body.data.status).toBe('quotation_comparison');

    const directorNotificationsAfterResubmit = await waitFor(async () => {
      const found = await Notification.find({ notificationType: 'requirement_ready_for_review', relatedRecord: requirementId, receiverRole: ROLES.DIRECTOR });
      return found.length >= 1 ? found : null;
    });
    expect(directorNotificationsAfterResubmit.length).toBeGreaterThanOrEqual(1);

    await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${directorToken}`).send();
    const approved = await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send({
        decision: 'approved',
        remarks: 'Vendor B confirmed better delivery terms.',
        selectedQuotationId: secondQuotation.body.data._id,
      });

    expect(approved.status).toBe(200);
    expect(approved.body.data.requirement.status).toBe('approved');

    const review = await DirectorReview.findOne({ requirement: requirementId });
    expect(review).not.toBeNull();
    expect(review!.version).toBe(2); // sent_back (1) + approved (2) — the two 'viewed' events don't bump version
    const actions = review!.history.map((h) => h.action);
    expect(actions).toEqual(['viewed', 'sent_back', 'viewed', 'approved']);
  });
});

describe('Workflow enhancement — Director submission control', () => {
  it('locks quotation upload once submitted to the Director, and unlocks it again after Send Back', async () => {
    const { duToken, directorToken, requirementId } = await setupRequirementWithComparison('DR15');

    const blockedUpload = await request(app)
      .post(`/api/v1/requirements/${requirementId}/quotations`)
      .set('Authorization', `Bearer ${duToken}`)
      .send({
        temporaryVendor: { name: 'Late Vendor' },
        quotationDate: '2026-07-21',
        amount: 250000,
        gst: 18,
        currency: 'INR',
        paymentTerms: 'Net 30',
        deliveryTerms: 'Within 2 Weeks',
        priority: 'medium',
      });
    expect(blockedUpload.status).toBe(404);

    await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${directorToken}`).send();
    await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ decision: 'sent_back', remarks: 'Need one more quote.' });

    const allowedUpload = await request(app)
      .post(`/api/v1/requirements/${requirementId}/quotations`)
      .set('Authorization', `Bearer ${duToken}`)
      .send({
        temporaryVendor: { name: 'Late Vendor' },
        quotationDate: '2026-07-21',
        amount: 250000,
        gst: 18,
        currency: 'INR',
        paymentTerms: 'Net 30',
        deliveryTerms: 'Within 2 Weeks',
        priority: 'medium',
      });
    expect(allowedUpload.status).toBe(201);
  });

  it('does not notify Directors when a quotation is uploaded — only when explicitly submitted', async () => {
    const admin = await createTestUser({ email: 'dr-notify-admin-DR16@vms.local', role: ROLES.SUPER_ADMIN });
    const director = await createTestUser({ email: 'dr-notify-director-DR16@vms.local', role: ROLES.DIRECTOR });
    const dept = await createTestDepartment({ name: 'Notify Timing Dept', code: 'DR16', createdBy: admin.id });
    const du = await createTestUser({ email: 'dr-notify-du-DR16@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });

    const duToken = tokenFor(du);
    const directorToken = tokenFor(director);

    const created = await request(app)
      .post('/api/v1/requirements')
      .set('Authorization', `Bearer ${duToken}`)
      .send({ title: 'Notify Timing Requirement', budget: 500000, requiredDate: '2026-08-01', items: sampleItems });
    const requirementId = created.body.data._id as string;

    await request(app).patch(`/api/v1/requirements/${requirementId}/submit`).set('Authorization', `Bearer ${duToken}`).send();

    const quotationRes = await request(app)
      .post(`/api/v1/requirements/${requirementId}/quotations`)
      .set('Authorization', `Bearer ${duToken}`)
      .send({
        temporaryVendor: { name: 'Vendor A' },
        quotationDate: '2026-07-18',
        amount: 300000,
        gst: 18,
        currency: 'INR',
        paymentTerms: 'Net 30',
        deliveryTerms: 'Within 2 Weeks',
        priority: 'medium',
      });
    expect(quotationRes.status).toBe(201);
    // First quotation still moves the requirement into quotation_collection (uploads stay
    // open) — it just must not notify the Director anymore.
    const afterUpload = await Requirement.findById(requirementId).select('status');
    expect(afterUpload!.status).toBe('quotation_collection');

    const beforeSubmit = await request(app).get('/api/v1/notifications').set('Authorization', `Bearer ${directorToken}`);
    expect(
      beforeSubmit.body.data.some((n: { notificationType: string }) => n.notificationType === 'requirement_ready_for_review'),
    ).toBe(false);

    await seedOcrResult(quotationRes.body.data._id, 300000);
    await request(app).post(`/api/v1/requirements/${requirementId}/comparison`).set('Authorization', `Bearer ${duToken}`).send();
    const submitted = await request(app).patch(`/api/v1/requirements/${requirementId}/submit-to-director`).set('Authorization', `Bearer ${duToken}`).send();
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.status).toBe('quotation_comparison');

    const afterSubmit = await waitFor(async () => {
      const found = await Notification.find({ notificationType: 'requirement_ready_for_review', relatedRecord: requirementId, receiverRole: ROLES.DIRECTOR });
      return found.length > 0 ? found : null;
    });
    expect(afterSubmit).toHaveLength(1);
  });

  it('rejects submit-to-director with no quotations, and rejects a non-owner', async () => {
    const admin = await createTestUser({ email: 'dr-nosub-admin@vms.local', role: ROLES.SUPER_ADMIN });
    const dept = await createTestDepartment({ name: 'No Submit Dept', code: 'DRNS', createdBy: admin.id });
    const du = await createTestUser({ email: 'dr-nosub-du@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
    const otherDu = await createTestUser({ email: 'dr-nosub-otherdu@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
    const duToken = tokenFor(du);
    const otherToken = tokenFor(otherDu);

    const created = await request(app)
      .post('/api/v1/requirements')
      .set('Authorization', `Bearer ${duToken}`)
      .send({ title: 'No Quotations Yet', budget: 100000, requiredDate: '2026-08-01', items: sampleItems });
    const requirementId = created.body.data._id as string;

    // Still 'submitted' (draft -> submitted), never entered quotation_collection — submit-to-director
    // is only reachable from quotation_collection.
    const tooEarly = await request(app).patch(`/api/v1/requirements/${requirementId}/submit-to-director`).set('Authorization', `Bearer ${duToken}`).send();
    expect(tooEarly.status).toBe(404);

    await request(app).patch(`/api/v1/requirements/${requirementId}/submit`).set('Authorization', `Bearer ${duToken}`).send();
    const noQuotations = await request(app).patch(`/api/v1/requirements/${requirementId}/submit-to-director`).set('Authorization', `Bearer ${otherToken}`).send();
    expect(noQuotations.status).toBe(404); // not the owner — 404, mirrors requirementService.submit()
  });

  it('makes AI Comparison read-only once the Director has approved', async () => {
    const { duToken, directorToken, requirementId, quotationId } = await setupRequirementWithComparison('DR17');
    // Not yet decided — comparison can still be regenerated at this point.
    const stillOpen = await request(app).post(`/api/v1/requirements/${requirementId}/comparison`).set('Authorization', `Bearer ${duToken}`).send();
    expect(stillOpen.status).toBe(201);

    await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${directorToken}`).send();
    const approved = await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ decision: 'approved', selectedQuotationId: quotationId });
    expect(approved.status).toBe(200);
    expect(approved.body.data.requirement.status).toBe('approved');

    const lockedRegenerate = await request(app).post(`/api/v1/requirements/${requirementId}/comparison`).set('Authorization', `Bearer ${duToken}`).send();
    expect(lockedRegenerate.status).toBe(400);

    const stillReadable = await request(app).get(`/api/v1/requirements/${requirementId}/comparison`).set('Authorization', `Bearer ${duToken}`).send();
    expect(stillReadable.status).toBe(200);
  });
});

describe('Workflow enhancement — Parallel dual Director approval', () => {
  interface TwoDirectorSetup {
    duToken: string;
    director1Token: string;
    director1Id: string;
    director2Token: string;
    director2Id: string;
    requirementId: string;
    quotationId: string;
  }

  /** Same shape as `setupRequirementWithComparison`, but with two active Directors instead
   *  of one — every requirement created this way needs both to approve before it resolves
   *  (see docs/WORKFLOW_DUAL_DIRECTOR_APPROVAL.md). Leaves the requirement freshly
   *  `quotation_comparison` (submitted, not yet opened by either Director). */
  async function setupRequirementWithTwoDirectors(deptCode: string): Promise<TwoDirectorSetup> {
    const admin = await createTestUser({ email: `dd-admin-${deptCode}@vms.local`, role: ROLES.SUPER_ADMIN });
    const dept = await createTestDepartment({ name: `Dual Director Dept ${deptCode}`, code: deptCode, createdBy: admin.id });
    const du = await createTestUser({ email: `dd-du-${deptCode}@vms.local`, role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
    const director1 = await createTestUser({ email: `dd-director1-${deptCode}@vms.local`, role: ROLES.DIRECTOR });
    const director2 = await createTestUser({ email: `dd-director2-${deptCode}@vms.local`, role: ROLES.DIRECTOR });

    const duToken = tokenFor(du);
    const director1Token = tokenFor(director1);
    const director2Token = tokenFor(director2);

    const created = await request(app)
      .post('/api/v1/requirements')
      .set('Authorization', `Bearer ${duToken}`)
      .send({ title: `Dual Director Requirement ${deptCode}`, budget: 500000, requiredDate: '2026-08-01', items: sampleItems });
    const requirementId = created.body.data._id as string;

    await request(app).patch(`/api/v1/requirements/${requirementId}/submit`).set('Authorization', `Bearer ${duToken}`).send();
    const quotationRes = await request(app)
      .post(`/api/v1/requirements/${requirementId}/quotations`)
      .set('Authorization', `Bearer ${duToken}`)
      .send({
        temporaryVendor: { name: 'Dual Approval Vendor' },
        quotationDate: '2026-07-19',
        amount: 200000,
        gst: 18,
        currency: 'INR',
        paymentTerms: 'Net 30',
        deliveryTerms: 'Within 2 Weeks',
        priority: 'medium',
      });

    const submitted = await request(app).patch(`/api/v1/requirements/${requirementId}/submit-to-director`).set('Authorization', `Bearer ${duToken}`).send();
    expect(submitted.status).toBe(200);

    return {
      duToken,
      director1Token,
      director1Id: String(director1._id),
      director2Token,
      director2Id: String(director2._id),
      requirementId,
      quotationId: quotationRes.body.data._id as string,
    };
  }

  it('notifies both active Directors after Submit to Director', async () => {
    const { requirementId } = await setupRequirementWithTwoDirectors('DDA1');

    const notifications = await waitFor(async () => {
      const found = await Notification.find({ notificationType: 'requirement_ready_for_review', relatedRecord: requirementId, receiverRole: ROLES.DIRECTOR });
      return found.length >= 2 ? found : null;
    });
    expect(notifications).toHaveLength(2);
  });

  it('shows both Directors as Pending on the roster before either decides', async () => {
    const { requirementId, director1Token } = await setupRequirementWithTwoDirectors('DDA2');

    const res = await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${director1Token}`).send();
    expect(res.status).toBe(200);
    expect(res.body.data.review.approvals).toHaveLength(2);
    expect(res.body.data.review.approvals.every((entry: { decision: string }) => entry.decision === 'pending')).toBe(true);
    expect(res.body.data.review.decision).toBe('pending');
  });

  it('either Director can review first — approving does not resolve the requirement while the other Director is still pending', async () => {
    const { requirementId, director1Id, director2Token, quotationId } = await setupRequirementWithTwoDirectors('DDA3');

    // Director 2 opens and decides first — order must not matter.
    await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${director2Token}`).send();
    const decision = await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${director2Token}`)
      .send({ decision: 'approved', selectedQuotationId: quotationId });

    expect(decision.status).toBe(200);
    expect(decision.body.data.requirement.status).toBe('director_review'); // still waiting on Director 1
    expect(decision.body.data.review.decision).toBe('pending'); // aggregate not yet resolved

    const approvals = decision.body.data.review.approvals as Array<{ director: string; decision: string }>;
    const director2Entry = approvals.find((entry) => entry.decision === 'approved');
    expect(director2Entry).toBeDefined();
    const director1Entry = approvals.find((entry) => entry.director === director1Id);
    expect(director1Entry?.decision).toBe('pending');

    const requirement = await Requirement.findById(requirementId);
    expect(requirement!.status).toBe('director_review');
  });

  it('resolves the requirement to Approved only once BOTH Directors have approved, and notifies the Department User only then', async () => {
    const { requirementId, director1Token, director2Token, quotationId } = await setupRequirementWithTwoDirectors('DDA4');

    await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${director1Token}`).send();
    const first = await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${director1Token}`)
      .send({ decision: 'approved', selectedQuotationId: quotationId });
    expect(first.body.data.requirement.status).toBe('director_review');

    // No "Requirement Approved" notification yet — only one of two Directors has approved.
    const tooEarly = await Notification.find({ notificationType: 'director_review_approved', relatedRecord: requirementId });
    expect(tooEarly).toHaveLength(0);

    await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${director2Token}`).send();
    const second = await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${director2Token}`)
      .send({ decision: 'approved', selectedQuotationId: quotationId });

    expect(second.status).toBe(200);
    expect(second.body.data.requirement.status).toBe('approved');
    expect(second.body.data.review.decision).toBe('approved');
    expect((second.body.data.review.approvals as Array<{ decision: string }>).every((entry) => entry.decision === 'approved')).toBe(true);

    const approvedNotifications = await waitFor(async () => {
      const found = await Notification.find({ notificationType: 'director_review_approved', relatedRecord: requirementId });
      return found.length > 0 ? found : null;
    });
    expect(approvedNotifications.length).toBeGreaterThan(0);
  });

  it('rejects a second decision from the same Director — each Director may decide only once per round', async () => {
    const { requirementId, director1Token, quotationId } = await setupRequirementWithTwoDirectors('DDA5');

    await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${director1Token}`).send();
    const first = await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${director1Token}`)
      .send({ decision: 'approved', selectedQuotationId: quotationId });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${director1Token}`)
      .send({ decision: 'approved', selectedQuotationId: quotationId });
    expect(second.status).toBe(400);
    expect(second.body.message).toMatch(/already submitted/i);
  });

  it('either Director Rejecting resolves the requirement immediately, without waiting for the other Director', async () => {
    const { requirementId, director1Token, duToken } = await setupRequirementWithTwoDirectors('DDA6');

    await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${director1Token}`).send();
    const rejected = await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${director1Token}`)
      .send({ decision: 'rejected', remarks: 'Budget far exceeds approved limit.' });

    expect(rejected.status).toBe(200);
    expect(rejected.body.data.requirement.status).toBe('rejected');

    const requirement = await Requirement.findById(requirementId);
    expect(requirement!.status).toBe('rejected');

    const notified = await waitFor(async () => {
      const found = await Notification.find({ notificationType: 'director_review_rejected', relatedRecord: requirementId });
      return found.length > 0 ? found : null;
    });
    expect(notified.length).toBeGreaterThan(0);

    // The Department User cannot resurrect it via submit-to-director — Rejected is terminal.
    const resubmitAttempt = await request(app).patch(`/api/v1/requirements/${requirementId}/submit-to-director`).set('Authorization', `Bearer ${duToken}`).send();
    expect(resubmitAttempt.status).toBe(404);
  });

  it('either Director sending back clears BOTH Directors\' approvals and returns to quotation_collection', async () => {
    const { requirementId, director1Token, director2Token, quotationId } = await setupRequirementWithTwoDirectors('DDA7');

    // Director 2 approves first.
    await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${director2Token}`).send();
    await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${director2Token}`)
      .send({ decision: 'approved', selectedQuotationId: quotationId });

    // Director 1 then sends it back instead of approving.
    await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${director1Token}`).send();
    const sentBack = await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${director1Token}`)
      .send({ decision: 'sent_back', remarks: 'Need a third quotation before deciding.' });

    expect(sentBack.status).toBe(200);
    expect(sentBack.body.data.requirement.status).toBe('quotation_collection');

    const review = await DirectorReview.findOne({ requirement: requirementId });
    expect(review!.approvals).toHaveLength(2);
    expect(review!.approvals.every((entry) => entry.decision === 'pending')).toBe(true);
    expect(review!.approvals.every((entry) => !entry.remarks)).toBe(true);
  });

  it("hides a Director's remarks from the other Director until they submit their own decision", async () => {
    const { requirementId, director1Token, director2Token, quotationId } = await setupRequirementWithTwoDirectors('DDA8');

    await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${director1Token}`).send();
    await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${director1Token}`)
      .send({ decision: 'approved', remarks: 'Confidential reasoning only Director 1 should see first.', selectedQuotationId: quotationId });

    // Director 2 hasn't decided yet — Director 1's remarks must be hidden from them.
    const beforeDeciding = await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${director2Token}`).send();
    const peerEntryBefore = (beforeDeciding.body.data.review.approvals as Array<{ decision: string; remarks?: string }>).find((entry) => entry.decision === 'approved');
    expect(peerEntryBefore?.remarks).toBeUndefined();

    // Once Director 2 submits their own decision, Director 1's remarks become visible.
    await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${director2Token}`)
      .send({ decision: 'approved', selectedQuotationId: quotationId });

    const afterDeciding = await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${director2Token}`).send();
    const peerEntryAfter = (afterDeciding.body.data.review.approvals as Array<{ decision: string; remarks?: string }>).find((entry) => entry.remarks);
    expect(peerEntryAfter?.remarks).toBe('Confidential reasoning only Director 1 should see first.');
  });

  it('allows a Super Admin decision to override and resolve the requirement immediately, regardless of individual Director entries', async () => {
    const { requirementId, quotationId } = await setupRequirementWithTwoDirectors('DDA9');
    const admin = await createTestUser({ email: 'dd-override-admin-DDA9@vms.local', role: ROLES.SUPER_ADMIN });
    const overrideToken = tokenFor(admin);

    await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${overrideToken}`).send();
    const approved = await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${overrideToken}`)
      .send({ decision: 'approved', selectedQuotationId: quotationId });

    expect(approved.status).toBe(200);
    expect(approved.body.data.requirement.status).toBe('approved');
  });
});

describe('POST decision — Director explicit quotation selection (selectedQuotationId)', () => {
  interface SelectionSetup {
    duToken: string;
    directorToken: string;
    requirementId: string;
    cheapQuotationId: string;
    premiumQuotationId: string;
  }

  /** Two quotations at different prices so the AI Comparison's "best value" recommendation
   *  (lowest complete price — see comparisonEngine.ts) deterministically differs from the
   *  Director's explicit override used in these tests. Leaves the requirement already viewed
   *  by the Director (director_review), ready for a decision. */
  async function setupWithTwoQuotations(deptCode: string): Promise<SelectionSetup> {
    const admin = await createTestUser({ email: `dr-sel-admin-${deptCode}@vms.local`, role: ROLES.SUPER_ADMIN });
    const dept = await createTestDepartment({ name: `Selection Dept ${deptCode}`, code: deptCode, createdBy: admin.id });
    const du = await createTestUser({ email: `dr-sel-du-${deptCode}@vms.local`, role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
    const director = await createTestUser({ email: `dr-sel-director-${deptCode}@vms.local`, role: ROLES.DIRECTOR });
    const duToken = tokenFor(du);
    const directorToken = tokenFor(director);

    const created = await request(app)
      .post('/api/v1/requirements')
      .set('Authorization', `Bearer ${duToken}`)
      .send({ title: `Selection Requirement ${deptCode}`, budget: 500000, requiredDate: '2026-08-01', items: sampleItems });
    const requirementId = created.body.data._id as string;
    await request(app).patch(`/api/v1/requirements/${requirementId}/submit`).set('Authorization', `Bearer ${duToken}`).send();

    const cheapRes = await request(app)
      .post(`/api/v1/requirements/${requirementId}/quotations`)
      .set('Authorization', `Bearer ${duToken}`)
      .send({ temporaryVendor: { name: 'Vendor Cheap' }, quotationDate: '2026-07-18', amount: 200000, gst: 18, currency: 'INR', paymentTerms: 'Net 30', deliveryTerms: 'Within 2 Weeks', priority: 'medium' });
    const cheapQuotationId = cheapRes.body.data._id as string;
    await seedOcrResult(cheapQuotationId, 200000);

    const premiumRes = await request(app)
      .post(`/api/v1/requirements/${requirementId}/quotations`)
      .set('Authorization', `Bearer ${duToken}`)
      .send({ temporaryVendor: { name: 'Vendor Premium' }, quotationDate: '2026-07-18', amount: 300000, gst: 18, currency: 'INR', paymentTerms: 'Net 30', deliveryTerms: 'Within 2 Weeks', priority: 'medium' });
    const premiumQuotationId = premiumRes.body.data._id as string;
    await seedOcrResult(premiumQuotationId, 300000);

    await request(app).post(`/api/v1/requirements/${requirementId}/comparison`).set('Authorization', `Bearer ${duToken}`).send();
    await request(app).patch(`/api/v1/requirements/${requirementId}/submit-to-director`).set('Authorization', `Bearer ${duToken}`).send();
    await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${directorToken}`).send();

    return { duToken, directorToken, requirementId, cheapQuotationId, premiumQuotationId };
  }

  it("stores the Director's explicit pick when approving, overriding what the AI would recommend", async () => {
    const { directorToken, requirementId, premiumQuotationId } = await setupWithTwoQuotations('DRSEL1');

    const res = await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ decision: 'approved', selectedQuotationId: premiumQuotationId });

    expect(res.status).toBe(200);
    const review = await DirectorReview.findOne({ requirement: requirementId });
    expect(String(review!.selectedQuotation)).toBe(premiumQuotationId);
  });

  it('rejects approving without an explicit pick — no AI/earliest-quotation default anymore', async () => {
    const { directorToken, requirementId } = await setupWithTwoQuotations('DRSEL2');

    const res = await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ decision: 'approved' });

    expect(res.status).toBe(400);
    const review = await DirectorReview.findOne({ requirement: requirementId });
    expect(review!.selectedQuotation).toBeUndefined();
  });

  it('rejects a selectedQuotationId that belongs to a different requirement', async () => {
    const first = await setupWithTwoQuotations('DRSEL3A');
    const second = await setupWithTwoQuotations('DRSEL3B');

    const res = await request(app)
      .post(`/api/v1/requirements/${first.requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${first.directorToken}`)
      .send({ decision: 'approved', selectedQuotationId: second.premiumQuotationId });

    expect(res.status).toBe(400);
    const review = await DirectorReview.findOne({ requirement: first.requirementId });
    expect(review!.selectedQuotation).toBeUndefined();
  });

  it('rejects a selectedQuotationId sent alongside a Reject or Send Back decision', async () => {
    const { directorToken, requirementId, premiumQuotationId } = await setupWithTwoQuotations('DRSEL4');

    const rejected = await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ decision: 'rejected', remarks: 'Not acceptable', selectedQuotationId: premiumQuotationId });
    expect(rejected.status).toBe(400);

    const sentBack = await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ decision: 'sent_back', remarks: 'Need more info', selectedQuotationId: premiumQuotationId });
    expect(sentBack.status).toBe(400);
  });
});
