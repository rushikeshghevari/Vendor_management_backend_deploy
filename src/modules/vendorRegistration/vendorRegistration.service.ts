import { ROLES } from '@/constants/roles';
import { REQUIREMENT_STATUS } from '@/constants/status';
import { DirectorReview, type IDirectorReview } from '@/modules/directorReview/directorReview.model';
import { Quotation, type IQuotation } from '@/modules/quotation/quotation.model';
import { Requirement, type IRequirement } from '@/modules/requirement/requirement.model';
import { generateVendorCode } from '@/modules/vendor/vendor.service';
import { Vendor, type IVendor, type IVendorDocument } from '@/modules/vendor/vendor.model';
import type { RegisterVendorInput } from '@/modules/vendorRegistration/vendorRegistration.validation';
import type { Actor } from '@/types/actor';
import { ApiError } from '@/utils/ApiError';

/** Only a Department User (their own requirement) or Super Admin may actually register a
 *  vendor — matches Phase 6's role table exactly ("Manual vendor creation must not be
 *  allowed" for everyone else; HOD/Director are read-only, enforced in the routes layer). */
const REGISTER_ROLES: Array<(typeof ROLES)[keyof typeof ROLES]> = [ROLES.DEPARTMENT_USER, ROLES.SUPER_ADMIN];

const CORE_DOCUMENT_TYPES = ['gst_certificate', 'pan_card', 'cancelled_cheque'] as const;

/** Same read-visibility rule used by every other Requirement-scoped module in this codebase
 *  (requirement/comparison/directorReview each keep their own local copy). */
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

async function requireApprovedReview(requirementId: string): Promise<IDirectorReview> {
  const review = await DirectorReview.findOne({ requirement: requirementId, decision: 'approved' });
  if (!review) throw ApiError.badRequest('This requirement has not been approved by a Director yet');
  return review;
}

/** The Director's own explicit pick on the approved DirectorReview is the only source for the
 *  winning quotation — no AI Comparison recommendation or earliest-uploaded fallback anymore;
 *  the AI comparison stays purely informational (see `directorReview.validation.ts`, which now
 *  requires `selectedQuotationId` on every Approve). Re-validated here (not just trusted from
 *  the review record) in case anything changed between approval and registration. */
async function resolveWinningQuotation(requirementId: string, review: IDirectorReview): Promise<IQuotation> {
  if (!review.selectedQuotation) {
    throw ApiError.badRequest('The Director did not select a winning quotation for this requirement');
  }

  const selected = await Quotation.findOne({
    _id: review.selectedQuotation,
    requirement: requirementId,
    isDeleted: { $ne: true },
  });
  if (!selected) throw ApiError.badRequest('The Director-selected quotation is no longer available');
  return selected;
}

/** Prevents duplicate vendors on GST / PAN / Email (Vendor Code is always freshly
 *  server-generated, so it can never collide). Checked against the *entire* Vendor
 *  collection, not just requirement-registered ones, so it also catches a collision with a
 *  vendor created through the pre-existing manual `POST /vendors` flow. */
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

export interface RegisterVendorResult {
  vendor: IVendor;
  requirement: IRequirement;
  quotation: IQuotation;
}

export interface VendorRegistrationStatus {
  alreadyRegistered: boolean;
  vendor: IVendor | null;
  winningVendorName: string;
}

/** Shared by `checkVendorStatus` (read-only preview) and `linkExistingVendor` (which re-derives
 *  this server-side rather than trusting a client-supplied vendorId, to stop a tampered id from
 *  linking an arbitrary Vendor). Two ways a match is found: (1) the quotation directly
 *  referenced an existing Vendor (`quotation.vendor`), or (2) its manually-entered
 *  `temporaryVendor.email`/`phone` matches an already-registered Vendor — the same two fields
 *  `assertNoDuplicateVendor` treats as identity above. */
async function findMatchingVendor(quotation: IQuotation): Promise<IVendor | null> {
  if (quotation.vendor) {
    const vendor = await Vendor.findById(quotation.vendor);
    if (vendor) return vendor;
  }

  const info = quotation.temporaryVendor;
  const orConditions: Record<string, unknown>[] = [];
  if (info?.email) orConditions.push({ email: info.email });
  if (info?.phone) orConditions.push({ phone: info.phone });

  return orConditions.length > 0 ? Vendor.findOne({ $or: orConditions }) : null;
}

export const vendorRegistrationService = {
  /** Returns the vendor already registered for a requirement, if any — used both to render
   *  the Registration Success screen on revisit and as the idempotency check before a second
   *  registration attempt. Read-only, visible to all four roles (scoped). Checks
   *  `finalizedVendor` too, not just `createdFromRequirement` — a vendor reused via
   *  `linkExistingVendor` was created FROM a different requirement, so `createdFromRequirement`
   *  alone would miss it here. */
  async getRegisteredVendor(requirementId: string, actor: Actor): Promise<IVendor> {
    const requirement = await Requirement.findOne(scopeToRequirement(actor, requirementId)).select('finalizedVendor');
    if (!requirement) throw ApiError.notFound('Requirement not found');

    const orConditions: Record<string, unknown>[] = [{ createdFromRequirement: requirementId }];
    if (requirement.finalizedVendor) orConditions.push({ _id: requirement.finalizedVendor });

    const vendor = await Vendor.findOne({ $or: orConditions })
      .populate('department', 'name code')
      .populate('createdFromQuotation', 'quotationCode')
      .populate('approvedByDirector', 'name');
    if (!vendor) throw ApiError.notFound('No vendor has been registered for this requirement yet');
    return vendor;
  },

  /** Checked once a requirement reaches `approved`, before the Department User/HOD decides
   *  between "Register Vendor" and "Generate Vendor Link" — matches the Director-selected
   *  winning quotation against the Vendor collection so a vendor who is already in the system
   *  never gets sent through a redundant registration/link flow. */
  async checkVendorStatus(requirementId: string, actor: Actor): Promise<VendorRegistrationStatus> {
    const requirement = await loadScopedRequirement(requirementId, actor);
    if (requirement.status !== REQUIREMENT_STATUS.APPROVED) {
      throw ApiError.badRequest('Vendor status is only available once a requirement has been Director-approved');
    }

    const review = await requireApprovedReview(requirementId);
    const quotation = await resolveWinningQuotation(requirementId, review);
    const vendor = await findMatchingVendor(quotation);

    return {
      alreadyRegistered: !!vendor,
      vendor,
      winningVendorName: vendor?.name ?? quotation.temporaryVendor?.name ?? 'the winning vendor',
    };
  },

  /**
   * Creates a Vendor strictly from an Approved Requirement's own AI Comparison + Director
   * Review — never accepts a client-chosen quotation or department, and never re-derives the
   * recommendation. Sets `Requirement.status = vendor_finalized` (the hand-off point Phase 5
   * declared but never wired) once the vendor is created.
   */
  async register(
    requirementId: string,
    input: RegisterVendorInput,
    documents: IVendorDocument[],
    actor: Actor,
  ): Promise<RegisterVendorResult> {
    if (!REGISTER_ROLES.includes(actor.role)) {
      throw ApiError.forbidden('Only a Department User or Super Admin can register a vendor');
    }

    return createVendorFromRequirement(requirementId, input, documents, actor);
  },

  /** The other half of `checkVendorStatus`'s "already registered" branch: confirms and
   *  finalizes a requirement whose winning quotation's vendor turned out to already exist in
   *  the system, without creating a duplicate Vendor record. Only sets `Requirement.status =
   *  vendor_finalized` + `finalizedVendor` — the Vendor document itself is untouched. */
  async linkExistingVendor(requirementId: string, vendorId: string, actor: Actor): Promise<RegisterVendorResult> {
    if (!REGISTER_ROLES.includes(actor.role)) {
      throw ApiError.forbidden('Only a Department User or Super Admin can link an existing vendor');
    }

    const requirement = await loadScopedRequirement(requirementId, actor);

    const existing = await Vendor.findOne({ createdFromRequirement: requirementId }).select('_id');
    if (existing || requirement.finalizedVendor) {
      throw ApiError.conflict('A vendor has already been registered for this requirement');
    }

    if (requirement.status !== REQUIREMENT_STATUS.APPROVED) {
      throw ApiError.badRequest('Vendor registration is only available once a requirement has been Director-approved');
    }

    const review = await requireApprovedReview(requirementId);
    const quotation = await resolveWinningQuotation(requirementId, review);

    const matched = await findMatchingVendor(quotation);
    if (!matched || matched._id.toString() !== vendorId) {
      throw ApiError.badRequest('This vendor no longer matches the winning quotation on this requirement');
    }

    await Requirement.updateOne(
      { _id: requirementId },
      { status: REQUIREMENT_STATUS.VENDOR_FINALIZED, finalizedVendor: matched._id },
    );
    requirement.status = REQUIREMENT_STATUS.VENDOR_FINALIZED;
    requirement.finalizedVendor = matched._id;

    return { vendor: matched, requirement, quotation };
  },
};

/**
 * The actual creation logic, split out of `register()` so the Vendor Registration Link
 * pipeline (vendorRegistrationLink.service.ts's `verify()`) can call directly into it with
 * pre-supplied data (sourced from a stored link submission, not a live request) and its own
 * role gate (Department User own / HOD department / Super Admin) — HOD may verify a link
 * submission even though HOD is excluded from `REGISTER_ROLES` above, since that gate only
 * applies to the direct, authenticated `POST /vendor-registration` pathway.
 */
export async function createVendorFromRequirement(
  requirementId: string,
  input: RegisterVendorInput,
  documents: IVendorDocument[],
  actor: Actor,
): Promise<RegisterVendorResult> {
  const requirement = await loadScopedRequirement(requirementId, actor);

  // Checked before the approved-status gate below: once a vendor has been registered the
  // requirement always moves on to `vendor_finalized`, so a repeat attempt would otherwise
  // surface as a confusing "not approved" 400 instead of the actually-true "already
  // registered" 409.
  const existing = await Vendor.findOne({ createdFromRequirement: requirementId }).select('_id');
  if (existing) throw ApiError.conflict('A vendor has already been registered for this requirement');

  if (requirement.status !== REQUIREMENT_STATUS.APPROVED) {
    throw ApiError.badRequest('Vendor registration is only available once a requirement has been Director-approved');
  }

  const review = await requireApprovedReview(requirementId);
  const quotation = await resolveWinningQuotation(requirementId, review);
  await assertNoDuplicateVendor(input);

  const departmentId = String((requirement.department as unknown as { _id?: unknown })._id ?? requirement.department);
  const code = await generateVendorCode(departmentId);

  const hasCoreDocuments = CORE_DOCUMENT_TYPES.every((type) => documents.some((doc) => doc.type === type));

  const vendor = await Vendor.create({
    name: input.name,
    code,
    department: departmentId,
    createdBy: actor.id,
    contactPerson: input.contactPerson,
    phone: input.phone,
    email: input.email,
    gstNumber: input.gstNumber || undefined,
    panNumber: input.panNumber || undefined,
    address: input.address,
    state: input.state,
    district: input.district,
    city: input.city,
    country: input.country || 'India',
    pincode: input.pincode,
    bankDetails: {
      bankName: input.bankName,
      accountHolderName: input.accountHolderName,
      accountNumber: input.accountNumber,
      ifscCode: input.ifscCode,
      upiId: input.upiId || undefined,
    },
    category: input.category || 'General',
    status: 'active',
    documents,
    registrationStatus: hasCoreDocuments ? 'registered' : 'pending_documents',
    createdFromRequirement: requirementId,
    createdFromQuotation: quotation._id,
    approvedByDirector: review.director,
  });

  await Requirement.updateOne(
    { _id: requirementId },
    { status: REQUIREMENT_STATUS.VENDOR_FINALIZED, finalizedVendor: vendor._id },
  );
  requirement.status = REQUIREMENT_STATUS.VENDOR_FINALIZED;
  requirement.finalizedVendor = vendor._id;

  return { vendor, requirement, quotation };
}
