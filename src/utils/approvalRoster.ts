/**
 * Shared by quotation.service.ts and bill.service.ts — both modules run the same CEO/Director
 * approval engine, so the "has every required approver on this route signed off?" check lives
 * here once instead of being reimplemented per module.
 *
 * A route is only fully approved once every entry in its roster (CEO route: just the CEO;
 * Director route: every currently-active Director, computed live) has independently decided
 * "approved" — a single approver's sign-off is never enough to flip the shared status when the
 * route requires more than one.
 */
export function isRosterFullyApproved(roster: { decision: string }[]): boolean {
  return roster.length > 0 && roster.every((entry) => entry.decision === 'approved');
}
