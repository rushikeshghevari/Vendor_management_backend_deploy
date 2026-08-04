import { ROLES } from '@/constants/roles';
import { REQUIREMENT_STATUS } from '@/constants/status';
import { Comparison, type IComparison } from '@/modules/comparison/comparison.model';
import { compare, type QuotationInput, type RequirementInput } from '@/modules/comparison/comparisonEngine';
import { Quotation, type IQuotation } from '@/modules/quotation/quotation.model';
import { Requirement, type IRequirement } from '@/modules/requirement/requirement.model';
import type { Actor } from '@/types/actor';
import { ApiError } from '@/utils/ApiError';

/** Same read-visibility rule as `requirementService`'s own `scopeToOwner` (duplicated here
 *  rather than imported — this codebase keeps each module's scoping filter local, e.g.
 *  `quotation.service.ts` has its own distinct copy too). Department User sees only their own
 *  requirement's comparison; HOD sees their department's; Director/Super Admin see any. */
function scopeToRequirement(actor: Actor, requirementId: string): Record<string, unknown> {
  const filter: Record<string, unknown> = { _id: requirementId, isDeleted: { $ne: true } };
  if (actor.role === ROLES.DEPARTMENT_USER) {
    filter.createdBy = actor.id;
  } else if (actor.role === ROLES.HOD) {
    filter.department = actor.department;
  }
  return filter;
}

function toRequirementInput(requirement: IRequirement): RequirementInput {
  return {
    budget: requirement.budget,
    items: requirement.items.map((item) => ({
      itemName: item.itemName,
      quantity: item.quantity,
      unit: item.unit,
      estimatedRate: item.estimatedRate,
      estimatedAmount: item.estimatedAmount,
    })),
  };
}

function toQuotationInput(quotation: IQuotation & { vendor?: { name?: string } }): QuotationInput {
  return {
    id: String(quotation._id),
    quotationCode: quotation.quotationCode,
    vendorName: quotation.temporaryVendor?.name ?? quotation.vendor?.name ?? 'Unknown Vendor',
    fileHashes: quotation.attachments.map((a) => a.fileHash),
    amount: quotation.amount,
    gst: quotation.gst,
    currency: quotation.currency,
    paymentTerms: quotation.paymentTerms,
    deliveryTerms: quotation.deliveryTerms,
    quotationDate: quotation.quotationDate.toISOString().slice(0, 10),
    ocrStatus: quotation.ocr?.status ?? 'not_started',
    ocrConfidence: quotation.ocr?.confidence,
    ocrStructuredData: quotation.ocr?.structuredData
      ? {
          vendorName: quotation.ocr.structuredData.vendorName,
          quotationDate: quotation.ocr.structuredData.quotationDate,
          currency: quotation.ocr.structuredData.currency,
          discount: quotation.ocr.structuredData.discount,
          grandTotal: quotation.ocr.structuredData.grandTotal,
          items: quotation.ocr.structuredData.items.map((item) => ({
            description: item.description,
            quantity: item.quantity,
            unit: item.unit,
            unitPrice: item.unitPrice,
            amount: item.amount,
          })),
        }
      : undefined,
  };
}

const GENERATE_ROLES: Array<(typeof ROLES)[keyof typeof ROLES]> = [ROLES.DEPARTMENT_USER, ROLES.HOD, ROLES.SUPER_ADMIN];

// AI Comparison becomes read-only once the Director has made a final decision (or the
// pipeline has moved past that point) — see docs/WORKFLOW_ENHANCEMENT_DIRECTOR_SUBMISSION.md.
// GET (getLatest, below) is unaffected — only regeneration is blocked.
const COMPARISON_LOCKED_STATUSES: string[] = [
  REQUIREMENT_STATUS.APPROVED,
  REQUIREMENT_STATUS.REJECTED,
  REQUIREMENT_STATUS.VENDOR_FINALIZED,
  REQUIREMENT_STATUS.CLOSED,
];

export const comparisonService = {
  /** Reads every non-deleted quotation attached to the requirement and the OCR structured
   *  data already stored on each (Phase 3) — never re-runs OCR, never writes back to
   *  `Quotation.ocr`. Always inserts a new Comparison row (never overwrites an earlier one),
   *  so "Generated time" always reflects exactly when that particular result was produced. */
  async generate(requirementId: string, actor: Actor): Promise<IComparison> {
    if (!GENERATE_ROLES.includes(actor.role)) {
      throw ApiError.forbidden('Only a Department User, HOD, or Super Admin can generate a comparison');
    }

    const requirement = await Requirement.findOne(scopeToRequirement(actor, requirementId));
    if (!requirement) throw ApiError.notFound('Requirement not found');

    if (COMPARISON_LOCKED_STATUSES.includes(requirement.status)) {
      throw ApiError.badRequest('AI Comparison is read-only once a decision has been made on this requirement');
    }

    const quotations = await Quotation.find({ requirement: requirementId, isDeleted: { $ne: true } })
      .populate('vendor', 'name');
    if (quotations.length === 0) {
      throw ApiError.badRequest('Add at least one quotation before generating a comparison');
    }

    const result = compare(
      toRequirementInput(requirement),
      quotations.map((q) => toQuotationInput(q as IQuotation & { vendor?: { name?: string } })),
    );

    return Comparison.create({
      requirement: requirementId,
      ...result,
      generatedAt: new Date(),
      generatedBy: actor.id,
    });
  },

  async getLatest(requirementId: string, actor: Actor): Promise<IComparison> {
    const requirement = await Requirement.findOne(scopeToRequirement(actor, requirementId)).select('_id');
    if (!requirement) throw ApiError.notFound('Requirement not found');

    const comparison = await Comparison.findOne({ requirement: requirementId }).sort({ generatedAt: -1 });
    if (!comparison) throw ApiError.notFound('No comparison has been generated yet for this requirement');
    return comparison;
  },
};
