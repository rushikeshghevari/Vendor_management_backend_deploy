import request from 'supertest';

import { createApp } from '@/app';
import { ROLES } from '@/constants/roles';
import { OCR_STATUS } from '@/constants/status';
import { Department } from '@/modules/department/department.model';
import { Quotation } from '@/modules/quotation/quotation.model';
import { Vendor } from '@/modules/vendor/vendor.model';
import { User } from '@/modules/user/user.model';
import { VendorRegistrationLink } from '@/modules/vendorRegistrationLink/vendorRegistrationLink.model';
import { createTestDepartment, createTestUser } from '@/test/factories';
import { signAccessToken } from '@/utils/jwt';

const app = createApp();

function tokenFor(user: { _id: unknown; role: string; department?: unknown }): string {
  return signAccessToken({ sub: String(user._id), role: user.role as never, department: user.department ? String(user.department) : undefined });
}

const sampleItems = [{ itemName: 'Laptop', quantity: 5, unit: 'pcs', estimatedRate: 60000 }];

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
  hodToken: string;
  directorToken: string;
  superAdminToken: string;
  requirementId: string;
  dept: { _id: { toString(): string } };
}

/** Drives a fresh requirement through Submit -> Quotation -> Comparison -> Submit to Director
 *  -> Approved, exactly the state the Vendor Registration Link pipeline requires. Mirrors
 *  vendorRegistration.test.ts's own setup helper. */
async function setupApprovedRequirement(deptCode: string, amount = 300000): Promise<Setup> {
  // Dual Director Approval (docs/WORKFLOW_DUAL_DIRECTOR_APPROVAL.md) requires *every* active
  // Director to approve before the aggregate resolves — the roster is global, not scoped per
  // department. Deactivating every Director left active by an earlier setup call in this same
  // test file keeps each call's own single new Director sufficient to resolve its review.
  await User.updateMany({ role: ROLES.DIRECTOR, isActive: true }, { isActive: false });

  const admin = await createTestUser({ email: `vrl-admin-${deptCode}@vms.local`, role: ROLES.SUPER_ADMIN });
  const dept = await createTestDepartment({ name: `Vendor Link Dept ${deptCode}`, code: deptCode, createdBy: admin.id });
  const hod = await createTestUser({ email: `vrl-hod-${deptCode}@vms.local`, role: ROLES.HOD, department: dept._id.toString() });
  await Department.updateOne({ _id: dept._id }, { hod: hod._id });
  const du = await createTestUser({ email: `vrl-du-${deptCode}@vms.local`, role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
  const director = await createTestUser({ email: `vrl-director-${deptCode}@vms.local`, role: ROLES.DIRECTOR });

  const duToken = tokenFor(du);
  const hodToken = tokenFor(hod);
  const directorToken = tokenFor(director);
  const superAdminToken = tokenFor(admin);

  const created = await request(app)
    .post('/api/v1/requirements')
    .set('Authorization', `Bearer ${duToken}`)
    .send({ title: `Vendor Link Requirement ${deptCode}`, budget: 500000, requiredDate: '2026-08-01', items: sampleItems });
  const requirementId = created.body.data._id as string;

  await request(app).patch(`/api/v1/requirements/${requirementId}/submit`).set('Authorization', `Bearer ${duToken}`).send();

  const quotationRes = await request(app)
    .post(`/api/v1/requirements/${requirementId}/quotations`)
    .set('Authorization', `Bearer ${duToken}`)
    .send({
      temporaryVendor: { name: 'Link Winning Vendor', contactPerson: 'Ramesh', phone: '9876543210', email: `link-winner-${deptCode}@vendor.local`, address: 'Industrial Estate' },
      quotationDate: '2026-07-18',
      amount,
      gst: 18,
      currency: 'INR',
      paymentTerms: 'Net 30',
      deliveryTerms: 'Within 2 Weeks',
      priority: 'medium',
    });
  const quotationId = quotationRes.body.data._id as string;
  await seedOcrResult(quotationId, amount, 'Link Winning Vendor');

  await request(app).post(`/api/v1/requirements/${requirementId}/comparison`).set('Authorization', `Bearer ${duToken}`).send();
  await request(app).patch(`/api/v1/requirements/${requirementId}/submit-to-director`).set('Authorization', `Bearer ${duToken}`).send();
  await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${directorToken}`).send();
  const approved = await request(app)
    .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
    .set('Authorization', `Bearer ${directorToken}`)
    .send({ decision: 'approved', selectedQuotationId: quotationId });
  expect(approved.body.data.requirement.status).toBe('approved');

  return { duToken, hodToken, directorToken, superAdminToken, requirementId, dept };
}

const PDF_BYTES = Buffer.from('%PDF-1.4 fake vendor document');

function vendorPayload(overrides: Record<string, string> = {}) {
  return {
    name: 'Link Winning Vendor',
    contactPerson: 'Ramesh Gupta',
    phone: '9876543210',
    email: 'accounts@linkwinningvendor.example',
    gstNumber: '27ABCDE1234F1Z5',
    panNumber: 'ABCDE1234F',
    address: 'Industrial Estate, Plot 12',
    state: 'Maharashtra',
    district: 'Pune',
    city: 'Pune',
    pincode: '411001',
    bankName: 'HDFC Bank',
    accountHolderName: 'Link Winning Vendor Co',
    accountNumber: '123456789012',
    ifscCode: 'HDFC0001234',
    category: 'Raw Materials',
    ...overrides,
  };
}

function generateLink(requirementId: string, token: string) {
  return request(app).post(`/api/v1/requirements/${requirementId}/vendor-registration-link`).set('Authorization', `Bearer ${token}`).send();
}

function submitPublic(token: string, payload: Record<string, string>, withDocs = true) {
  let req = request(app).post(`/api/v1/public/vendor-registration/${token}`);
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

describe('POST /api/v1/requirements/:id/vendor-registration-link', () => {
  it('rejects generating a link before the requirement is Director-approved', async () => {
    const admin = await createTestUser({ email: 'vrl-notapproved-admin@vms.local', role: ROLES.SUPER_ADMIN });
    const dept = await createTestDepartment({ name: 'Link Not Approved Dept', code: 'VRLNA', createdBy: admin.id });
    const du = await createTestUser({ email: 'vrl-notapproved-du@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
    const duToken = tokenFor(du);

    const created = await request(app)
      .post('/api/v1/requirements')
      .set('Authorization', `Bearer ${duToken}`)
      .send({ title: 'Link Not Approved Yet', budget: 100000, requiredDate: '2026-08-01', items: sampleItems });
    const requirementId = created.body.data._id as string;

    const res = await generateLink(requirementId, duToken);
    expect(res.status).toBe(400);
  });

  it('forbids a Director from generating a link', async () => {
    const { directorToken, requirementId } = await setupApprovedRequirement('VRL1');
    const res = await generateLink(requirementId, directorToken);
    expect(res.status).toBe(403);
  });

  it('generates a link for the Department User, HOD, and Super Admin', async () => {
    const { duToken, requirementId } = await setupApprovedRequirement('VRL2');
    const duRes = await generateLink(requirementId, duToken);
    expect(duRes.status).toBe(201);
    expect(duRes.body.data.token).toMatch(/^[0-9a-f]{64}$/);
    expect(duRes.body.data.status).toBe('pending');

    const setup2 = await setupApprovedRequirement('VRL2B');
    const hodRes = await generateLink(setup2.requirementId, setup2.hodToken);
    expect(hodRes.status).toBe(201);

    const setup3 = await setupApprovedRequirement('VRL2D');
    const saRes = await generateLink(setup3.requirementId, setup3.superAdminToken);
    expect(saRes.status).toBe(201);
  });

  it('is idempotent — a second generate call returns the same live link instead of erroring', async () => {
    const { duToken, requirementId } = await setupApprovedRequirement('VRL3');
    const first = await generateLink(requirementId, duToken);
    expect(first.status).toBe(201);

    const second = await generateLink(requirementId, duToken);
    expect(second.status).toBe(200);
    expect(second.body.data.token).toBe(first.body.data.token);
  });

  it('returns 404 when a non-owner Department User tries to generate a link for someone else\'s requirement', async () => {
    const { requirementId } = await setupApprovedRequirement('VRL4A');
    const strangerAdmin = await createTestUser({ email: 'vrl-stranger-admin@vms.local', role: ROLES.SUPER_ADMIN });
    const strangerDept = await createTestDepartment({ name: 'Stranger Dept', code: 'VRLST', createdBy: strangerAdmin.id });
    const stranger = await createTestUser({ email: 'vrl-stranger@vms.local', role: ROLES.DEPARTMENT_USER, department: strangerDept._id.toString() });
    const strangerToken = tokenFor(stranger);
    const res = await generateLink(requirementId, strangerToken);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/v1/public/vendor-registration/:token', () => {
  it('returns minimal safe info without any authentication', async () => {
    const { duToken, requirementId } = await setupApprovedRequirement('VRL5');
    const link = await generateLink(requirementId, duToken);
    const token = link.body.data.token as string;

    const res = await request(app).get(`/api/v1/public/vendor-registration/${token}`).send();
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('pending');
    expect(res.body.data.requirementNumber).toBeDefined();
    expect(res.body.data.departmentName).toBeDefined();
    // Never leaks anything sensitive
    expect(res.body.data.budget).toBeUndefined();
    expect(res.body.data.department).toBeUndefined();
  });

  it('returns 404 for an invalid/unknown token', async () => {
    const res = await request(app).get('/api/v1/public/vendor-registration/' + 'a'.repeat(64)).send();
    expect(res.status).toBe(404);
  });

  it('returns 410 once the link has already been verified', async () => {
    const { duToken, requirementId } = await setupApprovedRequirement('VRL6');
    const link = await generateLink(requirementId, duToken);
    const token = link.body.data.token as string;

    await submitPublic(token, vendorPayload());
    const verifyRes = await request(app)
      .post(`/api/v1/requirements/${requirementId}/vendor-registration-link/verify`)
      .set('Authorization', `Bearer ${duToken}`)
      .send();
    expect(verifyRes.status).toBe(200);

    const res = await request(app).get(`/api/v1/public/vendor-registration/${token}`).send();
    expect(res.status).toBe(410);
  });
});

describe('POST /api/v1/public/vendor-registration/:token', () => {
  it('stores the submission and marks the link submitted', async () => {
    const { duToken, requirementId } = await setupApprovedRequirement('VRL7');
    const link = await generateLink(requirementId, duToken);
    const token = link.body.data.token as string;

    const res = await submitPublic(token, vendorPayload());
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('submitted');

    const stored = await VendorRegistrationLink.findOne({ token });
    expect(stored!.status).toBe('submitted');
    expect(stored!.submittedData!.name).toBe('Link Winning Vendor');
    expect(stored!.submittedDocuments).toHaveLength(3);
  });

  it('rejects a duplicate GST/PAN/email with a clear 409 and does not create a pending record', async () => {
    const first = await setupApprovedRequirement('VRL8A');
    const firstLink = await generateLink(first.requirementId, first.duToken);
    await submitPublic(firstLink.body.data.token, vendorPayload({ email: 'dup-shared@vendor.example' }));
    await request(app)
      .post(`/api/v1/requirements/${first.requirementId}/vendor-registration-link/verify`)
      .set('Authorization', `Bearer ${first.duToken}`)
      .send();

    const second = await setupApprovedRequirement('VRL8B');
    const secondLink = await generateLink(second.requirementId, second.duToken);
    const token = secondLink.body.data.token as string;

    const res = await submitPublic(token, vendorPayload({ email: 'dup-shared@vendor.example', gstNumber: '', panNumber: '' }));
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already registered/i);

    const stored = await VendorRegistrationLink.findOne({ token });
    expect(stored!.status).toBe('pending');
    expect(stored!.submittedData).toBeUndefined();
  });

  it('rejects a second submission attempt on the same token', async () => {
    const { duToken, requirementId } = await setupApprovedRequirement('VRL9');
    const link = await generateLink(requirementId, duToken);
    const token = link.body.data.token as string;

    const first = await submitPublic(token, vendorPayload());
    expect(first.status).toBe(201);

    const second = await submitPublic(token, vendorPayload({ email: 'different@vendor.example' }));
    expect(second.status).toBe(410);
  });

  it('returns 404 for an invalid token', async () => {
    const res = await submitPublic('b'.repeat(64), vendorPayload());
    expect(res.status).toBe(404);
  });
});

describe('POST /api/v1/requirements/:id/vendor-registration-link/verify', () => {
  it('rejects verification when nothing has been submitted yet', async () => {
    const { duToken, requirementId } = await setupApprovedRequirement('VRL10');
    await generateLink(requirementId, duToken);

    const res = await request(app)
      .post(`/api/v1/requirements/${requirementId}/vendor-registration-link/verify`)
      .set('Authorization', `Bearer ${duToken}`)
      .send();
    expect(res.status).toBe(400);
  });

  it('verifies the submission, creates the Vendor, and advances the requirement to vendor_finalized', async () => {
    const { duToken, requirementId } = await setupApprovedRequirement('VRL11');
    const link = await generateLink(requirementId, duToken);
    const token = link.body.data.token as string;
    await submitPublic(token, vendorPayload());

    const res = await request(app)
      .post(`/api/v1/requirements/${requirementId}/vendor-registration-link/verify`)
      .set('Authorization', `Bearer ${duToken}`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.data.vendor.name).toBe('Link Winning Vendor');
    expect(res.body.data.vendor.code).toMatch(/VEN/);
    expect(res.body.data.vendor.registrationStatus).toBe('registered');
    expect(res.body.data.vendor.createdFromRequirement).toBe(requirementId);
    expect(res.body.data.requirement.status).toBe('vendor_finalized');

    const vendor = await Vendor.findOne({ createdFromRequirement: requirementId });
    expect(vendor).not.toBeNull();
    expect(vendor!.documents).toHaveLength(3);

    const storedLink = await VendorRegistrationLink.findOne({ requirement: requirementId }).sort({ createdAt: -1 });
    expect(storedLink!.status).toBe('verified');
    expect(storedLink!.verifiedBy).toBeDefined();
  });

  it('allows an HOD (department) to verify', async () => {
    const { duToken, hodToken, requirementId } = await setupApprovedRequirement('VRL12');
    const link = await generateLink(requirementId, duToken);
    await submitPublic(link.body.data.token, vendorPayload());

    const res = await request(app)
      .post(`/api/v1/requirements/${requirementId}/vendor-registration-link/verify`)
      .set('Authorization', `Bearer ${hodToken}`)
      .send();
    expect(res.status).toBe(200);
  });

  it('allows a Super Admin to verify', async () => {
    const { duToken, superAdminToken, requirementId } = await setupApprovedRequirement('VRL13');
    const link = await generateLink(requirementId, duToken);
    await submitPublic(link.body.data.token, vendorPayload());

    const res = await request(app)
      .post(`/api/v1/requirements/${requirementId}/vendor-registration-link/verify`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send();
    expect(res.status).toBe(200);
  });

  it('forbids a Director from verifying', async () => {
    const { duToken, directorToken, requirementId } = await setupApprovedRequirement('VRL14');
    const link = await generateLink(requirementId, duToken);
    await submitPublic(link.body.data.token, vendorPayload());

    const res = await request(app)
      .post(`/api/v1/requirements/${requirementId}/vendor-registration-link/verify`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send();
    expect(res.status).toBe(403);
  });

  it('returns 404 for a wrong-department HOD', async () => {
    const { duToken, requirementId } = await setupApprovedRequirement('VRL15A');
    const link = await generateLink(requirementId, duToken);
    await submitPublic(link.body.data.token, vendorPayload());

    const otherAdmin = await createTestUser({ email: 'vrl-otheradmin@vms.local', role: ROLES.SUPER_ADMIN });
    const otherDept = await createTestDepartment({ name: 'Other Dept VRL', code: 'VRLOD', createdBy: otherAdmin.id });
    const otherHod = await createTestUser({ email: 'vrl-otherhod@vms.local', role: ROLES.HOD, department: otherDept._id.toString() });
    const otherHodToken = tokenFor(otherHod);

    const res = await request(app)
      .post(`/api/v1/requirements/${requirementId}/vendor-registration-link/verify`)
      .set('Authorization', `Bearer ${otherHodToken}`)
      .send();
    expect(res.status).toBe(404);
  });
});

describe('GET /api/v1/requirements/:id/vendor-registration-link', () => {
  it('returns 404 before any link has been generated', async () => {
    const { duToken, requirementId } = await setupApprovedRequirement('VRL16');
    const res = await request(app)
      .get(`/api/v1/requirements/${requirementId}/vendor-registration-link`)
      .set('Authorization', `Bearer ${duToken}`)
      .send();
    expect(res.status).toBe(404);
  });

  it('reflects submitted status once the vendor submits', async () => {
    const { duToken, requirementId } = await setupApprovedRequirement('VRL17');
    const link = await generateLink(requirementId, duToken);
    await submitPublic(link.body.data.token, vendorPayload());

    const res = await request(app)
      .get(`/api/v1/requirements/${requirementId}/vendor-registration-link`)
      .set('Authorization', `Bearer ${duToken}`)
      .send();
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('submitted');
  });
});
