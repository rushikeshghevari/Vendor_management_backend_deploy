import request from 'supertest';

import { createApp } from '@/app';
import { ROLES } from '@/constants/roles';
import { OCR_STATUS } from '@/constants/status';
import { ActivityLog } from '@/modules/activityLog/activityLog.model';
import { PurchaseOrder } from '@/modules/purchaseOrder/purchaseOrder.model';
import { Quotation } from '@/modules/quotation/quotation.model';
import type { IUser } from '@/modules/user/user.model';
import { createTestDepartment, createTestUser } from '@/test/factories';
import { signAccessToken } from '@/utils/jwt';

const app = createApp();

// Same "sign the JWT directly, skip /auth/login" technique used throughout this test suite
// (see directorReview.test.ts / vendorRegistration.test.ts) — avoids tripping the
// 20-req/window authRateLimiter given how many users a full end-to-end fixture creates.
function tokenFor(user: IUser): string {
  return signAccessToken({ sub: String(user._id), role: user.role, department: user.department?.toString() });
}

async function waitFor<T>(check: () => Promise<T | null | undefined>, maxAttempts = 20, intervalMs = 100): Promise<T> {
  for (let i = 0; i < maxAttempts; i++) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Condition was not met within the polling window');
}

const sampleItems = [{ itemName: 'Laptop', quantity: 5, unit: 'pcs', estimatedRate: 60000 }];

function poItemsPayload() {
  return [
    { itemName: 'Laptop', quantity: 5, unitPrice: 60000, gstRate: 18, gstAmount: 54000, taxAmount: 0, discount: 0, total: 354000 },
  ];
}

function vendorPayload(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Legacy Vendor Co',
    contactPerson: 'Suresh Rao',
    phone: '9876500000',
    email: 'legacy-vendor@example.com',
    address: 'Industrial Area',
    state: 'Maharashtra',
    district: 'Pune',
    city: 'Pune',
    pincode: '411001',
    bankDetails: { bankName: 'HDFC Bank', accountHolderName: 'Legacy Vendor Co', accountNumber: '111122223333', ifscCode: 'HDFC0001234' },
    category: 'Raw Materials',
    ...overrides,
  };
}

// ─── Legacy quotation-based fixture (regression) ──────────────────────────────────────────

interface LegacyFixture {
  duToken: string;
  hodToken: string;
  directorToken: string;
  ceoToken: string;
  superAdminToken: string;
  quotationId: string;
  vendorName: string;
}

/** Full legacy pipeline: standalone Vendor -> standalone Quotation -> Submit -> CEO approves
 *  (amount kept at/under the ₹50,000 default CEO Approval Limit so a single CEO decision is
 *  enough — no Director roster needed). This is the pre-Phase-7 flow purchaseOrder.service.ts
 *  has always supported; these tests exist purely as a regression safety net since the module
 *  had zero test coverage before this phase. */
async function setupApprovedLegacyQuotation(deptCode: string, amount = 40000): Promise<LegacyFixture> {
  const admin = await createTestUser({ email: `po-admin-${deptCode}@vms.local`, role: ROLES.SUPER_ADMIN });
  const hod = await createTestUser({ email: `po-hod-${deptCode}@vms.local`, role: ROLES.HOD });
  const dept = await createTestDepartment({ name: `PO Legacy Dept ${deptCode}`, code: deptCode, createdBy: admin.id, hod: hod.id });
  const du = await createTestUser({ email: `po-du-${deptCode}@vms.local`, role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
  const director = await createTestUser({ email: `po-director-${deptCode}@vms.local`, role: ROLES.DIRECTOR });
  const ceo = await createTestUser({ email: `po-ceo-${deptCode}@vms.local`, role: ROLES.CEO });

  const duToken = tokenFor(du);
  const hodToken = tokenFor(hod);
  const directorToken = tokenFor(director);
  const ceoToken = tokenFor(ceo);
  const superAdminToken = tokenFor(admin);

  const vendorName = `Legacy Vendor ${deptCode}`;
  const vendorRes = await request(app)
    .post('/api/v1/vendors')
    .set('Authorization', `Bearer ${duToken}`)
    .send(vendorPayload({ name: vendorName, email: `legacy-vendor-${deptCode}@example.com` }));
  expect(vendorRes.status).toBe(201);
  const vendorId = vendorRes.body.data._id as string;

  const quotationRes = await request(app)
    .post('/api/v1/quotations')
    .set('Authorization', `Bearer ${duToken}`)
    .send({
      vendor: vendorId,
      quotationDate: '2026-07-01',
      requiredDate: '2026-08-01',
      amount,
      gst: 18,
      currency: 'INR',
      paymentTerms: 'Net 30',
      deliveryTerms: 'Within 2 Weeks',
      priority: 'medium',
    });
  expect(quotationRes.status).toBe(201);
  const quotationId = quotationRes.body.data._id as string;

  const submitRes = await request(app).patch(`/api/v1/quotations/${quotationId}/submit`).set('Authorization', `Bearer ${duToken}`).send();
  expect(submitRes.status).toBe(200);

  const decideRes = await request(app)
    .patch(`/api/v1/quotations/${quotationId}/decision`)
    .set('Authorization', `Bearer ${ceoToken}`)
    .send({ decision: 'approved' });
  expect(decideRes.status).toBe(200);
  expect(decideRes.body.data.status).toBe('approved');

  return { duToken, hodToken, directorToken, ceoToken, superAdminToken, quotationId, vendorName };
}

// ─── Requirement-based fixture (Phase 7) ──────────────────────────────────────────────────

interface RequirementFixture {
  duToken: string;
  hodToken: string;
  directorToken: string;
  superAdminToken: string;
  requirementId: string;
  registeredVendorName: string;
}

async function seedOcrResult(quotationId: string, grandTotal: number, vendorName: string) {
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

const PDF_BYTES = Buffer.from('%PDF-1.4 fake vendor document');

function registerVendor(requirementId: string, token: string, vendorName: string) {
  return request(app)
    .post(`/api/v1/requirements/${requirementId}/vendor-registration`)
    .set('Authorization', `Bearer ${token}`)
    .field('name', vendorName)
    .field('contactPerson', 'Ramesh Gupta')
    .field('phone', '9876543210')
    .field('email', `${vendorName.toLowerCase().replace(/\s+/g, '-')}@vendor.example`)
    .field('address', 'Industrial Estate, Plot 12')
    .field('state', 'Maharashtra')
    .field('district', 'Pune')
    .field('city', 'Pune')
    .field('pincode', '411001')
    .field('bankName', 'HDFC Bank')
    .field('accountHolderName', vendorName)
    .field('accountNumber', '123456789012')
    .field('ifscCode', 'HDFC0001234')
    .field('category', 'Raw Materials')
    .attach('gstCertificate', PDF_BYTES, { filename: 'gst.pdf', contentType: 'application/pdf' })
    .attach('panCard', PDF_BYTES, { filename: 'pan.pdf', contentType: 'application/pdf' })
    .attach('cancelledCheque', PDF_BYTES, { filename: 'cheque.pdf', contentType: 'application/pdf' });
}

/** Drives a fresh requirement through the full Phase 1-6 pipeline (Submit -> Quotation -> OCR
 *  -> AI Comparison -> Director Review (approved) -> Vendor Registration) so it ends up
 *  vendor_finalized — the only state Phase 7's requirement-based PO path accepts. */
async function setupVendorFinalizedRequirement(deptCode: string, amount = 300000): Promise<RequirementFixture> {
  const admin = await createTestUser({ email: `po-req-admin-${deptCode}@vms.local`, role: ROLES.SUPER_ADMIN });
  const dept = await createTestDepartment({ name: `PO Requirement Dept ${deptCode}`, code: deptCode, createdBy: admin.id });
  const hod = await createTestUser({ email: `po-req-hod-${deptCode}@vms.local`, role: ROLES.HOD, department: dept._id.toString() });
  const du = await createTestUser({ email: `po-req-du-${deptCode}@vms.local`, role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
  const director = await createTestUser({ email: `po-req-director-${deptCode}@vms.local`, role: ROLES.DIRECTOR });

  const duToken = tokenFor(du);
  const hodToken = tokenFor(hod);
  const directorToken = tokenFor(director);
  const superAdminToken = tokenFor(admin);

  const created = await request(app)
    .post('/api/v1/requirements')
    .set('Authorization', `Bearer ${duToken}`)
    .send({ title: `PO Requirement ${deptCode}`, budget: 500000, requiredDate: '2026-08-01', items: sampleItems });
  const requirementId = created.body.data._id as string;

  await request(app).patch(`/api/v1/requirements/${requirementId}/submit`).set('Authorization', `Bearer ${duToken}`).send();

  const registeredVendorName = `Winning Vendor ${deptCode}`;
  const quotationRes = await request(app)
    .post(`/api/v1/requirements/${requirementId}/quotations`)
    .set('Authorization', `Bearer ${duToken}`)
    .send({
      temporaryVendor: { name: registeredVendorName, contactPerson: 'Ramesh', phone: '9876543210' },
      quotationDate: '2026-07-18',
      amount,
      gst: 18,
      currency: 'INR',
      paymentTerms: 'Net 30',
      deliveryTerms: 'Within 2 Weeks',
      priority: 'medium',
    });
  const quotationId = quotationRes.body.data._id as string;
  await seedOcrResult(quotationId, amount, registeredVendorName);

  await request(app).post(`/api/v1/requirements/${requirementId}/comparison`).set('Authorization', `Bearer ${duToken}`).send();
  // Explicit hand-off — the only way a requirement reaches Director Review now (see
  // requirementService.submitToDirector / docs/WORKFLOW_ENHANCEMENT_DIRECTOR_SUBMISSION.md).
  await request(app).patch(`/api/v1/requirements/${requirementId}/submit-to-director`).set('Authorization', `Bearer ${duToken}`).send();
  await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${directorToken}`).send();
  const approved = await request(app)
    .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
    .set('Authorization', `Bearer ${directorToken}`)
    .send({ decision: 'approved', selectedQuotationId: quotationId });
  expect(approved.body.data.requirement.status).toBe('approved');

  const registerRes = await registerVendor(requirementId, duToken, registeredVendorName);
  expect(registerRes.status).toBe(201);
  expect(registerRes.body.data.requirement.status).toBe('vendor_finalized');

  return { duToken, hodToken, directorToken, superAdminToken, requirementId, registeredVendorName };
}

describe('POST /api/v1/purchase-orders — legacy quotation-based path (regression)', () => {
  it('generates a Purchase Order from an Approved Quotation', async () => {
    const { duToken, quotationId, vendorName } = await setupApprovedLegacyQuotation('POL1');

    const res = await request(app)
      .post('/api/v1/purchase-orders')
      .set('Authorization', `Bearer ${duToken}`)
      .send({ quotationId, items: poItemsPayload(), terms: 'Net 30', notes: 'Handle with care' });

    expect(res.status).toBe(201);
    expect(res.body.data.quotation).toBe(quotationId);
    expect(res.body.data.vendorName).toBe(vendorName);
    expect(res.body.data.requirement).toBeFalsy();
    expect(res.body.data.requirementNumber).toBeFalsy();
    // subtotal (60000*5 - 0 = 300000) + totalGst (54000) + totalTax (0)
    expect(res.body.data.grandTotal).toBe(354000);
  });

  it('rejects generating a second Purchase Order for the same Quotation', async () => {
    const { duToken, quotationId } = await setupApprovedLegacyQuotation('POL2');
    const first = await request(app).post('/api/v1/purchase-orders').set('Authorization', `Bearer ${duToken}`).send({ quotationId, items: poItemsPayload() });
    expect(first.status).toBe(201);

    const second = await request(app).post('/api/v1/purchase-orders').set('Authorization', `Bearer ${duToken}`).send({ quotationId, items: poItemsPayload() });
    expect(second.status).toBe(409);
  });

  it('rejects generating a Purchase Order for a Quotation that is not yet Approved', async () => {
    const admin = await createTestUser({ email: 'po-draft-admin@vms.local', role: ROLES.SUPER_ADMIN });
    const dept = await createTestDepartment({ name: 'PO Draft Dept', code: 'PODRFT', createdBy: admin.id });
    const du = await createTestUser({ email: 'po-draft-du@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
    const duToken = tokenFor(du);

    const vendorRes = await request(app).post('/api/v1/vendors').set('Authorization', `Bearer ${duToken}`).send(vendorPayload({ email: 'draft-vendor@example.com' }));
    const quotationRes = await request(app)
      .post('/api/v1/quotations')
      .set('Authorization', `Bearer ${duToken}`)
      .send({
        vendor: vendorRes.body.data._id,
        quotationDate: '2026-07-01',
        requiredDate: '2026-08-01',
        amount: 20000,
        gst: 18,
        currency: 'INR',
        paymentTerms: 'Net 30',
        deliveryTerms: 'Within 2 Weeks',
        priority: 'medium',
      });

    const res = await request(app)
      .post('/api/v1/purchase-orders')
      .set('Authorization', `Bearer ${duToken}`)
      .send({ quotationId: quotationRes.body.data._id, items: poItemsPayload() });

    expect(res.status).toBe(400);
  });

  it('forbids a Director from generating a Purchase Order', async () => {
    const { directorToken, quotationId } = await setupApprovedLegacyQuotation('POL3');
    const res = await request(app).post('/api/v1/purchase-orders').set('Authorization', `Bearer ${directorToken}`).send({ quotationId, items: poItemsPayload() });
    expect(res.status).toBe(403);
  });

  it('validation rejects a request with neither quotationId nor requirementId', async () => {
    const { duToken } = await setupApprovedLegacyQuotation('POL4');
    const res = await request(app).post('/api/v1/purchase-orders').set('Authorization', `Bearer ${duToken}`).send({ items: poItemsPayload() });
    expect(res.status).toBe(400);
  });

  it('getById reports poTotal/paidAmount/outstandingBalance and getByQuotation finds it back', async () => {
    const { duToken, quotationId } = await setupApprovedLegacyQuotation('POL5');
    const created = await request(app).post('/api/v1/purchase-orders').set('Authorization', `Bearer ${duToken}`).send({ quotationId, items: poItemsPayload() });
    const poId = created.body.data._id as string;

    const detail = await request(app).get(`/api/v1/purchase-orders/${poId}`).set('Authorization', `Bearer ${duToken}`).send();
    expect(detail.status).toBe(200);
    expect(detail.body.data.paidAmount).toBe(0);
    expect(detail.body.data.outstandingBalance).toBe(detail.body.data.grandTotal);

    const byQuotation = await request(app).get(`/api/v1/purchase-orders/by-quotation/${quotationId}`).set('Authorization', `Bearer ${duToken}`).send();
    expect(byQuotation.status).toBe(200);
    expect(byQuotation.body.data._id).toBe(poId);
  });
});

describe('POST /api/v1/purchase-orders — requirement-based path (Phase 7)', () => {
  it('generates a Purchase Order from a vendor_finalized Requirement, resolving the winning quotation and registered vendor', async () => {
    const { duToken, requirementId, registeredVendorName } = await setupVendorFinalizedRequirement('POR1');

    const res = await request(app)
      .post('/api/v1/purchase-orders')
      .set('Authorization', `Bearer ${duToken}`)
      .send({ requirementId, items: poItemsPayload() });

    expect(res.status).toBe(201);
    expect(res.body.data.requirement).toBe(requirementId);
    expect(res.body.data.requirementNumber).toBeTruthy();
    expect(res.body.data.vendorName).toBe(registeredVendorName);
    expect(res.body.data.quotation).toBeTruthy();
    expect(res.body.data.quotationCode).toBeTruthy();
  });

  it('rejects generating a Purchase Order before a vendor has been registered (still just approved)', async () => {
    const admin = await createTestUser({ email: 'po-notfinal-admin@vms.local', role: ROLES.SUPER_ADMIN });
    const dept = await createTestDepartment({ name: 'PO Not Finalized Dept', code: 'PONF', createdBy: admin.id });
    const du = await createTestUser({ email: 'po-notfinal-du@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
    const director = await createTestUser({ email: 'po-notfinal-director@vms.local', role: ROLES.DIRECTOR });
    const duToken = tokenFor(du);
    const directorToken = tokenFor(director);

    const created = await request(app)
      .post('/api/v1/requirements')
      .set('Authorization', `Bearer ${duToken}`)
      .send({ title: 'Not Finalized', budget: 500000, requiredDate: '2026-08-01', items: sampleItems });
    const requirementId = created.body.data._id as string;
    await request(app).patch(`/api/v1/requirements/${requirementId}/submit`).set('Authorization', `Bearer ${duToken}`).send();

    const quotationRes = await request(app)
      .post(`/api/v1/requirements/${requirementId}/quotations`)
      .set('Authorization', `Bearer ${duToken}`)
      .send({
        temporaryVendor: { name: 'Some Vendor' },
        quotationDate: '2026-07-18',
        amount: 300000,
        gst: 18,
        currency: 'INR',
        paymentTerms: 'Net 30',
        deliveryTerms: 'Within 2 Weeks',
        priority: 'medium',
      });
    await seedOcrResult(quotationRes.body.data._id, 300000, 'Some Vendor');
    await request(app).post(`/api/v1/requirements/${requirementId}/comparison`).set('Authorization', `Bearer ${duToken}`).send();
    await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${directorToken}`).send();
    await request(app)
      .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send({ decision: 'approved', selectedQuotationId: quotationRes.body.data._id });
    // Deliberately skip vendor registration — requirement is 'approved', not 'vendor_finalized'.

    const res = await request(app)
      .post('/api/v1/purchase-orders')
      .set('Authorization', `Bearer ${duToken}`)
      .send({ requirementId, items: poItemsPayload() });

    expect(res.status).toBe(400);
  });

  it('rejects a second Purchase Order for the same Requirement', async () => {
    const { duToken, requirementId } = await setupVendorFinalizedRequirement('POR2');
    const first = await request(app).post('/api/v1/purchase-orders').set('Authorization', `Bearer ${duToken}`).send({ requirementId, items: poItemsPayload() });
    expect(first.status).toBe(201);

    const second = await request(app).post('/api/v1/purchase-orders').set('Authorization', `Bearer ${duToken}`).send({ requirementId, items: poItemsPayload() });
    expect(second.status).toBe(409);
  });

  it('returns 404 for a non-existent Requirement', async () => {
    const { duToken } = await setupVendorFinalizedRequirement('POR3');
    const res = await request(app)
      .post('/api/v1/purchase-orders')
      .set('Authorization', `Bearer ${duToken}`)
      .send({ requirementId: '507f1f77bcf86cd799439099', items: poItemsPayload() });
    expect(res.status).toBe(404);
  });

  it('allows an HOD to generate a Purchase Order (PO_CREATE_ROLES parity with the legacy path)', async () => {
    const { hodToken, requirementId } = await setupVendorFinalizedRequirement('POR4');
    const res = await request(app).post('/api/v1/purchase-orders').set('Authorization', `Bearer ${hodToken}`).send({ requirementId, items: poItemsPayload() });
    expect(res.status).toBe(201);
  });

  it('forbids a Director from generating a Purchase Order from a Requirement', async () => {
    const { directorToken, requirementId } = await setupVendorFinalizedRequirement('POR5');
    const res = await request(app).post('/api/v1/purchase-orders').set('Authorization', `Bearer ${directorToken}`).send({ requirementId, items: poItemsPayload() });
    expect(res.status).toBe(403);
  });

  it('GET by-requirement returns null before creation and the PO after', async () => {
    const { duToken, requirementId } = await setupVendorFinalizedRequirement('POR6');

    const before = await request(app).get(`/api/v1/purchase-orders/by-requirement/${requirementId}`).set('Authorization', `Bearer ${duToken}`).send();
    expect(before.status).toBe(200);
    expect(before.body.data).toBeNull();

    const created = await request(app).post('/api/v1/purchase-orders').set('Authorization', `Bearer ${duToken}`).send({ requirementId, items: poItemsPayload() });

    const after = await request(app).get(`/api/v1/purchase-orders/by-requirement/${requirementId}`).set('Authorization', `Bearer ${duToken}`).send();
    expect(after.status).toBe(200);
    expect(after.body.data._id).toBe(created.body.data._id);
  });
});

describe('POST /api/v1/purchase-orders/:id/email', () => {
  it('records the email attempt and reports sent:false when SMTP is not configured (test env)', async () => {
    const { duToken, quotationId } = await setupApprovedLegacyQuotation('POE1');
    const created = await request(app).post('/api/v1/purchase-orders').set('Authorization', `Bearer ${duToken}`).send({ quotationId, items: poItemsPayload() });
    const poId = created.body.data._id as string;

    const res = await request(app).post(`/api/v1/purchase-orders/${poId}/email`).set('Authorization', `Bearer ${duToken}`).send();

    expect(res.status).toBe(200);
    expect(res.body.data.sent).toBe(false);
    expect(res.body.data.recipientEmail).toBeTruthy();

    const log = await waitFor(() => ActivityLog.findOne({ action: 'po_emailed', targetId: poId }));
    expect(log).not.toBeNull();
  });

  it('uses an explicit recipientEmail override when provided', async () => {
    const { duToken, quotationId } = await setupApprovedLegacyQuotation('POE2');
    const created = await request(app).post('/api/v1/purchase-orders').set('Authorization', `Bearer ${duToken}`).send({ quotationId, items: poItemsPayload() });
    const poId = created.body.data._id as string;

    const res = await request(app)
      .post(`/api/v1/purchase-orders/${poId}/email`)
      .set('Authorization', `Bearer ${duToken}`)
      .send({ recipientEmail: 'override@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.data.recipientEmail).toBe('override@example.com');
  });

  it('forbids a Director from emailing a Purchase Order', async () => {
    const { directorToken, duToken, quotationId } = await setupApprovedLegacyQuotation('POE3');
    const created = await request(app).post('/api/v1/purchase-orders').set('Authorization', `Bearer ${duToken}`).send({ quotationId, items: poItemsPayload() });
    const poId = created.body.data._id as string;

    const res = await request(app).post(`/api/v1/purchase-orders/${poId}/email`).set('Authorization', `Bearer ${directorToken}`).send();
    expect(res.status).toBe(403);
  });

  it('returns 404 for a non-existent Purchase Order', async () => {
    const { duToken } = await setupApprovedLegacyQuotation('POE4');
    const res = await request(app).post('/api/v1/purchase-orders/507f1f77bcf86cd799439099/email').set('Authorization', `Bearer ${duToken}`).send();
    expect(res.status).toBe(404);
  });
});

describe('Regression — Purchase Order model invariants unaffected by Phase 7', () => {
  it('a legacy PO document has no requirement/requirementNumber set', async () => {
    const { duToken, quotationId } = await setupApprovedLegacyQuotation('POM1');
    const created = await request(app).post('/api/v1/purchase-orders').set('Authorization', `Bearer ${duToken}`).send({ quotationId, items: poItemsPayload() });

    const po = await PurchaseOrder.findById(created.body.data._id);
    expect(po).not.toBeNull();
    expect(po!.requirement).toBeUndefined();
    expect(po!.requirementNumber).toBeUndefined();
    expect(po!.quotation.toString()).toBe(quotationId);
  });
});
