import request from 'supertest';

import { createApp } from '@/app';
import { ROLES } from '@/constants/roles';
import { OCR_STATUS } from '@/constants/status';
import { PurchaseOrder } from '@/modules/purchaseOrder/purchaseOrder.model';
import type { IUser } from '@/modules/user/user.model';
import { createTestDepartment, createTestUser } from '@/test/factories';
import { signAccessToken } from '@/utils/jwt';

const app = createApp();

// Same "sign the JWT directly, skip /auth/login" technique used throughout this test suite
// (see purchaseOrder.test.ts / directorReview.test.ts) — avoids tripping the 20-req/window
// authRateLimiter given how many users a full end-to-end fixture creates.
function tokenFor(user: IUser): string {
  return signAccessToken({ sub: String(user._id), role: user.role, department: user.department?.toString() });
}

const sampleItems = [{ itemName: 'Laptop', quantity: 5, unit: 'pcs', estimatedRate: 60000 }];

function poItemsPayload() {
  return [
    { itemName: 'Laptop', quantity: 5, unitPrice: 60000, gstRate: 18, gstAmount: 54000, taxAmount: 0, discount: 0, total: 354000 },
  ];
}

function vendorPayload(overrides: Record<string, unknown> = {}) {
  return {
    name: 'GRN Vendor Co',
    contactPerson: 'Suresh Rao',
    phone: '9876500000',
    email: 'grn-vendor@example.com',
    address: 'Industrial Area',
    state: 'Maharashtra',
    district: 'Pune',
    city: 'Pune',
    pincode: '411001',
    bankDetails: { bankName: 'HDFC Bank', accountHolderName: 'GRN Vendor Co', accountNumber: '111122223333', ifscCode: 'HDFC0001234' },
    category: 'Raw Materials',
    ...overrides,
  };
}

function grnItemsPayload() {
  return [
    { itemName: 'Laptop', orderedQuantity: 5, receivedQuantity: 5, condition: 'good' },
  ];
}

// ─── Legacy quotation-based PO fixture (regression) ───────────────────────────────────────

interface LegacyPoFixture {
  duToken: string;
  hodToken: string;
  directorToken: string;
  poId: string;
}

/** Standalone Vendor -> standalone Quotation -> Submit -> CEO approves -> PO generated. Mirrors
 *  purchaseOrder.test.ts's setupApprovedLegacyQuotation, extended one step further to a real PO
 *  since Goods Receipt is recorded against a PO, not a Quotation. */
async function setupLegacyPo(deptCode: string, amount = 40000): Promise<LegacyPoFixture> {
  const admin = await createTestUser({ email: `grn-admin-${deptCode}@vms.local`, role: ROLES.SUPER_ADMIN });
  const dept = await createTestDepartment({ name: `GRN Legacy Dept ${deptCode}`, code: deptCode, createdBy: admin.id });
  const hod = await createTestUser({ email: `grn-hod-${deptCode}@vms.local`, role: ROLES.HOD, department: dept._id.toString() });
  const du = await createTestUser({ email: `grn-du-${deptCode}@vms.local`, role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
  const director = await createTestUser({ email: `grn-director-${deptCode}@vms.local`, role: ROLES.DIRECTOR });
  const ceo = await createTestUser({ email: `grn-ceo-${deptCode}@vms.local`, role: ROLES.CEO });

  const duToken = tokenFor(du);
  const hodToken = tokenFor(hod);
  const directorToken = tokenFor(director);
  const ceoToken = tokenFor(ceo);

  const vendorRes = await request(app)
    .post('/api/v1/vendors')
    .set('Authorization', `Bearer ${duToken}`)
    .send(vendorPayload({ email: `grn-vendor-${deptCode}@example.com` }));

  const quotationRes = await request(app)
    .post('/api/v1/quotations')
    .set('Authorization', `Bearer ${duToken}`)
    .send({
      vendor: vendorRes.body.data._id,
      quotationDate: '2026-07-01',
      requiredDate: '2026-08-01',
      amount,
      gst: 18,
      currency: 'INR',
      paymentTerms: 'Net 30',
      deliveryTerms: 'Within 2 Weeks',
      priority: 'medium',
    });
  const quotationId = quotationRes.body.data._id as string;

  await request(app).patch(`/api/v1/quotations/${quotationId}/submit`).set('Authorization', `Bearer ${duToken}`).send();
  await request(app).patch(`/api/v1/quotations/${quotationId}/decision`).set('Authorization', `Bearer ${ceoToken}`).send({ decision: 'approved' });

  const poRes = await request(app)
    .post('/api/v1/purchase-orders')
    .set('Authorization', `Bearer ${duToken}`)
    .send({ quotationId, items: poItemsPayload() });
  expect(poRes.status).toBe(201);

  return { duToken, hodToken, directorToken, poId: poRes.body.data._id as string };
}

// ─── Requirement-originated PO fixture (Phase 7 + 8) ──────────────────────────────────────

interface RequirementPoFixture {
  duToken: string;
  hodToken: string;
  directorToken: string;
  poId: string;
  requirementNumber: string;
}

async function seedOcrResult(quotationId: string, grandTotal: number, vendorName: string) {
  const { Quotation } = await import('@/modules/quotation/quotation.model');
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

/** Drives a fresh requirement through Phases 1-7 (Submit -> Quotation -> OCR -> AI Comparison ->
 *  Director Review (approved) -> Vendor Registration -> Purchase Order) so a Requirement-
 *  originated PO exists to record a Goods Receipt against. Mirrors purchaseOrder.test.ts's
 *  setupVendorFinalizedRequirement, extended one step further to generate the PO itself. */
async function setupRequirementPo(deptCode: string, amount = 300000): Promise<RequirementPoFixture> {
  const admin = await createTestUser({ email: `grn-req-admin-${deptCode}@vms.local`, role: ROLES.SUPER_ADMIN });
  const dept = await createTestDepartment({ name: `GRN Requirement Dept ${deptCode}`, code: deptCode, createdBy: admin.id });
  const hod = await createTestUser({ email: `grn-req-hod-${deptCode}@vms.local`, role: ROLES.HOD, department: dept._id.toString() });
  const du = await createTestUser({ email: `grn-req-du-${deptCode}@vms.local`, role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
  const director = await createTestUser({ email: `grn-req-director-${deptCode}@vms.local`, role: ROLES.DIRECTOR });

  const duToken = tokenFor(du);
  const hodToken = tokenFor(hod);
  const directorToken = tokenFor(director);

  const created = await request(app)
    .post('/api/v1/requirements')
    .set('Authorization', `Bearer ${duToken}`)
    .send({ title: `GRN Requirement ${deptCode}`, budget: 500000, requiredDate: '2026-08-01', items: sampleItems });
  const requirementId = created.body.data._id as string;

  await request(app).patch(`/api/v1/requirements/${requirementId}/submit`).set('Authorization', `Bearer ${duToken}`).send();

  const registeredVendorName = `GRN Winning Vendor ${deptCode}`;
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
  await request(app)
    .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
    .set('Authorization', `Bearer ${directorToken}`)
    .send({ decision: 'approved', selectedQuotationId: quotationId });

  await registerVendor(requirementId, duToken, registeredVendorName);

  const poRes = await request(app)
    .post('/api/v1/purchase-orders')
    .set('Authorization', `Bearer ${duToken}`)
    .send({ requirementId, items: poItemsPayload() });
  expect(poRes.status).toBe(201);

  return { duToken, hodToken, directorToken, poId: poRes.body.data._id as string, requirementNumber: poRes.body.data.requirementNumber as string };
}

describe('POST /api/v1/goods-receipts — legacy PO (regression, no Requirement)', () => {
  it('records a Goods Receipt against a legacy Purchase Order', async () => {
    const { duToken, poId } = await setupLegacyPo('GRNL1');

    const res = await request(app)
      .post('/api/v1/goods-receipts')
      .set('Authorization', `Bearer ${duToken}`)
      .send({ purchaseOrder: poId, receivedDate: '2026-08-05', items: grnItemsPayload(), overallCondition: 'good' });

    expect(res.status).toBe(201);
    expect(res.body.data.purchaseOrder).toBe(poId);
    expect(res.body.data.requirement).toBeFalsy();
    expect(res.body.data.grnNumber).toMatch(/^GRN-\d{4}-\d{6}$/);

    const po = await PurchaseOrder.findById(poId);
    expect(po!.goodsReceipt).toBeTruthy();
  });

  it('rejects a second Goods Receipt for the same Purchase Order', async () => {
    const { duToken, poId } = await setupLegacyPo('GRNL2');
    const first = await request(app).post('/api/v1/goods-receipts').set('Authorization', `Bearer ${duToken}`).send({ purchaseOrder: poId, receivedDate: '2026-08-05', items: grnItemsPayload(), overallCondition: 'good' });
    expect(first.status).toBe(201);

    const second = await request(app).post('/api/v1/goods-receipts').set('Authorization', `Bearer ${duToken}`).send({ purchaseOrder: poId, receivedDate: '2026-08-06', items: grnItemsPayload(), overallCondition: 'good' });
    expect(second.status).toBe(409);
  });

  it('forbids a Director from recording a Goods Receipt', async () => {
    const { directorToken, poId } = await setupLegacyPo('GRNL3');
    const res = await request(app).post('/api/v1/goods-receipts').set('Authorization', `Bearer ${directorToken}`).send({ purchaseOrder: poId, receivedDate: '2026-08-05', items: grnItemsPayload(), overallCondition: 'good' });
    expect(res.status).toBe(403);
  });

  it('allows an HOD to record a Goods Receipt', async () => {
    const { hodToken, poId } = await setupLegacyPo('GRNL4');
    const res = await request(app).post('/api/v1/goods-receipts').set('Authorization', `Bearer ${hodToken}`).send({ purchaseOrder: poId, receivedDate: '2026-08-05', items: grnItemsPayload(), overallCondition: 'good' });
    expect(res.status).toBe(201);
  });

  it('returns 404 for a non-existent Purchase Order', async () => {
    const { duToken } = await setupLegacyPo('GRNL5');
    const res = await request(app)
      .post('/api/v1/goods-receipts')
      .set('Authorization', `Bearer ${duToken}`)
      .send({ purchaseOrder: '507f1f77bcf86cd799439099', receivedDate: '2026-08-05', items: grnItemsPayload(), overallCondition: 'good' });
    expect(res.status).toBe(404);
  });

  it('GET by-po returns null before creation and the Goods Receipt after', async () => {
    const { duToken, poId } = await setupLegacyPo('GRNL6');

    const before = await request(app).get(`/api/v1/goods-receipts/by-po/${poId}`).set('Authorization', `Bearer ${duToken}`).send();
    expect(before.status).toBe(200);
    expect(before.body.data).toBeNull();

    const created = await request(app).post('/api/v1/goods-receipts').set('Authorization', `Bearer ${duToken}`).send({ purchaseOrder: poId, receivedDate: '2026-08-05', items: grnItemsPayload(), overallCondition: 'good' });

    const after = await request(app).get(`/api/v1/goods-receipts/by-po/${poId}`).set('Authorization', `Bearer ${duToken}`).send();
    expect(after.status).toBe(200);
    expect(after.body.data._id).toBe(created.body.data._id);
  });
});

describe('POST /api/v1/goods-receipts — Requirement-originated PO (Phase 7 + 8)', () => {
  it('records a Goods Receipt and denormalizes the requirement/requirementNumber from the PO', async () => {
    const { duToken, poId, requirementNumber } = await setupRequirementPo('GRNR1');

    const res = await request(app)
      .post('/api/v1/goods-receipts')
      .set('Authorization', `Bearer ${duToken}`)
      .send({ purchaseOrder: poId, receivedDate: '2026-08-05', items: grnItemsPayload(), overallCondition: 'good' });

    expect(res.status).toBe(201);
    expect(res.body.data.requirement).toBeTruthy();
    expect(res.body.data.requirementNumber).toBe(requirementNumber);
  });
});
