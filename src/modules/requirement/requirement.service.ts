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

/** Falls back to a readable label built from the item names when the requester didn't type a title. */
function deriveTitleFromItems(items: { itemName: string }[]): string {
  const names = items.map((item) => item.itemName);
  if (names.length <= 2) return names.join(' & ');
  return `${names.slice(0, 2).join(', ')} +${names.length - 2} more`;
}

/** Merges another AND-ed condition into `filter` without clobbering one already there (e.g.
 *  `list()`'s search `$or` and a role's own `$or` scoping would otherwise collide on the same
 *  top-level `$or` key — each gets its own `$and` entry instead). */
function addAndCondition(filter: Record<string, unknown>, condition: Record<string, unknown>): void {
  const existing = filter.$and as Record<string, unknown>[] | undefined;
  filter.$and = existing ? [...existing, condition] : [condition];
}

/** Matches a requirement currently sitting in `actor.department` that was routed in from a
 *  *different* department (`requestedByDepartment` — see requirement.model.ts — differs from
 *  the current `department`), as opposed to one of the department's own peers' own requests.
 *  Shared by every "widen access for the receiving department" check below so a plain
 *  same-department co-worker's own requirement stays private, matching the pre-routing
 *  behavior, while a genuinely routed-in one opens up. */
function routedIntoOwnDepartment(actor: Actor): Record<string, unknown> {
  return { department: actor.department, requestedByDepartment: { $ne: actor.department } };
}

/**
 * Read-visibility filter — a Department User sees requirements they personally created, plus
 * any routed into their own department by another department's user (see `targetDepartment`
 * in requirement.validation.ts) — once routed, the receiving department owns it operationally
 * even though someone else originally requested it. A same-department co-worker's own
 * requirement stays invisible, same as before this existed. An HOD sees every requirement in
 * their department (read-only per Phase 1 — see docs/PHASE1_REQUIREMENT_MODULE.md); a Director
 * sees everything (read-only, no scoping — will narrow to "awaiting comparison" once that step
 * exists); Super Admin sees everything.
 */
function scopeToOwner(actor: Actor, filter: Record<string, unknown>): void {
  if (actor.role === ROLES.DEPARTMENT_USER) {
    addAndCondition(filter, { $or: [{ createdBy: actor.id }, routedIntoOwnDepartment(actor)] });
  } else if (actor.role === ROLES.HOD) {
    filter.department = actor.department;
  }
}

/**
 * Mutation-scope filter for draft-stage actions (edit/submit/delete) — only the Department
 * User who personally created the requirement (or Super Admin) may still touch it while it's
 * a draft. HOD has no write access here in Phase 1 (view + optional approval is deferred —
 * see docs/PHASE1_REQUIREMENT_MODULE.md).
 */
function ownershipFilter(actor: Actor): Record<string, unknown> {
  return actor.role === ROLES.SUPER_ADMIN ? {} : { createdBy: actor.id };
}

/**
 * Mutation-scope filter for `submitToDirector` specifically — by this stage the requirement
 * has already left the creator's hands and is being actively worked by whichever department
 * it's currently sitting in: its own team, or (only when genuinely routed in — see
 * `routedIntoOwnDepartment`) another department's. HOD is included here (unlike
 * `ownershipFilter`) because HOD already does real write work at this stage via
 * quotation.service.ts's `createForRequirement`, so being unable to then submit those
 * quotations to the Director would be an inconsistent dead end.
 */
function departmentWriteFilter(actor: Actor): Record<string, unknown> {
  if (actor.role === ROLES.SUPER_ADMIN) return {};
  return { $or: [{ createdBy: actor.id }, routedIntoOwnDepartment(actor)] };
}

export const requirementService = {
  async create(input: CreateRequirementInput, actor: Actor) {
    if (actor.role !== ROLES.DEPARTMENT_USER && actor.role !== ROLES.SUPER_ADMIN) {
      throw ApiError.forbidden('Only a Department User can create a requirement');
    }
    if (!actor.department) {
      throw ApiError.badRequest('You must belong to a department to create a requirement');
    }

    // Defaults to the requester's own department; `targetDepartment` lets them route it to a
    // different one instead (e.g. an IT user requesting furniture routes to Admin) — only
    // departments Super Admin has opted in via isRequirementTarget are valid targets, so this
    // can never be used to silently misfile a requirement into an arbitrary department.
    let department = actor.department;
    if (input.targetDepartment) {
      const targetDept = await Department.findOne({
        _id: input.targetDepartment,
        isActive: true,
        isRequirementTarget: true,
      }).select('_id');
      if (!targetDept) throw ApiError.badRequest('Selected department is not a valid requirement target');
      department = targetDept.id;
    }

    const requirementNumber = await generateRequirementCode(department);

    // unit/estimatedRate are optional on input — the requester only says what's needed and how
    // much; a real unit/rate gets attached later during quotation collection.
    const items = input.items.map((item) => {
      const estimatedRate = item.estimatedRate ?? 0;
      return {
        ...item,
        unit: item.unit || 'pcs',
        estimatedRate,
        estimatedAmount: item.estimatedAmount || item.quantity * estimatedRate,
      };
    });

    const { targetDepartment: _targetDepartment, title, budget, requiredDate, ...rest } = input;

    return Requirement.create({
      ...rest,
      // Derived when the requester didn't set them — see createRequirementSchema's comment for
      // why: budget/date are decided downstream, and the title is just a label for lists/PDFs.
      title: title || deriveTitleFromItems(items),
      budget: budget ?? items.reduce((sum, item) => sum + item.estimatedAmount, 0),
      requiredDate: requiredDate ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      items,
      requirementNumber,
      department,
      requestedByDepartment: actor.department,
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
      addAndCondition(filter, {
        $or: [
          { requirementNumber: new RegExp(escapeRegex(String(query.search).trim()), 'i') },
          { title: new RegExp(escapeRegex(String(query.search).trim()), 'i') },
        ],
      });
    }

    scopeToOwner(actor, filter);

    const [items, total] = await Promise.all([
      Requirement.find(filter)
        .populate('department', 'name code')
        // `department` (nested) is the requester's own — surfaced so the receiving
        // department can tell a routed-in requirement (see targetDepartment in
        // requirement.validation.ts) apart from one raised by their own team.
        .populate({ path: 'createdBy', select: 'name email department', populate: { path: 'department', select: 'name' } })
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
      .populate({ path: 'createdBy', select: 'name email department', populate: { path: 'department', select: 'name' } })
      .populate('submittedBy', 'name email');

    if (!requirement) throw ApiError.notFound('Requirement not found');
    return requirement;
  },

  async update(id: string, input: UpdateRequirementInput, actor: Actor) {
    if (actor.role !== ROLES.DEPARTMENT_USER && actor.role !== ROLES.SUPER_ADMIN) {
      throw ApiError.forbidden('Only a Department User can edit a requirement');
    }

    const items = input.items?.map((item) => {
      const estimatedRate = item.estimatedRate ?? 0;
      return {
        ...item,
        unit: item.unit || 'pcs',
        estimatedRate,
        estimatedAmount: item.estimatedAmount || item.quantity * estimatedRate,
      };
    });

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
   * The department currently working the requirement — a Department User or HOD, either its
   * own or (if routed via targetDepartment) the receiving department's — explicitly hands it
   * over to the Director. The only way a requirement ever enters Director Review from here on.
   * Locks quotation upload (see the `createForRequirement` status gate in quotation.service.ts)
   * and is the trigger point for the `requirement_ready_for_review` notification (moved here
   * from "first quotation uploaded" — see requirement.controller.ts). Reachable an unlimited
   * number of times: a Director's "Send Back" decision returns the requirement to
   * QUOTATION_COLLECTION, and it can be submitted again after revising.
   */
  async submitToDirector(id: string, actor: Actor) {
    if (actor.role !== ROLES.DEPARTMENT_USER && actor.role !== ROLES.HOD && actor.role !== ROLES.SUPER_ADMIN) {
      throw ApiError.forbidden('Only a Department User or HOD can submit a requirement to the Director');
    }

    const requirement = await Requirement.findOne({
      _id: id,
      ...departmentWriteFilter(actor),
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
