/** A price row older than this is still shown, but marked as possibly stale. */
export const PRICE_FRESHNESS_DAYS = 60;

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * True when a `verifiedOn` date is older than the freshness window.
 *
 * A missing or malformed date is not "stale": the card already has a separate
 * "not re-verified" state for that. The comparison is strict, so a row verified
 * exactly 60 days ago is still fresh.
 */
export function priceIsStale(
  verifiedOn: string | undefined,
  now: number = Date.now(),
): boolean {
  if (!verifiedOn) return false;
  const verified = Date.parse(verifiedOn);
  if (!Number.isFinite(verified)) return false;
  return now - verified > PRICE_FRESHNESS_DAYS * DAY_MS;
}
