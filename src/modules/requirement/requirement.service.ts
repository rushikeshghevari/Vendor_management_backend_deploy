import { Types } from 'mongoose';

import { ROLES } from '@/constants/roles';
import { REQUIREMENT_STATUS } from '@/constants/status';
import { Department } from '@/modules/department/department.model';
import { Quotation } from '@/modules/quotation/quotation.model';
import { Requirement } from '@/modules/requirement/requirement.model';
import type { CreateRequirementInput, UpdateRequirementInput } from '@/modules/requirement/requirement.validation';
import type { Actor } from '@/types/actor';
import { ApiError } from '@/utils/ApiError';
import { escapeRegex } from '@/utils/escapeRegex';
import { buildPaginationMeta, parsePagination } from '@/utils/pagination';
import { nextSequence, seedSequenceFromExisting } from '@/utils/sequence.model';

const EDITABLE_STATUSES = [REQUIREMENT_STATUS.DRAFT];

/**
 * Requirement code = department prefix + "-REQ" + a zero-padded running number, unique per
 * department. Same atomic-counter idiom as `generateQuotationCode` in quotation.service.ts —
 * sourced from `nextSequence` rather than counting existing documents, so two Department
 * Users creating a requirement at the same instant can never be handed the same code.
 */
async function generateRequirementCode(departmentId: string): Promise<string> {
  const department = await Department.findById(departmentId).select('code');
  if (!department) throw ApiError.badRequest('Department not found for this requirement');

  const prefix = (department.code.match(/^[A-Za-z]+/)?.[0] ?? 'REQ').toUpperCase();
  const codePrefix = `${prefix}-REQ`;
  const counterKey = `requirement:${codePrefix}`;

  await seedSequenceFromExisting(counterKey, async () => {
    const existingCodes = await Requirement.find({ requirementNumber: new RegExp(`^${codePrefix}\\d+$`) })
      .select('requirementNumber')
      .lean();
    return existingCodes.reduce((max, item) => {
      const num = parseInt(item.requirementNumber.slice(codePrefix.length), 10);
      return Number.isFinite(num) && num > max ? num : max;
    }, 0);
  });

  const sequence = await nextSequence(counterKey);
  return `${codePrefix}${String(sequence).padStart(3, '0')}`;
}

/**
 * Read-visibility filter — a Department User sees only requirements they personally
 * created; an HOD sees every requirement in their department (read-only per Phase 1 —
 * see docs/PHASE1_REQUIREMENT_MODULE.md); a Director sees everything (read-only, no
 * scoping — will narrow to "awaiting comparison" once that step exists); Super Admin
 * sees everything.
 */
function scopeToOwner(actor: Actor, filter: Record<string, unknown>): void {
  if (actor.role === ROLES.DEPARTMENT_USER) {
    filter.createdBy = actor.id;
  } else if (actor.role === ROLES.HOD) {
    filter.department = actor.department;
  }
}

/**
 * Mutation-scope filter — only a Department User (their own records) or Super Admin (any
 * record) can write. HOD has no write access in Phase 1 (view + optional approval is
 * deferred — see docs/PHASE1_REQUIREMENT_MODULE.md), so it is deliberately absent here.
 */
function ownershipFilter(actor: Actor): Record<string, unknown> {
  return actor.role === ROLES.SUPER_ADMIN ? {} : { createdBy: actor.id };
}

export const requirementService = {
  async create(input: CreateRequirementInput, actor: Actor) {
    if (actor.role !== ROLES.DEPARTMENT_USER && actor.role !== ROLES.SUPER_ADMIN) {
      throw ApiError.forbidden('Only a Department User can create a requirement');
    }
    if (!actor.department) {
      throw ApiError.badRequest('You must belong to a department to create a requirement');
    }

    const requirementNumber = await generateRequirementCode(actor.department);

    const items = input.items.map((item) => ({
      ...item,
      estimatedAmount: item.estimatedAmount || item.quantity * item.estimatedRate,
    }));

    return Requirement.create({
      ...input,
      items,
      requirementNumber,
      department: actor.department,
      createdBy: actor.id,
      status: REQUIREMENT_STATUS.DRAFT,
    });
  },

  async list(query: Record<string, unknown>, actor: Actor) {
    const pagination = parsePagination(query);
    const filter: Record<string, unknown> = { isDeleted: { $ne: true } };

    if (query.status) filter.status = query.status;
    if (query.priority) filter.priority = query.priority;
    if (query.department && actor.role === ROLES.SUPER_ADMIN) filter.department = query.department;
    if (query.search) {
      filter.$or = [
        { requirementNumber: new RegExp(escapeRegex(String(query.search).trim()), 'i') },
        { title: new RegExp(escapeRegex(String(query.search).trim()), 'i') },
      ];
    }

    scopeToOwner(actor, filter);

    const [items, total] = await Promise.all([
      Requirement.find(filter)
        .populate('department', 'name code')
        .populate('createdBy', 'name email')
        .populate('submittedBy', 'name email')
        .sort({ createdAt: -1 })
        .skip(pagination.skip)
        .limit(pagination.limit),
      Requirement.countDocuments(filter),
    ]);

    // One grouped query for the whole page rather than a per-item count — stays bounded by
    // `pagination.limit` (same page size as the `items` query above), never N+1.
    const quotationCounts = await Quotation.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { requirement: { $in: items.map((item) => item._id) }, isDeleted: { $ne: true } } },
      { $group: { _id: '$requirement', count: { $sum: 1 } } },
    ]);
    const countByRequirement = new Map(quotationCounts.map((entry) => [entry._id.toString(), entry.count]));

    const itemsWithQuotationCount = items.map((item) => ({
      ...item.toJSON(),
      quotationCount: countByRequirement.get(item._id.toString()) ?? 0,
    }));

    return { items: itemsWithQuotationCount, meta: buildPaginationMeta(total, pagination) };
  },

  async getById(id: string, actor: Actor) {
    const filter: Record<string, unknown> = { _id: id, isDeleted: { $ne: true } };
    scopeToOwner(actor, filter);

    const requirement = await Requirement.findOne(filter)
      .populate('department', 'name code')
      .populate('createdBy', 'name email')
      .populate('submittedBy', 'name email');

    if (!requirement) throw ApiError.notFound('Requirement not found');
    return requirement;
  },

  async update(id: string, input: UpdateRequirementInput, actor: Actor) {
    if (actor.role !== ROLES.DEPARTMENT_USER && actor.role !== ROLES.SUPER_ADMIN) {
      throw ApiError.forbidden('Only a Department User can edit a requirement');
    }

    const items = input.items?.map((item) => ({
      ...item,
      estimatedAmount: item.estimatedAmount || item.quantity * item.estimatedRate,
    }));

    const requirement = await Requirement.findOneAndUpdate(
      {
        _id: id,
        ...ownershipFilter(actor),
        status: { $in: EDITABLE_STATUSES },
        isDeleted: { $ne: true },
      },
      { ...input, ...(items ? { items } : {}) },
      { new: true, runValidators: true },
    );
    if (!requirement) {
      throw ApiError.notFound('Requirement not found, or it is no longer editable');
    }
    return requirement;
  },

  async submit(id: string, actor: Actor) {
    if (actor.role !== ROLES.DEPARTMENT_USER && actor.role !== ROLES.SUPER_ADMIN) {
      throw ApiError.forbidden('Only a Department User can submit a requirement');
    }

    const requirement = await Requirement.findOneAndUpdate(
      { _id: id, ...ownershipFilter(actor), status: REQUIREMENT_STATUS.DRAFT, isDeleted: { $ne: true } },
      { status: REQUIREMENT_STATUS.SUBMITTED, submittedAt: new Date(), submittedBy: actor.id },
      { new: true },
    )
      .populate('department', 'name hod')
      .populate('createdBy', 'name')
      .populate('submittedBy', 'name');
    if (!requirement) {
      throw ApiError.notFound('Requirement not found, or it is not in Draft status');
    }
    return requirement;
  },

  /**
   * The Department User explicitly hands the requirement over to the Director — the only way
   * a requirement ever enters Director Review from here on. Locks quotation upload (see the
   * `createForRequirement` status gate in quotation.service.ts) and is the trigger point for
   * the `requirement_ready_for_review` notification (moved here from "first quotation
   * uploaded" — see requirement.controller.ts). Reachable an unlimited number of times: a
   * Director's "Send Back" decision returns the requirement to QUOTATION_COLLECTION, and the
   * Department User can submit again after revising.
   */
  async submitToDirector(id: string, actor: Actor) {
    if (actor.role !== ROLES.DEPARTMENT_USER && actor.role !== ROLES.SUPER_ADMIN) {
      throw ApiError.forbidden('Only a Department User can submit a requirement to the Director');
    }

    const requirement = await Requirement.findOne({
      _id: id,
      ...ownershipFilter(actor),
      status: REQUIREMENT_STATUS.QUOTATION_COLLECTION,
      isDeleted: { $ne: true },
    });
    if (!requirement) {
      throw ApiError.notFound('Requirement not found, or it is not currently collecting quotations');
    }

    const hasQuotation = await Quotation.exists({ requirement: id, isDeleted: { $ne: true } });
    if (!hasQuotation) {
      throw ApiError.badRequest('Add at least one quotation before submitting to the Director');
    }

    requirement.status = REQUIREMENT_STATUS.QUOTATION_COMPARISON;
    await requirement.save();
    await requirement.populate([
      { path: 'department', select: 'name hod' },
      { path: 'createdBy', select: 'name' },
      { path: 'submittedBy', select: 'name' },
    ]);

    return requirement;
  },

  /** Soft delete — Draft only, per the Draft business rules (mirrors quotationService.remove). */
  async remove(id: string, actor: Actor) {
    if (actor.role !== ROLES.DEPARTMENT_USER && actor.role !== ROLES.SUPER_ADMIN) {
      throw ApiError.forbidden('Only a Department User can delete a requirement');
    }

    const requirement = await Requirement.findOneAndUpdate(
      { _id: id, ...ownershipFilter(actor), status: REQUIREMENT_STATUS.DRAFT, isDeleted: { $ne: true } },
      { isDeleted: true },
      { new: true },
    );
    if (!requirement) {
      throw ApiError.notFound('Requirement not found, or only a Draft requirement can be deleted');
    }
    return requirement;
  },
};
