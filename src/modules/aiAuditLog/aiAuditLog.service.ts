import { ROLES } from '@/constants/roles';
import { AiAuditLog, type IAiAuditLog } from '@/modules/aiAuditLog/aiAuditLog.model';
import type { Actor } from '@/types/actor';
import { ApiError } from '@/utils/ApiError';
import { buildPaginationMeta, parsePagination } from '@/utils/pagination';
import type { AiRisk, AiRecommendation } from '@/constants/status';
import { GEMINI_MODEL, GEMINI_PROMPT_VERSION } from '@/config/gemini';

export interface CreateAiAuditLogInput {
  purchaseOrderId: string;
  billId: string;
  triggeredBy: string;
  triggeredByRole: string;
  promptSnapshot?: string;
  rawResponse?: string;
  executionTimeMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  matchPercentage: number;
  risk: AiRisk;
  recommendation: AiRecommendation;
  confidence: number;
  differenceCount: number;
  modelVersion?: string;
  promptVersion?: string;
  success: boolean;
  errorMessage?: string;
  usedFallback: boolean;
}

export const aiAuditLogService = {

  async create(input: CreateAiAuditLogInput): Promise<IAiAuditLog> {
    return AiAuditLog.create({
      purchaseOrder:   input.purchaseOrderId,
      bill:            input.billId,
      triggeredBy:     input.triggeredBy,
      triggeredByRole: input.triggeredByRole,
      promptSnapshot:  (input.promptSnapshot ?? '').slice(0, 8000),
      rawResponse:     (input.rawResponse ?? '').slice(0, 5000),
      executionTimeMs: input.executionTimeMs,
      inputTokens:     input.inputTokens,
      outputTokens:    input.outputTokens,
      totalTokens:     input.totalTokens,
      matchPercentage: input.matchPercentage,
      risk:            input.risk,
      recommendation:  input.recommendation,
      confidence:      input.confidence,
      differenceCount: input.differenceCount,
      modelVersion:    input.modelVersion  ?? GEMINI_MODEL,
      promptVersion:   input.promptVersion ?? GEMINI_PROMPT_VERSION,
      success:         input.success,
      errorMessage:    input.errorMessage,
      usedFallback:    input.usedFallback,
    });
  },

  async listByPurchaseOrder(purchaseOrderId: string, actor: Actor): Promise<IAiAuditLog[]> {
    if (![ROLES.ACCOUNTS, ROLES.SUPER_ADMIN].includes(actor.role as never)) {
      throw ApiError.forbidden('Access denied');
    }
    return AiAuditLog.find({ purchaseOrder: purchaseOrderId })
      .sort({ createdAt: -1 })
      .populate('triggeredBy', 'name email')
      .lean() as Promise<IAiAuditLog[]>;
  },

  /** No role check here — the caller (billService.getTimeline) has already verified the actor
   *  can see this Bill via the same role-scoped visibility rule as every other bill endpoint. */
  async listByBill(billId: string): Promise<IAiAuditLog[]> {
    return AiAuditLog.find({ bill: billId })
      .sort({ createdAt: -1 })
      .populate('triggeredBy', 'name email')
      .lean() as Promise<IAiAuditLog[]>;
  },

  async list(
    query: Record<string, unknown>,
    actor: Actor,
  ): Promise<{ items: IAiAuditLog[]; meta: ReturnType<typeof buildPaginationMeta> }> {
    if (actor.role !== ROLES.SUPER_ADMIN) {
      throw ApiError.forbidden('Only Super Admin can view all AI audit logs');
    }

    const { page, limit, skip } = parsePagination(query);
    const filter: Record<string, unknown> = {};

    if (query.purchaseOrderId)  filter.purchaseOrder  = query.purchaseOrderId;
    if (query.success !== undefined) filter.success   = query.success === 'true';
    if (query.usedFallback !== undefined) filter.usedFallback = query.usedFallback === 'true';
    if (query.risk) filter.risk = query.risk;

    const total = await AiAuditLog.countDocuments(filter);
    const items = await AiAuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('triggeredBy', 'name email')
      .populate('purchaseOrder', 'poNumber')
      .populate('bill', 'billCode')
      .lean();

    return { items: items as IAiAuditLog[], meta: buildPaginationMeta(total, { page, limit, skip }) };
  },
};
