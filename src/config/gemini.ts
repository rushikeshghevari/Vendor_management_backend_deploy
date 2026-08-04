import { GoogleGenAI } from '@google/genai';

import { env } from '@/config/env';

/**
 * Latest stable Gemini model. Update here when Google releases a newer stable version.
 * All services import this constant so a model upgrade is a one-line change.
 */
export const GEMINI_MODEL = 'gemini-2.0-flash';

/** Semver prompt version — bump when the verification prompt changes materially. */
export const GEMINI_PROMPT_VERSION = '2.0.0';

/** Retry policy for transient API errors. */
export const GEMINI_MAX_RETRIES = 2;

/** Hard timeout per Gemini call (ms). Rule Engine still completes if Gemini exceeds this. */
export const GEMINI_TIMEOUT_MS = 45_000;

/** Maximum output tokens. JSON responses for PO/Bill comparison rarely exceed 2 k tokens. */
export const GEMINI_MAX_OUTPUT_TOKENS = 4096;

let _client: GoogleGenAI | null = null;

/**
 * Returns the singleton Gemini client.
 * Throws if GEMINI_API_KEY is absent (callers should guard with isGeminiAvailable() first).
 */
export function getGeminiClient(): GoogleGenAI {
  if (_client) return _client;

  if (!env.geminiApiKey) {
    throw new Error(
      'GEMINI_API_KEY is not set — cannot create Gemini client. ' +
      'Set GEMINI_API_KEY in .env to enable AI verification.',
    );
  }

  _client = new GoogleGenAI({ apiKey: env.geminiApiKey });
  return _client;
}

/** True when GEMINI_API_KEY is present and the client can be created. */
export function isGeminiAvailable(): boolean {
  return Boolean(env.geminiApiKey);
}
