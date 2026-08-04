import request from 'supertest';

import { createApp } from '@/app';
import { ROLES } from '@/constants/roles';
import { OCR_STATUS } from '@/constants/status';
import { Bill } from '@/modules/bill/bill.model';
import type { IUser } from '@/modules/user/user.model';
import { createTestDepartment, createTestUser } from '@/test/factories';
import { signAccessToken } from '@/utils/jwt';

const app = createApp();

// Same "sign the JWT directly, skip /auth/login" technique used throughout this test suite
// (see purchaseOrder.test.ts) — avoids tripping the 20-req/window authRateLimiter given how
// many users a full end-to-end fixture creates.
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
    name: 'Bill Test Vendor Co',
    contactPerson: 'Suresh Rao',
    phone: '9876500000',
    email: 'bill-test-vendor@example.com',
    address: 'Industrial Area',
    state: 'Maharashtra',
    district: 'Pune',
    city: 'Pune',
    pincode: '411001',
    bankDetails: { bankName: 'HDFC Bank', accountHolderName: 'Bill Test Vendor Co', accountNumber: '111122223333', ifscCode: 'HDFC0001234' },
    category: 'Raw Materials',
    ...overrides,
  };
}

function billPayload(quotationId: string, overrides: Record<string, unknown> = {}) {
  return {
    quotation: quotationId,
    invoiceNumber: `INV-${Math.random().toString(36).slice(2, 10)}`,
    invoiceDate: '2026-08-01',
    invoiceAmount: 300000,
    taxableAmount: 254237,
    gstAmount: 45763,
    paymentTerms: 'Net 30',
    dueDate: '2026-09-01',
    ...overrides,
  };
}

function grnItemsPayload() {
  return [
    { itemName: 'Laptop', orderedQuantity: 5, receivedQuantity: 5, condition: 'good' },
  ];
}

// ─── Legacy quotation-based PO fixture (regression) ───────────────────────────────────────

interface LegacyFixture {
  duToken: string;
  quotationId: string;
}

/** Standalone Vendor -> standalone Quotation -> Submit -> CEO approves -> PO generated. Amount
 *  is kept at/under the ₹50,000 default CEO Approval Limit so a single CEO decision suffices
 *  (see purchaseOrder.test.ts's identical convention). A legacy PO has no `requirement`, so
 *  Phase 8's Goods Receipt gate must never apply to it. */
async function setupLegacyPoAndQuotation(deptCode: string, amount = 40000): Promise<LegacyFixture> {
  const admin = await createTestUser({ email: `bill-admin-${deptCode}@vms.local`, role: ROLES.SUPER_ADMIN });
  const dept = await createTestDepartment({ name: `Bill Legacy Dept ${deptCode}`, code: deptCode, createdBy: admin.id });
  const du = await createTestUser({ email: `bill-du-${deptCode}@vms.local`, role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
  const ceo = await createTestUser({ email: `bill-ceo-${deptCode}@vms.local`, role: ROLES.CEO });

  const duToken = tokenFor(du);
  const ceoToken = tokenFor(ceo);

  const vendorRes = await request(app)
    .post('/api/v1/vendors')
    .set('Authorization', `Bearer ${duToken}`)
    .send(vendorPayload({ email: `bill-vendor-${deptCode}@example.com` }));

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

  return { duToken, quotationId };
}

// ─── Requirement-originated PO fixture (Phase 7 + 8) ──────────────────────────────────────

interface RequirementFixture {
  duToken: string;
  quotationId: string;
  poId: string;
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

/** Drives a fresh requirement through Phases 1-7 to a generated Requirement-originated PO —
 *  the only shape Phase 8's Goods Receipt gate actually applies to. */
async function setupRequirementPo(deptCode: string, amount = 300000): Promise<RequirementFixture> {
  const admin = await createTestUser({ email: `bill-req-admin-${deptCode}@vms.local`, role: ROLES.SUPER_ADMIN });
  const dept = await createTestDepartment({ name: `Bill Requirement Dept ${deptCode}`, code: deptCode, createdBy: admin.id });
  const du = await createTestUser({ email: `bill-req-du-${deptCode}@vms.local`, role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
  const director = await createTestUser({ email: `bill-req-director-${deptCode}@vms.local`, role: ROLES.DIRECTOR });

  const duToken = tokenFor(du);
  const directorToken = tokenFor(director);

  const created = await request(app)
    .post('/api/v1/requirements')
    .set('Authorization', `Bearer ${duToken}`)
    .send({ title: `Bill Requirement ${deptCode}`, budget: 500000, requiredDate: '2026-08-01', items: sampleItems });
  const requirementId = created.body.data._id as string;

  await request(app).patch(`/api/v1/requirements/${requirementId}/submit`).set('Authorization', `Bearer ${duToken}`).send();

  const registeredVendorName = `Bill Winning Vendor ${deptCode}`;
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

  return { duToken, quotationId, poId: poRes.body.data._id as string };
}

describe('POST /api/v1/bills — legacy quotation-only PO (regression, Phase 8 gate must not apply)', () => {
  it('creates a Draft bill with no Goods Receipt recorded at all', async () => {
    const { duToken, quotationId } = await setupLegacyPoAndQuotation('BILLL1');

    const res = await request(app)
      .post('/api/v1/bills')
      .set('Authorization', `Bearer ${duToken}`)
      .send(billPayload(quotationId));

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('draft');
  });
});

describe('Regression — Bill model invariants unaffected by Phase 9', () => {
  it('a legacy quotation-only Bill has requirement/requirementNumber/goodsReceipt/grnNumber genuinely undefined', async () => {
    const { duToken, quotationId } = await setupLegacyPoAndQuotation('BILLM1');

    const res = await request(app)
      .post('/api/v1/bills')
      .set('Authorization', `Bearer ${duToken}`)
      .send(billPayload(quotationId));
    expect(res.status).toBe(201);

    const bill = await Bill.findById(res.body.data._id);
    expect(bill).not.toBeNull();
    expect(bill!.requirement).toBeUndefined();
    expect(bill!.requirementNumber).toBeUndefined();
    expect(bill!.goodsReceipt).toBeUndefined();
    expect(bill!.grnNumber).toBeUndefined();
  });
});

describe('POST /api/v1/bills — Requirement/Goods-Receipt lineage (Phase 9)', () => {
  it('carries requirement/requirementNumber/goodsReceipt/grnNumber onto the new Bill', async () => {
    const { duToken, quotationId, poId } = await setupRequirementPo('BILLR3');

    const grnRes = await request(app)
      .post('/api/v1/goods-receipts')
      .set('Authorization', `Bearer ${duToken}`)
      .send({ purchaseOrder: poId, receivedDate: '2026-08-05', items: grnItemsPayload(), overallCondition: 'good' });
    expect(grnRes.status).toBe(201);

    const res = await request(app)
      .post('/api/v1/bills')
      .set('Authorization', `Bearer ${duToken}`)
      .send(billPayload(quotationId));
    expect(res.status).toBe(201);

    const bill = await Bill.findById(res.body.data._id);
    expect(bill).not.toBeNull();
    expect(bill!.requirement).toBeDefined();
    expect(bill!.requirementNumber).toBeTruthy();
    expect(bill!.goodsReceipt).toBeDefined();
    expect(bill!.grnNumber).toBe(grnRes.body.data.grnNumber);
  });
});

describe('POST /api/v1/bills — Requirement-originated PO (Phase 8 Goods Receipt gate)', () => {
  it('blocks Bill creation until a Goods Receipt is recorded for the Purchase Order', async () => {
    const { duToken, quotationId } = await setupRequirementPo('BILLR1');

    const blocked = await request(app)
      .post('/api/v1/bills')
      .set('Authorization', `Bearer ${duToken}`)
      .send(billPayload(quotationId));

    expect(blocked.status).toBe(400);
    expect(blocked.body.message).toMatch(/Goods Receipt/i);
  });

  it('allows Bill creation once the Goods Receipt has been recorded', async () => {
    const { duToken, quotationId, poId } = await setupRequirementPo('BILLR2');

    const grnRes = await request(app)
      .post('/api/v1/goods-receipts')
      .set('Authorization', `Bearer ${duToken}`)
      .send({ purchaseOrder: poId, receivedDate: '2026-08-05', items: grnItemsPayload(), overallCondition: 'good' });
    expect(grnRes.status).toBe(201);

    const res = await request(app)
      .post('/api/v1/bills')
      .set('Authorization', `Bearer ${duToken}`)
      .send(billPayload(quotationId));

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('draft');
  });
});
