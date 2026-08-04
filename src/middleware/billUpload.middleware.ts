import path from 'node:path';

import multer from 'multer';

import { ApiError } from '@/utils/ApiError';

const UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'bills');

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, UPLOAD_DIR),
  filename: (_req, file, callback) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    callback(null, `${Date.now()}-${safeName}`);
  },
});

const billUpload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (file.mimetype !== 'application/pdf') {
      callback(ApiError.badRequest('Only PDF files are allowed'));
      return;
    }
    callback(null, true);
  },
});

export const uploadBillInvoice = billUpload.single('file');
export const uploadBillSupportingDocument = billUpload.single('file');
