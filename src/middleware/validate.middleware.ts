import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';

import { ApiError } from '@/utils/ApiError';

interface ValidationSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

function collectFieldErrors(issues: { path: PropertyKey[]; message: string }[]): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of issues) {
    const key = issue.path.join('.') || 'root';
    fieldErrors[key] ??= [];
    fieldErrors[key].push(issue.message);
  }
  return fieldErrors;
}

/** Validates and replaces req.body/query/params with the parsed (and type-coerced) result. */
export function validate(schemas: ValidationSchemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (schemas.body) {
      const result = schemas.body.safeParse(req.body);
      if (!result.success) {
        throw ApiError.badRequest('Validation failed', collectFieldErrors(result.error.issues));
      }
      req.body = result.data;
    }

    if (schemas.query) {
      const result = schemas.query.safeParse(req.query);
      if (!result.success) {
        throw ApiError.badRequest('Validation failed', collectFieldErrors(result.error.issues));
      }
      req.query = result.data as Request['query'];
    }

    if (schemas.params) {
      const result = schemas.params.safeParse(req.params);
      if (!result.success) {
        throw ApiError.badRequest('Validation failed', collectFieldErrors(result.error.issues));
      }
      req.params = result.data as Request['params'];
    }

    next();
  };
}
