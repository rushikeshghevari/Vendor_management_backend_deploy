const UNIT_TO_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

/** Parses durations like "15m", "7d", "30s" into a future Date. */
export function durationFromNow(duration: string): Date {
  const match = /^(\d+)([smhd])$/.exec(duration.trim());
  if (!match) {
    throw new Error(`Invalid duration format: "${duration}". Expected formats like "15m" or "7d".`);
  }
  const [, amount = '0', unit = 's'] = match;
  const ms = Number(amount) * UNIT_TO_MS[unit]!;
  return new Date(Date.now() + ms);
}
