import path from 'node:path';

import { OCR_STATUS } from '@/constants/status';
import { activityLogService } from '@/modules/activityLog/activityLog.service';
import { notificationService } from '@/modules/notification/notification.service';
import { Quotation } from '@/modules/quotation/quotation.model';
import { User } from '@/modules/user/user.model';
import { geminiVisionProvider } from '@/services/ocr/providers/geminiVisionProvider';
import { pdfParseProvider } from '@/services/ocr/providers/pdfParseProvider';
import type { OcrProvider } from '@/services/ocr/ocrProvider.interface';
import { computeOcrConfidence, parseQuotationText } from '@/services/ocr/quotationOcrParser';
import type { Actor } from '@/types/actor';
import { ApiError } from '@/utils/ApiError';

const PROVIDERS: OcrProvider[] = [pdfParseProvider, geminiVisionProvider];

function selectProvider(mimeType: string): OcrProvider {
  const provider = PROVIDERS.find((p) => p.supports(mimeType));
  if (!provider) throw new Error(`No OCR provider supports mime type "${mimeType}"`);
  return provider;
}

function resolveFilePath(url: string): string {
  const relative = url.startsWith('/') ? url.slice(1) : url;
  return path.join(process.cwd(), relative);
}

const TRANSIENT_NETWORK_ERRORS = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED'];

function isTransientNetworkError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return TRANSIENT_NETWORK_ERRORS.some((code) => message.includes(code));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The pipeline's DB calls occasionally land on a pooled Mongo connection whose individual
 *  socket has been reset (this dev network's NAT/firewall drops idle sockets in bursts) —
 *  this fails with `ECONNRESET` even while `mongoose.connection.readyState` still reports
 *  "connected" (that flag is pool/topology-level, not per-socket), so waiting on it never
 *  actually waits. Use a real exponential backoff instead, and let the pool replace the
 *  dead socket with a fresh one on the next attempt. */
async function withTransientRetry<T>(fn: () => Promise<T>): Promise<T> {
  const maxAttempts = 12;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientNetworkError(err) || attempt >= maxAttempts) throw err;
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 20_000));
    }
  }
}

/** Notify + log to the quotation's creator — the one person "View OCR result" access
 *  always covers, regardless of who (Department User or HOD) actually triggered the run. */
async function notifyCreator(
  quotationId: string,
  createdBy: string,
  quotationCode: string,
  outcome: 'completed' | 'failed',
  actor: Actor,
): Promise<void> {
  const creator = await User.findById(createdBy).select('role').lean();
  if (!creator) return;

  activityLogService.record(
    {
      action: outcome === 'completed' ? 'quotation_ocr_completed' : 'quotation_ocr_failed',
      targetId: quotationId,
      targetType: 'Quotation',
      newValue: { quotationCode },
    },
    actor,
  ).catch(() => null);

  notificationService.notifyUser(
    { id: createdBy, role: creator.role },
    outcome === 'completed'
      ? {
          title: 'OCR Complete',
          message: `Quotation data was extracted from ${quotationCode}'s attachment. Review the result.`,
          module: 'quotation',
          relatedRecord: quotationId,
          notificationType: 'quotation_ocr_completed',
          priority: 'low',
          category: 'success',
          sender: actor.id,
        }
      : {
          title: 'OCR Failed',
          message: `Automatic data extraction failed for ${quotationCode}'s attachment. You can retry it.`,
          module: 'quotation',
          relatedRecord: quotationId,
          notificationType: 'quotation_ocr_failed',
          priority: 'medium',
          category: 'warning',
          sender: actor.id,
        },
  ).catch(() => null);
}

/**
 * Runs the OCR pipeline against a quotation's latest attachment and persists the result
 * onto `quotation.ocr`. Never throws — a failure is recorded as `status: 'failed'` with
 * `error`, exactly like every other fire-and-forget side effect in this codebase
 * (activity log, notifications), so a slow or broken OCR provider can never fail the
 * request that triggered it.
 */
async function runOcrPipeline(quotationId: string, actor: Actor): Promise<void> {
  const quotation = await withTransientRetry(() => Quotation.findById(quotationId));
  if (!quotation) return;

  const latestAttachment = quotation.attachments[quotation.attachments.length - 1];
  if (!latestAttachment) {
    quotation.ocr = { status: OCR_STATUS.FAILED, error: 'No attachment to run OCR against' };
    await quotation.save();
    return;
  }

  const startedAt = quotation.ocr?.startedAt ?? new Date();

  try {
    const provider = selectProvider(latestAttachment.mimeType);
    const filePath = resolveFilePath(latestAttachment.url);
    const { rawText, provider: providerName } = await provider.extractRawText(filePath, latestAttachment.mimeType);
    const structuredData = parseQuotationText(rawText);
    const confidence = computeOcrConfidence(structuredData);

    await withTransientRetry(() =>
      Quotation.updateOne(
        { _id: quotationId },
        {
          ocr: {
            status: OCR_STATUS.COMPLETED,
            attachmentVersion: latestAttachment.version,
            provider: providerName,
            startedAt,
            completedAt: new Date(),
            confidence,
            extractedText: rawText.slice(0, 10_000),
            structuredData,
          },
        },
      ),
    );
    await notifyCreator(quotationId, quotation.createdBy.toString(), quotation.quotationCode, 'completed', actor);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'OCR processing failed';
    await withTransientRetry(() =>
      Quotation.updateOne(
        { _id: quotationId },
        {
          ocr: {
            status: OCR_STATUS.FAILED,
            attachmentVersion: latestAttachment.version,
            startedAt,
            completedAt: new Date(),
            error: message,
          },
        },
      ),
    );
    await notifyCreator(quotationId, quotation.createdBy.toString(), quotation.quotationCode, 'failed', actor);
  }
}

export const quotationOcrService = {
  /** Fire-and-forget entry point, called right after a successful attachment upload. */
  run(quotationId: string, actor: Actor): void {
    runOcrPipeline(quotationId, actor).catch((err) => console.error('[quotationOcr] Unexpected failure:', err));
  },

  /**
   * Explicit re-run, used by the "Retry OCR" mobile action. Flips status to `processing`
   * synchronously (so the response the caller gets already reflects it) before kicking
   * off the same background pipeline as `run()`.
   */
  async retry(quotationId: string, actor: Actor): Promise<InstanceType<typeof Quotation>> {
    const quotation = await withTransientRetry(() => Quotation.findById(quotationId));
    if (!quotation) throw ApiError.notFound('Quotation not found');
    if (quotation.attachments.length === 0) {
      throw ApiError.badRequest('This quotation has no attachment to run OCR against');
    }

    quotation.ocr = {
      status: OCR_STATUS.PROCESSING,
      attachmentVersion: quotation.attachments[quotation.attachments.length - 1]!.version,
      startedAt: new Date(),
    };
    await withTransientRetry(() => quotation.save());

    this.run(quotationId, actor);
    return quotation;
  },
};
