import type { NextFunction, Request, Response } from 'express';

import { ROLES, type Role } from '@/constants/roles';
import { ApiError } from '@/utils/ApiError';
import { logger } from '@/utils/logger';

/** Restricts a route to the given roles. Must run after `authenticate`. */
export function authorize(...allowedRoles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      throw ApiError.unauthorized('Authentication required');
    }

    if (!allowedRoles.includes(req.user.role)) {
      logger.warn('[security] Authorization denied', {
        userId: req.user.id,
        role: req.user.role,
        requiredRoles: allowedRoles,
        method: req.method,
        path: req.originalUrl,
        ip: req.ip,
      });
      throw ApiError.forbidden('You do not have permission to perform this action');
    }

    next();
  };
}

export const requireHOD = authorize(ROLES.HOD);
