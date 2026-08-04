import { ROLES, type Role } from '@/constants/roles';
import { Department } from '@/modules/department/department.model';
import { Vendor } from '@/modules/vendor/vendor.model';
import type { CreateVendorInput, UpdateVendorInput } from '@/modules/vendor/vendor.validation';
import type { Actor } from '@/types/actor';
import { ApiError } from '@/utils/ApiError';
import { escapeRegex } from '@/utils/escapeRegex';
import { buildPaginationMeta, parsePagination } from '@/utils/pagination';
import { nextSequence, seedSequenceFromExisting } from '@/utils/sequence.model';

/** Department User and HOD may both create/manage vendor records. */
const VENDOR_WRITE_ROLES: Role[] = [ROLES.DEPARTMENT_USER, ROLES.HOD];

/**
 * Vendor visibility is per-creator for a Department User — they see and manage only the
 * vendors they personally registered, not every vendor in their department. An HOD, by
 * contrast, oversees the whole department and sees every vendor in it regardless of who
 * registered it. Super Admin (and any other role) is left unscoped.
 */
function scopeToOwner(actor: Actor, filter: Record<string, unknown>) {
  if (actor.role === ROLES.DEPARTMENT_USER) {
    filter.createdBy = actor.id;
  } else if (actor.role === ROLES.HOD) {
    filter.department = actor.department;
  }
}

/**
 * Vendor code = department prefix (the leading letters of the department's own code,
 * e.g. "PUR-001" / "PUR001" -> "PUR") + "-VEN" + a zero-padded running number, unique
 * per department. Sourced from an atomic counter so two Department Users registering a
 * vendor at the same instant can never be handed the same code.
 */
export async function generateVendorCode(departmentId: string): Promise<string> {
  const department = await Department.findById(departmentId).select('code');
  if (!department) throw ApiError.badRequest('Department not found for this vendor');

  const prefix = (department.code.match(/^[A-Za-z]+/)?.[0] ?? 'VEN').toUpperCase();
  const codePrefix = `${prefix}-VEN`;
  const counterKey = `vendor:${codePrefix}`;

  await seedSequenceFromExisting(counterKey, async () => {
    const existingCodes = await Vendor.find({ code: new RegExp(`^${codePrefix}\\d+$`) })
      .select('code')
      .lean();
    return existingCodes.reduce((max, item) => {
      const num = parseInt(item.code.slice(codePrefix.length), 10);
      return Number.isFinite(num) && num > max ? num : max;
    }, 0);
  });

  const sequence = await nextSequence(counterKey);
  return `${codePrefix}${String(sequence).padStart(3, '0')}`;
}

export const vendorService = {
  async create(input: CreateVendorInput, actor: Actor) {
    if (!VENDOR_WRITE_ROLES.includes(actor.role) || !actor.department) {
      throw ApiError.forbidden('Only a Department User or HOD can register a vendor');
    }

    const code = await generateVendorCode(actor.department);

    return Vendor.create({
      ...input,
      gstNumber: input.gstNumber || undefined,
      panNumber: input.panNumber || undefined,
      code,
      department: actor.department,
      createdBy: actor.id,
    });
  },

  async list(query: Record<string, unknown>, actor: Actor) {
    const pagination = parsePagination(query);
    const filter: Record<string, unknown> = {};

    if (query.department) filter.department = query.department;
    if (query.category) filter.category = query.category;
    if (query.status) filter.status = query.status;
    if (query.search) {
      const search = escapeRegex(String(query.search).trim());
      filter.$or = [
        { name: new RegExp(search, 'i') },
        { code: new RegExp(search, 'i') },
        { gstNumber: new RegExp(search, 'i') },
        { phone: new RegExp(search, 'i') },
      ];
    }

    scopeToOwner(actor, filter);

    const [items, total] = await Promise.all([
      Vendor.find(filter)
        .populate('department', 'name code')
        .populate('createdBy', 'name email')
        .sort({ createdAt: -1 })
        .skip(pagination.skip)
        .limit(pagination.limit),
      Vendor.countDocuments(filter),
    ]);

    return { items, meta: buildPaginationMeta(total, pagination) };
  },

  async getById(id: string, actor: Actor) {
    const filter: Record<string, unknown> = { _id: id };
    scopeToOwner(actor, filter);

    const vendor = await Vendor.findOne(filter)
      .populate('department', 'name code')
      .populate('createdBy', 'name email');
    if (!vendor) throw ApiError.notFound('Vendor not found');
    return vendor;
  },

  async update(id: string, input: UpdateVendorInput, actor: Actor) {
    if (!VENDOR_WRITE_ROLES.includes(actor.role)) {
      throw ApiError.forbidden('Only a Department User or HOD can update a vendor');
    }

    const filter: Record<string, unknown> = { _id: id };
    scopeToOwner(actor, filter);

    const update = {
      ...input,
      gstNumber: input.gstNumber || undefined,
      panNumber: input.panNumber || undefined,
    };

    const vendor = await Vendor.findOneAndUpdate(filter, update, { new: true, runValidators: true });
    if (!vendor) throw ApiError.notFound('Vendor not found');
    return vendor;
  },

  async setStatus(id: string, status: string, actor: Actor) {
    if (!VENDOR_WRITE_ROLES.includes(actor.role)) {
      throw ApiError.forbidden('Only a Department User or HOD can change a vendor status');
    }

    const filter: Record<string, unknown> = { _id: id };
    scopeToOwner(actor, filter);

    const vendor = await Vendor.findOneAndUpdate(filter, { status }, { new: true });
    if (!vendor) throw ApiError.notFound('Vendor not found');
    return vendor;
  },

  /** Soft delete — status becomes "inactive"; the record is never removed. */
  async remove(id: string, actor: Actor) {
    if (!VENDOR_WRITE_ROLES.includes(actor.role)) {
      throw ApiError.forbidden('Only a Department User or HOD can delete a vendor');
    }

    const filter: Record<string, unknown> = { _id: id };
    scopeToOwner(actor, filter);

    const vendor = await Vendor.findOneAndUpdate(filter, { status: 'inactive' }, { new: true });
    if (!vendor) throw ApiError.notFound('Vendor not found');
    return vendor;
  },
};
