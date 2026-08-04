import request from 'supertest';

import { createApp } from '@/app';
import { ROLES } from '@/constants/roles';
import { OCR_STATUS } from '@/constants/status';
import { ActivityLog } from '@/modules/activityLog/activityLog.model';
import { Department } from '@/modules/department/department.model';
import { Notification } from '@/modules/notification/notification.model';
import { Quotation } from '@/modules/quotation/quotation.model';
import { Vendor } from '@/modules/vendor/vendor.model';
import { User, type IUser } from '@/modules/user/user.model';
import { createTestDepartment, createTestUser } from '@/test/factories';
import { signAccessToken } from '@/utils/jwt';

const app = createApp();

// Same "sign the JWT directly, skip /auth/login" technique adopted in directorReview.test.ts —
// avoids tripping the 20-req/window authRateLimiter given how many users this suite creates.
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

async function seedOcrResult(quotationId: string, grandTotal: number, vendorName = 'Seeded Vendor') {
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
          vendorName,
          currency: 'INR',
          discount: 0,
          grandTotal,
          items: [{ description: 'Laptop', quantity: 5, unit: 'pcs', unitPrice: grandTotal / 5, amount: grandTotal }],
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

/** Drives a fresh requirement all the way through Submit → Quotation → OCR → AI Comparison →
 *  Director Review (viewed) → Approved, exactly the pipeline Phase 6 is only ever reachable
 *  from. Returns tokens for every role plus the requirement/quotation ids. */
async function setupApprovedRequirement(deptCode: string, amount = 300000): Promise<Setup> {
  const admin = await createTestUser({ email: `vr-admin-${deptCode}@vms.local`, role: ROLES.SUPER_ADMIN });
  const dept = await createTestDepartment({ name: `Vendor Reg Dept ${deptCode}`, code: deptCode, createdBy: admin.id });
  // The HOD's own `department` field (used by every module's `scopeToRequirement`) is a
  // separate link from Department.hod (used for notification fan-out) — both must be set.
  const hod = await createTestUser({ email: `vr-hod-${deptCode}@vms.local`, role: ROLES.HOD, department: dept._id.toString() });
  await Department.updateOne({ _id: dept._id }, { hod: hod._id });
  const du = await createTestUser({ email: `vr-du-${deptCode}@vms.local`, role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
  const director = await createTestUser({ email: `vr-director-${deptCode}@vms.local`, role: ROLES.DIRECTOR });

  const duToken = tokenFor(du);
  const directorToken = tokenFor(director);
  const superAdminToken = tokenFor(admin);
  const hodToken = tokenFor(hod);

  const created = await request(app)
    .post('/api/v1/requirements')
    .set('Authorization', `Bearer ${duToken}`)
    .send({ title: `Vendor Reg Requirement ${deptCode}`, budget: 500000, requiredDate: '2026-08-01', items: sampleItems });
  const requirementId = created.body.data._id as string;

  await request(app).patch(`/api/v1/requirements/${requirementId}/submit`).set('Authorization', `Bearer ${duToken}`).send();

  const quotationRes = await request(app)
    .post(`/api/v1/requirements/${requirementId}/quotations`)
    .set('Authorization', `Bearer ${duToken}`)
    .send({
      temporaryVendor: { name: 'Winning Vendor Co', contactPerson: 'Ramesh', phone: '9876543210', email: `winning-${deptCode}@vendor.local`, address: 'Industrial Estate' },
      quotationDate: '2026-07-18',
      amount,
      gst: 18,
      currency: 'INR',
      paymentTerms: 'Net 30',
      deliveryTerms: 'Within 2 Weeks',
      priority: 'medium',
    });
  const quotationId = quotationRes.body.data._id as string;
  await seedOcrResult(quotationId, amount, 'Winning Vendor Co');

  await request(app).post(`/api/v1/requirements/${requirementId}/comparison`).set('Authorization', `Bearer ${duToken}`).send();
  // Explicit hand-off — the only way a requirement reaches Director Review now (see
  // requirementService.submitToDirector / docs/WORKFLOW_ENHANCEMENT_DIRECTOR_SUBMISSION.md).
  await request(app).patch(`/api/v1/requirements/${requirementId}/submit-to-director`).set('Authorization', `Bearer ${duToken}`).send();
  await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${directorToken}`).send();
  const approved = await request(app)
    .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
    .set('Authorization', `Bearer ${directorToken}`)
    .send({ decision: 'approved', selectedQuotationId: quotationId });
  expect(approved.status).toBe(200);
  expect(approved.body.data.requirement.status).toBe('approved');

  return { duToken, directorToken, superAdminToken, hodToken, requirementId, quotationId, dept };
}

const PDF_BYTES = Buffer.from('%PDF-1.4 fake vendor document');

function vendorPayload(overrides: Record<string, string> = {}) {
  return {
    name: 'Winning Vendor Co',
    contactPerson: 'Ramesh Gupta',
    phone: '9876543210',
    email: 'accounts@winningvendor.example',
    gstNumber: '27ABCDE1234F1Z5',
    panNumber: 'ABCDE1234F',
    address: 'Industrial Estate, Plot 12',
    state: 'Maharashtra',
    district: 'Pune',
    city: 'Pune',
    pincode: '411001',
    bankName: 'HDFC Bank',
    accountHolderName: 'Winning Vendor Co',
    accountNumber: '123456789012',
    ifscCode: 'HDFC0001234',
    category: 'Raw Materials',
    ...overrides,
  };
}

function postRegistration(requirementId: string, token: string, payload: Record<string, string>, withDocs = true) {
  let req = request(app)
    .post(`/api/v1/requirements/${requirementId}/vendor-registration`)
    .set('Authorization', `Bearer ${token}`);
  for (const [key, value] of Object.entries(payload)) {
    req = req.field(key, value);
  }
  if (withDocs) {
    req = req
      .attach('gstCertificate', PDF_BYTES, { filename: 'gst.pdf', contentType: 'application/pdf' })
      .attach('panCard', PDF_BYTES, { filename: 'pan.pdf', contentType: 'application/pdf' })
      .attach('cancelledCheque', PDF_BYTES, { filename: 'cheque.pdf', contentType: 'application/pdf' });
  }
  return req;
}

describe('GET /api/v1/requirements/:id/vendor-registration', () => {
  it('returns 404 before any vendor has been registered', async () => {
    const { duToken, requirementId } = await setupApprovedRequirement('VR1');

    const res = await request(app)
      .get(`/api/v1/requirements/${requirementId}/vendor-registration`)
      .set('Authorization', `Bearer ${duToken}`)
      .send();

    expect(res.status).toBe(404);
  });

  it('returns the registered vendor to all four roles once one exists', async () => {
    const { duToken, hodToken, directorToken, superAdminToken, requirementId } = await setupApprovedRequirement('VR2');
    await postRegistration(requirementId, duToken, vendorPayload());

    for (const token of [duToken, hodToken, directorToken, superAdminToken]) {
      const res = await request(app)
        .get(`/api/v1/requirements/${requirementId}/vendor-registration`)
        .set('Authorization', `Bearer ${token}`)
        .send();
      expect(res.status).toBe(200);
      expect(res.body.data.code).toMatch(/VEN/);
    }
  });
});

describe('POST /api/v1/requirements/:id/vendor-registration', () => {
  it('rejects registration before the requirement is Director-approved', async () => {
    const admin = await createTestUser({ email: 'vr-notapproved-admin@vms.local', role: ROLES.SUPER_ADMIN });
    const dept = await createTestDepartment({ name: 'Not Approved Dept', code: 'VRNA', createdBy: admin.id });
    const du = await createTestUser({ email: 'vr-notapproved-du@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
    const duToken = tokenFor(du);

    const created = await request(app)
      .post('/api/v1/requirements')
      .set('Authorization', `Bearer ${duToken}`)
      .send({ title: 'Not Approved Yet', budget: 100000, requiredDate: '2026-08-01', items: sampleItems });
    const requirementId = created.body.data._id as string;

    const res = await postRegistration(requirementId, duToken, vendorPayload());
    expect(res.status).toBe(400);
  });

  it('forbids an HOD from registering (read only)', async () => {
    const { hodToken, requirementId } = await setupApprovedRequirement('VR3');
    const res = await postRegistration(requirementId, hodToken, vendorPayload());
    expect(res.status).toBe(403);
  });

  it('forbids a Director from registering (read only)', async () => {
    const { directorToken, requirementId } = await setupApprovedRequirement('VR4');
    const res = await postRegistration(requirementId, directorToken, vendorPayload());
    expect(res.status).toBe(403);
  });

  it('registers the vendor, links it to the requirement/quotation/director, and advances the requirement to vendor_finalized', async () => {
    const { duToken, directorToken, requirementId, quotationId } = await setupApprovedRequirement('VR5');

    const res = await postRegistration(requirementId, duToken, vendorPayload());

    expect(res.status).toBe(201);
    expect(res.body.data.vendor.name).toBe('Winning Vendor Co');
    expect(res.body.data.vendor.code).toMatch(/VEN/);
    expect(res.body.data.vendor.registrationStatus).toBe('registered');
    expect(res.body.data.vendor.createdFromRequirement).toBe(requirementId);
    expect(res.body.data.vendor.createdFromQuotation).toBe(quotationId);
    expect(res.body.data.requirement.status).toBe('vendor_finalized');

    const vendor = await Vendor.findOne({ createdFromRequirement: requirementId });
    expect(vendor).not.toBeNull();
    expect(vendor!.documents).toHaveLength(3);
    expect(String(vendor!.approvedByDirector)).not.toBe('');

    const log = await waitFor(() => ActivityLog.findOne({ action: 'vendor_registered', targetId: vendor!.id }));
    expect(log).not.toBeNull();

    const notifications = await waitFor(async () => {
      const found = await Notification.find({ notificationType: 'vendor_registered', relatedRecord: vendor!.id });
      return found.length >= 3 ? found : null; // HOD + Director + Super Admin
    });
    const roles = notifications.map((n) => n.receiverRole);
    expect(roles).toContain(ROLES.HOD);
    expect(roles).toContain(ROLES.DIRECTOR);
    expect(roles).toContain(ROLES.SUPER_ADMIN);
  });

  it('stays blocked after only one of two Directors approves, and unlocks once both have (dual Director approval)', async () => {
    const admin = await createTestUser({ email: 'vr-dual-admin@vms.local', role: ROLES.SUPER_ADMIN });
    const dept = await createTestDepartment({ name: 'Dual Director Vendor Dept', code: 'VRDD', createdBy: admin.id });
    const du = await createTestUser({ email: 'vr-dual-du@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
    const director1 = await createTestUser({ email: 'vr-dual-director1@vms.local', role: ROLES.DIRECTOR });
    const director2 = await createTestUser({ email: 'vr-dual-director2@vms.local', role: ROLES.DIRECTOR });
    const duToken = tokenFor(du);
    const director1Token = tokenFor(director1);
    const director2Token = tokenFor(director2);

    const created = await request(app)
      .post('/api/v1/requirements')
      .set('Authorization', `Bearer ${duToken}`)
      .send({ title: 'Dual Director Vendor Reg', budget: 400000, requiredDate: '2026-08-01', items: sampleItems });
    const requirementId = created.body.data._id as string;
    await request(app).patch(`/api/v1/requirements/${requirementId}/submit`).set('Authorization', `Bearer ${duToken}`).send();

    const quotationRes = await request(app)
      .post(`/api/v1/requirements/${requirementId}/quotations`)
      .set('Authorization', `Bearer ${duToken}`)
      .send({
        temporaryVendor: { name: 'Dual Director Winning Vendor', contactPerson: 'Kiran', phone: '9123456780', email: 'dual-winner@vendor.local', address: 'MIDC' },
        quotationDate: '2026-07-19',
        amount: 350000,
        gst: 18,
        currency: 'INR',
        paymentTerms: 'Net 30',
        deliveryTerms: 'Within 2 Weeks',
        priority: 'medium',
      });
    const quotationId = quotationRes.body.data._id as string;

    await request(app).patch(`/api/v1/requirements/${requirementId}/submit-to-director`).set('Authorization', `Bearer ${duToken}`).send();

    await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${director1Token}`).send();
    const firstApproval = await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${director1Token}`)
      .send({ decision: 'approved', selectedQuotationId: quotationId });
    expect(firstApproval.body.data.requirement.status).toBe('director_review');

    // Only one of two Directors has approved — Vendor Registration must stay blocked.
    const blocked = await postRegistration(requirementId, duToken, vendorPayload({ name: 'Dual Director Winning Vendor', email: 'dual-blocked@vendor.example' }));
    expect(blocked.status).toBe(400);

    await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${director2Token}`).send();
    const secondApproval = await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${director2Token}`)
      .send({ decision: 'approved', selectedQuotationId: quotationId });
    expect(secondApproval.body.data.requirement.status).toBe('approved');

    // Both Directors have now approved — Vendor Registration unlocks.
    const allowed = await postRegistration(requirementId, duToken, vendorPayload({ name: 'Dual Director Winning Vendor', email: 'dual-allowed@vendor.example' }));
    expect(allowed.status).toBe(201);
    expect(allowed.body.data.vendor.createdFromQuotation).toBe(quotationId);
  });

  it("registers the vendor from the Director's explicit pick when no AI comparison was ever generated (manual review workflow)", async () => {
    const admin = await createTestUser({ email: 'vr-nocomp-admin@vms.local', role: ROLES.SUPER_ADMIN });
    const dept = await createTestDepartment({ name: 'No Comparison Vendor Dept', code: 'VRNC', createdBy: admin.id });
    const du = await createTestUser({ email: 'vr-nocomp-du@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
    const director = await createTestUser({ email: 'vr-nocomp-director@vms.local', role: ROLES.DIRECTOR });
    const duToken = tokenFor(du);
    const directorToken = tokenFor(director);

    const created = await request(app)
      .post('/api/v1/requirements')
      .set('Authorization', `Bearer ${duToken}`)
      .send({ title: 'No Comparison Vendor Reg', budget: 100000, requiredDate: '2026-08-01', items: sampleItems });
    const requirementId = created.body.data._id as string;
    await request(app).patch(`/api/v1/requirements/${requirementId}/submit`).set('Authorization', `Bearer ${duToken}`).send();

    const quotationRes = await request(app)
      .post(`/api/v1/requirements/${requirementId}/quotations`)
      .set('Authorization', `Bearer ${duToken}`)
      .send({
        temporaryVendor: { name: 'Manual Review Vendor', contactPerson: 'Asha', phone: '9998887776', email: 'manual@vendor.local', address: 'MIDC' },
        quotationDate: '2026-07-19',
        amount: 45000,
        gst: 18,
        currency: 'INR',
        paymentTerms: 'Net 15',
        deliveryTerms: 'Within 1 Week',
        priority: 'medium',
      });
    const quotationId = quotationRes.body.data._id as string;

    // Never calls POST /comparison — this requirement goes straight from quotation to
    // Director Review, exactly the "no AI provider configured" path.
    await request(app).patch(`/api/v1/requirements/${requirementId}/submit-to-director`).set('Authorization', `Bearer ${duToken}`).send();
    const reviewRes = await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${directorToken}`).send();
    expect(reviewRes.body.data.comparison).toBeNull();

    const approved = await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ decision: 'approved', selectedQuotationId: quotationId });
    expect(approved.status).toBe(200);

    const res = await postRegistration(requirementId, duToken, vendorPayload({ name: 'Manual Review Vendor', email: 'manual-review@vendor.example' }));

    expect(res.status).toBe(201);
    expect(res.body.data.vendor.createdFromQuotation).toBe(quotationId);
    expect(res.body.data.requirement.status).toBe('vendor_finalized');
  });

  it('allows a Super Admin to register (full access override)', async () => {
    const { superAdminToken, requirementId } = await setupApprovedRequirement('VR6');
    const res = await postRegistration(requirementId, superAdminToken, vendorPayload());
    expect(res.status).toBe(201);
  });

  it('marks registrationStatus pending_documents when a core document (e.g. cancelled cheque) is missing', async () => {
    const { duToken, requirementId } = await setupApprovedRequirement('VR7');

    const res = await postRegistration(requirementId, duToken, vendorPayload(), false).attach('gstCertificate', PDF_BYTES, { filename: 'gst.pdf', contentType: 'application/pdf' })
      .attach('panCard', PDF_BYTES, { filename: 'pan.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(201);
    expect(res.body.data.vendor.registrationStatus).toBe('pending_documents');
  });

  it('rejects a second registration attempt for the same requirement', async () => {
    const { duToken, requirementId } = await setupApprovedRequirement('VR8');
    const first = await postRegistration(requirementId, duToken, vendorPayload());
    expect(first.status).toBe(201);

    const second = await postRegistration(requirementId, duToken, vendorPayload({ email: 'different@vendor.example' }));
    expect(second.status).toBe(409);
  });

  it('rejects a duplicate vendor by email even across different requirements', async () => {
    const first = await setupApprovedRequirement('VR9A');
    const firstRes = await postRegistration(first.requirementId, first.duToken, vendorPayload({ email: 'shared@vendor.example' }));
    expect(firstRes.status).toBe(201);

    // Dual-director approval (see docs/WORKFLOW_DUAL_DIRECTOR_APPROVAL.md) requires every
    // currently-active Director to approve — deactivate VR9A's Director so the second
    // setup's own review isn't left waiting on an unrelated Director from this test's first
    // call (there's no afterEach between these two calls within the same `it`).
    await User.updateOne({ email: 'vr-director-VR9A@vms.local' }, { isActive: false });

    const second = await setupApprovedRequirement('VR9B');
    const res = await postRegistration(second.requirementId, second.duToken, vendorPayload({ email: 'shared@vendor.example', gstNumber: '', panNumber: '' }));
    expect(res.status).toBe(409);
  });

  it('rejects a duplicate vendor by GST number across different requirements', async () => {
    const first = await setupApprovedRequirement('VR10A');
    const firstRes = await postRegistration(first.requirementId, first.duToken, vendorPayload({ gstNumber: '29PQRST1234F1Z5' }));
    expect(firstRes.status).toBe(201);

    // Same reasoning as the email-duplicate test above.
    await User.updateOne({ email: 'vr-director-VR10A@vms.local' }, { isActive: false });

    const second = await setupApprovedRequirement('VR10B');
    const res = await postRegistration(second.requirementId, second.duToken, vendorPayload({ gstNumber: '29PQRST1234F1Z5', email: 'unique2@vendor.example', panNumber: '' }));
    expect(res.status).toBe(409);
  });

  it('validates the request body (e.g. an invalid IFSC code) with a 400', async () => {
    const { duToken, requirementId } = await setupApprovedRequirement('VR11');
    const res = await postRegistration(requirementId, duToken, vendorPayload({ ifscCode: 'NOTVALID' }));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/v1/requirements/:id/vendor-registration — Director explicit quotation selection', () => {
  interface TwoQuotationSetup {
    duToken: string;
    directorToken: string;
    requirementId: string;
    cheapQuotationId: string;
    premiumQuotationId: string;
  }

  /** Two quotations at different prices so the AI Comparison's "best value" recommendation
   *  (lowest complete price) deterministically differs from the premium one a Director might
   *  explicitly pick — leaves the requirement in Director Review, not yet decided. */
  async function setupWithTwoQuotations(deptCode: string): Promise<TwoQuotationSetup> {
    const admin = await createTestUser({ email: `vr-sel-admin-${deptCode}@vms.local`, role: ROLES.SUPER_ADMIN });
    const dept = await createTestDepartment({ name: `Selection Vendor Dept ${deptCode}`, code: deptCode, createdBy: admin.id });
    const du = await createTestUser({ email: `vr-sel-du-${deptCode}@vms.local`, role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
    const director = await createTestUser({ email: `vr-sel-director-${deptCode}@vms.local`, role: ROLES.DIRECTOR });
    const duToken = tokenFor(du);
    const directorToken = tokenFor(director);

    const created = await request(app)
      .post('/api/v1/requirements')
      .set('Authorization', `Bearer ${duToken}`)
      .send({ title: `Selection Vendor Reg ${deptCode}`, budget: 500000, requiredDate: '2026-08-01', items: sampleItems });
    const requirementId = created.body.data._id as string;
    await request(app).patch(`/api/v1/requirements/${requirementId}/submit`).set('Authorization', `Bearer ${duToken}`).send();

    const cheapRes = await request(app)
      .post(`/api/v1/requirements/${requirementId}/quotations`)
      .set('Authorization', `Bearer ${duToken}`)
      .send({
        temporaryVendor: { name: 'Cheap Vendor', contactPerson: 'Anita', phone: '9111111111', email: `cheap-${deptCode}@vendor.local`, address: 'MIDC' },
        quotationDate: '2026-07-18',
        amount: 200000,
        gst: 18,
        currency: 'INR',
        paymentTerms: 'Net 30',
        deliveryTerms: 'Within 2 Weeks',
        priority: 'medium',
      });
    const cheapQuotationId = cheapRes.body.data._id as string;
    await seedOcrResult(cheapQuotationId, 200000, 'Cheap Vendor');

    const premiumRes = await request(app)
      .post(`/api/v1/requirements/${requirementId}/quotations`)
      .set('Authorization', `Bearer ${duToken}`)
      .send({
        temporaryVendor: { name: 'Premium Vendor', contactPerson: 'Bhavesh', phone: '9222222222', email: `premium-${deptCode}@vendor.local`, address: 'Industrial Estate' },
        quotationDate: '2026-07-18',
        amount: 300000,
        gst: 18,
        currency: 'INR',
        paymentTerms: 'Net 30',
        deliveryTerms: 'Within 2 Weeks',
        priority: 'medium',
      });
    const premiumQuotationId = premiumRes.body.data._id as string;
    await seedOcrResult(premiumQuotationId, 300000, 'Premium Vendor');

    await request(app).post(`/api/v1/requirements/${requirementId}/comparison`).set('Authorization', `Bearer ${duToken}`).send();
    await request(app).patch(`/api/v1/requirements/${requirementId}/submit-to-director`).set('Authorization', `Bearer ${duToken}`).send();
    await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${directorToken}`).send();

    return { duToken, directorToken, requirementId, cheapQuotationId, premiumQuotationId };
  }

  it("uses the Director's explicit selection over the AI recommendation when both exist", async () => {
    const { duToken, directorToken, requirementId, premiumQuotationId } = await setupWithTwoQuotations('VRSEL1');

    const approved = await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ decision: 'approved', selectedQuotationId: premiumQuotationId });
    expect(approved.status).toBe(200);

    const res = await postRegistration(requirementId, duToken, vendorPayload({ name: 'Premium Vendor', email: 'premium-registered@vendor.example' }));

    expect(res.status).toBe(201);
    expect(res.body.data.vendor.createdFromQuotation).toBe(premiumQuotationId);
  });

  it('rejects approving without an explicit selection — there is no AI-recommendation fallback anymore', async () => {
    const { directorToken, requirementId } = await setupWithTwoQuotations('VRSEL2');

    const approved = await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ decision: 'approved' });
    expect(approved.status).toBe(400);
  });
});
