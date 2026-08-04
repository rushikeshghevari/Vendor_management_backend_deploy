import { Types } from 'mongoose';
import { ROLES, type Role } from '@/constants/roles';
import { BILL_STATUS, QUOTATION_STATUS, PAYMENT_STATUS, type BillStatus } from '@/constants/status';
import { Bill, type IBill } from '@/modules/bill/bill.model';
import { Payment } from '@/modules/payment/payment.model';
import type {
  BillDecisionInput,
  BillFinancialDecisionInput,
  BillPaymentStatusInput,
  CreateBillInput,
  UpdateBillInput,
} from '@/modules/bill/bill.validation';
import { activityLogService } from '@/modules/activityLog/activityLog.service';
import { aiAuditLogService } from '@/modules/aiAuditLog/aiAuditLog.service';
import { AuditLog } from '@/modules/auditLog/auditLog.model';
import { Department } from '@/modules/department/department.model';
import { GoodsReceipt } from '@/modules/goodsReceipt/goodsReceipt.model';
import { notificationService } from '@/modules/notification/notification.service';
import { PurchaseOrder } from '@/modules/purchaseOrder/purchaseOrder.model';
import { Quotation } from '@/modules/quotation/quotation.model';
import { quotationService } from '@/modules/quotation/quotation.service';
import { User } from '@/modules/user/user.model';
import { runAiVerification } from '@/services/ai/aiVerification.service';
import type { Actor } from '@/types/actor';
import { ApiError } from '@/utils/ApiError';
import { escapeRegex } from '@/utils/escapeRegex';
import { buildPaginationMeta, parsePagination } from '@/utils/pagination';
import { nextSequence, seedSequenceFromExisting } from '@/utils/sequence.model';

// ── Status groups ──────────────────────────────────────────────────────────────

/** Statuses where a Department User may still edit / re-upload the bill. */
const EDITABLE_STATUSES: BillStatus[] = [
  BILL_STATUS.DRAFT,
  BILL_STATUS.DIRECTOR_CORRECTION,
  BILL_STATUS.CORRECTION_REQUESTED,
];

const PAYMENT_TRANSITIONS: Record<string, BillStatus> = {
  [BILL_STATUS.VERIFIED]:         BILL_STATUS.PAYMENT_PENDING,
  [BILL_STATUS.PAYMENT_PENDING]:  BILL_STATUS.PAID,
  [BILL_STATUS.PAID]:             BILL_STATUS.COMPLETED,
};

// ── Role-based visibility ──────────────────────────────────────────────────────

/**
 * Scopes the bill query to what each role should see:
 *  - Department User: only their own bills (all statuses).
 *  - Director: bills waiting for their Financial Approval (AI_VERIFIED) + any they already decided.
 *  - Accounts: bills the Director has approved — never the pre-approval stages.
 *  - Payment Department: bills ready for/in payment.
 *  - Super Admin: all bills (no filter).
 */
function scopeToOwner(actor: Actor, filter: Record<string, unknown>) {
  if (actor.role === ROLES.DEPARTMENT_USER) {
    filter.createdBy = actor.id;
  } else if (actor.role === ROLES.HOD) {
    filter.department = actor.department;
  } else if (actor.role === ROLES.DIRECTOR) {
    // Directors see bills in any financial-approval-relevant state, plus SUBMITTED/AI_FAILED
    // so a bill stuck mid-AI-pipeline is still reachable via the "Bill Stuck"/"AI Verification
    // Failed" notification deep-link and the Retry AI Verification recovery action. Also
    // includes post-approval statuses through COMPLETED so the "Approved"/"Completed" Director
    // dashboard tabs have something to show (see BillListScreen.tsx DIRECTOR_TAB_STATUSES).
    filter.status = {
      $in: [
        BILL_STATUS.SUBMITTED,
        BILL_STATUS.AI_FAILED,
        BILL_STATUS.AI_VERIFIED,
        BILL_STATUS.DIRECTOR_APPROVED,
        BILL_STATUS.DIRECTOR_REJECTED,
        BILL_STATUS.DIRECTOR_CORRECTION,
        BILL_STATUS.CORRECTION_REQUESTED,
        BILL_STATUS.VERIFIED,
        BILL_STATUS.PAYMENT_PENDING,
        BILL_STATUS.PAID,
        BILL_STATUS.COMPLETED,
      ],
    };
  } else if (actor.role === ROLES.ACCOUNTS) {
    // Accounts only sees bills after Director Financial Approval
    filter.status = {
      $nin: [
        BILL_STATUS.DRAFT,
        BILL_STATUS.SUBMITTED,
        BILL_STATUS.AI_VERIFIED,
        BILL_STATUS.DIRECTOR_REJECTED,
        BILL_STATUS.DIRECTOR_CORRECTION,
      ],
    };
  } else if (actor.role === ROLES.PAYMENT_DEPARTMENT) {
    filter.status = {
      $in: [BILL_STATUS.VERIFIED, BILL_STATUS.PAYMENT_PENDING, BILL_STATUS.PAID],
    };
  }
}

// ── Bill code generator ────────────────────────────────────────────────────────

async function generateBillCode(departmentId: string): Promise<string> {
  const department = await Department.findById(departmentId).select('code');
  if (!department) throw ApiError.badRequest('Department not found for this bill');

  const prefix = (department.code.match(/^[A-Za-z]+/)?.[0] ?? 'BILL').toUpperCase();
  const codePrefix = `${prefix}-BILL`;
  const counterKey = `bill:${codePrefix}`;

  await seedSequenceFromExisting(counterKey, async () => {
    const existingCodes = await Bill.find({ billCode: new RegExp(`^${codePrefix}\\d+$`) })
      .select('billCode')
      .lean();
    return existingCodes.reduce((max, item) => {
      const num = parseInt(item.billCode.slice(codePrefix.length), 10);
      return Number.isFinite(num) && num > max ? num : max;
    }, 0);
  });

  const sequence = await nextSequence(counterKey);
  return `${codePrefix}${String(sequence).padStart(3, '0')}`;
}

/** Write-scope filter for a mutation — Department User may only touch bills they personally
 *  created; an HOD may touch anything in their department. */
function ownershipFilter(actor: Actor): Record<string, unknown> {
  return actor.role === ROLES.HOD ? { department: actor.department } : { createdBy: actor.id };
}

const BILL_WRITE_ROLES: Role[] = [ROLES.DEPARTMENT_USER, ROLES.HOD];

async function getActorName(actorId: string): Promise<string> {
  const user = await User.findById(actorId).select('name').lean();
  return (user as { name?: string } | null)?.name ?? 'Unknown';
}

// ── Background AI pipeline ─────────────────────────────────────────────────────

/**
 * Runs the 3-way AI verification pipeline for a submitted bill.
 * Executed in the background — bill.submit() does NOT await this.
 *
 * Flow:
 *  1. Find the linked PO and Quotation.
 *  2. Run AI (OCR → Rule Engine → Gemini 3-way).
 *  3. Store results on the PO.
 *  4. Transition bill to AI_VERIFIED.
 *  5. Notify all Directors — "Bill Financial Approval Required".
 *  6. If AI risk is HIGH → send additional "High Risk Alert" notification.
 */
async function runAiPipelineForBill(bill: IBill, actor: Actor): Promise<void> {
  const billId = String(bill._id);

  try {
    // Atomic claim: if the automatic (submit()-triggered, fire-and-forget) run and a manual
    // "Retry AI Verification" call race for the same bill, only one actually runs the pipeline
    // and sends the completion notifications — the second exits immediately, silently.
    const claimed = await Bill.findOneAndUpdate(
      { _id: billId, aiPipelineRunning: { $ne: true } },
      { aiPipelineRunning: true },
    );
    if (!claimed) {
      console.log(`[Bill AI] Pipeline already running for bill ${billId} — skipping duplicate run`);
      return;
    }

    // Find linked PO — required at Bill creation time (see billService.create), so this
    // should never be missing for a new bill. Kept as a defensive check for legacy data.
    const po = await PurchaseOrder.findOne({ quotation: bill.quotation, isDeleted: false });
    if (!po) {
      console.error(`[Bill AI] No PO found for bill ${bill.billCode} — cannot run AI verification`);
      await Bill.findByIdAndUpdate(billId, {
        status: BILL_STATUS.AI_FAILED,
        aiPipelineRunning: false,
        aiFailureReason: 'No Purchase Order linked to this Bill\'s Quotation',
        $push: {
          history: {
            event: 'ai_failed', status: BILL_STATUS.AI_FAILED,
            remarks: 'No Purchase Order linked to this Bill\'s Quotation',
            actorId: actor.id, actorRole: actor.role, at: new Date(),
          },
        },
      });
      const superAdmins = await notificationService.findActiveUsersByRole(ROLES.SUPER_ADMIN);
      if (superAdmins.length > 0) {
        await notificationService.notifyUsers(superAdmins, {
          title: 'Bill Stuck — No Purchase Order Linked',
          message: `Bill ${bill.billCode} has no linked Purchase Order, so AI verification cannot run. Generate a matching PO, then use "Retry AI Verification".`,
          module: 'bill',
          relatedRecord: billId,
          notificationType: 'bill_ai_blocked',
          sender: actor.id,
        });
      }
      return;
    }

    // Find Quotation for 3-way comparison
    const quotation = await Quotation.findById(bill.quotation);

    // Populate vendor on the bill for the AI service
    const billWithVendor = await Bill.findById(billId)
      .populate<{ vendor: { name: string; gstNumber?: string } }>('vendor', 'name gstNumber')
      .lean();
    if (!billWithVendor) {
      await Bill.findByIdAndUpdate(billId, { aiPipelineRunning: false });
      return;
    }

    const enrichedBill = {
      ...billWithVendor,
      vendorName: (billWithVendor.vendor as unknown as { name: string })?.name ?? '',
      vendorGst:  (billWithVendor.vendor as unknown as { gstNumber?: string })?.gstNumber ?? '',
    };

    // Run AI (sets PO status to ai_verification_pending, then ai_verified)
    const { PO_STATUS } = await import('@/constants/status');
    po.status = PO_STATUS.AI_VERIFICATION_PENDING;
    await po.save();

    const aiResult = await runAiVerification({
      po,
      bill: enrichedBill as unknown as Parameters<typeof runAiVerification>[0]['bill'],
      quotation: quotation ?? undefined,
      actor,
    });

    // Store AI results on PO (canonical, full result)
    po.aiVerification = aiResult;
    po.status = PO_STATUS.AI_VERIFIED;
    po.bill = bill._id as unknown as typeof po.bill;
    await po.save();

    // Goes straight to DIRECTOR_APPROVED, skipping the AI_VERIFIED "awaiting Director Financial
    // Approval" wait state entirely — a Director already approved this vendor/quotation at the
    // Requirement stage (see directorReviewService.decide()), so a second Director gate here was
    // redundant. `decideFinancialApproval()` is left in place (unreachable in the normal flow
    // now, since no bill ever sits at AI_VERIFIED) rather than removed, in case a Super Admin
    // ever needs the manual override path back.
    await Bill.findByIdAndUpdate(billId, {
      status: BILL_STATUS.DIRECTOR_APPROVED,
      aiPipelineRunning: false,
      purchaseOrder: po._id,
      aiMatchPercentage: aiResult.matchPercentage,
      aiRisk: aiResult.risk,
      aiRecommendation: aiResult.recommendation,
      aiVerifiedAt: aiResult.verifiedAt,
      $unset: { aiFailureReason: 1 },
      $push: {
        history: {
          $each: [
            {
              event: 'ai_verified', status: BILL_STATUS.AI_VERIFIED,
              actorId: actor.id, actorRole: actor.role, at: aiResult.verifiedAt,
              meta: { matchPercentage: aiResult.matchPercentage, risk: aiResult.risk, recommendation: aiResult.recommendation, provider: aiResult.aiProvider },
            },
            {
              event: 'director_decision', status: BILL_STATUS.DIRECTOR_APPROVED,
              remarks: 'Auto-approved — Director Financial Approval is no longer a required step; sent straight to Accounts.',
              actorId: actor.id, actorRole: actor.role, at: aiResult.verifiedAt,
            },
          ],
        },
      },
    });

    // No `req` available here — this runs in the background, not inside a controller.
    activityLogService.record(
      {
        action: 'ai_completed', targetId: billId, targetType: 'Bill', department: bill.department.toString(),
        newValue: { matchPercentage: aiResult.matchPercentage, risk: aiResult.risk, recommendation: aiResult.recommendation },
      },
      actor,
    ).catch(() => null);

    // Directors/CEO get an FYI now, not an action request — the bill has already gone straight
    // to Accounts (see the DIRECTOR_APPROVED transition above).
    const [department, quotationDoc] = await Promise.all([
      Department.findById(bill.department).select('name').lean(),
      quotation ?? Quotation.findById(bill.quotation).select('quotationCode').lean(),
    ]);
    const directors = await notificationService.findActiveUsersByRole(ROLES.DIRECTOR);
    const ceos = await notificationService.findActiveUsersByRole(ROLES.CEO);
    if (directors.length + ceos.length > 0) {
      await notificationService.notifyUsers([...directors, ...ceos], {
        title: 'Bill Passed AI Verification',
        message: `Bill ${bill.billCode} has passed AI verification (${aiResult.matchPercentage}% match, Risk: ${aiResult.risk}) and was sent straight to Accounts. ` +
          `Vendor: ${enrichedBill.vendorName || '—'} | Quotation: ${(quotationDoc as { quotationCode?: string } | null)?.quotationCode ?? '—'} | ` +
          `Amount: ₹${bill.invoiceAmount.toLocaleString('en-IN')} | Department: ${(department as { name?: string } | null)?.name ?? '—'}`,
        module: 'bill',
        relatedRecord: billId,
        notificationType: 'bill_financial_approved',
        sender: actor.id,
      });
    }

    // Accounts's real trigger point now — previously only fired once a Director financially
    // approved (see decideFinancialApproval()'s isFullyApproved branch, same title/message/type
    // reused here for consistency).
    const accountsUsers = await notificationService.findActiveUsersByRole(ROLES.ACCOUNTS);
    if (accountsUsers.length > 0) {
      await notificationService.notifyUsers(accountsUsers, {
        title: 'Bill Ready for Verification',
        message: `Bill ${bill.billCode} has passed AI verification. Please verify.`,
        module: 'bill',
        relatedRecord: billId,
        notificationType: 'bill_financial_approved',
        sender: actor.id,
      });
    }

    // Extra HIGH-risk alert to Directors + CEO + Super Admins
    if (aiResult.risk === 'HIGH') {
      const superAdmins = await notificationService.findActiveUsersByRole(ROLES.SUPER_ADMIN);
      const alertRecipients = [...directors, ...ceos, ...superAdmins];
      if (alertRecipients.length > 0) {
        await notificationService.notifyUsers(alertRecipients, {
          title: 'High Risk Bill Alert',
          message: `Bill ${bill.billCode} flagged HIGH RISK by AI. Recommendation: ${aiResult.recommendation}. Immediate review required.`,
          module: 'bill',
          relatedRecord: billId,
          notificationType: 'ai_high_risk_alert',
          sender: actor.id,
        });
      }
    }

    // Notify bill owner of AI completion
    await notificationService.notifyUser(
      { id: bill.createdBy.toString(), role: ROLES.DEPARTMENT_USER },
      {
        title: 'Bill AI Verification Complete',
        message: `Bill ${bill.billCode} has been verified by AI (${aiResult.matchPercentage}% match) and sent to Accounts for verification.`,
        module: 'bill',
        relatedRecord: billId,
        notificationType: 'bill_ai_verified',
        sender: actor.id,
      },
    );
  } catch (err) {
    console.error(`[Bill AI] Pipeline failed for bill ${bill.billCode}:`, err);
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    try {
      // An AI outage (Gemini quota exhaustion, network error, etc.) must never block a bill
      // from reaching Accounts — AI verification is a helpful check, not a required gate. Same
      // forward-to-Accounts transition as the success path above, just without match/risk data,
      // and `aiFailureReason` stays set so Accounts/Super Admin can see AI didn't run and review
      // the invoice more carefully themselves.
      await Bill.findByIdAndUpdate(billId, {
        status: BILL_STATUS.DIRECTOR_APPROVED,
        aiPipelineRunning: false,
        aiFailureReason: message,
        $push: {
          history: {
            $each: [
              { event: 'ai_failed', status: BILL_STATUS.AI_FAILED, remarks: message, actorId: actor.id, actorRole: actor.role, at: new Date() },
              {
                event: 'director_decision', status: BILL_STATUS.DIRECTOR_APPROVED,
                remarks: 'AI verification unavailable — forwarded to Accounts without AI validation.',
                actorId: actor.id, actorRole: actor.role, at: new Date(),
              },
            ],
          },
        },
      });
      const [superAdmins, directors, ceos, accountsUsers] = await Promise.all([
        notificationService.findActiveUsersByRole(ROLES.SUPER_ADMIN),
        notificationService.findActiveUsersByRole(ROLES.DIRECTOR),
        notificationService.findActiveUsersByRole(ROLES.CEO),
        notificationService.findActiveUsersByRole(ROLES.ACCOUNTS),
      ]);
      const recipients = [...superAdmins, ...directors, ...ceos];
      if (recipients.length > 0) {
        await notificationService.notifyUsers(recipients, {
          title: 'AI Verification Unavailable',
          message: `Bill ${bill.billCode} could not be AI-verified (${message.slice(0, 200)}) — sent to Accounts without AI validation. Use "Retry AI Verification" to get AI data later.`,
          module: 'bill',
          relatedRecord: billId,
          notificationType: 'bill_ai_blocked',
          sender: actor.id,
        });
      }
      if (accountsUsers.length > 0) {
        await notificationService.notifyUsers(accountsUsers, {
          title: 'Bill Ready for Verification',
          message: `Bill ${bill.billCode} is ready for Accounts verification — AI verification was unavailable, so please review the invoice manually.`,
          module: 'bill',
          relatedRecord: billId,
          notificationType: 'bill_financial_approved',
          sender: actor.id,
        });
      }
    } catch { /* non-fatal */ }
  }
}

// ── billService ────────────────────────────────────────────────────────────────

export const billService = {
  /** A Bill can only be created from an Approved Quotation the creator owns; one Bill per Quotation. */
  async create(input: CreateBillInput, actor: Actor) {
    if (!BILL_WRITE_ROLES.includes(actor.role) || !actor.department) {
      throw ApiError.forbidden('Only a Department User or HOD can create a bill');
    }

    const quotation = await Quotation.findById(input.quotation);
    if (!quotation || quotation.isDeleted) throw ApiError.badRequest('Quotation not found');
    if (actor.role === ROLES.DEPARTMENT_USER && quotation.createdBy.toString() !== actor.id) {
      throw ApiError.forbidden('You can only create a bill for a quotation you created');
    }
    if (actor.role === ROLES.HOD && quotation.department.toString() !== actor.department) {
      throw ApiError.forbidden('You can only create a bill for a quotation in your department');
    }
    // The "must be Approved" gate only applies to the manual quotation-picking path — a
    // Requirement-linked quotation is never individually approved and stays at DRAFT forever
    // (Director Review approves the Requirement as a whole; see purchaseOrder.service.ts's
    // identical `if (!requirementId)` gate around its own Approved/Billed check). The PO's
    // existence (checked below) plus, for a Requirement-originated PO, the Phase 8 Goods
    // Receipt gate are the equivalent "ready for billing" signal there.
    if (!quotation.requirement && quotation.status !== QUOTATION_STATUS.APPROVED) {
      throw ApiError.badRequest('A bill can only be created for an Approved quotation');
    }

    // A Purchase Order is the legal commitment document and is required before a Bill can
    // exist — without it, the AI 3-way pipeline has nothing to compare against and the Bill
    // would be stuck at SUBMITTED forever (see runAiPipelineForBill's PO lookup below).
    const linkedPo = await PurchaseOrder.findOne({ quotation: quotation.id, isDeleted: false });
    if (!linkedPo) {
      throw ApiError.badRequest(
        'A Purchase Order must be generated for this Quotation before a Bill can be created.',
      );
    }

    // Phase 8 — Goods Receipt gates Bill creation, but only for Requirement-originated POs
    // (`linkedPo.requirement` set). A legacy quotation-only PO continues straight to Bill
    // exactly as it did before Phase 8 — see docs/PHASE8_GOODS_RECEIPT.md.
    // Phase 9 — while here, also carry the Requirement/Goods-Receipt lineage onto the new
    // Bill (pure denormalization for traceability; the receipt's existence is already
    // guaranteed by the gate below, nothing new to validate).
    let lineageFields: Partial<Pick<IBill, 'requirement' | 'requirementNumber' | 'goodsReceipt' | 'grnNumber'>> = {};
    if (linkedPo.requirement) {
      const receipt = await GoodsReceipt.findOne({ purchaseOrder: linkedPo._id, isDeleted: false });
      if (!receipt) {
        throw ApiError.badRequest(
          'Goods Receipt must be recorded for this Purchase Order before a Bill can be created.',
        );
      }
      lineageFields = {
        requirement: linkedPo.requirement,
        requirementNumber: linkedPo.requirementNumber,
        goodsReceipt: receipt._id as unknown as IBill['goodsReceipt'],
        grnNumber: receipt.grnNumber,
      };
    }

    const agg = await Bill.aggregate<{ total: number }>([
      { $match: { quotation: quotation._id, isDeleted: { $ne: true } } },
      { $group: { _id: null, total: { $sum: '$invoiceAmount' } } },
    ]);
    const alreadyBilled = agg[0]?.total ?? 0;
    const remaining = linkedPo.grandTotal - alreadyBilled;
    if (input.invoiceAmount > remaining) {
      throw ApiError.badRequest(
        `Bill amount (₹${input.invoiceAmount.toLocaleString('en-IN')}) exceeds remaining PO balance ` +
        `(₹${remaining.toLocaleString('en-IN')} of ₹${linkedPo.grandTotal.toLocaleString('en-IN')})`,
      );
    }

    const existingBill = await Bill.findOne({ quotation: quotation.id, isDeleted: { $ne: true } });
    if (existingBill) throw ApiError.conflict('Bill already created for this quotation.');

    // Invoice number must be unique per Vendor — prevents the same vendor invoice being billed
    // twice (accidentally or fraudulently) against two different quotations. DB-level partial
    // unique index on {vendor, invoiceNumber} (see bill.model.ts) backstops the race window.
    // Sourced from `linkedPo.vendor`, not `quotation.vendor` — a Requirement-linked quotation
    // never carries a `vendor` ref (it uses `temporaryVendor`; see purchaseOrder.service.ts's
    // identical resolvedVendor comment), while the PO always has the correctly resolved vendor
    // for both paths.
    const duplicateInvoice = await Bill.findOne({
      vendor: linkedPo.vendor,
      invoiceNumber: input.invoiceNumber,
      isDeleted: { $ne: true },
    });
    if (duplicateInvoice) {
      throw ApiError.conflict(
        `Invoice number "${input.invoiceNumber}" has already been billed for this vendor (Bill ${duplicateInvoice.billCode})`,
      );
    }

    const billCode = await generateBillCode(actor.department);
    const uploader = await User.findById(actor.id).select('name role').lean();

    const bill = await Bill.create({
      ...input,
      billCode,
      vendor: linkedPo.vendor,
      department: actor.department,
      createdBy: actor.id,
      purchaseOrder: linkedPo._id,
      ...lineageFields,
      uploadedByName: uploader?.name ?? 'Unknown',
      uploadedByRole: uploader?.role ?? actor.role,
      status: BILL_STATUS.DRAFT,
      history: [{
        event: 'created',
        status: BILL_STATUS.DRAFT,
        actorId: actor.id,
        actorName: uploader?.name ?? 'Unknown',
        actorRole: actor.role,
        at: new Date(),
      }],
    });

    // A Requirement-linked quotation stays at DRAFT for its whole lifecycle (see the Approved
    // gate above) — there is nothing to transition to BILLED for it, and attempting to would
    // throw a conflict (transitionStatus requires the *current* status to match) after the
    // Bill above has already been created. The Requirement's own status is the source of
    // truth for that pipeline instead.
    if (!quotation.requirement) {
      await quotationService.transitionStatus(quotation.id, [QUOTATION_STATUS.APPROVED], QUOTATION_STATUS.BILLED);
    }

    return bill;
  },

  async list(query: Record<string, unknown>, actor: Actor) {
    const pagination = parsePagination(query);
    const filter: Record<string, unknown> = { isDeleted: { $ne: true } };

    if (query.status) filter.status = query.status;
    if (query.department) filter.department = query.department;
    if (query.vendor) filter.vendor = query.vendor;
    if (query.quotation) filter.quotation = query.quotation;
    if (query.search) {
      filter.billCode = new RegExp(escapeRegex(String(query.search).trim()), 'i');
    }
    if (query.dateFrom || query.dateTo) {
      const invoiceDate: Record<string, Date> = {};
      if (query.dateFrom) invoiceDate.$gte = query.dateFrom as Date;
      if (query.dateTo) invoiceDate.$lte = query.dateTo as Date;
      filter.invoiceDate = invoiceDate;
    }

    scopeToOwner(actor, filter);

    const [items, total] = await Promise.all([
      Bill.find(filter)
        .populate('vendor', 'name code category status')
        .populate('department', 'name code')
        .populate('quotation', 'quotationCode status amount gst')
        .populate('purchaseOrder', 'poNumber grandTotal status')
        .populate('requirement', 'requirementNumber title')
        .populate('goodsReceipt', 'grnNumber receivedDate overallCondition')
        .populate('createdBy', 'name email')
        .populate('verifiedBy', 'name email')
        .populate('directorFinancialBy', 'name email')
        .sort({ createdAt: -1 })
        .skip(pagination.skip)
        .limit(pagination.limit),
      Bill.countDocuments(filter),
    ]);

    return { items, meta: buildPaginationMeta(total, pagination) };
  },

  async getById(id: string, actor: Actor) {
    const filter: Record<string, unknown> = { _id: id, isDeleted: { $ne: true } };
    scopeToOwner(actor, filter);

    const bill = await Bill.findOne(filter)
      .populate('vendor')
      .populate('department', 'name code')
      .populate('quotation')
      .populate('purchaseOrder', 'poNumber grandTotal status')
      .populate('requirement', 'requirementNumber title')
      .populate('goodsReceipt', 'grnNumber receivedDate overallCondition')
      .populate('createdBy', 'name email')
      .populate('verifiedBy', 'name email')
      .populate('directorFinancialBy', 'name email')
      .populate('decisionHistory.decidedBy', 'name email');

    if (!bill) throw ApiError.notFound('Bill not found');

    const completedPayments = await Payment.find({
      quotation: bill.quotation._id || bill.quotation,
      status: { $in: [PAYMENT_STATUS.PAID, PAYMENT_STATUS.COMPLETED] }
    }).select('amount').lean();

    const paidAmount = completedPayments.reduce((sum, pay) => sum + pay.amount, 0);
    const poTotal = (bill.purchaseOrder as any)?.grandTotal || 0;
    const outstandingBalance = poTotal ? (poTotal - paidAmount) : 0;

    // Fetch all active directors
    const activeDirectors = await User.find({ role: ROLES.DIRECTOR, isActive: true }).select('name isActive role createdAt').lean();
    const decidedByDirectorId = new Map(bill.directorApprovals.map((entry) => [entry.directorId.toString(), entry]));
    const roster = activeDirectors
      .filter((dir) => dir.isActive || decidedByDirectorId.has(String(dir._id)))
      .map((dir) => {
        const entry = decidedByDirectorId.get(String(dir._id));
        return {
          directorId: dir._id,
          directorName: dir.name,
          directorCreatedAt: dir.createdAt,
          decision: entry?.decision ?? 'pending',
          remarks: entry?.remarks,
          decidedAt: entry?.decidedAt ?? null,
        };
      });

    roster.sort((a, b) => {
      if (!a.decidedAt && !b.decidedAt) return 0;
      if (!a.decidedAt) return 1;
      if (!b.decidedAt) return -1;
      return new Date(b.decidedAt).getTime() - new Date(a.decidedAt).getTime();
    });

    return Object.assign(bill.toObject(), {
      poTotal,
      paidAmount,
      outstandingBalance,
      directorApprovals: roster,
    });
  },

  async update(id: string, input: UpdateBillInput, actor: Actor) {
    if (!BILL_WRITE_ROLES.includes(actor.role)) {
      throw ApiError.forbidden('Only a Department User or HOD can edit a bill');
    }

    const existing = await Bill.findOne({
      _id: id,
      ...ownershipFilter(actor),
      status: { $in: EDITABLE_STATUSES },
      isDeleted: { $ne: true },
    });
    if (!existing) throw ApiError.notFound('Bill not found, or it is no longer editable');

    // Re-validate against the PO balance if the amount is changing — create() only checks
    // this once at creation time; without this, editing a Draft/Correction bill's amount
    // upward could silently exceed the PO after the fact.
    if (input.invoiceAmount !== undefined && input.invoiceAmount !== existing.invoiceAmount) {
      const linkedPo = await PurchaseOrder.findOne({ quotation: existing.quotation, isDeleted: false });
      if (linkedPo) {
        const agg = await Bill.aggregate<{ total: number }>([
          { $match: { quotation: existing.quotation, isDeleted: { $ne: true }, _id: { $ne: existing._id } } },
          { $group: { _id: null, total: { $sum: '$invoiceAmount' } } },
        ]);
        const otherBilled = agg[0]?.total ?? 0;
        const remaining = linkedPo.grandTotal - otherBilled;
        if (input.invoiceAmount > remaining) {
          throw ApiError.badRequest(
            `Bill amount (₹${input.invoiceAmount.toLocaleString('en-IN')}) exceeds remaining PO balance ` +
            `(₹${remaining.toLocaleString('en-IN')} of ₹${linkedPo.grandTotal.toLocaleString('en-IN')})`,
          );
        }
      }
    }

    // Re-validate invoice-number-per-vendor uniqueness if it's changing.
    if (input.invoiceNumber !== undefined && input.invoiceNumber !== existing.invoiceNumber) {
      const duplicate = await Bill.findOne({
        _id: { $ne: existing._id },
        vendor: existing.vendor,
        invoiceNumber: input.invoiceNumber,
        isDeleted: { $ne: true },
      });
      if (duplicate) {
        throw ApiError.conflict(
          `Invoice number "${input.invoiceNumber}" has already been billed for this vendor (Bill ${duplicate.billCode})`,
        );
      }
    }

    const bill = await Bill.findByIdAndUpdate(
      existing._id,
      {
        ...input,
        $push: {
          history: {
            event: 'updated', actorId: actor.id, actorName: await getActorName(actor.id),
            actorRole: actor.role, at: new Date(),
          },
        },
      },
      { new: true, runValidators: true },
    );
    if (!bill) throw ApiError.notFound('Bill not found, or it is no longer editable');
    return bill;
  },

  /**
   * Department User submits a Draft (or Director-Correction) bill for AI verification.
   * Requires an invoice PDF to be uploaded first.
   *
   * The bill immediately enters SUBMITTED status and the AI pipeline fires in the background.
   * This endpoint returns fast — AI completes asynchronously and transitions to AI_VERIFIED.
   */
  async submit(id: string, actor: Actor) {
    if (!BILL_WRITE_ROLES.includes(actor.role)) {
      throw ApiError.forbidden('Only a Department User or HOD can submit a bill');
    }

    const bill = await Bill.findOne({
      _id: id,
      ...ownershipFilter(actor),
      status: BILL_STATUS.DRAFT,
      isDeleted: { $ne: true },
    });
    if (!bill) throw ApiError.notFound('Bill not found, or it is not in Draft status');
    if (bill.invoiceFiles.length === 0) {
      throw ApiError.badRequest('An invoice PDF must be uploaded before submitting this bill');
    }

    bill.status = BILL_STATUS.SUBMITTED;
    bill.submittedAt = new Date();
    bill.history.push({
      event: 'submitted', status: BILL_STATUS.SUBMITTED,
      actorId: actor.id as unknown as IBill['createdBy'], actorName: await getActorName(actor.id),
      actorRole: actor.role, at: bill.submittedAt,
    });
    await bill.save();

    // "Bill Uploaded" confirmation to the uploader — reuses `po_bill_uploaded`, a notification
    // type that already existed in the enum but was never dispatched anywhere (a good semantic
    // fit here, since a Bill can only exist against a PO in this workflow). Fired here (not
    // create()) since this is the moment the bill actually enters the workflow and AI starts.
    await notificationService.notifyUser(
      { id: bill.createdBy.toString(), role: ROLES.DEPARTMENT_USER },
      {
        title: 'Bill Uploaded',
        message: `Bill ${bill.billCode} has been submitted. AI verification is now running.`,
        module: 'bill',
        relatedRecord: String(bill._id),
        notificationType: 'po_bill_uploaded',
        sender: actor.id,
        // submit() is the draft→submitted transition only, reachable exactly once per
        // Bill (a corrected/returned bill goes through resubmit() instead) — safe to
        // dedupe strictly.
        dedupKey: `bill_uploaded:${bill._id}`,
      },
    ).catch(() => null);

    // Fire AI pipeline in background — does NOT block this response
    runAiPipelineForBill(bill, actor).catch((err) =>
      console.error('[Bill Submit] Background AI pipeline error:', err),
    );

    return bill;
  },

  /**
   * Re-submit from DIRECTOR_CORRECTION — same validation, restarts the full AI pipeline.
   * Re-submit from CORRECTION_REQUESTED (Accounts) — skips AI, goes directly back to Accounts.
   */
  async resubmit(id: string, actor: Actor) {
    if (!BILL_WRITE_ROLES.includes(actor.role)) {
      throw ApiError.forbidden('Only a Department User or HOD can resubmit a bill');
    }

    // From Director Correction → re-run AI pipeline
    const correctionBill = await Bill.findOne({
      _id: id,
      ...ownershipFilter(actor),
      status: BILL_STATUS.DIRECTOR_CORRECTION,
      isDeleted: { $ne: true },
    });

    if (correctionBill) {
      if (correctionBill.invoiceFiles.length === 0) {
        throw ApiError.badRequest('An invoice PDF must be uploaded before resubmitting');
      }
      correctionBill.status = BILL_STATUS.SUBMITTED;
      correctionBill.submittedAt = new Date();
      correctionBill.history.push({
        event: 'resubmitted', status: BILL_STATUS.SUBMITTED,
        actorId: actor.id as unknown as IBill['createdBy'], actorName: await getActorName(actor.id),
        actorRole: actor.role, at: correctionBill.submittedAt,
      });
      await correctionBill.save();

      runAiPipelineForBill(correctionBill, actor).catch((err) =>
        console.error('[Bill Resubmit] Background AI pipeline error:', err),
      );

      return correctionBill;
    }

    // From Accounts Correction → skip AI, go back to Director Approved (Accounts sees it again)
    const accountsCorrectionBill = await Bill.findOneAndUpdate(
      {
        _id: id,
        ...ownershipFilter(actor),
        status: BILL_STATUS.CORRECTION_REQUESTED,
        isDeleted: { $ne: true },
      },
      {
        status: BILL_STATUS.DIRECTOR_APPROVED,
        $push: {
          history: {
            event: 'resubmitted', status: BILL_STATUS.DIRECTOR_APPROVED,
            actorId: actor.id, actorName: await getActorName(actor.id), actorRole: actor.role, at: new Date(),
          },
        },
      },
      { new: true },
    );
    if (!accountsCorrectionBill) {
      throw ApiError.notFound('Bill not found or not in a resubmittable status');
    }

    // Notify Accounts that the bill is back for verification
    const accountsUsers = await notificationService.findActiveUsersByRole(ROLES.ACCOUNTS);
    await notificationService.notifyUsers(accountsUsers, {
      title: 'Bill Resubmitted for Verification',
      message: `Bill ${accountsCorrectionBill.billCode} has been resubmitted and is ready for Accounts verification.`,
      module: 'bill',
      relatedRecord: String(accountsCorrectionBill._id),
      notificationType: 'bill_submitted',
      sender: actor.id,
    });

    return accountsCorrectionBill;
  },

  /**
   * Director-only — Financial Approval (Approval 2).
   * Triggered after 3-Way AI verification. Decisions: approved, rejected, correction_required.
   * Only one Director needs to act (not a full roster like Quotation dual-Director approval).
   */
  async decideFinancialApproval(id: string, input: BillFinancialDecisionInput, actor: Actor) {
    if (actor.role !== ROLES.DIRECTOR) {
      throw ApiError.forbidden('Only a Director can make a financial approval decision on a bill');
    }

    const bill = await Bill.findOne({
      _id: id,
      status: BILL_STATUS.AI_VERIFIED,
      isDeleted: { $ne: true },
    });
    if (!bill) {
      throw ApiError.notFound('Bill not found, or it is not awaiting Director Financial Approval');
    }

    const now = new Date();
    const actorName = await getActorName(actor.id);

    // Update or push to directorApprovals
    const existingEntry = bill.directorApprovals.find((entry) => entry.directorId.toString() === actor.id);
    if (existingEntry) {
      existingEntry.decision = input.decision;
      existingEntry.remarks = input.remarks;
      existingEntry.decidedAt = now;
    } else {
      bill.directorApprovals.push({
        directorId: actor.id as unknown as Types.ObjectId,
        directorName: actorName,
        decision: input.decision,
        remarks: input.remarks,
        decidedAt: now,
      });
    }

    // Fetch all active directors
    const activeDirectors = await User.find({ role: ROLES.DIRECTOR, isActive: true }).select('name isActive role createdAt').lean();
    const decidedByDirectorId = new Map(bill.directorApprovals.map((entry) => [entry.directorId.toString(), entry]));
    const roster = activeDirectors
      .filter((dir) => dir.isActive || decidedByDirectorId.has(String(dir._id)))
      .map((dir) => {
        const entry = decidedByDirectorId.get(String(dir._id));
        return {
          directorId: dir._id,
          directorName: dir.name,
          directorCreatedAt: dir.createdAt,
          decision: entry?.decision ?? 'pending',
          remarks: entry?.remarks,
          decidedAt: entry?.decidedAt ?? null,
        };
      });

    const isBlockingDecision = input.decision === 'rejected' || input.decision === 'correction_required';
    const isFullyApproved = !isBlockingDecision && roster.every((r) => r.decision === 'approved');

    let newStatus: BillStatus = BILL_STATUS.AI_VERIFIED;
    if (isBlockingDecision) {
      newStatus = input.decision === 'rejected' ? BILL_STATUS.DIRECTOR_REJECTED : BILL_STATUS.DIRECTOR_CORRECTION;
    } else if (isFullyApproved) {
      newStatus = BILL_STATUS.DIRECTOR_APPROVED;
    }

    bill.directorFinancialDecision = input.decision;
    bill.directorFinancialBy       = actor.id as unknown as IBill['directorFinancialBy'];
    bill.directorFinancialAt       = now;
    bill.directorFinancialRemarks  = input.remarks;
    bill.status                    = newStatus;
    bill.decisionAt                = now;
    bill.history.push({
      event: 'director_decision',
      status: newStatus,
      remarks: input.remarks,
      actorId: actor.id as unknown as IBill['createdBy'],
      actorName,
      actorRole: actor.role,
      at: now,
    });

    await bill.save();

    const ownerId = bill.createdBy.toString();
    const relatedRecord = String(bill._id);

    if (isBlockingDecision) {
      if (input.decision === 'rejected') {
        await notificationService.notifyUser(
          { id: ownerId, role: ROLES.DEPARTMENT_USER },
          {
            title: 'Bill Financially Rejected',
            message: `Your bill ${bill.billCode} has been rejected by Director ${actorName}.${input.remarks ? ` Reason: ${input.remarks}` : ''}`,
            module: 'bill',
            relatedRecord,
            notificationType: 'bill_financial_rejected',
            sender: actor.id,
          },
        );
      } else {
        // correction_required
        await notificationService.notifyUser(
          { id: ownerId, role: ROLES.DEPARTMENT_USER },
          {
            title: 'Bill Correction Required',
            message: `Director ${actorName} has requested corrections on bill ${bill.billCode}.${input.remarks ? ` Remarks: ${input.remarks}` : ''} Please update and resubmit.`,
            module: 'bill',
            relatedRecord,
            notificationType: 'bill_director_correction_required',
            sender: actor.id,
          },
        );
      }
    } else if (input.decision === 'approved') {
      const pendingDirectors = roster.filter((r) => r.decision === 'pending');
      if (pendingDirectors.length > 0) {
        // Not fully approved yet
        const orderedRoster = [...roster].sort(
          (a, b) => new Date(a.directorCreatedAt).getTime() - new Date(b.directorCreatedAt).getTime(),
        );
        const approverIndex = orderedRoster.findIndex((entry) => String(entry.directorId) === actor.id) + 1;

        await notificationService.notifyUser(
          { id: ownerId, role: ROLES.DEPARTMENT_USER },
          {
            title: 'Bill Reviewed',
            message: `Director ${approverIndex} approved bill ${bill.billCode}. Waiting for remaining Director.`,
            module: 'bill',
            relatedRecord,
            notificationType: 'bill_financial_approved',
            sender: actor.id,
          },
        );

        await notificationService.notifyUsers(
          pendingDirectors.map((entry) => ({ id: String(entry.directorId), role: ROLES.DIRECTOR })),
          {
            title: 'Review Pending',
            message: `Director ${actorName} completed the review on bill ${bill.billCode}. Your review is still pending.`,
            module: 'bill',
            relatedRecord,
            notificationType: 'bill_financial_approved',
            sender: actor.id,
          },
        );
      } else {
        // Fully Approved! Notify Accounts and Department User
        const accountsUsers = await notificationService.findActiveUsersByRole(ROLES.ACCOUNTS);
        await notificationService.notifyUsers(accountsUsers, {
          title: 'Bill Ready for Verification',
          message: `Bill ${bill.billCode} has been financially approved by all Directors. Please verify.`,
          module: 'bill',
          relatedRecord,
          notificationType: 'bill_financial_approved',
          sender: actor.id,
        });

        await notificationService.notifyUser(
          { id: ownerId, role: ROLES.DEPARTMENT_USER },
          {
            title: 'Bill Financially Approved',
            message: `Your bill ${bill.billCode} has been approved by the Directors and sent to Accounts for verification.`,
            module: 'bill',
            relatedRecord,
            notificationType: 'bill_financial_approved',
            sender: actor.id,
          },
        );
      }
    }

    return bill;
  },

  /**
   * Accounts-only — 3-way verification decision.
   * Bill must be DIRECTOR_APPROVED before Accounts can act.
   * Every decision is recorded in `decisionHistory` for full audit trail.
   */
  async decide(id: string, input: BillDecisionInput, actor: Actor) {
    if (actor.role !== ROLES.ACCOUNTS) {
      throw ApiError.forbidden('Only Accounts can decide on a bill');
    }

    const now = new Date();
    const isVerified = input.decision === BILL_STATUS.VERIFIED;

    const bill = await Bill.findOneAndUpdate(
      { _id: id, status: BILL_STATUS.DIRECTOR_APPROVED, isDeleted: { $ne: true } },
      {
        status: input.decision,
        accountsRemarks: input.remarks,
        decisionAt: now,
        ...(isVerified ? { verifiedBy: actor.id, verifiedAt: now } : {}),
        $push: {
          decisionHistory: {
            decision: input.decision,
            remarks: input.remarks,
            decidedBy: actor.id,
            decidedAt: now,
          },
        },
      },
      { new: true },
    );
    if (!bill) {
      throw ApiError.notFound('Bill not found, or it is not awaiting Accounts verification');
    }

    // Write audit log
    const po = await PurchaseOrder.findOne({ quotation: bill.quotation, isDeleted: false });
    if (po) {
      const decidedByUser = await User.findById(actor.id).select('name').lean();
      await AuditLog.create({
        purchaseOrder:              po._id,
        bill:                       bill._id,
        quotation:                  bill.quotation,
        aiRecommendation:           po.aiVerification?.recommendation ?? 'MANUAL_REVIEW',
        aiConfidence:               po.aiVerification?.confidence     ?? 0,
        matchPercentage:            po.aiVerification?.matchPercentage ?? 0,
        quotationMatch:             po.aiVerification?.quotationMatch,
        purchaseOrderMatch:         po.aiVerification?.purchaseOrderMatch,
        risk:                       po.aiVerification?.risk            ?? 'HIGH',
        differenceCount:            po.aiVerification?.differences.length ?? 0,
        differences:                po.aiVerification?.differences     ?? [],
        directorFinancialDecision:  bill.directorFinancialDecision,
        directorFinancialBy:        bill.directorFinancialBy,
        directorFinancialRemarks:   bill.directorFinancialRemarks,
        directorFinancialAt:        bill.directorFinancialAt,
        accountsDecision:           input.decision,
        reason:                     input.remarks,
        decidedBy:                  actor.id,
        decidedByName:              (decidedByUser as { name?: string } | null)?.name ?? 'Accounts',
        decidedByRole:              actor.role,
        decidedAt:                  now,
      }).catch((err) => console.error('[Bill Decide] Audit log write failed:', err));
    }

    if (isVerified) {
      const paymentUsers = await notificationService.findActiveUsersByRole(ROLES.PAYMENT_DEPARTMENT);
      await notificationService.notifyUsers(paymentUsers, {
        title: 'Bill Verified — Ready for Payment',
        message: `Bill ${bill.billCode} has been verified by Accounts and is ready for payment.`,
        module: 'bill',
        relatedRecord: bill.id,
        notificationType: 'bill_verified',
        sender: actor.id,
      });
      await notificationService.notifyUser(
        { id: bill.createdBy.toString(), role: ROLES.DEPARTMENT_USER },
        {
          title: 'Bill Verified',
          message: `Bill ${bill.billCode} verified by Accounts. Sent to Payment Department.`,
          module: 'bill',
          relatedRecord: bill.id,
          notificationType: 'bill_verified',
          sender: actor.id,
        },
      );
    }

    return bill;
  },

  // ── Dashboard stats ──────────────────────────────────────────────────────────

  /** Accounts dashboard — only bills that cleared Director Financial Approval. */
  async getAccountsStats(actor: Actor) {
    if (actor.role !== ROLES.ACCOUNTS) {
      throw ApiError.forbidden('Only Accounts can view this dashboard');
    }

    const base = {
      isDeleted: { $ne: true },
      status: {
        $nin: [
          BILL_STATUS.DRAFT,
          BILL_STATUS.SUBMITTED,
          BILL_STATUS.AI_VERIFIED,
          BILL_STATUS.DIRECTOR_REJECTED,
          BILL_STATUS.DIRECTOR_CORRECTION,
        ],
      },
    };
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [pendingVerification, correctionRequested, verifiedToday, rejected, total, totalVerified] =
      await Promise.all([
        Bill.countDocuments({ ...base, status: BILL_STATUS.DIRECTOR_APPROVED }),
        Bill.countDocuments({ ...base, status: BILL_STATUS.CORRECTION_REQUESTED }),
        Bill.countDocuments({ ...base, status: BILL_STATUS.VERIFIED, verifiedAt: { $gte: today } }),
        Bill.countDocuments({ ...base, status: BILL_STATUS.REJECTED }),
        Bill.countDocuments(base),
        Bill.countDocuments({ ...base, verifiedBy: { $exists: true } }),
      ]);

    return { pendingVerification, correctionRequested, verifiedToday, rejected, total, totalVerified };
  },

  /** Payment Department dashboard. */
  async getPaymentStats(actor: Actor) {
    if (actor.role !== ROLES.PAYMENT_DEPARTMENT) {
      throw ApiError.forbidden('Only Payment Department can view this dashboard');
    }

    const base = { isDeleted: { $ne: true } };
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [readyForPayment, paymentPending, paidToday, completed] = await Promise.all([
      Bill.countDocuments({ ...base, status: BILL_STATUS.VERIFIED }),
      Bill.countDocuments({ ...base, status: BILL_STATUS.PAYMENT_PENDING }),
      Bill.countDocuments({ ...base, status: BILL_STATUS.PAID, updatedAt: { $gte: today } }),
      Bill.countDocuments({ ...base, status: BILL_STATUS.COMPLETED }),
    ]);

    return { readyForPayment, paymentPending, paidToday, completed };
  },

  /** Director dashboard — bills awaiting Financial Approval, plus today's decisions. */
  async getDirectorStats(actor: Actor) {
    if (actor.role !== ROLES.DIRECTOR) {
      throw ApiError.forbidden('Only a Director can view this dashboard');
    }

    const base = { isDeleted: { $ne: true } };
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [pendingFinancialApprovals, approvedToday, rejectedToday, correctionToday, highRiskBills, pendingAi, aiFailed] =
      await Promise.all([
        Bill.countDocuments({ ...base, status: BILL_STATUS.AI_VERIFIED }),
        Bill.countDocuments({ ...base, status: BILL_STATUS.DIRECTOR_APPROVED, directorFinancialAt: { $gte: today } }),
        Bill.countDocuments({ ...base, status: BILL_STATUS.DIRECTOR_REJECTED, directorFinancialAt: { $gte: today } }),
        Bill.countDocuments({ ...base, status: BILL_STATUS.DIRECTOR_CORRECTION, directorFinancialAt: { $gte: today } }),
        // High-risk AI-verified bills
        Bill.countDocuments({ ...base, status: BILL_STATUS.AI_VERIFIED }),
        // Powers the "Pending AI" Director Dashboard tab.
        Bill.countDocuments({ ...base, status: BILL_STATUS.SUBMITTED }),
        Bill.countDocuments({ ...base, status: BILL_STATUS.AI_FAILED }),
      ]);

    return { pendingFinancialApprovals, approvedToday, rejectedToday, correctionToday, highRiskBills, pendingAi, aiFailed };
  },

  /** Super Admin dashboard counters — org-wide. Replaces client-side `.length`/`.filter()`
   *  over the capped-at-100 `list()` result, which silently under-counted past 100 rows. */
  async getSuperAdminStats(actor: Actor) {
    if (actor.role !== ROLES.SUPER_ADMIN) {
      throw ApiError.forbidden('Only Super Admin can view this dashboard');
    }

    const base = { isDeleted: { $ne: true } };
    const [total, pending, verified] = await Promise.all([
      Bill.countDocuments(base),
      Bill.countDocuments({
        ...base,
        status: { $in: [BILL_STATUS.SUBMITTED, BILL_STATUS.AI_VERIFIED, BILL_STATUS.DIRECTOR_APPROVED] },
      }),
      Bill.countDocuments({
        ...base,
        status: { $in: [BILL_STATUS.VERIFIED, BILL_STATUS.PAYMENT_PENDING, BILL_STATUS.PAID, BILL_STATUS.COMPLETED] },
      }),
    ]);

    return { total, pending, verified };
  },

  /**
   * Payment Department — update bill payment status.
   * Requires bill.status === VERIFIED (i.e. Director approved + Accounts verified).
   */
  async updatePaymentStatus(
    id: string,
    input: BillPaymentStatusInput,
    actor: Actor,
    options: { suppressNotifications?: boolean } = {},
  ) {
    if (actor.role !== ROLES.PAYMENT_DEPARTMENT) {
      throw ApiError.forbidden('Only Payment Department can update a bill payment status');
    }

    const requiredCurrentStatus = (Object.entries(PAYMENT_TRANSITIONS) as [BillStatus, BillStatus][]).find(
      ([, next]) => next === input.status,
    )?.[0];
    if (!requiredCurrentStatus) throw ApiError.badRequest('Invalid payment status transition');

    const bill = await Bill.findOneAndUpdate(
      { _id: id, status: requiredCurrentStatus, isDeleted: { $ne: true } },
      {
        status: input.status,
        $push: {
          history: {
            event: 'payment_status_changed', status: input.status,
            actorId: actor.id, actorName: await getActorName(actor.id), actorRole: actor.role, at: new Date(),
          },
        },
      },
      { new: true },
    );
    if (!bill) {
      throw ApiError.conflict(`Bill cannot transition to "${input.status}" from its current status`);
    }

    if (!options.suppressNotifications) {
      const NOTIFICATION_TYPES: Partial<Record<BillStatus, 'payment_pending' | 'payment_paid' | 'payment_completed'>> = {
        [BILL_STATUS.PAYMENT_PENDING]: 'payment_pending',
        [BILL_STATUS.PAID]:            'payment_paid',
        [BILL_STATUS.COMPLETED]:       'payment_completed',
      };
      const NOTIFICATION_TITLES: Partial<Record<BillStatus, string>> = {
        [BILL_STATUS.PAYMENT_PENDING]: 'Payment Pending',
        [BILL_STATUS.PAID]:            'Payment Paid',
        [BILL_STATUS.COMPLETED]:       'Payment Completed',
      };
      const notificationType = NOTIFICATION_TYPES[input.status];
      if (notificationType) {
        await notificationService.notifyUser(
          { id: bill.createdBy.toString(), role: ROLES.DEPARTMENT_USER },
          {
            title: NOTIFICATION_TITLES[input.status]!,
            message: `Bill ${bill.billCode} payment status updated to "${NOTIFICATION_TITLES[input.status]}".`,
            module: 'bill',
            relatedRecord: bill.id,
            notificationType,
            sender: actor.id,
          },
        );
      }
    }

    return bill;
  },

  async uploadInvoice(id: string, fileName: string, url: string, actor: Actor) {
    const bill = await Bill.findOne({
      _id: id,
      ...ownershipFilter(actor),
      status: { $in: EDITABLE_STATUSES },
      isDeleted: { $ne: true },
    });
    if (!bill) throw ApiError.notFound('Bill not found, or it is no longer editable');

    const version = bill.invoiceFiles.length + 1;
    bill.invoiceFiles.push({ version, fileName, url, uploadedAt: new Date() });
    bill.history.push({
      event: 'invoice_uploaded', actorId: actor.id as unknown as IBill['createdBy'],
      actorName: await getActorName(actor.id), actorRole: actor.role, at: new Date(),
      meta: { version, fileName },
    });
    await bill.save();
    return bill;
  },

  async uploadSupportingDocument(id: string, fileName: string, url: string, actor: Actor) {
    const bill = await Bill.findOne({
      _id: id,
      ...ownershipFilter(actor),
      status: { $in: EDITABLE_STATUSES },
      isDeleted: { $ne: true },
    });
    if (!bill) throw ApiError.notFound('Bill not found, or it is no longer editable');

    const version = bill.supportingDocuments.length + 1;
    bill.supportingDocuments.push({ version, fileName, url, uploadedAt: new Date() });
    bill.history.push({
      event: 'supporting_document_uploaded', actorId: actor.id as unknown as IBill['createdBy'],
      actorName: await getActorName(actor.id), actorRole: actor.role, at: new Date(),
      meta: { version, fileName },
    });
    await bill.save();
    return bill;
  },

  /**
   * Director / Super Admin — recovery path for a Bill stuck at SUBMITTED (legacy: no PO was
   * linked when the pipeline ran) or AI_FAILED (the pipeline threw). Once the underlying issue
   * is resolved, this re-runs the same pipeline synchronously (unlike submit(), which fires it
   * in the background) so the caller sees the result immediately.
   */
  async retryAiVerification(id: string, actor: Actor) {
    if (actor.role !== ROLES.DIRECTOR && actor.role !== ROLES.SUPER_ADMIN) {
      throw ApiError.forbidden('Only a Director or Super Admin can retry AI verification');
    }

    const bill = await Bill.findOne({
      _id: id,
      status: { $in: [BILL_STATUS.SUBMITTED, BILL_STATUS.AI_FAILED] },
      isDeleted: { $ne: true },
    });
    if (!bill) {
      throw ApiError.notFound('Bill not found, or it is not in a retryable state (Submitted or AI Failed)');
    }

    const po = await PurchaseOrder.findOne({ quotation: bill.quotation, isDeleted: false });
    if (!po) {
      throw ApiError.badRequest('No Purchase Order exists for this Bill\'s Quotation yet — generate one first');
    }

    bill.history.push({
      event: 'retry_ai_verification',
      actorId: actor.id as unknown as IBill['createdBy'], actorName: await getActorName(actor.id),
      actorRole: actor.role, at: new Date(),
    });
    await bill.save();

    await runAiPipelineForBill(bill, actor);

    const refreshed = await Bill.findById(id);
    return refreshed;
  },

  /**
   * Complete Bill Timeline API — merges three sources into one chronologically-sorted feed:
   *  - `bill.history[]` — status changes, submits, AI runs (success/failure), retries, director
   *    decisions (every revision, not just the latest), uploads, edits.
   *  - `bill.decisionHistory[]` — Accounts' full decision history (already its own audit trail).
   *  - `AiAuditLog` — one row per AI run with prompt/token/timing metadata not kept on the Bill.
   * Visibility mirrors getById() — same role-scoped filter, so nobody sees a bill's history
   * they couldn't see the bill itself.
   */
  async getTimeline(id: string, actor: Actor) {
    const filter: Record<string, unknown> = { _id: id, isDeleted: { $ne: true } };
    scopeToOwner(actor, filter);

    const bill = await Bill.findOne(filter)
      .populate('history.actorId', 'name email')
      .populate('decisionHistory.decidedBy', 'name email');
    if (!bill) throw ApiError.notFound('Bill not found');

    const auditLogs = await aiAuditLogService.listByBill(id);

    interface TimelineItem {
      type: 'bill_event' | 'accounts_decision' | 'ai_run';
      event: string;
      status?: string;
      remarks?: string;
      actorName?: string;
      actorRole?: string;
      at: Date;
      meta?: Record<string, unknown>;
    }

    const items: TimelineItem[] = [];

    for (const entry of bill.history) {
      const actorRef = entry.actorId as unknown as { name?: string } | undefined;
      items.push({
        type: 'bill_event',
        event: entry.event,
        status: entry.status,
        remarks: entry.remarks,
        actorName: entry.actorName ?? actorRef?.name,
        actorRole: entry.actorRole,
        at: entry.at,
        meta: entry.meta,
      });
    }

    for (const entry of bill.decisionHistory) {
      const decidedBy = entry.decidedBy as unknown as { name?: string } | undefined;
      items.push({
        type: 'accounts_decision',
        event: 'accounts_decision',
        status: entry.decision,
        remarks: entry.remarks,
        actorName: decidedBy?.name,
        actorRole: 'accounts',
        at: entry.decidedAt,
      });
    }

    for (const log of auditLogs) {
      const triggeredBy = log.triggeredBy as unknown as { name?: string } | undefined;
      items.push({
        type: 'ai_run',
        event: 'ai_run',
        remarks: log.success ? undefined : log.errorMessage,
        actorName: triggeredBy?.name,
        actorRole: log.triggeredByRole,
        at: (log as unknown as { createdAt: Date }).createdAt,
        meta: {
          matchPercentage: log.matchPercentage,
          risk: log.risk,
          recommendation: log.recommendation,
          executionTimeMs: log.executionTimeMs,
          totalTokens: log.totalTokens,
          modelVersion: log.modelVersion,
          success: log.success,
          usedFallback: log.usedFallback,
        },
      });
    }

    items.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

    return { billId: id, billCode: bill.billCode, events: items };
  },

  async remove(id: string, actor: Actor) {
    const bill = await Bill.findOneAndUpdate(
      { _id: id, ...ownershipFilter(actor), status: BILL_STATUS.DRAFT, isDeleted: { $ne: true } },
      { isDeleted: true },
      { new: true },
    );
    if (!bill) throw ApiError.notFound('Bill not found, or only a Draft bill can be deleted');

    await quotationService.transitionStatus(
      bill.quotation.toString(),
      [QUOTATION_STATUS.BILLED],
      QUOTATION_STATUS.APPROVED,
    );

    return bill;
  },
};
