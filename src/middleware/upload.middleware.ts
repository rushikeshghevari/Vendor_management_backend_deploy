import path from 'node:path';

import multer from 'multer';

import { ApiError } from '@/utils/ApiError';

const UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'quotations');
const ATTACHMENT_MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg'] as const;

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, UPLOAD_DIR),
  filename: (_req, file, callback) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    callback(null, `${Date.now()}-${safeName}`);
  },
});

export const uploadQuotationPdf = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (file.mimetype !== 'application/pdf') {
      callback(ApiError.badRequest('Only PDF files are allowed'));
      return;
    }
    callback(null, true);
  },
}).single('file');

export const uploadQuotationAttachment = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (!ATTACHMENT_MIME_TYPES.includes(file.mimetype as (typeof ATTACHMENT_MIME_TYPES)[number])) {
      callback(ApiError.badRequest('Only PDF, PNG, and JPG files are allowed'));
      return;
    }
    callback(null, true);
  },
}).single('file');

// Phase 6 — Vendor Registration supporting documents (GST Certificate, PAN Card, Cancelled
// Cheque, MSME Certificate). A separate upload dir/instance from quotations, same
// disk-storage + mime-type-filter shape as `uploadQuotationAttachment` above.
const VENDOR_UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'vendors');

const vendorStorage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, VENDOR_UPLOAD_DIR),
  filename: (_req, file, callback) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    callback(null, `${Date.now()}-${safeName}`);
  },
});

export const uploadVendorDocuments = multer({
  storage: vendorStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (!ATTACHMENT_MIME_TYPES.includes(file.mimetype as (typeof ATTACHMENT_MIME_TYPES)[number])) {
      callback(ApiError.badRequest('Only PDF, PNG, and JPG files are allowed'));
      return;
    }
    callback(null, true);
  },
}).fields([
  { name: 'gstCertificate', maxCount: 1 },
  { name: 'panCard', maxCount: 1 },
  { name: 'cancelledCheque', maxCount: 1 },
  { name: 'msmeCertificate', maxCount: 1 },
]);
