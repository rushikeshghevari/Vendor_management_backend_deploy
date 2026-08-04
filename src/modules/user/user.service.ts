import { ROLES } from '@/constants/roles';
import { Department } from '@/modules/department/department.model';
import { User } from '@/modules/user/user.model';
import type { CreateUserInput, UpdateUserInput } from '@/modules/user/user.validation';
import { ApiError } from '@/utils/ApiError';
import { escapeRegex } from '@/utils/escapeRegex';
import { buildPaginationMeta, parsePagination } from '@/utils/pagination';

/** Department User and HOD are the only roles that belong to a department. */
const DEPARTMENT_SCOPED_ROLES: string[] = [ROLES.DEPARTMENT_USER, ROLES.HOD];

const SORTABLE_FIELDS = new Set(['name', 'email', 'createdAt']);

export const userService = {
  async create(input: CreateUserInput) {
    const existing = await User.findOne({ email: input.email });
    if (existing) throw ApiError.conflict('A user with this email already exists');

    const payload = { ...input };
    if (!DEPARTMENT_SCOPED_ROLES.includes(payload.role)) payload.department = undefined;
    if (payload.role === ROLES.CEO) await assertNoActiveCeo();

    const user = await User.create(payload);
    return user.toObject({ transform: stripPassword });
  },

  async list(query: Record<string, unknown>) {
    const pagination = parsePagination(query);
    const filter: Record<string, unknown> = {};
    if (query.role) filter.role = query.role;
    if (query.department) filter.department = query.department;
    if (query.isActive !== undefined) filter.isActive = query.isActive === 'true';
    if (query.search) {
      const regex = new RegExp(escapeRegex(String(query.search).trim()), 'i');
      filter.$or = [{ name: regex }, { email: regex }];
    }

    const sortField = typeof query.sort === 'string' && SORTABLE_FIELDS.has(query.sort) ? query.sort : 'createdAt';
    const sortOrder = query.order === 'asc' ? 1 : -1;

    const [items, total] = await Promise.all([
      User.find(filter)
        .populate('department', 'name code')
        .sort({ [sortField]: sortOrder })
        .skip(pagination.skip)
        .limit(pagination.limit),
      User.countDocuments(filter),
    ]);

    return { items, meta: buildPaginationMeta(total, pagination) };
  },

  /** Bulk activate/deactivate — a single `updateMany` (not a per-id loop) to avoid N+1 writes.
   *  Returns the matched ids so the caller can activity-log/notify each one. */
  async bulkSetStatus(ids: string[], isActive: boolean, filter: Record<string, unknown> = {}) {
    if (!isActive) {
      const superAdminConflict = await User.exists({ _id: { $in: ids }, ...filter, role: ROLES.SUPER_ADMIN });
      if (superAdminConflict) throw ApiError.forbidden('The primary Super Admin account cannot be deactivated');

      const hodConflict = await Department.exists({ hod: { $in: ids }, isActive: true });
      if (hodConflict) throw ApiError.conflict('One or more selected users is an active department HOD — transfer HOD ownership before deactivating them');
    }

    const matched = await User.find({ _id: { $in: ids }, ...filter }).select('_id role department');
    if (matched.length === 0) return { matched: [] };

    const matchedIds = matched.map((doc) => String(doc._id));
    await User.updateMany({ _id: { $in: matchedIds } }, { isActive });

    return {
      matched: matched.map((doc) => ({
        id: String(doc._id),
        role: doc.role,
        department: doc.department ? String(doc.department) : undefined,
      })),
    };
  },

  async getById(id: string) {
    const user = await User.findById(id).populate('department', 'name code');
    if (!user) throw ApiError.notFound('User not found');
    return user;
  },

  async update(id: string, input: UpdateUserInput) {
    const existing = await User.findById(id).select('role isActive');
    if (!existing) throw ApiError.notFound('User not found');

    const payload = { ...input };
    const nextRole = payload.role ?? existing.role;
    if (!DEPARTMENT_SCOPED_ROLES.includes(nextRole)) payload.department = undefined;

    const nextIsActive = payload.isActive ?? existing.isActive;
    if (nextRole === ROLES.CEO && nextIsActive) await assertNoActiveCeo(id);

    const user = await User.findByIdAndUpdate(id, payload, { new: true, runValidators: true });
    if (!user) throw ApiError.notFound('User not found');
    return user;
  },

  async setStatus(id: string, isActive: boolean) {
    if (!isActive) {
      await assertNotSuperAdmin(id);
      await assertNotActiveHod(id);
    }
    if (isActive) {
      const target = await User.findById(id).select('role');
      if (target?.role === ROLES.CEO) await assertNoActiveCeo(id);
    }
    const user = await User.findByIdAndUpdate(id, { isActive }, { new: true });
    if (!user) throw ApiError.notFound('User not found');
    return user;
  },

  async deactivate(id: string) {
    await assertNotSuperAdmin(id);
    await assertNotActiveHod(id);
    const user = await User.findByIdAndUpdate(id, { isActive: false }, { new: true });
    if (!user) throw ApiError.notFound('User not found');
    return user;
  },

  async changePassword(id: string, currentPassword: string, newPassword: string) {
    const user = await User.findById(id).select('+password');
    if (!user) throw ApiError.notFound('User not found');

    const matches = await user.comparePassword(currentPassword);
    if (!matches) throw ApiError.badRequest('Current password is incorrect');

    user.password = newPassword;
    await user.save();
  },

  /** Admin-initiated reset — sets a new password directly, no current password required. */
  async resetPassword(id: string, newPassword: string) {
    const user = await User.findById(id);
    if (!user) throw ApiError.notFound('User not found');

    user.password = newPassword;
    await user.save();
  },
};

function stripPassword(_doc: unknown, ret: Record<string, unknown>) {
  delete ret.password;
  return ret;
}

async function assertNotSuperAdmin(id: string): Promise<void> {
  const user = await User.findById(id).select('role');
  if (user?.role === ROLES.SUPER_ADMIN) {
    throw ApiError.forbidden('The primary Super Admin account cannot be deleted');
  }
}

/** A user currently referenced as a department's active HOD must be transferred away first —
 *  otherwise the department would be left pointing at a deactivated account. */
async function assertNotActiveHod(id: string): Promise<void> {
  const department = await Department.exists({ hod: id, isActive: true });
  if (department) {
    throw ApiError.conflict('This user is the active HOD of a department — transfer HOD ownership before deactivating them');
  }
}

/** Only one CEO may be active at a time — `excludeId` lets editing/reactivating the existing CEO not self-conflict. */
async function assertNoActiveCeo(excludeId?: string): Promise<void> {
  const filter: Record<string, unknown> = { role: ROLES.CEO, isActive: true };
  if (excludeId) filter._id = { $ne: excludeId };
  const existing = await User.findOne(filter).select('_id');
  if (existing) {
    throw ApiError.conflict('An active CEO already exists. Deactivate the existing CEO before creating a new one.');
  }
}
