import fs from 'node:fs';

import { extractTextFromImage } from '@/services/ai/gemini.service';
import { isGeminiAvailable } from '@/config/gemini';
import type { OcrProvider, OcrProviderResult } from '@/services/ocr/ocrProvider.interface';

const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];

/** Image text extraction via Gemini Vision — reuses the exact same
 *  `extractTextFromImage` call already used by the Bill-invoice AI verification
 *  pipeline (`aiVerification.service.ts`), just wrapped behind the provider interface. */
export const geminiVisionProvider: OcrProvider = {
  name: 'gemini-vision',

  supports(mimeType: string): boolean {
    return IMAGE_MIME_TYPES.includes(mimeType);
  },

  async extractRawText(filePath: string, mimeType: string): Promise<OcrProviderResult> {
    if (!isGeminiAvailable()) {
      throw new Error('Gemini is not configured (GEMINI_API_KEY missing) — cannot OCR an image attachment');
    }
    const base64 = fs.readFileSync(filePath).toString('base64');
    const rawText = await extractTextFromImage(base64, mimeType);
    return { rawText, provider: geminiVisionProvider.name };
  },
};
