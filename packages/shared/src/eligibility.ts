import type { ClearBid, EligibilityPredicate } from './clear.js';

/**
 * D8: the one rule for "which bids count". A bid counts only while it is HELD **and** carries a
 * PayPal authorization id; a bid with no hold never reaches Clear, `/book`, `/simulate`, the
 * slider or the rounds runner. `loadClearInput` applies the same rule in SQL.
 */
export const isEligibleBid: EligibilityPredicate = (bid: ClearBid): boolean =>
  bid.status === 'HELD' && bid.paypalAuthorizationId != null && bid.paypalAuthorizationId !== '';
