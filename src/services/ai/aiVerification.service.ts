import path from 'node:path';
import fs from 'node:fs';

import type { IPurchaseOrder, IAiVerification } from '@/modules/purchaseOrder/purchaseOrder.model';
import type { IBill } from '@/modules/bill/bill.model';
import type { IQuotation } from '@/modules/quotation/quotation.model';
import { extractFromPdf, parseOcrResultFromGeminiText } from '@/services/ocr/ocr.service';
import { runRuleEngine, scoreToRisk } from '@/services/ruleEngine/ruleEngine.service';
import {
  verifyWithGemini,
  extractTextFromImage,
  type GeminiVerificationOutput,
} from '@/services/ai/gemini.service';
import { AI_RECOMMENDATION, AI_RISK } from '@/constants/status';
import { isGeminiAvailable, GEMINI_MODEL, GEMINI_PROMPT_VERSION } from '@/config/gemini';
import { aiAuditLogService } from '@/modules/aiAuditLog/aiAuditLog.service';
import type { Actor } from '@/types/actor';

export interface AiVerificationInput {
  po: IPurchaseOrder;
  bill: IBill & { vendorName?: string; vendorCode?: string; vendorGst?: string };
  quotation?: IQuotation;
  actor?: Actor;
}

// The Gemini SDK's ApiError often embeds the *entire* Google API error body — quota
// metrics, doc links, retry-delay details — as JSON inside `err.message` (e.g.
// `ApiError: {"error":{"code":429,"message":"...","status":"RESOURCE_EXHAUSTED",...}}`).
// That raw dump ends up in the AI audit log and, from there, verbatim in the Bill
// History UI, which reads as a crash to a non-technical user even when the Rule Engine
// fallback (logged separately right after) succeeded. Reduce it to a short, human line.
function summarizeAiError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const jsonStart = raw.indexOf('{');
  if (jsonStart !== -1) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart)) as {
        error?: { code?: number; status?: string; message?: string };
      };
      const inner = parsed.error;
      if (inner?.message) {
        const firstLine = (inner.message.split('\n')[0] ?? inner.message).slice(0, 160);
        return [inner.status, inner.code, firstLine].filter(Boolean).join(' · ');
      }
    } catch {
      // Not JSON — fall through to plain truncation below.
    }
  }
  return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
}

// ── Build Quotation summary for Gemini prompt ──────────────────────────────────
function buildQuotationSummary(quotation: IQuotation): Record<string, unknown> {
  return {
    quotationCode:  quotation.quotationCode,
    quotationDate:  quotation.quotationDate,
    requiredDate:   quotation.requiredDate,
    amount:         quotation.amount,
    gst:            quotation.gst,
    currency:       quotation.currency,
    paymentTerms:   quotation.paymentTerms,
    deliveryTerms:  quotation.deliveryTerms,
    priority:       quotation.priority,
    description:    quotation.description,
  };
}

// ── Build PO summary for Gemini prompt ────────────────────────────────────────
function buildPoSummary(po: IPurchaseOrder): Record<string, unknown> {
  return {
    poNumber:      po.poNumber,
    poDate:        po.poDate,
    quotationCode: po.quotationCode,
    vendorName:    po.vendorName,
    vendorGst:     po.vendorGst,
    vendorAddress: po.vendorAddress,
    departmentName: po.departmentName,
    currency:       'INR',
    paymentTerms:   (po as unknown as Record<string, unknown>).paymentTerms ?? null,
    deliveryTerms:  (po as unknown as Record<string, unknown>).deliveryTerms ?? null,
    items: po.items.map((item) => ({
      itemName:  item.itemName,
      quantity:  item.quantity,
      unitPrice: item.unitPrice,
      gstRate:   item.gstRate,
      gstAmount: item.gstAmount,
      taxAmount: item.taxAmount,
      discount:  item.discount,
      total:     item.total,
    })),
    subtotal:      po.subtotal,
    totalGst:      po.totalGst,
    totalTax:      po.totalTax,
    totalDiscount: po.totalDiscount,
    grandTotal:    po.grandTotal,
  };
}

// ── Build Bill summary for Gemini prompt ──────────────────────────────────────
function buildBillSummary(
  bill: IBill & { vendorName?: string; vendorGst?: string },
  ocrData?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    billCode:      bill.billCode,
    invoiceNumber: bill.invoiceNumber,
    invoiceDate:   bill.invoiceDate,
    invoiceAmount: bill.invoiceAmount,
    taxableAmount: bill.taxableAmount,
    gstAmount:     bill.gstAmount,
    vendorName:    bill.vendorName ?? 'Unknown',
    vendorGst:     bill.vendorGst  ?? 'Unknown',
    paymentTerms:  (bill as unknown as Record<string, unknown>).paymentTerms ?? null,
    ...(ocrData ?? {}),
  };
}

// ── Resolve actual file path from stored URL ──────────────────────────────────
function resolveFilePath(url: string): string {
  const relative = url.startsWith('/') ? url.slice(1) : url;
  return path.join(process.cwd(), relative);
}

// ── Rule Engine only fallback result ──────────────────────────────────────────
function buildRuleEngineOnlyResult(
  ruleResult: ReturnType<typeof runRuleEngine>,
  ocrData?: Record<string, unknown>,
  executionTimeMs?: number,
): IAiVerification {
  const risk = scoreToRisk(ruleResult.score);
  let recommendation: IAiVerification['recommendation'];

  if (ruleResult.score >= 95 && ruleResult.criticalMismatches.length === 0) {
    recommendation = AI_RECOMMENDATION.APPROVE;
  } else if (ruleResult.score >= 75 && ruleResult.criticalMismatches.length === 0) {
    recommendation = AI_RECOMMENDATION.MANUAL_REVIEW;
  } else {
    recommendation = ruleResult.criticalMismatches.length > 0
      ? AI_RECOMMENDATION.REJECT
      : AI_RECOMMENDATION.MANUAL_REVIEW;
  }

  const summaryParts: string[] = [];
  if (ruleResult.criticalMismatches.length > 0) {
    summaryParts.push(`Critical issues: ${ruleResult.criticalMismatches.join(', ')}.`);
  }
  if (ruleResult.warnings.length > 0) {
    summaryParts.push(`Warnings: ${ruleResult.warnings.join(', ')}.`);
  }
  if (summaryParts.length === 0) {
    summaryParts.push('Rule Engine analysis complete. No significant differences detected.');
  }

  return {
    matchPercentage:    ruleResult.score,
    quotationMatch:     ruleResult.score,
    purchaseOrderMatch: ruleResult.score,
    risk:             AI_RISK[risk],
    recommendation,
    confidence:       75,
    summary:          summaryParts.join(' '),
    differences:      ruleResult.differences,
    ruleEngineScore:  ruleResult.score,
    verifiedAt:       new Date(),
    ocrExtractedData: ocrData,
    executionTimeMs,
    promptVersion:    GEMINI_PROMPT_VERSION,
    modelVersion:     'rule_engine_only',
    tokenUsage:       { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    aiProvider:       'rule_engine_only',
  };
}

// ── Orchestrator ───────────────────────────────────────────────────────────────
export async function runAiVerification(input: AiVerificationInput): Promise<IAiVerification> {
  const { po, bill, quotation, actor } = input;
  const startMs = Date.now();

  // ── Step 1: OCR on the latest invoice file ──────────────────────────────────
  let ocrResult: Awaited<ReturnType<typeof extractFromPdf>> | undefined;
  const latestInvoice = bill.invoiceFiles[bill.invoiceFiles.length - 1];

  if (latestInvoice) {
    const filePath = resolveFilePath(latestInvoice.url);
    const ext = path.extname(latestInvoice.fileName).toLowerCase();

    try {
      if (ext === '.pdf') {
        ocrResult = await extractFromPdf(filePath);
      } else if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
        const imageBuffer = fs.readFileSync(filePath);
        const base64 = imageBuffer.toString('base64');
        const mimeMap: Record<string, string> = {
          '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.png': 'image/png',  '.webp': 'image/webp',
        };
        const geminiText = await extractTextFromImage(base64, mimeMap[ext] ?? 'image/jpeg');
        const extractedData = await parseOcrResultFromGeminiText(geminiText);
        ocrResult = { rawText: geminiText, extractedData, source: 'gemini-vision' };
      }
    } catch (err) {
      console.warn('[AI Verification] OCR failed, proceeding without extracted data:', err);
    }
  }

  // ── Step 2: Rule Engine (fast, deterministic comparison) ───────────────────
  const ruleResult = runRuleEngine(po, bill, ocrResult?.extractedData);

  const quotationJson = quotation ? buildQuotationSummary(quotation) : {};
  const poJson        = buildPoSummary(po);
  const billJson      = buildBillSummary(bill, ocrResult?.extractedData as unknown as Record<string, unknown>);

  const ruleEngineSummary = [
    `Rule Engine Score: ${ruleResult.score}/100`,
    `Critical Mismatches: ${ruleResult.criticalMismatches.join(', ') || 'None'}`,
    `Warnings: ${ruleResult.warnings.join(', ') || 'None'}`,
    `Differences found: ${ruleResult.differences.length}`,
  ].join('\n');

  // ── Step 3: Gemini AI 3-way semantic analysis ──────────────────────────────
  let finalResult: IAiVerification;
  let geminiOutput: GeminiVerificationOutput | null = null;
  let geminiError: string | undefined;
  let usedFallback = false;

  if (isGeminiAvailable()) {
    try {
      geminiOutput = await verifyWithGemini(quotationJson, poJson, billJson, ruleEngineSummary);

      // Weighted overall score: Rule Engine 40% + Gemini 60%
      const finalMatchPct = Math.round(
        (ruleResult.score * 0.4) + (geminiOutput.matchPercentage * 0.6),
      );

      // Merge differences: Rule Engine base + Gemini additions (deduplicated by field)
      const allDiffs = [...ruleResult.differences];
      for (const gDiff of geminiOutput.differences) {
        const exists = allDiffs.some(
          (d) => d.field.toLowerCase() === gDiff.field.toLowerCase(),
        );
        if (!exists) allDiffs.push(gDiff);
      }

      const executionTimeMs = Date.now() - startMs;

      finalResult = {
        matchPercentage:    finalMatchPct,
        quotationMatch:     geminiOutput.quotationMatch,
        purchaseOrderMatch: geminiOutput.purchaseOrderMatch,
        risk:             geminiOutput.risk,
        recommendation:   geminiOutput.recommendation,
        confidence:       geminiOutput.confidence,
        summary:          geminiOutput.summary,
        differences:      allDiffs,
        ruleEngineScore:  ruleResult.score,
        verifiedAt:       new Date(),
        ocrExtractedData: ocrResult?.extractedData as unknown as Record<string, unknown>,
        executionTimeMs,
        promptVersion:    geminiOutput.promptVersion,
        modelVersion:     geminiOutput.modelVersion,
        tokenUsage:       geminiOutput.tokenUsage,
        aiProvider:       'gemini',
      };
    } catch (err) {
      geminiError = summarizeAiError(err);
      usedFallback = true;
      console.warn('[AI Verification] Gemini failed, using Rule Engine fallback:', err);
      finalResult = buildRuleEngineOnlyResult(
        ruleResult,
        ocrResult?.extractedData as unknown as Record<string, unknown>,
        Date.now() - startMs,
      );
    }
  } else {
    usedFallback = true;
    finalResult = buildRuleEngineOnlyResult(
      ruleResult,
      ocrResult?.extractedData as unknown as Record<string, unknown>,
      Date.now() - startMs,
    );
  }

  // ── Step 4: Write AI Audit Log (non-fatal) ─────────────────────────────────
  if (actor) {
    const billId = String((po.bill ?? bill._id) ?? '');
    if (billId) {
      aiAuditLogService.create({
        purchaseOrderId: String(po._id),
        billId,
        triggeredBy:     actor.id,
        triggeredByRole: actor.role,
        promptSnapshot:  geminiOutput?.promptSnapshot ?? ruleEngineSummary,
        rawResponse:     geminiOutput?.rawResponse ?? '',
        executionTimeMs: finalResult.executionTimeMs ?? 0,
        inputTokens:     finalResult.tokenUsage?.inputTokens  ?? 0,
        outputTokens:    finalResult.tokenUsage?.outputTokens ?? 0,
        totalTokens:     finalResult.tokenUsage?.totalTokens  ?? 0,
        matchPercentage: finalResult.matchPercentage,
        risk:            finalResult.risk,
        recommendation:  finalResult.recommendation,
        confidence:      finalResult.confidence,
        differenceCount: finalResult.differences.length,
        modelVersion:    finalResult.modelVersion,
        promptVersion:   finalResult.promptVersion,
        success:         !usedFallback || !geminiError,
        errorMessage:    geminiError,
        usedFallback,
      }).catch((logErr) =>
        console.error('[AI Verification] Failed to write AI audit log:', logErr),
      );
    }
  }

  return finalResult;
}
