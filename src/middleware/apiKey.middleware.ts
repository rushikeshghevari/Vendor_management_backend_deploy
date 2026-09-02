import type { NextFunction, Request, Response } from 'express';

import { env } from '@/config/env';
import { ApiError } from '@/utils/ApiError';
import { catchAsync } from '@/utils/catchAsync';
import { logger } from '@/utils/logger';

/**
 * Guards the `/external/*` read-only API used by other, separate projects (no user login on
 * their end) — a fixed shared secret in a header, not the JWT `authenticate` middleware used
 * everywhere else. Fails closed: if EXTERNAL_API_KEY was never configured, every request is
 * rejected rather than silently allowed through.
 */
export const apiKeyAuth = catchAsync(async (req: Request, _res: Response, next: NextFunction) => {
  if (!env.externalApiKey) {
    logger.warn('[security] External API denied — EXTERNAL_API_KEY is not configured', { path: req.originalUrl });
    throw ApiError.unauthorized('External API is not configured');
  }

  const key = req.headers['x-api-key'];
  if (!key || key !== env.externalApiKey) {
    logger.warn('[security] External API denied — invalid or missing API key', { path: req.originalUrl, ip: req.ip });
    throw ApiError.unauthorized('Invalid or missing API key');
  }

  next();
});
