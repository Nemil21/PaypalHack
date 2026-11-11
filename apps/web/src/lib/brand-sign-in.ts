/**
 * W02 brand sign-in helpers (HF-010). The callback (`/api/auth/paypal/callback`) sends failures
 * back to `/brand/sign-in?error=<code>`; these turn that into the screen's error state.
 */

export type SignInErrorCode = 'cancelled' | 'state' | 'failed' | 'unverified';

const MESSAGES: Record<SignInErrorCode, string> = {
  cancelled: 'PayPal sign-in was cancelled.',
  state: 'That sign-in link expired or was opened in another browser. Please try again.',
  failed: 'PayPal sign-in didn’t go through. Please try again.',
  unverified: 'Confirm your email address with PayPal, then sign in again.',
};

/** The error message for `?error=`, or null when there is none (unknown codes read as failed). */
export function signInErrorMessage(code: string | null): string | null {
  if (!code) return null;
  return MESSAGES[code as SignInErrorCode] ?? MESSAGES.failed;
}

/** `next` only when it is a same-origin path (the API rejects anything else with a 400). */
export function safeNext(next: string | null): string | undefined {
  if (!next || next.length > 512) return undefined;
  return /^\/(?![/\\])[^\s]*$/.test(next) ? next : undefined;
}

/** Full-page navigation target for "Continue with PayPal". */
export function paypalStartUrl(next?: string): string {
  return next
    ? `/api/auth/paypal/start?next=${encodeURIComponent(next)}`
    : '/api/auth/paypal/start';
}
