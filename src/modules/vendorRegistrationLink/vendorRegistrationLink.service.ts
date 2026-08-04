import crypto from 'node:crypto';

import { ROLES } from '@/constants/roles';
import { REQUIREMENT_STATUS } from '@/constants/status';
import { Requirement, type IRequirement } from '@/modules/requirement/requirement.model';
import type { IVendorDocument } from '@/modules/vendor/vendor.model';
import { Vendor } from '@/modules/vendor/vendor.model';
import { createVendorFromRequirement, type RegisterVendorResult } from '@/modules/vendorRegistration/vendorRegistration.service';
import type { RegisterVendorInput } from '@/modules/vendorRegistration/vendorRegistration.validation';
import { VendorRegistrationLink, type IVendorRegistrationLink } from '@/modules/vendorRegistrationLink/vendorRegistrationLink.model';
import type { Actor } from '@/types/actor';
import { ApiError } from '@/utils/ApiError';

const LINK_ROLES: Array<(typeof ROLES)[keyof typeof ROLES]> = [ROLES.DEPARTMENT_USER, ROLES.HOD, ROLES.SUPER_ADMIN];
const LINK_TTL_DAYS = 7;

/** Same read-visibility rule used by vendorRegistration.service.ts and every other
 *  Requirement-scoped module (each keeps its own local copy — established precedent). */
function scopeToRequirement(actor: Actor, requirementId: string): Record<string, unknown> {
  const filter: Record<string, unknown> = { _id: requirementId, isDeleted: { $ne: true } };
  if (actor.role === ROLES.DEPARTMENT_USER) {
    filter.createdBy = actor.id;
  } else if (actor.role === ROLES.HOD) {
    filter.department = actor.department;
  }
  return filter;
}

async function loadScopedRequirement(requirementId: string, actor: Actor): Promise<IRequirement> {
  const requirement = await Requirement.findOne(scopeToRequirement(actor, requirementId)).populate('department', 'name code hod');
  if (!requirement) throw ApiError.notFound('Requirement not found');
  return requirement;
}

function isLive(link: Pick<IVendorRegistrationLink, 'status' | 'expiresAt'>): boolean {
  return (link.status === 'pending' || link.status === 'submitted') && link.expiresAt.getTime() > Date.now();
}

/** Lazily flips a stale pending/submitted link to `expired` the moment it's read past its
 *  TTL — there's no background sweep job for this, so every read path (public info, submit,
 *  verify) self-heals the status instead of trusting a value that may be long past due. */
async function expireIfPast(link: IVendorRegistrationLink): Promise<IVendorRegistrationLink> {
  if ((link.status === 'pending' || link.status === 'submitted') && link.expiresAt.getTime() <= Date.now()) {
    link.status = 'expired';
    await link.save();
  }
  return link;
}

/** Same GST/PAN/Email duplicate check as vendorRegistration.service.ts's own
 *  `assertNoDuplicateVendor` (kept as a local copy per this codebase's convention of not
 *  sharing small validation helpers across modules) — run at *submit* time so a duplicate
 *  vendor is caught before anything is stored on the link at all, not just at verify time. */
async function assertNoDuplicateVendor(input: RegisterVendorInput): Promise<void> {
  const orConditions: Record<string, unknown>[] = [{ email: input.email }];
  if (input.gstNumber) orConditions.push({ gstNumber: input.gstNumber });
  if (input.panNumber) orConditions.push({ panNumber: input.panNumber });

  const duplicate = await Vendor.findOne({ $or: orConditions }).select('code email gstNumber panNumber');
  if (!duplicate) return;

  const field =
    duplicate.email === input.email ? 'email address'
    : input.gstNumber && duplicate.gstNumber === input.gstNumber ? 'GST number'
    : 'PAN number';
  throw ApiError.conflict(`A vendor with this ${field} is already registered (${duplicate.code})`);
}

export interface PublicLinkInfo {
  requirementNumber: string;
  title: string;
  departmentName: string;
  status: IVendorRegistrationLink['status'];
}

export const vendorRegistrationLinkService = {
  /** Idempotent — returns the existing live (pending/submitted) link if one already exists
   *  rather than erroring, so re-pressing "Generate Vendor Link" just re-shares the same
   *  token instead of failing. */
  async generate(requirementId: string, actor: Actor): Promise<{ link: IVendorRegistrationLink; created: boolean }> {
    if (!LINK_ROLES.includes(actor.role)) {
      throw ApiError.forbidden('Only a Department User, HOD, or Super Admin can generate a vendor registration link');
    }

    const requirement = await loadScopedRequirement(requirementId, actor);
    if (requirement.status !== REQUIREMENT_STATUS.APPROVED) {
      throw ApiError.badRequest('A vendor registration link can only be generated once this requirement has been Director-approved');
    }

    const existing = await VendorRegistrationLink.findOne({ requirement: requirementId }).sort({ createdAt: -1 });
    if (existing) {
      await expireIfPast(existing);
      if (isLive(existing)) return { link: existing, created: false };
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + LINK_TTL_DAYS * 24 * 60 * 60 * 1000);

    const link = await VendorRegistrationLink.create({
      requirement: requirementId,
      token,
      status: 'pending',
      expiresAt,
      submittedDocuments: [],
      createdBy: actor.id,
    });
    return { link, created: true };
  },

  async getStatus(requirementId: string, actor: Actor): Promise<IVendorRegistrationLink> {
    if (!LINK_ROLES.includes(actor.role)) {
      throw ApiError.forbidden('Only a Department User, HOD, or Super Admin can view the vendor registration link');
    }
    await loadScopedRequirement(requirementId, actor);

    const link = await VendorRegistrationLink.findOne({ requirement: requirementId }).sort({ createdAt: -1 });
    if (!link) throw ApiError.notFound('No vendor registration link has been generated for this requirement yet');
    return expireIfPast(link);
  },

  /** No auth — reads only the minimal, non-sensitive fields a vendor's browser needs to
   *  render the public form's header. Never returns requirement budget, items, department id,
   *  or anything else from the Requirement document. */
  async getPublicInfo(token: string): Promise<PublicLinkInfo> {
    const link = await VendorRegistrationLink.findOne({ token }).populate({
      path: 'requirement',
      select: 'requirementNumber title department',
      populate: { path: 'department', select: 'name' },
    });
    if (!link) throw ApiError.notFound('This vendor registration link is invalid');

    await expireIfPast(link);
    if (link.status === 'expired') throw ApiError.gone('This vendor registration link has expired');
    if (link.status === 'verified') throw ApiError.gone('This vendor registration link has already been used');

    const requirement = link.requirement as unknown as { requirementNumber: string; title: string; department?: { name?: string } };
    return {
      requirementNumber: requirement.requirementNumber,
      title: requirement.title,
      departmentName: requirement.department?.name ?? 'Unknown',
      status: link.status,
    };
  },

  /** Stores the vendor's own submission on the link (never creates the Vendor here — see
   *  `verify()`). One-shot: only accepted while the link is still `pending`; a second
   *  submission attempt against the same token is rejected, and a duplicate GST/PAN/email is
   *  rejected before anything is stored, so a bad submission never lands as a pending record
   *  at all. */
  async submit(token: string, input: RegisterVendorInput, documents: IVendorDocument[]): Promise<IVendorRegistrationLink> {
    const link = await VendorRegistrationLink.findOne({ token });
    if (!link) throw ApiError.notFound('This vendor registration link is invalid');

    await expireIfPast(link);
    if (link.status === 'expired') throw ApiError.gone('This vendor registration link has expired');
    if (link.status !== 'pending') {
      throw ApiError.gone('This vendor registration link has already been submitted or finalized');
    }

    await assertNoDuplicateVendor(input);

    link.submittedData = { ...input };
    link.submittedDocuments = documents;
    link.submittedAt = new Date();
    link.status = 'submitted';
    await link.save();
    return link;
  },

  /**
   * Loads the `submitted` link's stored data + documents and calls directly into
   * `createVendorFromRequirement` (the same creation logic `vendorRegistrationService.register()`
   * uses) — never re-copies that logic. Runs with the caller's own role gate (Department User
   * own / HOD department / Super Admin) rather than `register()`'s narrower one, since HOD may
   * verify a link submission even though HOD cannot use the direct registration endpoint.
   */
  async verify(requirementId: string, actor: Actor): Promise<RegisterVendorResult> {
    if (!LINK_ROLES.includes(actor.role)) {
      throw ApiError.forbidden('Only a Department User, HOD, or Super Admin can verify a vendor registration submission');
    }

    const link = await VendorRegistrationLink.findOne({ requirement: requirementId, status: 'submitted' }).sort({ createdAt: -1 });
    if (!link) {
      throw ApiError.badRequest('No submitted vendor registration is awaiting verification for this requirement');
    }

    await expireIfPast(link);
    if (link.status !== 'submitted') {
      throw ApiError.badRequest('This vendor registration link has expired since it was submitted');
    }

    const result = await createVendorFromRequirement(
      requirementId,
      link.submittedData as unknown as RegisterVendorInput,
      link.submittedDocuments,
      actor,
    );

    link.status = 'verified';
    link.verifiedBy = actor.id as never;
    link.verifiedAt = new Date();
    await link.save();

    return result;
  },
};
