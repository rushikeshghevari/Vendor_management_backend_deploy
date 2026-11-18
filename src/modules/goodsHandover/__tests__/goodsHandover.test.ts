import request from 'supertest';

import { createApp } from '@/app';
import { ROLES } from '@/constants/roles';
import { OCR_STATUS } from '@/constants/status';
import type { IUser } from '@/modules/user/user.model';
import { createTestDepartment, createTestUser } from '@/test/factories';
import { signAccessToken } from '@/utils/jwt';

const app = createApp();

// Same "sign the JWT directly, skip /auth/login" technique used throughout this test suite
// (see goodsReceipt.test.ts / purchaseOrder.test.ts) — avoids tripping the 20-req/window
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

function grnItemsPayload() {
  return [{ itemName: 'Laptop', orderedQuantity: 5, receivedQuantity: 5, condition: 'good' }];
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

/** Drives a requirement from Department A → (forward) → Admin → (forward) → Procurement, so a
 *  Goods Receipt recorded by Procurement should auto-create a Goods Handover back to Admin.
 *  Mirrors goodsReceipt.test.ts's setupRequirementPo, with the routing chain inserted between
 *  submit and the first hod-accept. */
async function setupRoutedRequirementPo(deptCode: string, amount = 300000) {
  const admin = await createTestUser({ email: `gh-admin-${deptCode}@vms.local`, role: ROLES.SUPER_ADMIN });

  const deptA = await createTestDepartment({ name: `GH Requesting Dept ${deptCode}`, code: `${deptCode}A`, createdBy: admin.id });
  const hodA = await createTestUser({ email: `gh-hoda-${deptCode}@vms.local`, role: ROLES.HOD, department: deptA._id.toString() });
  const duA = await createTestUser({ email: `gh-dua-${deptCode}@vms.local`, role: ROLES.DEPARTMENT_USER, department: deptA._id.toString() });

  // Must be literally named "Admin" — goodsHandoverService.createIfApplicable identifies the
  // Admin department by name (confirmed design decision, see
  // docs/PHASE12_DEPARTMENT_ROUTING_AND_GOODS_HANDOVER.md).
  const deptAdmin = await createTestDepartment({ name: 'Admin', code: `${deptCode}ADM`, createdBy: admin.id });
  const hodAdmin = await createTestUser({ email: `gh-hodadmin-${deptCode}@vms.local`, role: ROLES.HOD, department: deptAdmin._id.toString() });

  const deptProc = await createTestDepartment({ name: `GH Procurement ${deptCode}`, code: `${deptCode}PRC`, createdBy: admin.id });
  const hodProc = await createTestUser({ email: `gh-hodproc-${deptCode}@vms.local`, role: ROLES.HOD, department: deptProc._id.toString() });
  const duProc = await createTestUser({ email: `gh-duproc-${deptCode}@vms.local`, role: ROLES.DEPARTMENT_USER, department: deptProc._id.toString() });

  const director = await createTestUser({ email: `gh-director-${deptCode}@vms.local`, role: ROLES.DIRECTOR });

  const duAToken = tokenFor(duA);
  const hodAToken = tokenFor(hodA);
  const hodAdminToken = tokenFor(hodAdmin);
  const duProcToken = tokenFor(duProc);
  const hodProcToken = tokenFor(hodProc);
  const directorToken = tokenFor(director);

  const created = await request(app)
    .post('/api/v1/requirements')
    .set('Authorization', `Bearer ${duAToken}`)
    .send({ title: `GH Requirement ${deptCode}`, budget: 500000, requiredDate: '2026-08-01', items: sampleItems });
  const requirementId = created.body.data._id as string;

  await request(app).patch(`/api/v1/requirements/${requirementId}/submit`).set('Authorization', `Bearer ${duAToken}`).send();

  // Dept A's HOD forwards to Admin instead of accepting.
  const forward1 = await request(app)
    .patch(`/api/v1/requirements/${requirementId}/forward`)
    .set('Authorization', `Bearer ${hodAToken}`)
    .send({ toDepartment: deptAdmin._id.toString() });
  if (forward1.status !== 200) throw new Error(`forward to Admin failed: ${JSON.stringify(forward1.body)}`);

  // Admin's HOD forwards again, to Procurement.
  const forward2 = await request(app)
    .patch(`/api/v1/requirements/${requirementId}/forward`)
    .set('Authorization', `Bearer ${hodAdminToken}`)
    .send({ toDepartment: deptProc._id.toString() });
  if (forward2.status !== 200) throw new Error(`forward to Procurement failed: ${JSON.stringify(forward2.body)}`);

  // Procurement's HOD accepts — quotation collection unlocks here.
  const accepted = await request(app)
    .patch(`/api/v1/requirements/${requirementId}/hod-accept`)
    .set('Authorization', `Bearer ${hodProcToken}`)
    .send();
  if (accepted.status !== 200) throw new Error(`hod-accept at Procurement failed: ${JSON.stringify(accepted.body)}`);

  const registeredVendorName = `GH Winning Vendor ${deptCode}`;
  const quotationRes = await request(app)
    .post(`/api/v1/requirements/${requirementId}/quotations`)
    .set('Authorization', `Bearer ${duProcToken}`)
    .send({
      temporaryVendor: { name: registeredVendorName, contactPerson: 'Ramesh', phone: '9876543210' },
      quotationDate: '2026-07-18',
      amount,
      gst: 18,
      currency: 'INR',
      paymentTerms: 'Net 30',
      creditPeriod: 30,
      deliveryTerms: 'Within 2 Weeks',
      priority: 'medium',
    });
  const quotationId = quotationRes.body.data._id as string;
  await seedOcrResult(quotationId, amount, registeredVendorName);

  await request(app).post(`/api/v1/requirements/${requirementId}/comparison`).set('Authorization', `Bearer ${duProcToken}`).send();
  await request(app).patch(`/api/v1/requirements/${requirementId}/submit-to-director`).set('Authorization', `Bearer ${duProcToken}`).send();
  await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${directorToken}`).send();
  await request(app)
    .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
    .set('Authorization', `Bearer ${directorToken}`)
    .send({ decision: 'approved', selectedQuotationId: quotationId });

  await registerVendor(requirementId, duProcToken, registeredVendorName);

  const poRes = await request(app)
    .post('/api/v1/purchase-orders')
    .set('Authorization', `Bearer ${duProcToken}`)
    .send({ requirementId, items: poItemsPayload() });
  if (poRes.status !== 201) throw new Error(`PO generation failed: ${JSON.stringify(poRes.body)}`);

  return {
    duProcToken,
    hodProcToken,
    hodAdminToken,
    poId: poRes.body.data._id as string,
    deptProc,
    deptAdmin,
  };
}

/** Single-department requirement — accepted on the very first hod-accept, never forwarded,
 *  Admin never involved. Used for the "no handover created" regression case. Mirrors
 *  goodsReceipt.test.ts's setupRequirementPo. */
async function setupSingleDeptRequirementPo(deptCode: string, amount = 300000) {
  const admin = await createTestUser({ email: `gh-sd-admin-${deptCode}@vms.local`, role: ROLES.SUPER_ADMIN });
  const dept = await createTestDepartment({ name: `GH Single Dept ${deptCode}`, code: deptCode, createdBy: admin.id });
  const hod = await createTestUser({ email: `gh-sd-hod-${deptCode}@vms.local`, role: ROLES.HOD, department: dept._id.toString() });
  const du = await createTestUser({ email: `gh-sd-du-${deptCode}@vms.local`, role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
  const director = await createTestUser({ email: `gh-sd-director-${deptCode}@vms.local`, role: ROLES.DIRECTOR });

  const duToken = tokenFor(du);
  const hodToken = tokenFor(hod);
  const directorToken = tokenFor(director);

  const created = await request(app)
    .post('/api/v1/requirements')
    .set('Authorization', `Bearer ${duToken}`)
    .send({ title: `GH Single Requirement ${deptCode}`, budget: 500000, requiredDate: '2026-08-01', items: sampleItems });
  const requirementId = created.body.data._id as string;

  await request(app).patch(`/api/v1/requirements/${requirementId}/submit`).set('Authorization', `Bearer ${duToken}`).send();
  await request(app).patch(`/api/v1/requirements/${requirementId}/hod-accept`).set('Authorization', `Bearer ${hodToken}`).send();

  const registeredVendorName = `GH Single Winning Vendor ${deptCode}`;
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
      creditPeriod: 30,
      deliveryTerms: 'Within 2 Weeks',
      priority: 'medium',
    });
  const quotationId = quotationRes.body.data._id as string;
  await seedOcrResult(quotationId, amount, registeredVendorName);

  await request(app).post(`/api/v1/requirements/${requirementId}/comparison`).set('Authorization', `Bearer ${duToken}`).send();
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
  if (poRes.status !== 201) throw new Error(`PO generation failed: ${JSON.stringify(poRes.body)}`);

  return { duToken, poId: poRes.body.data._id as string };
}

describe('Goods Handover — auto-creation on Goods Receipt', () => {
  it('creates a pending Goods Handover (Procurement -> Admin) when the routing chain passed through Admin', async () => {
    const { duProcToken, poId, deptProc, deptAdmin } = await setupRoutedRequirementPo('GH1');

    const grnRes = await request(app)
      .post('/api/v1/goods-receipts')
      .set('Authorization', `Bearer ${duProcToken}`)
      .send({ purchaseOrder: poId, receivedDate: '2026-08-05', items: grnItemsPayload(), overallCondition: 'good' });
    expect(grnRes.status).toBe(201);

    const handoverRes = await request(app)
      .get(`/api/v1/goods-handovers/by-receipt/${grnRes.body.data._id}`)
      .set('Authorization', `Bearer ${duProcToken}`)
      .send();

    expect(handoverRes.status).toBe(200);
    expect(handoverRes.body.data).toBeTruthy();
    expect(handoverRes.body.data.status).toBe('pending');
    expect(handoverRes.body.data.fromDepartment._id).toBe(deptProc._id.toString());
    expect(handoverRes.body.data.toDepartment._id).toBe(deptAdmin._id.toString());
  });

  it('does NOT create a Goods Handover when the requirement was never forwarded (Admin never in the chain)', async () => {
    const { duToken, poId } = await setupSingleDeptRequirementPo('GH2');

    const grnRes = await request(app)
      .post('/api/v1/goods-receipts')
      .set('Authorization', `Bearer ${duToken}`)
      .send({ purchaseOrder: poId, receivedDate: '2026-08-05', items: grnItemsPayload(), overallCondition: 'good' });
    expect(grnRes.status).toBe(201);

    const handoverRes = await request(app)
      .get(`/api/v1/goods-handovers/by-receipt/${grnRes.body.data._id}`)
      .set('Authorization', `Bearer ${duToken}`)
      .send();

    expect(handoverRes.status).toBe(200);
    expect(handoverRes.body.data).toBeFalsy();
  });
});

describe('PATCH /api/v1/goods-handovers/:id/hand-over and /receive', () => {
  async function createHandover(deptCode: string) {
    const fixture = await setupRoutedRequirementPo(deptCode);
    const grnRes = await request(app)
      .post('/api/v1/goods-receipts')
      .set('Authorization', `Bearer ${fixture.duProcToken}`)
      .send({ purchaseOrder: fixture.poId, receivedDate: '2026-08-05', items: grnItemsPayload(), overallCondition: 'good' });
    const handoverRes = await request(app)
      .get(`/api/v1/goods-handovers/by-receipt/${grnRes.body.data._id}`)
      .set('Authorization', `Bearer ${fixture.duProcToken}`)
      .send();
    return { ...fixture, handoverId: handoverRes.body.data._id as string };
  }

  it('lets Procurement confirm hand-over — status moves to handed_over', async () => {
    const { hodProcToken, handoverId } = await createHandover('GH3');

    const res = await request(app)
      .patch(`/api/v1/goods-handovers/${handoverId}/hand-over`)
      .set('Authorization', `Bearer ${hodProcToken}`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('handed_over');
  });

  it('forbids an unrelated department from confirming hand-over', async () => {
    const { handoverId } = await createHandover('GH4');
    const admin = await createTestUser({ email: 'gh-unrelated-admin@vms.local', role: ROLES.SUPER_ADMIN });
    const unrelatedDept = await createTestDepartment({ name: 'GH Unrelated Dept', code: 'GHUN', createdBy: admin.id });
    const unrelatedHod = await createTestUser({ email: 'gh-unrelated-hod@vms.local', role: ROLES.HOD, department: unrelatedDept._id.toString() });

    const res = await request(app)
      .patch(`/api/v1/goods-handovers/${handoverId}/hand-over`)
      .set('Authorization', `Bearer ${tokenFor(unrelatedHod)}`)
      .send();

    expect(res.status).toBe(403);
  });

  it('lets Admin confirm receipt only after hand-over — status moves to received', async () => {
    const { hodProcToken, hodAdminToken, handoverId } = await createHandover('GH5');

    const tooEarly = await request(app)
      .patch(`/api/v1/goods-handovers/${handoverId}/receive`)
      .set('Authorization', `Bearer ${hodAdminToken}`)
      .send();
    expect(tooEarly.status).toBe(409);

    await request(app).patch(`/api/v1/goods-handovers/${handoverId}/hand-over`).set('Authorization', `Bearer ${hodProcToken}`).send();

    const res = await request(app)
      .patch(`/api/v1/goods-handovers/${handoverId}/receive`)
      .set('Authorization', `Bearer ${hodAdminToken}`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('received');
  });
});

describe('PATCH /api/v1/goods-handovers/:id/distribute', () => {
  async function createReceivedHandover(deptCode: string) {
    const fixture = await setupRoutedRequirementPo(deptCode);
    const grnRes = await request(app)
      .post('/api/v1/goods-receipts')
      .set('Authorization', `Bearer ${fixture.duProcToken}`)
      .send({ purchaseOrder: fixture.poId, receivedDate: '2026-08-05', items: grnItemsPayload(), overallCondition: 'good' });
    const handoverRes = await request(app)
      .get(`/api/v1/goods-handovers/by-receipt/${grnRes.body.data._id}`)
      .set('Authorization', `Bearer ${fixture.duProcToken}`)
      .send();
    const handoverId = handoverRes.body.data._id as string;

    await request(app).patch(`/api/v1/goods-handovers/${handoverId}/hand-over`).set('Authorization', `Bearer ${fixture.hodProcToken}`).send();
    await request(app).patch(`/api/v1/goods-handovers/${handoverId}/receive`).set('Authorization', `Bearer ${fixture.hodAdminToken}`).send();

    return { ...fixture, handoverId };
  }

  it('rejects logging a distribution before receipt is confirmed', async () => {
    const { hodProcToken, handoverId: unrelated } = await (async () => {
      const fixture = await setupRoutedRequirementPo('GH6');
      const grnRes = await request(app)
        .post('/api/v1/goods-receipts')
        .set('Authorization', `Bearer ${fixture.duProcToken}`)
        .send({ purchaseOrder: fixture.poId, receivedDate: '2026-08-05', items: grnItemsPayload(), overallCondition: 'good' });
      const handoverRes = await request(app)
        .get(`/api/v1/goods-handovers/by-receipt/${grnRes.body.data._id}`)
        .set('Authorization', `Bearer ${fixture.duProcToken}`)
        .send();
      return { ...fixture, handoverId: handoverRes.body.data._id as string };
    })();

    const res = await request(app)
      .patch(`/api/v1/goods-handovers/${unrelated}/distribute`)
      .set('Authorization', `Bearer ${hodProcToken}`)
      .send({ distributedToDepartment: '507f1f77bcf86cd799439099' });

    expect(res.status).toBe(409);
  });

  it('lets Admin log the final distribution once received, and rejects a second attempt', async () => {
    const { hodAdminToken, deptProc, handoverId } = await createReceivedHandover('GH7');

    const res = await request(app)
      .patch(`/api/v1/goods-handovers/${handoverId}/distribute`)
      .set('Authorization', `Bearer ${hodAdminToken}`)
      .send({ distributedToDepartment: deptProc._id.toString(), note: 'Handed to Procurement store' });

    expect(res.status).toBe(200);
    expect(res.body.data.distributedToDepartment).toBeTruthy();
    expect(res.body.data.distributedAt).toBeTruthy();

    const second = await request(app)
      .patch(`/api/v1/goods-handovers/${handoverId}/distribute`)
      .set('Authorization', `Bearer ${hodAdminToken}`)
      .send({ distributedToDepartment: deptProc._id.toString() });

    expect(second.status).toBe(409);
  });
});
