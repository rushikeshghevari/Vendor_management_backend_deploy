// @ts-nocheck
import { connectDB, disconnectDB } from '@/config/db';
import { ROLES } from '@/constants/roles';
import { QUOTATION_STATUS, BILL_STATUS, PAYMENT_STATUS, PAYMENT_METHOD } from '@/constants/status';
import { Department } from '@/modules/department/department.model';
import { User } from '@/modules/user/user.model';
import { Vendor } from '@/modules/vendor/vendor.model';
import { Quotation } from '@/modules/quotation/quotation.model';
import { Bill } from '@/modules/bill/bill.model';
import { Payment } from '@/modules/payment/payment.model';
import { logger } from '@/utils/logger';

async function seedFull(): Promise<void> {
  await connectDB();

  logger.info('Clearing existing data (except Super Admin)...');
  await Department.deleteMany({});
  await User.deleteMany({ role: { $ne: ROLES.SUPER_ADMIN } });
  await Vendor.deleteMany({});
  await Quotation.deleteMany({});
  await Bill.deleteMany({});
  await Payment.deleteMany({});

  // 1. Get Super Admin to set as creator
  const superAdmin = await User.findOne({ role: ROLES.SUPER_ADMIN });
  if (!superAdmin) {
    throw new Error('Super Admin not found! Please run npm run seed first.');
  }

  // 2. Create IT Department
  logger.info('Creating Department...');
  const dept = await Department.create({
    name: 'Information Technology',
    code: 'IT',
    description: 'IT Systems and Infrastructure',
    isActive: true,
    createdBy: superAdmin._id,
  });

  // 3. Create Users
  logger.info('Creating Users...');
  const users = await User.create([
    {
      name: 'IT HOD',
      email: 'hod@gmail.com',
      password: '1',
      role: ROLES.HOD,
      department: dept._id,
      phone: '9876543210',
      isActive: true,
    },
    {
      name: 'IT Executive',
      email: 'deptuser@gmail.com',
      password: '1',
      role: ROLES.DEPARTMENT_USER,
      department: dept._id,
      phone: '9876543211',
      isActive: true,
    },
    {
      name: 'Finance Director',
      email: 'director@gmail.com',
      password: '1',
      role: ROLES.DIRECTOR,
      phone: '9876543212',
      isActive: true,
    },
    {
      name: 'Accounts Executive',
      email: 'accounts@gmail.com',
      password: '1',
      role: ROLES.ACCOUNTS,
      phone: '9876543213',
      isActive: true,
    },
    {
      name: 'Payment Agent',
      email: 'payment@gmail.com',
      password: '1',
      role: ROLES.PAYMENT_DEPARTMENT,
      phone: '9876543214',
      isActive: true,
    },
    {
      name: 'CEO Approver',
      email: 'ceo@gmail.com',
      password: '1',
      role: ROLES.CEO,
      phone: '9876543215',
      isActive: true,
    },
  ]);

  const hod = users[0];
  const deptUser = users[1];
  const director = users[2];
  const accountsUser = users[3];
  const paymentUser = users[4];

  // Assign HOD to Department
  dept.hod = hod._id;
  await dept.save();

  // 4. Create Vendors
  logger.info('Creating Vendors...');
  const vendorsList = await Vendor.create([
    {
      name: 'Acme Solutions Pvt Ltd',
      code: 'VND-ACME-01',
      department: dept._id,
      createdBy: deptUser._id,
      contactPerson: 'John Doe',
      phone: '8888888881',
      email: 'john@acme.com',
      gstNumber: '27AAAAA1111A1Z1',
      panNumber: 'AAAAA1111A',
      address: '123 Tech Lane',
      state: 'Maharashtra',
      district: 'Pune',
      city: 'Pune',
      pincode: '411001',
      category: 'Software Services',
      status: 'active',
      bankDetails: {
        bankName: 'HDFC Bank',
        accountHolderName: 'Acme Solutions',
        accountNumber: '12345678901',
        ifscCode: 'HDFC0000123',
      },
    },
    {
      name: 'Beta Cloud Networks',
      code: 'VND-BETA-02',
      department: dept._id,
      createdBy: deptUser._id,
      contactPerson: 'Jane Smith',
      phone: '8888888882',
      email: 'jane@beta.com',
      gstNumber: '27BBBBB2222B2Z2',
      panNumber: 'BBBBB2222B',
      address: '456 Cloud Tower',
      state: 'Maharashtra',
      district: 'Mumbai',
      city: 'Mumbai',
      pincode: '400001',
      category: 'Cloud Hosting',
      status: 'active',
      bankDetails: {
        bankName: 'ICICI Bank',
        accountHolderName: 'Beta Cloud',
        accountNumber: '98765432109',
        ifscCode: 'ICIC0000456',
      },
    },
    {
      name: 'Sigma Hardware Traders',
      code: 'VND-SIGMA-03',
      department: dept._id,
      createdBy: deptUser._id,
      contactPerson: 'Bob Wilson',
      phone: '8888888883',
      email: 'bob@sigma.com',
      gstNumber: '27CCCCC3333C3Z3',
      panNumber: 'CCCCC3333C',
      address: '789 Trade Plaza',
      state: 'Maharashtra',
      district: 'Nagpur',
      city: 'Nagpur',
      pincode: '440001',
      category: 'Hardware Supplies',
      status: 'blacklisted',
      bankDetails: {
        bankName: 'State Bank of India',
        accountHolderName: 'Sigma Hardware',
        accountNumber: '55555555555',
        ifscCode: 'SBIN0000789',
      },
    },
  ]);

  const activeVendor = vendorsList[0];
  const betaVendor = vendorsList[1];

  // 5. Create Quotations
  logger.info('Creating Quotations...');
  const quotationsList = await Quotation.create([
    {
      quotationCode: 'QT-2026-001',
      vendor: activeVendor._id,
      department: dept._id,
      createdBy: deptUser._id,
      quotationDate: new Date(),
      requiredDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      amount: 150000,
      gst: 18,
      currency: 'INR',
      paymentTerms: '30 Days Net',
      deliveryTerms: 'FOB Destination',
      priority: 'high',
      description: 'Annual ERP License Subscription',
      status: QUOTATION_STATUS.APPROVED,
      pdfFiles: [{ version: 1, fileName: 'quote_erp.pdf', url: 'https://example.com/quote1.pdf', uploadedAt: new Date() }],
    },
    {
      quotationCode: 'QT-2026-002',
      vendor: betaVendor._id,
      department: dept._id,
      createdBy: deptUser._id,
      quotationDate: new Date(),
      requiredDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
      amount: 45000,
      gst: 18,
      currency: 'INR',
      paymentTerms: 'Immediate',
      deliveryTerms: 'Online Delivery',
      priority: 'medium',
      description: 'AWS Server Hosting Setup',
      status: QUOTATION_STATUS.SUBMITTED,
      pdfFiles: [{ version: 1, fileName: 'quote_aws.pdf', url: 'https://example.com/quote2.pdf', uploadedAt: new Date() }],
    },
    {
      quotationCode: 'QT-2026-003',
      vendor: activeVendor._id,
      department: dept._id,
      createdBy: deptUser._id,
      quotationDate: new Date(),
      requiredDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
      amount: 85000,
      gst: 18,
      currency: 'INR',
      paymentTerms: '50% Advance',
      deliveryTerms: 'Door Delivery',
      priority: 'low',
      description: 'Office Laptop Purchase',
      status: QUOTATION_STATUS.DRAFT,
      pdfFiles: [],
    },
    {
      quotationCode: 'QT-2026-004',
      vendor: activeVendor._id,
      department: dept._id,
      createdBy: deptUser._id,
      quotationDate: new Date(),
      requiredDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      amount: 120000,
      gst: 18,
      currency: 'INR',
      paymentTerms: '30 Days Net',
      deliveryTerms: 'FOB Destination',
      priority: 'high',
      description: 'Database Support License',
      status: QUOTATION_STATUS.APPROVED,
      pdfFiles: [{ version: 1, fileName: 'quote_db.pdf', url: 'https://example.com/quote3.pdf', uploadedAt: new Date() }],
    },
    {
      quotationCode: 'QT-2026-005',
      vendor: activeVendor._id,
      department: dept._id,
      createdBy: deptUser._id,
      quotationDate: new Date(),
      requiredDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      amount: 60000,
      gst: 18,
      currency: 'INR',
      paymentTerms: '30 Days Net',
      deliveryTerms: 'FOB Destination',
      priority: 'medium',
      description: 'Office Security Audit',
      status: QUOTATION_STATUS.APPROVED,
      pdfFiles: [{ version: 1, fileName: 'quote_audit.pdf', url: 'https://example.com/quote4.pdf', uploadedAt: new Date() }],
    },
  ]);

  const approvedQuote1 = quotationsList[0];
  const submittedQuote = quotationsList[1];
  const approvedQuote2 = quotationsList[3];
  const approvedQuote3 = quotationsList[4];

  // 6. Create Bills
  logger.info('Creating Bills...');
  const billsList = await Bill.create([
    {
      billCode: 'BILL-2026-001',
      quotation: approvedQuote1._id,
      vendor: activeVendor._id,
      department: dept._id,
      createdBy: deptUser._id,
      uploadedByName: deptUser.name,
      uploadedByRole: deptUser.role,
      invoiceNumber: 'INV-ACME-991',
      invoiceDate: new Date(),
      invoiceAmount: 177000, // 150000 + 18% GST
      taxableAmount: 150000,
      gstAmount: 27000,
      paymentTerms: '30 Days Net',
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      status: BILL_STATUS.COMPLETED,
      invoiceFiles: [{ version: 1, fileName: 'invoice_completed.pdf', url: 'https://example.com/inv1.pdf', uploadedAt: new Date() }],
    },
    {
      billCode: 'BILL-2026-002',
      quotation: approvedQuote2._id,
      vendor: activeVendor._id,
      department: dept._id,
      createdBy: deptUser._id,
      uploadedByName: deptUser.name,
      uploadedByRole: deptUser.role,
      invoiceNumber: 'INV-ACME-992',
      invoiceDate: new Date(),
      invoiceAmount: 141600, // 120000 + 18% GST
      taxableAmount: 120000,
      gstAmount: 21600,
      paymentTerms: '30 Days Net',
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      status: BILL_STATUS.VERIFIED,
      invoiceFiles: [{ version: 1, fileName: 'invoice_verified.pdf', url: 'https://example.com/inv2.pdf', uploadedAt: new Date() }],
    },
    {
      billCode: 'BILL-2026-003',
      quotation: approvedQuote3._id,
      vendor: activeVendor._id,
      department: dept._id,
      createdBy: deptUser._id,
      uploadedByName: deptUser.name,
      uploadedByRole: deptUser.role,
      invoiceNumber: 'INV-ACME-993',
      invoiceDate: new Date(),
      invoiceAmount: 70800, // 60000 + 18% GST
      taxableAmount: 60000,
      gstAmount: 10800,
      paymentTerms: '30 Days Net',
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      status: BILL_STATUS.DIRECTOR_APPROVED,
      invoiceFiles: [{ version: 1, fileName: 'invoice_dir.pdf', url: 'https://example.com/inv3.pdf', uploadedAt: new Date() }],
    },
  ]);

  const completedBill = billsList[0];
  const verifiedBill = billsList[1];

  // 7. Create Payments
  logger.info('Creating Payments...');
  await Payment.create([
    {
      paymentCode: 'PAY-2026-001',
      bill: completedBill._id,
      quotation: approvedQuote1._id,
      vendor: activeVendor._id,
      department: dept._id,
      amount: 177000,
      gst: 27000,
      invoiceNumber: completedBill.invoiceNumber,
      invoiceDate: completedBill.invoiceDate,
      paymentMethod: PAYMENT_METHOD.BANK_TRANSFER,
      bankName: 'ICICI Bank',
      accountNumber: '98765432109',
      ifsc: 'ICIC0000456',
      utrNumber: 'UTR9988776655',
      paymentDate: new Date(),
      status: PAYMENT_STATUS.COMPLETED,
      createdBy: accountsUser._id,
      processedBy: paymentUser._id,
    },
    {
      paymentCode: 'PAY-2026-002',
      bill: verifiedBill._id,
      quotation: approvedQuote2._id,
      vendor: activeVendor._id,
      department: dept._id,
      amount: 141600,
      gst: 21600,
      invoiceNumber: verifiedBill.invoiceNumber,
      invoiceDate: verifiedBill.invoiceDate,
      status: PAYMENT_STATUS.PAYMENT_PENDING,
      createdBy: accountsUser._id,
    },
  ]);

  logger.info('Database seeded fully and successfully!');
  await disconnectDB();
}

seedFull()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('Full seeding failed', error);
    process.exit(1);
  });
