export const PO_STATUS = {
  GENERATED: 'generated',
  BILL_UPLOADED: 'bill_uploaded',
  AI_VERIFICATION_PENDING: 'ai_verification_pending',
  AI_VERIFIED: 'ai_verified',
  ACCOUNTS_VERIFIED: 'accounts_verified',
  PAYMENT_PENDING: 'payment_pending',
  PAID: 'paid',
  CLOSED: 'closed',
} as const;
export type PurchaseOrderStatus = (typeof PO_STATUS)[keyof typeof PO_STATUS];

export const AI_RISK = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
} as const;
export type AiRisk = (typeof AI_RISK)[keyof typeof AI_RISK];

export const AI_RECOMMENDATION = {
  APPROVE: 'APPROVE',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  REJECT: 'REJECT',
} as const;
export type AiRecommendation = (typeof AI_RECOMMENDATION)[keyof typeof AI_RECOMMENDATION];

export const QUOTATION_STATUS = {
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  NEGOTIATION: 'negotiation',
  RESUBMITTED: 'resubmitted',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  BILLED: 'billed',
} as const;
export type QuotationStatus = (typeof QUOTATION_STATUS)[keyof typeof QUOTATION_STATUS];

export const NEGOTIATION_STATUS = {
  PENDING: 'pending',
  COUNTERED: 'countered',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
} as const;
export type NegotiationStatus = (typeof NEGOTIATION_STATUS)[keyof typeof NEGOTIATION_STATUS];

export const APPROVAL_DECISION = {
  APPROVED: 'approved',
  REJECTED: 'rejected',
} as const;
export type ApprovalDecision = (typeof APPROVAL_DECISION)[keyof typeof APPROVAL_DECISION];

export const BILL_STATUS = {
  DRAFT: 'draft',
  // Department User submitted — AI verification pipeline running in background.
  SUBMITTED: 'submitted',
  // AI pipeline threw (or found no linked PO) — never silently stays at SUBMITTED forever.
  // Director / Super Admin can retry via PATCH /bills/:id/retry-ai-verification.
  AI_FAILED: 'ai_failed',
  // 3-Way AI (Quotation + PO + Bill) complete — waiting for Director Financial Approval.
  AI_VERIFIED: 'ai_verified',
  // Director approved the bill financially — goes to Accounts for verification.
  DIRECTOR_APPROVED: 'director_approved',
  // Director rejected — terminal; never reaches Accounts.
  DIRECTOR_REJECTED: 'director_rejected',
  // Director requested correction — bill returns to Department User for amendment.
  DIRECTOR_CORRECTION: 'director_correction',
  // Accounts verified — goes to Payment Department.
  VERIFIED: 'verified',
  // Accounts requested correction — bill returns to Department User.
  CORRECTION_REQUESTED: 'correction_requested',
  // Accounts rejected — terminal.
  REJECTED: 'rejected',
  PAYMENT_PENDING: 'payment_pending',
  PAID: 'paid',
  COMPLETED: 'completed',
} as const;
export type BillStatus = (typeof BILL_STATUS)[keyof typeof BILL_STATUS];

export const PAYMENT_STATUS = {
  PAYMENT_PENDING: 'payment_pending',
  PROCESSING: 'processing',
  PAID: 'paid',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;
export type PaymentStatus = (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS];

export const PAYMENT_METHOD = {
  BANK_TRANSFER: 'bank_transfer',
  CHEQUE: 'cheque',
  UPI: 'upi',
  RTGS: 'rtgs',
  NEFT: 'neft',
  IMPS: 'imps',
  CASH: 'cash',
} as const;
export type PaymentMethod = (typeof PAYMENT_METHOD)[keyof typeof PAYMENT_METHOD];

export const PAYMENT_FAILURE_REASON = {
  BANK_TIMEOUT: 'bank_timeout',
  UPI_FAILED: 'upi_failed',
  CHEQUE_REJECTED: 'cheque_rejected',
  INSUFFICIENT_BALANCE: 'insufficient_balance',
  ACCOUNT_CLOSED: 'account_closed',
  INVALID_IFSC: 'invalid_ifsc',
  NETWORK_FAILURE: 'network_failure',
  MANUAL_HOLD: 'manual_hold',
  OTHER: 'other',
} as const;
export type PaymentFailureReason = (typeof PAYMENT_FAILURE_REASON)[keyof typeof PAYMENT_FAILURE_REASON];

// Enterprise Procurement Workflow, Phase 1 — see docs/PHASE1_REQUIREMENT_MODULE.md.
// Only DRAFT and SUBMITTED are reachable in Phase 1; the rest are declared now so the
// schema enum doesn't need a migration when later phases wire them in.
export const REQUIREMENT_STATUS = {
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  QUOTATION_COLLECTION: 'quotation_collection',
  QUOTATION_COMPARISON: 'quotation_comparison',
  DIRECTOR_REVIEW: 'director_review',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  VENDOR_FINALIZED: 'vendor_finalized',
  CLOSED: 'closed',
} as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUS)[keyof typeof REQUIREMENT_STATUS];

export const REQUIREMENT_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type RequirementPriority = (typeof REQUIREMENT_PRIORITIES)[number];

export const REQUIREMENT_APPROVAL_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
} as const;
export type RequirementApprovalStatus = (typeof REQUIREMENT_APPROVAL_STATUS)[keyof typeof REQUIREMENT_APPROVAL_STATUS];

// Phase 8 — Goods Receipt & Inspection. Recorded once per Purchase Order; a Requirement-
// originated PO cannot proceed to Bill until its Goods Receipt exists (see bill.service.ts's
// create()). A legacy quotation-only PO is unaffected — see docs/PHASE8_GOODS_RECEIPT.md.
export const GRN_ITEM_CONDITION = {
  GOOD: 'good',
  DAMAGED: 'damaged',
  SHORT_SUPPLY: 'short_supply',
} as const;
export type GrnItemCondition = (typeof GRN_ITEM_CONDITION)[keyof typeof GRN_ITEM_CONDITION];

export const GRN_OVERALL_CONDITION = {
  GOOD: 'good',
  DAMAGED: 'damaged',
  PARTIAL: 'partial',
} as const;
export type GrnOverallCondition = (typeof GRN_OVERALL_CONDITION)[keyof typeof GRN_OVERALL_CONDITION];

/** Quotation attachment OCR pipeline — see `src/services/ocr/quotationOcr.service.ts`. */
export const OCR_STATUS = {
  NOT_STARTED: 'not_started',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;
export type OcrStatus = (typeof OCR_STATUS)[keyof typeof OCR_STATUS];
