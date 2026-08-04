import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

import { env } from '@/config/env';

// Extract the user ID from a Bearer JWT payload without verifying the signature.
// Used only as a rate-limit partition key — actual verification happens in auth middleware.
function extractUserIdFromBearer(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const parts = authHeader.slice(7).split('.');
    const encoded = parts[1];
    if (!encoded) return null;
    const payload = JSON.parse(
      Buffer.from(encoded, 'base64url').toString(),
    ) as Record<string, unknown>;
    return typeof payload['id'] === 'string' ? payload['id'] : null;
  } catch {
    return null;
  }
}

export const apiRateLimiter = rateLimit({
  windowMs: env.rateLimitWindowMs,
  limit: env.rateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  // Rate-limit per authenticated user so shared-IP environments (offices, NAT)
  // don't pool everyone into the same bucket.
  // Unauthenticated requests (no Bearer token) fall back to IP.
  keyGenerator: (req) => {
    const userId = extractUserIdFromBearer(req.headers.authorization);
    return userId ?? ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? 'unknown');
  },
  message: { success: false, message: 'Too many requests. Please try again later.' },
});

export const authRateLimiter = rateLimit({
  windowMs: env.rateLimitWindowMs,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  // Auth endpoints stay IP-based intentionally — a per-user key for /login would let
  // an attacker brute-force unlimited passwords by rotating across valid usernames.
  message: { success: false, message: 'Too many authentication attempts. Please try again later.' },
});
