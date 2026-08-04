/**
 * Gemini AI verification service — 3-Way comparison: Quotation + Purchase Order + Bill.
 *
 * Uses @google/genai (new SDK — replaces deprecated @google/generative-ai).
 * Singleton client is managed in backend/src/config/gemini.ts.
 *
 * New output fields (v3 prompt):
 *   overallMatch        — weighted score across all three documents
 *   quotationMatch      — how closely the Bill aligns with the original Quotation
 *   purchaseOrderMatch  — how closely the Bill aligns with the Purchase Order
 */

import {
  getGeminiClient,
  GEMINI_MODEL,
  GEMINI_PROMPT_VERSION,
  GEMINI_MAX_RETRIES,
  GEMINI_TIMEOUT_MS,
  GEMINI_MAX_OUTPUT_TOKENS,
} from '@/config/gemini';
import type { IAiDifference } from '@/modules/purchaseOrder/purchaseOrder.model';
import type { AiRisk, AiRecommendation } from '@/constants/status';

// ── Output types ───────────────────────────────────────────────────────────────

export interface GeminiTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface GeminiVerificationOutput {
  /** Weighted overall match — Rule Engine 40% + Gemini 60% */
  matchPercentage: number;
  /** Gemini-computed quotation-vs-bill match (0-100) */
  quotationMatch: number;
  /** Gemini-computed PO-vs-bill match (0-100) */
  purchaseOrderMatch: number;
  risk: AiRisk;
  recommendation: AiRecommendation;
  confidence: number;
  summary: string;
  differences: IAiDifference[];
  modelVersion: string;
  promptVersion: string;
  tokenUsage: GeminiTokenUsage;
  rawResponse: string;
  promptSnapshot: string;
}

// ── In-memory cache (5 min TTL) ────────────────────────────────────────────────

interface CacheEntry { result: GeminiVerificationOutput; expiresAt: number; }
const _cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60_000;

function cacheKey(
  quotationJson: Record<string, unknown>,
  poJson: Record<string, unknown>,
  billJson: Record<string, unknown>,
): string {
  return [
    String(quotationJson.quotationCode ?? ''),
    String(poJson.poNumber ?? ''),
    String(billJson.invoiceNumber ?? ''),
    String(billJson.billCode ?? ''),
  ].join('|');
}

function fromCache(key: string): GeminiVerificationOutput | null {
  const entry = _cache.get(key);
  if (!entry || Date.now() > entry.expiresAt) {
    _cache.delete(key);
    return null;
  }
  return entry.result;
}

function toCache(key: string, result: GeminiVerificationOutput): void {
  _cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ── 3-Way Prompt Builder ───────────────────────────────────────────────────────

function buildVerificationPrompt(
  quotationJson: Record<string, unknown>,
  poJson: Record<string, unknown>,
  billJson: Record<string, unknown>,
  ruleEngineSummary: string,
): string {
  return `You are an enterprise ERP financial verification AI for an Indian Vendor Management System.
Your job is to compare THREE documents simultaneously — the original Quotation, the Purchase Order, and the Vendor Invoice (Bill) — and produce a structured 3-way JSON risk assessment.

═══════════════════════════════════════════════════════════════
RULE ENGINE PRE-ANALYSIS (deterministic checks already completed):
${ruleEngineSummary}
═══════════════════════════════════════════════════════════════

DOCUMENT 1 — ORIGINAL QUOTATION (basis for negotiation):
${JSON.stringify(quotationJson, null, 2)}

DOCUMENT 2 — PURCHASE ORDER (legal commitment after Director Business Approval):
${JSON.stringify(poJson, null, 2)}

DOCUMENT 3 — VENDOR INVOICE / BILL (vendor's financial claim):
${JSON.stringify(billJson, null, 2)}

═══════════════════════════════════════════════════════════════
TASK: Perform a comprehensive 3-way semantic comparison.
Evaluate consistency across all three documents.

FIELDS TO COMPARE (check every field with data present):
1.  Vendor Name — semantic match across all 3 docs
2.  Vendor GST Number — must match exactly in all 3 (uppercase GSTIN format)
3.  Vendor PAN Number — if present, must match
4.  Quotation Number — must appear on PO and ideally on Bill
5.  PO Number — must appear on the Bill
6.  Invoice Number — unique on the Bill
7.  Invoice Date — must not pre-date the PO date
8.  Quotation Date vs PO Date vs Invoice Date — timeline consistency
9.  Department Name — consistent across docs
10. Product / Service Names — semantic match (allow minor wording)
11. Quantity — exact numeric match per line item (Quotation → PO → Bill)
12. Unit Rate — within 2% tolerance; flag any Price escalation from Quotation to Bill
13. Tax / TDS amounts — must match applicable GST slabs
14. GST Rate and GST Amount — critical; must match across all 3
15. Discount — applied consistently
16. Quotation Total — base reference amount
17. PO Grand Total — legal commitment amount (must align with Quotation within approved variance)
18. Bill Grand Total — vendor claim (must align with PO within 5%; >15% is critical)
19. HSN / SAC Codes — consistent if present
20. Payment Terms — must match between PO and Bill
21. Delivery Terms — consistent
22. Currency — must match across all 3
23. Required / Delivery Date — Bill delivery must honour PO date
24. Budget / Department spend — flag if Bill exceeds Quotation significantly

RISK CLASSIFICATION RULES:
- quotationMatch AND purchaseOrderMatch both 95-100 → risk = "LOW"
- either score 75-94 (no critical issues) → risk = "MEDIUM"
- either score < 75 OR any critical mismatch → risk = "HIGH"

RECOMMENDATION RULES:
- LOW risk + no critical issues → "APPROVE"
- MEDIUM risk or minor discrepancies → "MANUAL_REVIEW"
- HIGH risk OR: GSTIN mismatch, Bill >15% above PO, Invoice pre-dates PO, duplicate invoice → "REJECT"

SEVERITY FOR EACH DIFFERENCE:
- "HIGH"   — Potential fraud, regulatory violation, >15% financial variance, GSTIN fraud
- "MEDIUM" — Significant discrepancy requiring manual review
- "LOW"    — Minor difference within tolerance

CRITICAL INSTRUCTIONS:
- Perform SEMANTIC validation — the Rule Engine handles exact arithmetic.
- Focus on fraud detection, regulatory compliance, and business reasonableness.
- Flag price escalation from Quotation to Bill (vendor charging more than what was quoted).
- Do NOT repeat differences already flagged by the Rule Engine unless adding business context.
- Return ONLY valid JSON. No markdown fences. No text outside the JSON object.
- Numbers must be plain integers or decimals (not strings).

═══════════════════════════════════════════════════════════════
RETURN THIS EXACT JSON STRUCTURE:

{
  "overallMatch": <integer 0-100, weighted consistency across all 3 documents>,
  "quotationMatch": <integer 0-100, how closely the Bill aligns with the Quotation>,
  "purchaseOrderMatch": <integer 0-100, how closely the Bill aligns with the PO>,
  "confidence": <integer 0-100>,
  "risk": "<LOW|MEDIUM|HIGH>",
  "recommendation": "<APPROVE|MANUAL_REVIEW|REJECT>",
  "summary": "<2-3 sentences for Director and Accounts — be specific about key findings>",
  "differences": [
    {
      "field": "<field name>",
      "purchaseOrder": "<PO value>",
      "bill": "<Invoice value>",
      "difference": "<clear description of the discrepancy>",
      "severity": "<LOW|MEDIUM|HIGH>"
    }
  ]
}

The "differences" array must contain ONLY actual discrepancies. Empty array [] if everything matches.
`;
}

// ── Response validation ────────────────────────────────────────────────────────

function extractJsonFromText(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const braceStart = text.indexOf('{');
  const braceEnd   = text.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    return text.slice(braceStart, braceEnd + 1);
  }
  return text.trim();
}

function validateDifference(d: unknown): IAiDifference | null {
  if (typeof d !== 'object' || d === null) return null;
  const obj = d as Record<string, unknown>;
  if (typeof obj.field !== 'string') return null;
  return {
    field:         obj.field,
    purchaseOrder: obj.purchaseOrder ?? obj.po ?? null,
    bill:          obj.bill ?? null,
    difference:    typeof obj.difference === 'string' ? obj.difference : String(obj.difference ?? ''),
    severity:      (['LOW', 'MEDIUM', 'HIGH'] as const).includes(obj.severity as never)
      ? (obj.severity as 'LOW' | 'MEDIUM' | 'HIGH')
      : 'MEDIUM',
  };
}

function validateOutput(
  raw: unknown,
  rawText: string,
  prompt: string,
  usage: GeminiTokenUsage,
): GeminiVerificationOutput {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Gemini returned non-object JSON');
  }

  const obj = raw as Record<string, unknown>;

  // Support overallMatch (v3) and legacy matchScore / matchPercentage
  const rawScore = obj.overallMatch ?? obj.matchScore ?? obj.matchPercentage;
  const matchPercentage = typeof rawScore === 'number'
    ? Math.min(100, Math.max(0, Math.round(rawScore)))
    : 50;

  const quotationMatch = typeof obj.quotationMatch === 'number'
    ? Math.min(100, Math.max(0, Math.round(obj.quotationMatch)))
    : matchPercentage;

  const purchaseOrderMatch = typeof obj.purchaseOrderMatch === 'number'
    ? Math.min(100, Math.max(0, Math.round(obj.purchaseOrderMatch)))
    : matchPercentage;

  const risk: AiRisk = (['LOW', 'MEDIUM', 'HIGH'] as const).includes(obj.risk as never)
    ? (obj.risk as AiRisk)
    : matchPercentage >= 95 ? 'LOW' : matchPercentage >= 75 ? 'MEDIUM' : 'HIGH';

  const recommendation: AiRecommendation = (['APPROVE', 'MANUAL_REVIEW', 'REJECT'] as const).includes(obj.recommendation as never)
    ? (obj.recommendation as AiRecommendation)
    : 'MANUAL_REVIEW';

  const confidence = typeof obj.confidence === 'number'
    ? Math.min(100, Math.max(0, Math.round(obj.confidence)))
    : 70;

  const summary = typeof obj.summary === 'string' && obj.summary.trim()
    ? obj.summary.trim()
    : 'AI 3-way analysis complete. Review differences below.';

  const differences: IAiDifference[] = Array.isArray(obj.differences)
    ? (obj.differences as unknown[]).map(validateDifference).filter(Boolean) as IAiDifference[]
    : [];

  return {
    matchPercentage,
    quotationMatch,
    purchaseOrderMatch,
    risk,
    recommendation,
    confidence,
    summary,
    differences,
    modelVersion:   GEMINI_MODEL,
    promptVersion:  GEMINI_PROMPT_VERSION,
    tokenUsage:     usage,
    rawResponse:    rawText.slice(0, 5000),
    promptSnapshot: prompt.slice(0, 8000),
  };
}

// ── Retry + timeout wrapper ────────────────────────────────────────────────────

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries: number, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        const delay = 1000 * (attempt + 1);
        console.warn(`[Gemini] ${label} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms:`, err);
        await new Promise((res) => setTimeout(res, delay));
      }
    }
  }
  throw lastErr;
}

// ── 3-Way Quotation + PO + Bill comparison ────────────────────────────────────

export async function verifyWithGemini(
  quotationJson: Record<string, unknown>,
  poJson: Record<string, unknown>,
  billJson: Record<string, unknown>,
  ruleEngineSummary: string,
): Promise<GeminiVerificationOutput> {
  const key = cacheKey(quotationJson, poJson, billJson);
  const cached = fromCache(key);
  if (cached) {
    console.info('[Gemini] Returning cached 3-way verification result');
    return cached;
  }

  const prompt = buildVerificationPrompt(quotationJson, poJson, billJson, ruleEngineSummary);
  const client = getGeminiClient();

  const rawText = await withRetry(
    () => withTimeout(
      (async () => {
        const response = await client.models.generateContent({
          model: GEMINI_MODEL,
          contents: prompt,
          config: {
            responseMimeType: 'application/json',
            temperature: 0.1,
            maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
          },
        });
        return response;
      })(),
      GEMINI_TIMEOUT_MS,
      'Gemini 3-way verification',
    ).then((response) => {
      const usage: GeminiTokenUsage = {
        inputTokens:  response.usageMetadata?.promptTokenCount  ?? 0,
        outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        totalTokens:  response.usageMetadata?.totalTokenCount   ?? 0,
      };
      return { text: response.text ?? '', usage };
    }),
    GEMINI_MAX_RETRIES,
    'Quotation + PO + Bill 3-way verification',
  );

  const { text, usage } = rawText as { text: string; usage: GeminiTokenUsage };
  const jsonStr = extractJsonFromText(text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(`Gemini returned invalid JSON. Raw (first 300 chars): ${text.slice(0, 300)}`);
  }

  const result = validateOutput(parsed, text, prompt, usage);
  toCache(key, result);
  return result;
}

// ── Vision: extract text from invoice images ───────────────────────────────────

export async function extractTextFromImage(imageBase64: string, mimeType: string): Promise<string> {
  const client = getGeminiClient();

  const response = await withRetry(
    () => withTimeout(
      client.models.generateContent({
        model: GEMINI_MODEL,
        contents: [
          {
            text: `Extract ALL text from this vendor invoice image.
Return structured text including:
- Invoice Number, Invoice Date, PO Number (if present)
- Vendor Name, Vendor GST Number, Vendor PAN Number (if present)
- Department / Billing Address
- Line items: Product/Service name, HSN/SAC code, Quantity, Unit Rate, GST Rate, GST Amount, Total
- Subtotal, GST Total, Tax Total, Discount, Grand Total
- Payment Terms, Currency
Format each field on its own line as: FIELD_NAME: value`,
          },
          { inlineData: { mimeType, data: imageBase64 } },
        ],
      }),
      GEMINI_TIMEOUT_MS,
      'Gemini Vision OCR',
    ),
    GEMINI_MAX_RETRIES,
    'Invoice OCR',
  );

  return response.text ?? '';
}
