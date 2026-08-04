import { ROLES, type Role } from '@/constants/roles';
import {
  Notification,
  type INotification,
  type NotificationCategory,
  type NotificationModule,
  type NotificationPriority,
  type NotificationType,
} from '@/modules/notification/notification.model';
import { User } from '@/modules/user/user.model';
import { sendPushToTokens } from '@/services/push/pushNotification.service';
import type { Actor } from '@/types/actor';
import { ApiError } from '@/utils/ApiError';
import { escapeRegex } from '@/utils/escapeRegex';
import { buildPaginationMeta, parsePagination } from '@/utils/pagination';
import type mongoose from 'mongoose';

export interface NotificationPayload {
  title: string;
  message: string;
  module: NotificationModule;
  relatedRecord: string;
  notificationType: NotificationType;
  priority?: NotificationPriority;
  category?: NotificationCategory;
  sender?: string;
  /**
   * Opt-in "send exactly once, ever" key (receiver id is appended automatically per
   * recipient). Only set this for events that can never legitimately recur for the same
   * record — e.g. `quotation_submitted:${quotationId}` — never for types with an intentional
   * retry/correction/resubmit loop (AI re-verification, negotiation, correction cycles),
   * where a second real send must not be silently swallowed.
   */
  dedupKey?: string;
}

export interface Receiver {
  id: string;
  role: Role;
}

interface ReceiverWithTokens extends Receiver {
  fcmTokens?: Array<{ token: string; platform: string; isActive: boolean }>;
}

async function dispatchPush(
  receivers: ReceiverWithTokens[],
  payload: NotificationPayload,
  notificationIds?: mongoose.Types.ObjectId[],
): Promise<void> {
  const tokens: Array<{ token: string; userId: string; platform: 'android' | 'ios' | 'web' }> = [];
  for (const r of receivers) {
    if (r.fcmTokens) {
      for (const t of r.fcmTokens) {
        if (t.isActive && t.token) {
          tokens.push({ token: t.token, userId: r.id, platform: t.platform as 'android' | 'ios' | 'web' });
        }
      }
    }
  }
  if (tokens.length === 0) return;

  const result = await sendPushToTokens(tokens, {
    title:            payload.title,
    body:             payload.message,
    module:           payload.module,
    referenceId:      payload.relatedRecord,
    priority:         payload.priority ?? 'medium',
    notificationType: payload.notificationType,
  });

  // Update delivery status on the notification docs
  if (notificationIds && notificationIds.length > 0) {
    const now = new Date();
    const update = result.successCount > 0
      ? { isPushSent: true, pushDeliveryStatus: 'sent', pushSentAt: now }
      : { pushDeliveryStatus: 'failed', pushFailedAt: now };
    await Notification.updateMany({ _id: { $in: notificationIds } }, update).catch(() => null);
  }
}

/** True for a MongoDB/Mongoose duplicate-key error (E11000) — i.e. a dedupKey collision. */
function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}

function buildNotificationDoc(
  receiver: Receiver,
  payload: NotificationPayload,
  dedupKey?: string,
) {
  return {
    ...payload,
    receiver: receiver.id,
    receiverRole: receiver.role,
    priority: payload.priority ?? 'medium',
    category: payload.category ?? 'information',
    dedupKey,
    status: 'sent' as const,
    isDelivered: true,
    deliveryCount: 1,
    lastSentAt: new Date(),
  };
}

/**
 * Creates one notification, honoring `dedupKey` idempotency when set: if a document
 * with this exact key already exists, the insert is rejected by the unique index and
 * this returns `{ doc: <the existing one>, isNew: false }` instead of throwing — the
 * caller uses `isNew` to decide whether a push should fire (never re-push on a skip).
 */
async function createOnce(
  receiver: Receiver,
  payload: NotificationPayload,
  dedupKey?: string,
): Promise<{ doc: mongoose.HydratedDocument<INotification>; isNew: boolean }> {
  try {
    const doc: mongoose.HydratedDocument<INotification> = await Notification.create(
      buildNotificationDoc(receiver, payload, dedupKey),
    );
    return { doc, isNew: true };
  } catch (err) {
    if (dedupKey && isDuplicateKeyError(err)) {
      const existing = await Notification.findOne({ dedupKey });
      if (existing) return { doc: existing, isNew: false };
    }
    throw err;
  }
}

export const notificationService = {
  /** Bulk-inserts one in-app notification per receiver, then fires FCM push. */
  async notifyUsers(receivers: Receiver[], payload: NotificationPayload): Promise<void> {
    if (receivers.length === 0) return;

    const userDocs = await User.find({ _id: { $in: receivers.map((r) => r.id) } })
      .select('_id role fcmTokens')
      .lean();

    const tokenMap = new Map<string, typeof userDocs[number]>();
    for (const u of userDocs) tokenMap.set(u._id.toString(), u);

    const created: { receiver: Receiver; id: mongoose.Types.ObjectId }[] = [];
    for (const receiver of receivers) {
      const dedupKey = payload.dedupKey ? `${payload.dedupKey}:${receiver.id}` : undefined;
      const { doc, isNew } = await createOnce(receiver, payload, dedupKey);
      if (isNew) created.push({ receiver, id: doc._id as mongoose.Types.ObjectId });
    }
    if (created.length === 0) return; // every recipient already had this exact notification

    const receiversWithTokens: ReceiverWithTokens[] = created.map(({ receiver }) => ({
      ...receiver,
      fcmTokens: tokenMap.get(receiver.id)?.fcmTokens ?? [],
    }));
    const ids = created.map((c) => c.id);

    // Fire-and-forget FCM push (never block the API response)
    dispatchPush(receiversWithTokens, payload, ids).catch((err) =>
      console.error('[push] dispatchPush error:', err),
    );
  },

  async notifyUser(receiver: Receiver, payload: NotificationPayload): Promise<void> {
    const dedupKey = payload.dedupKey ? `${payload.dedupKey}:${receiver.id}` : undefined;
    const { doc, isNew } = await createOnce(receiver, payload, dedupKey);
    if (!isNew) return; // already delivered — do not push again

    const userDoc = await User.findById(receiver.id).select('fcmTokens').lean();
    if (userDoc?.fcmTokens?.length) {
      const id = doc._id as mongoose.Types.ObjectId;
      dispatchPush([{ ...receiver, fcmTokens: userDoc.fcmTokens }], payload, [id]).catch((err) =>
        console.error('[push] dispatchPush error:', err),
      );
    }
  },

  /**
   * Schedules the one allowed exception to "send once": a reminder that fires at a
   * specific future time. Resets `followUpSent` so re-scheduling (e.g. pushing the date
   * out) is safe even if a previous reminder on this notification already fired.
   */
  async scheduleFollowUp(id: string, followUpDate: Date, actor: Actor) {
    const filter: Record<string, unknown> = { _id: id };
    if (actor.role !== ROLES.SUPER_ADMIN) filter.receiver = actor.id;
    const notification = await Notification.findOneAndUpdate(
      filter,
      { followUpDate, followUpSent: false },
      { new: true },
    );
    if (!notification) throw ApiError.notFound('Notification not found');
    return notification;
  },

  /**
   * Reminder scheduler's core tick. Claims each due, not-yet-sent follow-up atomically
   * (`findOneAndUpdate` filtering on `followUpSent: false` in the same operation that sets
   * it true) so two overlapping ticks — or a tick that races a server restart — can never
   * both claim the same reminder. Safe to call on every server boot: it only ever acts on
   * documents whose `followUpSent` is still false, which a past successful run always flips.
   */
  async processFollowUpReminders(): Promise<number> {
    const due = await Notification.find({
      followUpDate: { $lte: new Date() },
      followUpSent: false,
      isDeleted: { $ne: true },
    }).select('_id title message module relatedRecord receiver receiverRole');

    let sent = 0;
    for (const original of due) {
      const claimed = await Notification.findOneAndUpdate(
        { _id: original._id, followUpSent: false },
        { followUpSent: true },
        { new: true },
      );
      if (!claimed) continue; // another tick already claimed it

      await notificationService.notifyUser(
        { id: original.receiver.toString(), role: original.receiverRole },
        {
          title: 'Reminder',
          message: `Reminder: ${original.title} — ${original.message}`,
          module: original.module,
          relatedRecord: String(original.relatedRecord),
          notificationType: 'reminder',
          dedupKey: `reminder:${original._id}`,
        },
      ).catch((err) => console.error('[reminder] notifyUser error:', err));
      sent += 1;
    }
    return sent;
  },

  /** Every active user of a role — same idiom as quotation.service.ts's Director roster lookup. */
  async findActiveUsersByRole(role: Role): Promise<Receiver[]> {
    const users = await User.find({ role, isActive: true }).select('_id role').lean();
    return users.map((user) => ({ id: user._id.toString(), role: user.role }));
  },

  /** List notifications — Super Admin sees all; others see only their own. Excludes soft-deleted. */
  async list(query: Record<string, unknown>, actor: Actor) {
    const pagination = parsePagination(query);
    const filter: Record<string, unknown> =
      actor.role === ROLES.SUPER_ADMIN
        ? { isDeleted: { $ne: true } }
        : { receiver: actor.id, isDeleted: { $ne: true } };

    if (query.module) filter.module = query.module;
    if (query.isRead !== undefined) filter.isRead = query.isRead === 'true';
    if (query.isArchived !== undefined) filter.isArchived = query.isArchived === 'true';
    if (query.isPinned !== undefined) filter.isPinned = query.isPinned === 'true';
    if (query.priority) filter.priority = query.priority;
    if (query.since) filter.createdAt = { $gte: new Date(query.since as string) };
    if (query.search) {
      const search = String(query.search).trim();
      if (search) {
        const regex = new RegExp(escapeRegex(search), 'i');
        filter.$or = [{ title: regex }, { message: regex }];
      }
    }

    const [items, total] = await Promise.all([
      Notification.find(filter)
        .sort({ createdAt: -1 })
        .skip(pagination.skip)
        .limit(pagination.limit),
      Notification.countDocuments(filter),
    ]);

    return { items, meta: buildPaginationMeta(total, pagination) };
  },

  async getUnreadCount(actor: Actor) {
    const filter: Record<string, unknown> =
      actor.role === ROLES.SUPER_ADMIN
        ? { isRead: false, isDeleted: { $ne: true } }
        : { receiver: actor.id, isRead: false, isDeleted: { $ne: true } };
    const count = await Notification.countDocuments(filter);
    return { count };
  },

  async markRead(id: string, actor: Actor) {
    // Super Admin's unread count/list are org-wide (see getUnreadCount/list above), so they
    // must be able to mark ANY notification read, not just their own — mirrors that same
    // scoping exception. Without this, marking read on someone else's notification 404'd here,
    // silently (the frontend swallows the error), leaving the Super Admin's badge stuck.
    const filter: Record<string, unknown> = actor.role === ROLES.SUPER_ADMIN ? { _id: id } : { _id: id, receiver: actor.id };
    const notification = await Notification.findOneAndUpdate(
      filter,
      { isRead: true, status: 'read', clickedAt: new Date() },
      { new: true },
    );
    if (!notification) throw ApiError.notFound('Notification not found');
    return notification;
  },

  async markAllRead(actor: Actor) {
    const filter: Record<string, unknown> =
      actor.role === ROLES.SUPER_ADMIN ? { isRead: false } : { receiver: actor.id, isRead: false };
    await Notification.updateMany(filter, { isRead: true, status: 'read' });
  },

  async archive(id: string, actor: Actor) {
    const notification = await Notification.findOneAndUpdate(
      { _id: id, receiver: actor.id },
      { isArchived: true },
      { new: true },
    );
    if (!notification) throw ApiError.notFound('Notification not found');
    return notification;
  },

  async pin(id: string, actor: Actor) {
    const notification = await Notification.findOneAndUpdate(
      { _id: id, receiver: actor.id },
      { isPinned: true },
      { new: true },
    );
    if (!notification) throw ApiError.notFound('Notification not found');
    return notification;
  },

  async unpin(id: string, actor: Actor) {
    const notification = await Notification.findOneAndUpdate(
      { _id: id, receiver: actor.id },
      { isPinned: false },
      { new: true },
    );
    if (!notification) throw ApiError.notFound('Notification not found');
    return notification;
  },

  async softDelete(id: string, actor: Actor) {
    const notification = await Notification.findOneAndUpdate(
      { _id: id, receiver: actor.id },
      { isDeleted: true },
      { new: true },
    );
    if (!notification) throw ApiError.notFound('Notification not found');
    return notification;
  },

  async deleteAll(actor: Actor) {
    await Notification.updateMany({ receiver: actor.id }, { isDeleted: true });
  },

  /** Super Admin only: broadcast to all users or filtered by role/department. */
  async broadcast(
    payload: {
      title: string;
      message: string;
      targetRoles?: Role[];
      targetUserIds?: string[];
    },
    actor: Actor,
  ) {
    if (actor.role !== ROLES.SUPER_ADMIN) throw ApiError.forbidden('Super Admin only');

    const userFilter: Record<string, unknown> = { isActive: true };
    if (payload.targetUserIds?.length) {
      userFilter._id = { $in: payload.targetUserIds };
    } else if (payload.targetRoles?.length) {
      userFilter.role = { $in: payload.targetRoles };
    }

    const users = await User.find(userFilter).select('_id role fcmTokens').lean();

    const notificationPayload: NotificationPayload = {
      title: payload.title,
      message: payload.message,
      module: 'system',
      relatedRecord: actor.id,
      notificationType: 'broadcast',
      priority: 'high',
      category: 'information',
      sender: actor.id,
    };

    await Notification.insertMany(
      users.map((u) => ({
        ...notificationPayload,
        receiver: u._id,
        receiverRole: u.role,
      })),
    );

    const receiversWithTokens: ReceiverWithTokens[] = users.map((u) => ({
      id: u._id.toString(),
      role: u.role,
      fcmTokens: u.fcmTokens,
    }));

    dispatchPush(receiversWithTokens, notificationPayload).catch((err) =>
      console.error('[push] broadcast push error:', err),
    );

    return { sent: users.length };
  },

  /** Mark push as delivered when the user taps the notification from the system tray. */
  async recordDelivery(id: string, actor: Actor) {
    const notification = await Notification.findOneAndUpdate(
      { _id: id, receiver: actor.id },
      { isRead: true, clickedAt: new Date(), pushDeliveryStatus: 'sent', isPushSent: true },
      { new: true },
    );
    if (!notification) throw ApiError.notFound('Notification not found');
    return notification;
  },

  async getAnalytics(actor: Actor) {
    if (actor.role !== ROLES.SUPER_ADMIN) throw ApiError.forbidden('Super Admin only');

    const [total, delivered, read, failed] = await Promise.all([
      Notification.countDocuments(),
      Notification.countDocuments({ isPushSent: true }),
      Notification.countDocuments({ isRead: true }),
      Notification.countDocuments({ isPushSent: false }),
    ]);

    const readPercentage = total > 0 ? Math.round((read / total) * 100) : 0;

    return { total, delivered, read, unread: total - read, failed, readPercentage };
  },
};
