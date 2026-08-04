import type { Types } from 'mongoose';

import { ROLES, type Role } from '@/constants/roles';
import { PO_STATUS, QUOTATION_STATUS, PAYMENT_STATUS, REQUIREMENT_STATUS } from '@/constants/status';
import { Bill } from '@/modules/bill/bill.model';
import { DirectorReview } from '@/modules/directorReview/directorReview.model';
import { notificationService } from '@/modules/notification/notification.service';
import { PurchaseOrder, type IPurchaseOrder } from '@/modules/purchaseOrder/purchaseOrder.model';
import { Payment } from '@/modules/payment/payment.model';
import type { CreatePurchaseOrderInput, POListQuery } from '@/modules/purchaseOrder/purchaseOrder.validation';
import { Quotation } from '@/modules/quotation/quotation.model';
import { Requirement } from '@/modules/requirement/requirement.model';
import { Vendor } from '@/modules/vendor/vendor.model';
import { Department } from '@/modules/department/department.model';
import { User } from '@/modules/user/user.model';
import type { Actor } from '@/types/actor';
import { ApiError } from '@/utils/ApiError';
import { escapeRegex } from '@/utils/escapeRegex';
import { buildPaginationMeta, parsePagination } from '@/utils/pagination';
import { nextSequence } from '@/utils/sequence.model';
import { runAiVerification } from '@/services/ai/aiVerification.service';

interface VendorSnapshot {
  _id: Types.ObjectId;
  name: string;
  gstNumber?: string;
  address: string;
  state: string;
  city: string;
}

// ── Scope to role (read-only for non-Dept-Users) ─────────────────────────────
function scopeToRole(actor: Actor, filter: Record<string, unknown>): void {
  if (actor.role === ROLES.DEPARTMENT_USER) {
    filter.createdBy = actor.id;
  } else if (actor.role === ROLES.HOD) {
    filter.department = actor.department;
  }
  // Directors, CEO, Accounts, Payment — see all (read-only)
  // Super Admin — sees all
}

// ── Generate PO Number: PO-<DEPT_CODE>-2026-000001 ───────────────────────────
async function generatePoNumber(deptCode: string): Promise<string> {
  const year = new Date().getFullYear();
  const seq = await nextSequence(`po_${deptCode.toLowerCase()}`);
  return `PO-${deptCode.toUpperCase()}-${year}-${String(seq).padStart(6, '0')}`;
}

// ── Populate helper for list and detail responses ─────────────────────────────
const POPULATE_LIST = [
  { path: 'vendor',     select: 'name code' },
  { path: 'department', select: 'name code' },
  { path: 'createdBy',  select: 'name email' },
  { path: 'bill',       select: 'billCode status invoiceAmount' },
];

const POPULATE_DETAIL = [
  { path: 'quotation',  select: 'quotationCode amount gst currency paymentTerms deliveryTerms' },
  { path: 'vendor',     select: 'name code gstNumber address state city' },
  { path: 'department', select: 'name code' },
  { path: 'createdBy',  select: 'name email' },
  { path: 'bill',       select: 'billCode status invoiceAmount invoiceNumber invoiceDate invoiceFiles decisionHistory verifiedAt verifiedBy' },
  { path: 'goodsReceipt', select: 'grnNumber receivedDate overallCondition' },
];

const PO_CREATE_ROLES: Role[] = [ROLES.DEPARTMENT_USER, ROLES.HOD, ROLES.SUPER_ADMIN];

export const purchaseOrderService = {

  async create(input: CreatePurchaseOrderInput, actor: Actor): Promise<IPurchaseOrder> {
    if (!PO_CREATE_ROLES.includes(actor.role)) {
      throw ApiError.forbidden('Only a Department User or HOD can generate Purchase Orders');
    }

    let quotationId = input.quotationId;
    let requirementId: string | undefined;
    let requirementNumber: string | undefined;
    let resolvedVendor: VendorSnapshot | undefined;

    // Phase 7 — Requirement-originated path. Resolve down to the SAME winning Quotation the
    // registered Vendor was created from (Vendor.createdFromQuotation, set by
    // vendorRegistrationService.register() in Phase 6) rather than introducing a parallel
    // "no quotation" PO shape — this means every downstream read (getById's payment lookup,
    // the PDF's "Quotation Ref" line, the existing unique index on `quotation`) keeps working
    // completely unchanged for both paths.
    if (input.requirementId) {
      requirementId = input.requirementId;

      const requirement = await Requirement.findOne({ _id: requirementId, isDeleted: { $ne: true } }).lean();
      if (!requirement) throw ApiError.notFound('Requirement not found');
      if (requirement.status !== REQUIREMENT_STATUS.VENDOR_FINALIZED) {
        throw ApiError.badRequest('A Purchase Order can only be generated once a vendor has been registered for this Requirement');
      }

      // `requirement.finalizedVendor` is set for both a freshly-registered vendor AND a
      // reused one (vendorRegistrationService.linkExistingVendor) — prefer it, falling back to
      // the legacy createdFromRequirement lookup only for older data written before that field
      // existed. A reused vendor's own `createdFromRequirement` points at a DIFFERENT
      // requirement (whichever one originally created it), so it can't be used to find it here.
      const vendor = requirement.finalizedVendor
        ? await Vendor.findById(requirement.finalizedVendor).lean()
        : await Vendor.findOne({ createdFromRequirement: requirementId }).lean();
      if (!vendor) throw ApiError.badRequest('No registered vendor was found for this Requirement');

      // Always resolve THIS requirement's own winning quotation via its Director Review, not
      // `vendor.createdFromQuotation` — for a reused vendor that field points at the quotation
      // from whichever requirement originally registered it, not this one.
      const review = await DirectorReview.findOne({ requirement: requirementId, decision: 'approved' }).lean();
      if (!review?.selectedQuotation) throw ApiError.badRequest('No winning quotation found for this Requirement');

      quotationId = String(review.selectedQuotation);
      requirementNumber = requirement.requirementNumber;
      resolvedVendor = {
        _id: vendor._id,
        name: vendor.name,
        gstNumber: vendor.gstNumber,
        address: vendor.address,
        state: vendor.state,
        city: vendor.city,
      };
    }

    if (!quotationId) throw ApiError.badRequest('Provide either a quotationId or a requirementId');

    const quotation = await Quotation.findById(quotationId)
      .populate<{ vendor: VendorSnapshot }>('vendor')
      .lean();

    if (!quotation || quotation.isDeleted) throw ApiError.notFound('Quotation not found');

    // The legacy "must be Approved/Billed" gate only applies to the manual quotation-picking
    // path — a Requirement-linked quotation is never individually approved (Director Review
    // approves the Requirement as a whole, see directorReviewService.decide()); the
    // `Requirement.status === VENDOR_FINALIZED` check above is the equivalent signal there.
    if (!requirementId) {
      if (quotation.status !== QUOTATION_STATUS.APPROVED && quotation.status !== QUOTATION_STATUS.BILLED) {
        throw ApiError.badRequest('Purchase Order can only be generated for Approved Quotations');
      }
    }

    // Enforce one PO per quotation (transitively: one PO per Requirement too, since a
    // Requirement has exactly one registered Vendor with exactly one winning Quotation).
    const existing = await PurchaseOrder.findOne({ quotation: quotationId, isDeleted: false });
    if (existing) {
      throw ApiError.conflict(
        requirementId
          ? 'A Purchase Order has already been generated for this Requirement'
          : 'A Purchase Order already exists for this Quotation',
      );
    }

    // Fetch department for PO code
    const department = await Department.findById(actor.department ?? quotation.department).lean();
    if (!department) throw ApiError.notFound('Department not found');

    const deptCode = (department as { code?: string; name?: string }).code ?? 'DEPT';
    const poNumber = await generatePoNumber(deptCode);

    // Requirement-linked quotations use `temporaryVendor`, never a real `vendor` ref — so the
    // Phase 6 registered Vendor (resolved above) is the source of truth there; the legacy
    // path keeps reading the populated `quotation.vendor` exactly as before.
    const vendor = resolvedVendor ?? quotation.vendor;
    if (!vendor) throw ApiError.badRequest('This Quotation has no linked Vendor');

    // Compute totals
    const subtotal      = input.items.reduce((s, i) => s + (i.unitPrice * i.quantity - i.discount), 0);
    const totalGst      = input.items.reduce((s, i) => s + i.gstAmount, 0);
    const totalTax      = input.items.reduce((s, i) => s + i.taxAmount, 0);
    const totalDiscount = input.items.reduce((s, i) => s + i.discount, 0);
    const grandTotal    = subtotal + totalGst + totalTax;

    const po = await PurchaseOrder.create({
      poNumber,
      poDate: new Date(),
      quotation: quotationId,
      quotationCode: quotation.quotationCode,
      vendor: vendor._id,
      vendorName: vendor.name,
      vendorGst: vendor.gstNumber ?? 'N/A',
      vendorAddress: `${vendor.address}, ${vendor.city ?? ''}, ${vendor.state ?? ''}`.trim(),
      department: actor.department ?? quotation.department,
      departmentName: (department as { name: string }).name,
      createdBy: actor.id,
      items: input.items,
      subtotal,
      totalGst,
      totalTax,
      totalDiscount,
      grandTotal,
      terms: input.terms,
      notes: input.notes,
      status: PO_STATUS.GENERATED,
      requirement: requirementId,
      requirementNumber,
    });

    // Notify Super Admins, CEO, and Directors
    try {
      const [superAdmins, ceos, directors] = await Promise.all([
        notificationService.findActiveUsersByRole(ROLES.SUPER_ADMIN),
        notificationService.findActiveUsersByRole(ROLES.CEO),
        notificationService.findActiveUsersByRole(ROLES.DIRECTOR),
      ]);
      const recipients = [...superAdmins, ...ceos, ...directors];
      if (recipients.length > 0) {
        await notificationService.notifyUsers(recipients, {
          title: 'Purchase Order Generated',
          message: requirementId
            ? `PO ${poNumber} generated for Requirement ${requirementNumber} (Vendor ${vendor.name})`
            : `PO ${poNumber} generated against Quotation ${quotation.quotationCode}`,
          module: 'purchase_order',
          relatedRecord: String(po._id),
          notificationType: 'po_generated',
          // A PO can only ever be created once per Quotation (DB-unique-constrained), so
          // this event is genuinely one-shot forever — safe to dedupe strictly.
          dedupKey: `po_generated:${po._id}`,
        });
      }
    } catch { /* non-fatal */ }

    return po;
  },

  async list(query: POListQuery, actor: Actor): Promise<{ items: IPurchaseOrder[]; meta: ReturnType<typeof buildPaginationMeta> }> {
    const { page, limit, skip } = parsePagination(query);
    const filter: Record<string, unknown> = { isDeleted: false };

    scopeToRole(actor, filter);

    if (query.status) filter.status = query.status;
    if (query.vendorId) filter.vendor = query.vendorId;
    if (query.search) {
      const re = escapeRegex(query.search);
      filter.$or = [
        { poNumber: { $regex: re, $options: 'i' } },
        { quotationCode: { $regex: re, $options: 'i' } },
        { vendorName: { $regex: re, $options: 'i' } },
      ];
    }

    const total = await PurchaseOrder.countDocuments(filter);
    const items = await PurchaseOrder.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate(POPULATE_LIST)
      .lean();

    return { items: items as IPurchaseOrder[], meta: buildPaginationMeta(total, { page, limit, skip }) };
  },

  async getById(id: string, _actor: Actor): Promise<IPurchaseOrder> {
    const po = await PurchaseOrder.findOne({ _id: id, isDeleted: false })
      .populate(POPULATE_DETAIL)
      .lean();

    if (!po) throw ApiError.notFound('Purchase Order not found');

    const completedPayments = await Payment.find({
      quotation: po.quotation._id || po.quotation,
      status: { $in: [PAYMENT_STATUS.PAID, PAYMENT_STATUS.COMPLETED] }
    }).select('amount').lean();

    const paidAmount = completedPayments.reduce((sum, pay) => sum + pay.amount, 0);
    const poTotal = po.grandTotal;
    const outstandingBalance = poTotal - paidAmount;

    return {
      ...po,
      poTotal,
      paidAmount,
      outstandingBalance,
    } as any;
  },

  async getByQuotation(quotationId: string, _actor: Actor): Promise<IPurchaseOrder | null> {
    return PurchaseOrder.findOne({ quotation: quotationId, isDeleted: false })
      .populate(POPULATE_DETAIL)
      .lean() as Promise<IPurchaseOrder | null>;
  },

  /** Phase 7 — mirrors getByQuotation, used by the mobile app to check whether a PO already
   *  exists for a given Requirement before showing "Generate" vs "View" Purchase Order. */
  async getByRequirement(requirementId: string, _actor: Actor): Promise<IPurchaseOrder | null> {
    return PurchaseOrder.findOne({ requirement: requirementId, isDeleted: false })
      .populate(POPULATE_DETAIL)
      .lean() as Promise<IPurchaseOrder | null>;
  },

  /** Looks up the current email on file for a PO's Vendor — used by the "Email to Vendor"
   *  action so the recipient is always the vendor's live contact email, not a value snapshotted
   *  at PO-creation time. */
  async getVendorEmail(vendorId: Types.ObjectId | string): Promise<string | undefined> {
    const vendor = await Vendor.findById(vendorId).select('email').lean();
    return vendor?.email;
  },

  async triggerAiVerification(id: string, actor: Actor): Promise<IPurchaseOrder> {
    const po = await PurchaseOrder.findOne({ _id: id, isDeleted: false });
    if (!po) throw ApiError.notFound('Purchase Order not found');

    if (![ROLES.ACCOUNTS, ROLES.SUPER_ADMIN, ROLES.DIRECTOR].includes(actor.role as never)) {
      throw ApiError.forbidden('Only Accounts, Super Admin, or Director can trigger AI verification');
    }

    if (!po.bill) {
      throw ApiError.badRequest('No Bill is linked to this Purchase Order yet');
    }

    // Fetch the linked bill with vendor data
    const bill = await Bill.findById(po.bill)
      .populate<{ vendor: { name: string; gstNumber?: string } }>('vendor', 'name gstNumber')
      .lean();

    if (!bill) throw ApiError.notFound('Linked Bill not found');

    const billWithVendor = {
      ...bill,
      vendorName: (bill.vendor as unknown as { name: string })?.name ?? '',
      vendorGst: (bill.vendor as unknown as { gstNumber?: string })?.gstNumber ?? '',
    };

    // Update PO status to AI verification pending
    po.status = PO_STATUS.AI_VERIFICATION_PENDING;
    await po.save();

    // Run verification (async — can take a few seconds for Gemini)
    const aiResult = await runAiVerification({
      po,
      bill: billWithVendor as unknown as Parameters<typeof runAiVerification>[0]['bill'],
      actor,
    });

    // Store results on PO
    po.aiVerification = aiResult;
    po.status = PO_STATUS.AI_VERIFIED;
    await po.save();

    // Notify Accounts users
    try {
      const accountsUsers = await notificationService.findActiveUsersByRole(ROLES.ACCOUNTS);
      await notificationService.notifyUsers(accountsUsers, {
        title: 'AI Verification Complete',
        message: `PO ${po.poNumber}: ${aiResult.matchPercentage}% match — ${aiResult.recommendation}`,
        module: 'purchase_order',
        relatedRecord: String(po._id),
        notificationType: 'po_ai_verified',
      });
    } catch { /* non-fatal */ }

    return po.toObject() as IPurchaseOrder;
  },

  async getStats(actor: Actor): Promise<{
    generated: number;
    billUploaded: number;
    aiVerificationPending: number;
    aiVerified: number;
    accountsVerified: number;
    paymentPending: number;
    paid: number;
    closed: number;
    total: number;
  }> {
    const baseFilter: Record<string, unknown> = { isDeleted: false };
    scopeToRole(actor, baseFilter);

    const [
      generated, billUploaded, aiVerificationPending, aiVerified,
      accountsVerified, paymentPending, paid, closed, total,
    ] = await Promise.all([
      PurchaseOrder.countDocuments({ ...baseFilter, status: PO_STATUS.GENERATED }),
      PurchaseOrder.countDocuments({ ...baseFilter, status: PO_STATUS.BILL_UPLOADED }),
      PurchaseOrder.countDocuments({ ...baseFilter, status: PO_STATUS.AI_VERIFICATION_PENDING }),
      PurchaseOrder.countDocuments({ ...baseFilter, status: PO_STATUS.AI_VERIFIED }),
      PurchaseOrder.countDocuments({ ...baseFilter, status: PO_STATUS.ACCOUNTS_VERIFIED }),
      PurchaseOrder.countDocuments({ ...baseFilter, status: PO_STATUS.PAYMENT_PENDING }),
      PurchaseOrder.countDocuments({ ...baseFilter, status: PO_STATUS.PAID }),
      PurchaseOrder.countDocuments({ ...baseFilter, status: PO_STATUS.CLOSED }),
      PurchaseOrder.countDocuments(baseFilter),
    ]);

    return { generated, billUploaded, aiVerificationPending, aiVerified, accountsVerified, paymentPending, paid, closed, total };
  },
};
