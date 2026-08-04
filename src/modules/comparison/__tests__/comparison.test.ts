import request from 'supertest';

import { createApp } from '@/app';
import { ROLES } from '@/constants/roles';
import { OCR_STATUS } from '@/constants/status';
import { ActivityLog } from '@/modules/activityLog/activityLog.model';
import { Comparison } from '@/modules/comparison/comparison.model';
import { Notification } from '@/modules/notification/notification.model';
import { Quotation } from '@/modules/quotation/quotation.model';
import { createTestDepartment, createTestUser } from '@/test/factories';

const app = createApp();

async function loginAs(email: string, password = 'Password123!') {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  return res.body.data.accessToken as string;
}

const sampleItems = [
  { itemName: 'Laptop', quantity: 5, unit: 'pcs', estimatedRate: 60000 },
  { itemName: 'Mouse', quantity: 5, unit: 'pcs', estimatedRate: 500 },
];

async function waitFor<T>(check: () => Promise<T | null | undefined>, maxAttempts = 20, intervalMs = 100): Promise<T> {
  for (let i = 0; i < maxAttempts; i++) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Condition was not met within the polling window');
}

/** Sets OCR structured data directly on a quotation, bypassing the real OCR pipeline —
 *  Phase 4 only ever reads `Quotation.ocr` (see comparisonEngine.ts), never writes to it, so
 *  this is a legitimate deterministic test fixture rather than a shortcut around production
 *  logic (the actual pipeline is already covered by requirementOcr.test.ts). */
async function seedOcrResult(quotationId: string, grandTotal: number, confidence = 90) {
  await Quotation.updateOne(
    { _id: quotationId },
    {
      ocr: {
        status: OCR_STATUS.COMPLETED,
        attachmentVersion: 1,
        provider: 'test-fixture',
        startedAt: new Date(),
        completedAt: new Date(),
        confidence,
        extractedText: 'seeded for test',
        structuredData: {
          vendorName: 'Seeded Vendor',
          currency: 'INR',
          discount: 0,
          grandTotal,
          items: [
            { description: 'Laptop', quantity: 5, unit: 'pcs', unitPrice: 60000, amount: 300000 },
            { description: 'Mouse', quantity: 5, unit: 'pcs', unitPrice: 500, amount: 2500 },
          ],
        },
      },
    },
  );
}

async function setupRequirementWithQuotations(deptCode: string) {
  const admin = await createTestUser({ email: `cmp-admin-${deptCode}@vms.local`, role: ROLES.SUPER_ADMIN });
  const hod = await createTestUser({ email: `cmp-hod-${deptCode}@vms.local`, role: ROLES.HOD });
  const dept = await createTestDepartment({ name: `Compare Dept ${deptCode}`, code: deptCode, createdBy: admin.id, hod: hod.id });
  await createTestUser({ email: `cmp-du-${deptCode}@vms.local`, role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
  await createTestUser({ email: `cmp-director-${deptCode}@vms.local`, role: ROLES.DIRECTOR });

  const token = await loginAs(`cmp-du-${deptCode}@vms.local`);

  const created = await request(app)
    .post('/api/v1/requirements')
    .set('Authorization', `Bearer ${token}`)
    .send({ title: 'Comparison Test Requirement', budget: 500000, requiredDate: '2026-08-01', items: sampleItems });
  const requirementId = created.body.data._id as string;

  await request(app).patch(`/api/v1/requirements/${requirementId}/submit`).set('Authorization', `Bearer ${token}`).send();

  return { token, requirementId, dept };
}

async function addQuotation(token: string, requirementId: string, amount: number, vendorName: string) {
  const res = await request(app)
    .post(`/api/v1/requirements/${requirementId}/quotations`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      temporaryVendor: { name: vendorName },
      quotationDate: '2026-07-18',
      amount,
      gst: 18,
      currency: 'INR',
      paymentTerms: 'Net 30',
      deliveryTerms: 'Within 2 Weeks',
      priority: 'medium',
    });
  return res.body.data._id as string;
}

describe('POST /api/v1/requirements/:id/comparison', () => {
  it('generates a comparison across every quotation and persists it', async () => {
    const { token, requirementId } = await setupRequirementWithQuotations('CMP1');
    const q1 = await addQuotation(token, requirementId, 300000, 'Vendor A');
    const q2 = await addQuotation(token, requirementId, 400000, 'Vendor B');
    await seedOcrResult(q1, 300000, 95);
    await seedOcrResult(q2, 400000, 92);

    const res = await request(app)
      .post(`/api/v1/requirements/${requirementId}/comparison`)
      .set('Authorization', `Bearer ${token}`)
      .send();

    expect(res.status).toBe(201);
    expect(res.body.data.statistics.totalQuotations).toBe(2);
    expect(res.body.data.statistics.lowestPrice).toBe(300000);
    expect(res.body.data.statistics.highestPrice).toBe(400000);
    expect(res.body.data.recommendation.isAdvisoryOnly).toBe(true);
    expect(Array.isArray(res.body.data.observations)).toBe(true);

    // Database persistence — a real row exists, not just an HTTP response.
    const stored = await Comparison.findOne({ requirement: requirementId });
    expect(stored).not.toBeNull();
    expect(stored!.quotations).toHaveLength(2);
  });

  it('creates an activity log entry when a comparison is generated', async () => {
    const { token, requirementId } = await setupRequirementWithQuotations('CMP2');
    const q1 = await addQuotation(token, requirementId, 300000, 'Vendor A');
    await seedOcrResult(q1, 300000);

    const res = await request(app)
      .post(`/api/v1/requirements/${requirementId}/comparison`)
      .set('Authorization', `Bearer ${token}`)
      .send();
    expect(res.status).toBe(201);

    const log = await waitFor(() => ActivityLog.findOne({ action: 'comparison_generated', targetId: res.body.data._id }));
    expect(log).not.toBeNull();
  });

  it('notifies the department HOD and active Directors that a comparison is ready', async () => {
    const { token, requirementId } = await setupRequirementWithQuotations('CMP3');
    const q1 = await addQuotation(token, requirementId, 300000, 'Vendor A');
    await seedOcrResult(q1, 300000);

    const res = await request(app)
      .post(`/api/v1/requirements/${requirementId}/comparison`)
      .set('Authorization', `Bearer ${token}`)
      .send();
    expect(res.status).toBe(201);

    const notifications = await waitFor(async () => {
      const found = await Notification.find({ notificationType: 'comparison_generated', relatedRecord: requirementId });
      return found.length > 0 ? found : null;
    });
    const receiverRoles = notifications.map((n) => n.receiverRole);
    expect(receiverRoles).toContain(ROLES.HOD);
    expect(receiverRoles).toContain(ROLES.DIRECTOR);
  });

  it('generates a comparison even when OCR has not completed for every quotation, flagging it instead of blocking', async () => {
    const { token, requirementId } = await setupRequirementWithQuotations('CMP4');
    // Deliberately left with ocr.status still 'not_started' (no seedOcrResult call) —
    // Phase 4 must degrade gracefully rather than requiring OCR to be complete everywhere.
    await addQuotation(token, requirementId, 300000, 'Vendor A');

    const res = await request(app)
      .post(`/api/v1/requirements/${requirementId}/comparison`)
      .set('Authorization', `Bearer ${token}`)
      .send();

    expect(res.status).toBe(201);
    expect(res.body.data.observations.some((o: { type: string }) => o.type === 'ocr_confidence_warning')).toBe(false);
    // Falls back to the manually entered amount + GST when OCR structured data is absent.
    expect(res.body.data.quotations[0].grandTotalSource).toBe('quotation');
  });

  it('rejects generation when the requirement has no quotations yet', async () => {
    const { token, requirementId } = await setupRequirementWithQuotations('CMP5');

    const res = await request(app)
      .post(`/api/v1/requirements/${requirementId}/comparison`)
      .set('Authorization', `Bearer ${token}`)
      .send();

    expect(res.status).toBe(400);
  });

  it('returns 404 for a requirement id that does not exist', async () => {
    const { token } = await setupRequirementWithQuotations('CMP6');
    const fakeId = '507f1f77bcf86cd799439011';

    const res = await request(app)
      .post(`/api/v1/requirements/${fakeId}/comparison`)
      .set('Authorization', `Bearer ${token}`)
      .send();

    expect(res.status).toBe(404);
  });

  it('rejects an unauthenticated request', async () => {
    const { requirementId } = await setupRequirementWithQuotations('CMP7');

    const res = await request(app).post(`/api/v1/requirements/${requirementId}/comparison`).send();

    expect(res.status).toBe(401);
  });

  it('forbids a Director from generating a comparison (view-only per Phase 4 role permissions)', async () => {
    const { requirementId } = await setupRequirementWithQuotations('CMP8');
    const directorToken = await loginAs('cmp-director-CMP8@vms.local');

    const res = await request(app)
      .post(`/api/v1/requirements/${requirementId}/comparison`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send();

    expect(res.status).toBe(403);
  });
});

describe('GET /api/v1/requirements/:id/comparison', () => {
  it('returns the latest comparison to a Director (view-only access)', async () => {
    const { token, requirementId } = await setupRequirementWithQuotations('CMP9');
    const q1 = await addQuotation(token, requirementId, 300000, 'Vendor A');
    await seedOcrResult(q1, 300000);
    await request(app).post(`/api/v1/requirements/${requirementId}/comparison`).set('Authorization', `Bearer ${token}`).send();

    const directorToken = await loginAs('cmp-director-CMP9@vms.local');
    const res = await request(app)
      .get(`/api/v1/requirements/${requirementId}/comparison`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.data.statistics.totalQuotations).toBe(1);
  });

  it('returns 404 when no comparison has been generated yet', async () => {
    const { token, requirementId } = await setupRequirementWithQuotations('CMP10');

    const res = await request(app)
      .get(`/api/v1/requirements/${requirementId}/comparison`)
      .set('Authorization', `Bearer ${token}`)
      .send();

    expect(res.status).toBe(404);
  });
});
