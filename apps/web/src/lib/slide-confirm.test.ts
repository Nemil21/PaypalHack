import { describe, expect, it } from 'vitest';
import {
  isSlideComplete,
  SLIDE_KEY_STEP,
  SLIDE_THRESHOLD,
  slideFraction,
  slideKey,
} from './slide-confirm';

describe('slide-to-confirm (HF-061 M10)', () => {
  it('maps a drag to a fraction of the travel (track minus thumb)', () => {
    // 340 px track, 52 px thumb: 288 px of travel.
    expect(slideFraction(0, 144, 340, 52)).toBe(0.5);
    expect(slideFraction(0.5, 144, 340, 52)).toBe(1);
    expect(slideFraction(0, 288, 340, 52)).toBe(1);
  });

  it('clamps to the track and ignores a track with no travel', () => {
    expect(slideFraction(0, 9999, 340, 52)).toBe(1);
    expect(slideFraction(0.2, -9999, 340, 52)).toBe(0);
    expect(slideFraction(0.3, 50, 52, 52)).toBe(0.3);
    expect(slideFraction(0.3, 50, 0, 52)).toBe(0.3);
    expect(slideFraction(Number.NaN, 10, 340, 52)).toBe(0);
  });

  it('confirms only at or past the threshold', () => {
    expect(isSlideComplete(1)).toBe(true);
    expect(isSlideComplete(SLIDE_THRESHOLD)).toBe(true);
    expect(isSlideComplete(SLIDE_THRESHOLD - 0.01)).toBe(false);
    expect(isSlideComplete(0.5)).toBe(false);
  });

  it('keyboard: arrows step, Home/End jump; a tap or Enter never confirms', () => {
    expect(slideKey(0, 'ArrowRight')).toBe(SLIDE_KEY_STEP);
    expect(slideKey(0.9, 'ArrowUp')).toBe(1);
    expect(slideKey(0.1, 'ArrowLeft')).toBe(0);
    expect(slideKey(0.5, 'Home')).toBe(0);
    expect(slideKey(0, 'End')).toBe(1);
    expect(slideKey(0, 'Enter')).toBeNull();
    expect(slideKey(0, ' ')).toBeNull();
    let f = 0;
    for (let i = 0; i < 3; i++) f = slideKey(f, 'ArrowRight')!;
    expect(isSlideComplete(f)).toBe(false);
    expect(isSlideComplete(slideKey(f, 'ArrowRight')!)).toBe(true);
  });
});
