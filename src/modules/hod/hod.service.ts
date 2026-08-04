import { ROLES } from '@/constants/roles';
import { departmentService } from '@/modules/department/department.service';
import { User } from '@/modules/user/user.model';
import { userService } from '@/modules/user/user.service';
import type { HodCreateUserInput, HodUpdateUserInput } from '@/modules/hod/hod.validation';
import type { Actor } from '@/types/actor';
import { ApiError } from '@/utils/ApiError';

/** Confirms `id` refers to a Department User inside the HOD's own department — 404 if the
 *  user doesn't exist at all, 403 if they exist but are out of the HOD's jurisdiction. Never
 *  trusts a department id from the client; `actor.department` always comes from the JWT. */
async function assertOwnDepartmentUser(id: string, actor: Actor): Promise<void> {
  const target = await User.findById(id).select('role department');
  if (!target) throw ApiError.notFound('User not found');
  if (target.role !== ROLES.DEPARTMENT_USER || String(target.department) !== actor.department) {
    throw ApiError.forbidden('You can only manage users in your own department');
  }
}

export const hodService = {
  createUser(input: HodCreateUserInput, actor: Actor) {
    if (!actor.department) throw ApiError.forbidden('Your HOD account has no department assigned');
    return userService.create({ ...input, role: ROLES.DEPARTMENT_USER, department: actor.department });
  },

  listUsers(query: Record<string, unknown>, actor: Actor) {
    return userService.list({ ...query, role: ROLES.DEPARTMENT_USER, department: actor.department });
  },

  async getUser(id: string, actor: Actor) {
    await assertOwnDepartmentUser(id, actor);
    return userService.getById(id);
  },

  async updateUser(id: string, input: HodUpdateUserInput, actor: Actor) {
    await assertOwnDepartmentUser(id, actor);
    return userService.update(id, { ...input, role: ROLES.DEPARTMENT_USER, department: actor.department });
  },

  async setUserStatus(id: string, isActive: boolean, actor: Actor) {
    await assertOwnDepartmentUser(id, actor);
    return userService.setStatus(id, isActive);
  },

  async resetUserPassword(id: string, newPassword: string, actor: Actor) {
    await assertOwnDepartmentUser(id, actor);
    return userService.resetPassword(id, newPassword);
  },

  async deactivateUser(id: string, actor: Actor) {
    await assertOwnDepartmentUser(id, actor);
    return userService.deactivate(id);
  },

  /** Bulk activate/deactivate — scoped to the HOD's own department's Department Users only,
   *  regardless of which ids were sent (never trusts the client's department claim). */
  async bulkSetUserStatus(ids: string[], isActive: boolean, actor: Actor) {
    if (!actor.department) throw ApiError.forbidden('Your HOD account has no department assigned');
    const { matched } = await userService.bulkSetStatus(ids, isActive, { role: ROLES.DEPARTMENT_USER, department: actor.department });
    return { matched };
  },

  getOwnDepartment(actor: Actor) {
    if (!actor.department) throw ApiError.forbidden('Your HOD account has no department assigned');
    return departmentService.getById(actor.department);
  },

  getOwnAnalytics(actor: Actor) {
    if (!actor.department) throw ApiError.forbidden('Your HOD account has no department assigned');
    return departmentService.getAnalytics(actor.department);
  },
};
