import request from 'supertest';

import { createApp } from '@/app';
import { ROLES } from '@/constants/roles';
import { createTestDepartment, createTestUser } from '@/test/factories';

const app = createApp();

async function loginAs(email: string, password = 'Password123!') {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  return res.body.data.accessToken as string;
}

const validVendorPayload = (name: string) => ({
  name,
  contactPerson: 'Contact Person',
  phone: '9876543210',
  email: `${name.toLowerCase().replace(/\s+/g, '')}@vendor.local`,
  address: '123 Vendor Street',
  state: 'Gujarat',
  district: 'Ahmedabad',
  city: 'Ahmedabad',
  pincode: '380001',
  bankDetails: {
    bankName: 'Test Bank',
    accountHolderName: name,
    accountNumber: '1234567890',
    ifscCode: 'TEST0123456',
  },
  category: 'Materials',
});

async function setupDepartmentWithHod(deptCode: string, hodEmail: string) {
  const admin = await createTestUser({ email: `admin-${deptCode}@vms.local`, role: ROLES.SUPER_ADMIN });
  const dept = await createTestDepartment({ name: `Dept ${deptCode}`, code: deptCode, createdBy: admin.id });
  const hod = await createTestUser({ email: hodEmail, role: ROLES.HOD, department: dept._id.toString() });
  dept.hod = hod._id as typeof dept.hod;
  await dept.save();
  return { admin, dept, hod };
}

describe('Department isolation — Vendors', () => {
  it('a vendor created by HOD-A is invisible to HOD-B', async () => {
    await setupDepartmentWithHod('ISA', 'isohodA@vms.local');
    await setupDepartmentWithHod('ISB', 'isohodB@vms.local');

    const tokenA = await loginAs('isohodA@vms.local');
    const tokenB = await loginAs('isohodB@vms.local');

    const createRes = await request(app)
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${tokenA}`)
      .send(validVendorPayload('Vendor A Only'));
    expect(createRes.status).toBe(201);
    const vendorId = createRes.body.data._id ?? createRes.body.data.id;

    const listAsA = await request(app).get('/api/v1/vendors').set('Authorization', `Bearer ${tokenA}`);
    const listAsB = await request(app).get('/api/v1/vendors').set('Authorization', `Bearer ${tokenB}`);

    expect(listAsA.body.data.some((v: { _id: string }) => v._id === vendorId)).toBe(true);
    expect(listAsB.body.data.some((v: { _id: string }) => v._id === vendorId)).toBe(false);

    const getAsB = await request(app).get(`/api/v1/vendors/${vendorId}`).set('Authorization', `Bearer ${tokenB}`);
    expect(getAsB.status).toBe(404);
  });

  it('Super Admin can see vendors across all departments', async () => {
    const { admin } = await setupDepartmentWithHod('ISC', 'isohodC@vms.local');
    const tokenHod = await loginAs('isohodC@vms.local');
    const tokenAdmin = await loginAs(`admin-ISC@vms.local`);
    void admin;

    await request(app)
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${tokenHod}`)
      .send(validVendorPayload('Vendor Visible To Admin'));

    const listAsAdmin = await request(app).get('/api/v1/vendors').set('Authorization', `Bearer ${tokenAdmin}`);
    expect(listAsAdmin.body.data.length).toBeGreaterThanOrEqual(1);
  });
});
