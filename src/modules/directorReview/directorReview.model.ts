import { Schema, model, type Document, type Types } from 'mongoose';

/** The three decisions a Director can actually make. `pending` is the resting state before
 *  any decision has ever been recorded — never something a client submits. */
export const DIRECTOR_REVIEW_DECIDABLE = ['approved', 'rejected', 'sent_back'] as const;
export type DirectorReviewDecidable = (typeof DIRECTOR_REVIEW_DECIDABLE)[number];

export const DIRECTOR_REVIEW_DECISIONS = ['pending', ...DIRECTOR_REVIEW_DECIDABLE] as const;
export type DirectorReviewDecision = (typeof DIRECTOR_REVIEW_DECISIONS)[number];

export const DIRECTOR_REVIEW_HISTORY_ACTIONS = ['viewed', 'approved', 'rejected', 'sent_back', 'remarks_updated'] as const;
export type DirectorReviewHistoryAction = (typeof DIRECTOR_REVIEW_HISTORY_ACTIONS)[number];

/** One entry in the audit trail — every view, decision, and remarks edit ever made against
 *  this requirement's review, oldest first. Never removed or rewritten (same append-only
 *  idiom as `Quotation.directorApprovals[]`), so re-reviewing after a Send Back still shows
 *  the full history rather than losing the earlier round. */
export interface IDirectorReviewHistoryEntry {
  action: DirectorReviewHistoryAction;
  decision?: DirectorReviewDecidable;
  remarks?: string;
  performedBy: Types.ObjectId;
  performedByName: string;
  performedAt: Date;
}

/**
 * One Director's own, independent decision on this requirement — parallel dual-approval
 * (see docs/WORKFLOW_DUAL_DIRECTOR_APPROVAL.md). Every currently-active Director gets one
 * entry here, seeded `pending` by `directorReviewService.ensureApprovalRoster`; each Director
 * may only move their own entry away from `pending` once per round (directorReviewService.decide
 * rejects a second attempt). The requirement only reaches Approved once every entry is
 * `approved`; a single `rejected` or `sent_back` from any one Director resolves the whole
 * requirement immediately, matching the top-level `decision` below.
 *
 * `directorName` is denormalized (captured at seed time) rather than resolved via populate
 * on every read — deliberate, so a past round's record stays accurate even if that Director
 * is later renamed or deactivated, same reasoning as `IDirectorReviewHistoryEntry.performedByName`.
 */
export interface IDirectorApprovalEntry {
  director: Types.ObjectId;
  directorName: string;
  decision: DirectorReviewDecision;
  remarks?: string;
  decidedAt?: Date;
}

export interface IDirectorReview extends Document {
  requirement: Types.ObjectId;
  /** Most recent Director (or Super Admin acting as one) to view or decide. */
  director?: Types.ObjectId;
  /** The AGGREGATE outcome across every entry in `approvals` — stays `pending` until either
   *  every Director has approved (`approved`), or any single one has rejected or sent it
   *  back (immediate). `Requirement.status` tracks this 1:1 — see directorReviewService.decide. */
  decision: DirectorReviewDecision;
  /** Most recent actor's remarks — convenience/back-compat field mirroring the pre-dual-
   *  approval shape; each Director's own remarks also live on their own `approvals[]` entry. */
  remarks?: string;
  decisionDate?: Date;
  /** The quotation a Director explicitly picked as the winner when approving (overrides the
   *  AI Comparison recommendation / earliest-uploaded fallback in
   *  vendorRegistrationService.resolveWinningQuotation). Top-level, last-writer-wins: only
   *  overwritten by an approve decision that actually supplies one — an approval without one
   *  leaves whatever was already selected untouched. Unset means "no explicit override," the
   *  same as before this field existed. */
  selectedQuotation?: Types.ObjectId;
  /** One entry per Director active when this review round began. Reset to fresh `pending`
   *  entries whenever the aggregate decision becomes `sent_back` — the next round starts
   *  clean (rule: "Both Director approvals are cleared"). */
  approvals: IDirectorApprovalEntry[];
  history: IDirectorReviewHistoryEntry[];
  /** Increments on every decision or remarks edit — a Send Back followed by a re-review
   *  produces a new version of the same record rather than a new document. */
  version: number;
  createdBy: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const historyEntrySchema = new Schema<IDirectorReviewHistoryEntry>(
  {
    action: { type: String, enum: DIRECTOR_REVIEW_HISTORY_ACTIONS, required: true },
    decision: { type: String, enum: DIRECTOR_REVIEW_DECIDABLE },
    remarks: { type: String, trim: true },
    performedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    performedByName: { type: String, required: true, trim: true },
    performedAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const approvalEntrySchema = new Schema<IDirectorApprovalEntry>(
  {
    director: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    directorName: { type: String, required: true, trim: true },
    decision: { type: String, enum: DIRECTOR_REVIEW_DECISIONS, required: true, default: 'pending' },
    remarks: { type: String, trim: true },
    decidedAt: { type: Date },
  },
  { _id: false },
);

const directorReviewSchema = new Schema<IDirectorReview>(
  {
    // One review record per requirement — a Send Back and subsequent re-review update this
    // same document (see `version`/`history`) rather than creating a second one.
    requirement: { type: Schema.Types.ObjectId, ref: 'Requirement', required: true, unique: true },
    director: { type: Schema.Types.ObjectId, ref: 'User' },
    decision: { type: String, enum: DIRECTOR_REVIEW_DECISIONS, required: true, default: 'pending' },
    remarks: { type: String, trim: true },
    decisionDate: { type: Date },
    selectedQuotation: { type: Schema.Types.ObjectId, ref: 'Quotation' },
    approvals: { type: [approvalEntrySchema], default: [] },
    history: { type: [historyEntrySchema], default: [] },
    version: { type: Number, required: true, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export const DirectorReview = model<IDirectorReview>('DirectorReview', directorReviewSchema);
