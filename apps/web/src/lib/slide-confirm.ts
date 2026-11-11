/**
 * Slide-to-confirm maths (HF-061, screens.md M10: "slide-to-confirm (instead of typing)"). No
 * React: `SlideToConfirm` renders it. The thumb's position is a fraction of the travel (0 at the
 * start, 1 at the end); letting go at or past `SLIDE_THRESHOLD` confirms, anything short of it
 * springs back. Keyboard users step the same fraction and confirm only by reaching the end.
 */

/** Released at or past this share of the travel: confirmed. */
export const SLIDE_THRESHOLD = 0.92;

/** One arrow-key step. Four presses from the start reach the end. */
export const SLIDE_KEY_STEP = 0.25;

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * The thumb's fraction after dragging `dx` px from `startFraction`, on a track `trackWidth` px
 * wide with a `thumbWidth` px thumb. A track no wider than the thumb has no travel: stays put.
 */
export function slideFraction(
  startFraction: number,
  dx: number,
  trackWidth: number,
  thumbWidth: number,
): number {
  const travel = trackWidth - thumbWidth;
  if (!(travel > 0)) return clamp01(startFraction);
  return clamp01(startFraction + dx / travel);
}

/** Whether letting go at `fraction` confirms. */
export function isSlideComplete(fraction: number): boolean {
  return fraction >= SLIDE_THRESHOLD;
}

/** The fraction after a key press; null for keys the slider ignores. */
export function slideKey(fraction: number, key: string): number | null {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp':
      return clamp01(fraction + SLIDE_KEY_STEP);
    case 'ArrowLeft':
    case 'ArrowDown':
      return clamp01(fraction - SLIDE_KEY_STEP);
    case 'Home':
      return 0;
    case 'End':
      return 1;
    default:
      return null;
  }
}
