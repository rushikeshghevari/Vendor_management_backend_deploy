import type { Request } from 'express';

import { ROLES } from '@/constants/roles';
import { ActivityLog, type ActivityAction } from '@/modules/activityLog/activityLog.model';
import { User } from '@/modules/user/user.model';
import type { Actor } from '@/types/actor';
import { buildPaginationMeta, parsePagination } from '@/utils/pagination';
import { logger } from '@/utils/logger';

export interface RecordActivityEntry {
  action: ActivityAction;
  department?: string;
  targetId?: string;
  targetType?: string;
  oldValue?: unknown;
  newValue?: unknown;
}

export const activityLogService = {
  /**
   * Writes one activity-log entry. Deliberately never throws — a logging failure must never
   * break the business action it's observing. Callers fire this after their main action has
   * already succeeded and don't need to await error handling for it.
   *
   * `req` is optional — most callers are controllers with a live request to pull IP/device
   * from, but some events (e.g. `ai_completed`) originate from a background pipeline with no
   * HTTP request in scope; those just record without ipAddress/device rather than skip logging.
   */
  async record(entry: RecordActivityEntry, actor: Actor, req?: Request): Promise<void> {
    try {
      const performer = await User.findById(actor.id).select('name').lean();
      await ActivityLog.create({
        action: entry.action,
        performedBy: actor.id,
        performedByName: performer?.name ?? 'Unknown',
        performedByRole: actor.role,
        department: entry.department ?? actor.department,
        targetId: entry.targetId,
        targetType: entry.targetType,
        oldValue: entry.oldValue,
        newValue: entry.newValue,
        ipAddress: req?.ip,
        device: req?.headers['user-agent'],
      });
    } catch (error) {
      logger.error('[activityLog] Failed to record activity log entry', { action: entry.action, error });
    }
  },

  /** Super Admin sees every department's activity; HOD sees only their own. */
  async list(query: Record<string, unknown>, actor: Actor) {
    const pagination = parsePagination(query);
    const filter: Record<string, unknown> =
      actor.role === ROLES.SUPER_ADMIN ? {} : { department: actor.department };

    if (query.action) filter.action = query.action;
    if (query.department && actor.role === ROLES.SUPER_ADMIN) filter.department = query.department;
    if (query.performedBy) filter.performedBy = query.performedBy;
    if (query.from || query.to) {
      const createdAt: Record<string, Date> = {};
      if (query.from) createdAt.$gte = new Date(query.from as string);
      if (query.to) createdAt.$lte = new Date(query.to as string);
      filter.createdAt = createdAt;
    }

    const [items, total] = await Promise.all([
      ActivityLog.find(filter)
        .populate('department', 'name code')
        .sort({ createdAt: -1 })
        .skip(pagination.skip)
        .limit(pagination.limit)
        .lean(),
      ActivityLog.countDocuments(filter),
    ]);

    return { items, meta: buildPaginationMeta(total, pagination) };
  },
};
