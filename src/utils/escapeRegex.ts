/** Escapes regex metacharacters in user-supplied search input before it's used in `new RegExp()` — without this, a search string like `(a+)+$` can trigger catastrophic backtracking (ReDoS) against the single Node event loop. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
