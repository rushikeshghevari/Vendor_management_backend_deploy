import { ROLES } from '@/constants/roles';
import { REQUIREMENT_STATUS } from '@/constants/status';
import { ActivityLog, type IActivityLog } from '@/modules/activityLog/activityLog.model';
import { Comparison, type IComparison } from '@/modules/comparison/comparison.model';
import {
  DirectorReview,
  type IDirectorApprovalEntry,
  type IDirectorReview,
} from '@/modules/directorReview/directorReview.model';
import type { DecisionInput } from '@/modules/directorReview/directorReview.validation';
import { Quotation, type IQuotation } from '@/modules/quotation/quotation.model';
import { Requirement, type IRequirement } from '@/modules/requirement/requirement.model';
import { User } from '@/modules/user/user.model';
import type { Actor } from '@/types/actor';
import { ApiError } from '@/utils/ApiError';

const REVIEW_ROLES: Array<(typeof ROLES)[keyof typeof ROLES]> = [ROLES.DIRECTOR, ROLES.SUPER_ADMIN];
// QUOTATION_COLLECTION is deliberately excluded — a Director (or Super Admin) merely viewing
// the package while the Department User is still collecting quotations must never lock the
// requirement into Director Review on its own. Only requirementService.submitToDirector()
// (which moves status to QUOTATION_COMPARISON) opens that door now — see
// docs/WORKFLOW_ENHANCEMENT_DIRECTOR_SUBMISSION.md.
const STATUSES_ELIGIBLE_FOR_REVIEW = [REQUIREMENT_STATUS.QUOTATION_COMPARISON];

/** Same read-visibility rule used by `requirementService`/`comparisonService` (each module
 *  keeps its own local copy rather than sharing one — established precedent in this
 *  codebase). Department User sees only their own requirement; HOD sees their department's;
 *  Director/Super Admin see any — "read only" for the first two, full access for the rest. */
function scopeToRequirement(actor: Actor, requirementId: string): Record<string, unknown> {
  const filter: Record<string, unknown> = { _id: requirementId, isDeleted: { $ne: true } };
  if (actor.role === ROLES.DEPARTMENT_USER) {
    filter.createdBy = actor.id;
  } else if (actor.role === ROLES.HOD) {
    filter.department = actor.department;
  }
  return filter;
}

/** Adds a fresh `pending` entry for every currently-active Director not already on the
 *  roster — self-heals if a Director is added mid-review (e.g. a new one joins while the
 *  requirement is already in Director Review), and is a no-op once every active Director
 *  already has an entry. Never removes or overwrites an existing entry, even for a Director
 *  later deactivated, so a recorded decision is never silently lost. Parallel dual-approval
 *  (see docs/WORKFLOW_DUAL_DIRECTOR_APPROVAL.md) — with exactly two active Directors, this
 *  produces exactly the two roster slots the business rules describe; it isn't hardcoded to
 *  two, so it keeps working correctly if that ever changes. */
async function ensureApprovalRoster(review: IDirectorReview): Promise<void> {
  const activeDirectors = await User.find({ role: ROLES.DIRECTOR, isActive: true }).select('name').lean();
  const existingIds = new Set(review.approvals.map((entry) => entry.director.toString()));
  let changed = false;
  for (const director of activeDirectors) {
    if (!existingIds.has(String(director._id))) {
      review.approvals.push({ director: director._id, directorName: director.name, decision: 'pending' } as IDirectorApprovalEntry);
      changed = true;
    }
  }
  if (changed) await review.save();
}

async function getOrCreateReview(requirementId: string, actor: Actor): Promise<IDirectorReview> {
  const existing = await DirectorReview.findOne({ requirement: requirementId });
  const review =
    existing ?? (await DirectorReview.create({ requirement: requirementId, decision: 'pending', version: 0, createdBy: actor.id, history: [], approvals: [] }));
  await ensureApprovalRoster(review);
  return review;
}

// AI Comparison is optional, not a prerequisite — no AI provider is configured yet, and
// Director Review must work from the uploaded quotations alone until one is (see
// docs/WORKFLOW_MANUAL_DIRECTOR_REVIEW.md). Returns null instead of throwing when none has
// been generated; every consumer (below, and the frontend's ReviewPackage type) treats a
// null comparison as "review manually," not an error. Generation itself
// (comparisonService.generate) is untouched, so this becomes a no-op the moment a comparison
// does exist — nothing here needs to change to "turn AI on".
async function latestComparisonOrNull(requirementId: string): Promise<IComparison | null> {
  return Comparison.findOne({ requirement: requirementId }).sort({ generatedAt: -1 });
}

/** Hides another Director's remarks from a Director who hasn't submitted their own decision
 *  yet — a Director shouldn't have their own judgment anchored by reading the other's
 *  reasoning first. Decision status (Pending/Approved/...) always stays visible on every
 *  entry; only the free-text `remarks` are redacted, and only for the Director viewer, and
 *  only while their own entry is still `pending`. Department User, HOD, and Super Admin
 *  always see every remark. */
function redactPeerRemarks(review: IDirectorReview, actor: Actor): IDirectorReview {
  if (actor.role !== ROLES.DIRECTOR) return review;
  const myEntry = review.approvals.find((entry) => entry.director.toString() === actor.id);
  if (!myEntry || myEntry.decision !== 'pending') return review;

  const plain = review.toObject() as IDirectorReview;
  plain.approvals = plain.approvals.map((entry) =>
    entry.director.toString() === actor.id ? entry : { ...entry, remarks: undefined },
  );
  return plain;
}

export interface ReviewPackage {
  requirement: IRequirement;
  comparison: IComparison | null;
  quotations: IQuotation[];
  activityLogs: IActivityLog[];
  review: IDirectorReview;
}

export const directorReviewService = {
  /**
   * Assembles the full Director Review package — requirement, its AI comparison, every
   * quotation (with OCR data already on each), recent activity log entries, and the
   * DirectorReview record itself (with a fresh-per-active-Director `approvals` roster,
   * peer-remarks redacted for a Director who hasn't decided yet). A Department User/HOD may
   * only read their own scope ("read only" per Phase 5); only a Director/Super Admin
   * actually viewing this advances the requirement into Director Review and is logged as a
   * "viewed" event — read access by anyone else never moves the workflow forward.
   */
  async getReviewPackage(requirementId: string, actor: Actor): Promise<ReviewPackage> {
    const requirement = await Requirement.findOne(scopeToRequirement(actor, requirementId))
      .populate('department', 'name code hod')
      .populate('createdBy', 'name email')
      .populate('submittedBy', 'name');
    if (!requirement) throw ApiError.notFound('Requirement not found');

    const comparison = await latestComparisonOrNull(requirementId);

    const quotations = await Quotation.find({ requirement: requirementId, isDeleted: { $ne: true } })
      .populate('vendor', 'name')
      .sort({ createdAt: -1 });

    const activityLogs = await ActivityLog.find({
      targetId: { $in: [requirement._id, ...quotations.map((q) => q._id)] },
    })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    const review = await getOrCreateReview(requirementId, actor);

    if (REVIEW_ROLES.includes(actor.role)) {
      if (STATUSES_ELIGIBLE_FOR_REVIEW.includes(requirement.status as (typeof STATUSES_ELIGIBLE_FOR_REVIEW)[number])) {
        await Requirement.updateOne({ _id: requirementId, status: requirement.status }, { status: REQUIREMENT_STATUS.DIRECTOR_REVIEW });
        requirement.status = REQUIREMENT_STATUS.DIRECTOR_REVIEW;
      }

      const performer = await User.findById(actor.id).select('name').lean();
      review.director = actor.id as never;
      review.history.push({
        action: 'viewed',
        performedBy: actor.id as never,
        performedByName: performer?.name ?? 'Unknown',
        performedAt: new Date(),
      });
      await review.save();
    }

    return { requirement, comparison, quotations, activityLogs: activityLogs as IActivityLog[], review: redactPeerRemarks(review, actor) };
  },

  /**
   * Records one Director's own, independent decision (parallel dual-approval — see
   * docs/WORKFLOW_DUAL_DIRECTOR_APPROVAL.md):
   *  - Approve only ever resolves the requirement once EVERY active Director's own entry is
   *    `approved` — Requirement.status = APPROVED (ready for Vendor Registration). Until
   *    then it stays `director_review` ("Waiting for Director Approvals" — a UI-derived
   *    label, not a new status value).
   *  - Reject from any single Director resolves the requirement immediately → REJECTED
   *    (terminal) — the other Director's own pending decision becomes moot; their next
   *    attempt 404s below since the requirement has left Director Review.
   *  - Send Back from any single Director resolves immediately → QUOTATION_COLLECTION, and
   *    clears BOTH Directors' approvals back to pending for the next round.
   *  - A Super Admin's decision is a full-access override (same precedent as every other
   *    module in this codebase) — it resolves the requirement immediately regardless of
   *    where the individual Directors' own entries stand.
   *  - A Director may record their own decision only once per round (their entry must still
   *    be `pending`) — a repeat attempt is rejected with 400, not silently ignored.
   */
  async decide(requirementId: string, input: DecisionInput, actor: Actor): Promise<{ requirement: IRequirement; review: IDirectorReview }> {
    if (!REVIEW_ROLES.includes(actor.role)) {
      throw ApiError.forbidden('Only a Director or Super Admin can decide on a requirement');
    }

    const requirement = await Requirement.findOne({
      _id: requirementId,
      status: REQUIREMENT_STATUS.DIRECTOR_REVIEW,
      isDeleted: { $ne: true },
    })
      .populate('department', 'name hod')
      .populate('createdBy', 'name');
    if (!requirement) {
      throw ApiError.notFound('Requirement not found, or it is not currently in Director Review');
    }

    const performer = await User.findById(actor.id).select('name').lean();
    const review = await getOrCreateReview(requirementId, actor);
    const now = new Date();

    // Top-level, last-writer-wins: only an Approve that actually supplies a selection
    // overwrites it — an Approve without one (or a Reject/Send Back, blocked at the
    // validation layer) leaves whatever was selected by an earlier round/Director untouched.
    if (input.decision === 'approved' && input.selectedQuotationId) {
      const selected = await Quotation.findOne({
        _id: input.selectedQuotationId,
        requirement: requirementId,
        isDeleted: { $ne: true },
      }).select('_id');
      if (!selected) throw ApiError.badRequest('Selected quotation does not belong to this requirement');
      review.selectedQuotation = selected._id as never;
    }

    let aggregate: typeof review.decision;

    if (actor.role === ROLES.SUPER_ADMIN) {
      aggregate = input.decision;
    } else {
      const myEntry = review.approvals.find((entry) => entry.director.toString() === actor.id);
      if (!myEntry) {
        throw ApiError.forbidden('You are not on the Director approval roster for this requirement');
      }
      if (myEntry.decision !== 'pending') {
        throw ApiError.badRequest('You have already submitted your decision for this requirement');
      }

      myEntry.decision = input.decision;
      myEntry.remarks = input.remarks;
      myEntry.decidedAt = now;

      aggregate =
        input.decision === 'approved'
          ? (review.approvals.every((entry) => entry.decision === 'approved') ? 'approved' : 'pending')
          // Reject/Send Back from a single Director resolves the whole requirement right
          // away — it doesn't wait on the other Director's own pending decision.
          : input.decision;
    }

    review.decision = aggregate;
    review.director = actor.id as never;
    review.remarks = input.remarks;
    review.decisionDate = now;
    review.version += 1;
    review.updatedBy = actor.id as never;
    review.history.push({
      action: input.decision,
      decision: input.decision,
      remarks: input.remarks,
      performedBy: actor.id as never,
      performedByName: performer?.name ?? 'Unknown',
      performedAt: now,
    });

    // Both Directors' approvals are cleared once the requirement is sent back — the next
    // round starts clean rather than carrying over a stale decision from this one.
    if (aggregate === 'sent_back') {
      review.approvals.forEach((entry) => {
        entry.decision = 'pending';
        entry.remarks = undefined;
        entry.decidedAt = undefined;
      });
    }

    await review.save();

    const nextStatus =
      aggregate === 'approved' ? REQUIREMENT_STATUS.APPROVED
      : aggregate === 'rejected' ? REQUIREMENT_STATUS.REJECTED
      : aggregate === 'sent_back' ? REQUIREMENT_STATUS.QUOTATION_COLLECTION
      // Still 'pending' overall — this Director approved, the other one hasn't yet.
      : requirement.status;

    if (nextStatus !== requirement.status) {
      await Requirement.updateOne({ _id: requirementId }, { status: nextStatus });
      requirement.status = nextStatus;
    }

    return { requirement, review };
  },

  /** Updates the Director's remarks without changing the recorded decision — e.g. adding
   *  context while still reviewing. Does not touch `Requirement.status` or any
   *  `approvals[]` entry — a top-level convenience note, unchanged from before dual-approval. */
  async addRemarks(requirementId: string, remarks: string, actor: Actor): Promise<IDirectorReview> {
    if (!REVIEW_ROLES.includes(actor.role)) {
      throw ApiError.forbidden('Only a Director or Super Admin can update remarks');
    }

    const requirement = await Requirement.findOne({ _id: requirementId, isDeleted: { $ne: true } }).select('_id');
    if (!requirement) throw ApiError.notFound('Requirement not found');

    const performer = await User.findById(actor.id).select('name').lean();
    const review = await getOrCreateReview(requirementId, actor);

    review.remarks = remarks;
    review.version += 1;
    review.updatedBy = actor.id as never;
    review.director = review.director ?? (actor.id as never);
    review.history.push({
      action: 'remarks_updated',
      remarks,
      performedBy: actor.id as never,
      performedByName: performer?.name ?? 'Unknown',
      performedAt: new Date(),
    });
    await review.save();
    return review;
  },
};
