import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';

import { isProduction } from '@/config/env';
import { ApiError } from '@/utils/ApiError';
import { logger } from '@/utils/logger';

interface MongoServerErrorLike extends Error {
  code?: number;
  keyValue?: Record<string, unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(error: Error, req: Request, res: Response, _next: NextFunction): void {
  let statusCode = 500;
  let message = 'Internal server error';
  let fieldErrors: Record<string, string[]> | undefined;

  if (error instanceof ApiError) {
    statusCode = error.statusCode;
    message = error.message;
    fieldErrors = error.fieldErrors;
  } else if (error instanceof mongoose.Error.ValidationError) {
    statusCode = 400;
    message = 'Validation failed';
    fieldErrors = Object.fromEntries(
      Object.entries(error.errors).map(([field, err]) => [field, [err.message]]),
    );
  } else if (error instanceof mongoose.Error.CastError) {
    statusCode = 400;
    message = `Invalid value for field "${error.path}"`;
  } else if ((error as MongoServerErrorLike).code === 11000) {
    statusCode = 409;
    const duplicateField = Object.keys((error as MongoServerErrorLike).keyValue ?? {})[0] ?? 'field';
    message = `Duplicate value for "${duplicateField}"`;
    fieldErrors = { [duplicateField]: [`This ${duplicateField} is already in use`] };
  } else if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
    statusCode = 401;
    message = 'Invalid or expired token';
  }

  if (statusCode === 500) {
    logger.error(`${req.method} ${req.originalUrl} -> ${error.message}`, error.stack);
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(fieldErrors ? { errors: fieldErrors } : {}),
    ...(!isProduction && statusCode === 500 ? { stack: error.stack } : {}),
  });
}
