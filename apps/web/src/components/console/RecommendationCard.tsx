import type { Recommendation } from '@holdfast/shared';
import { recommendationView, type RecommendationChoice } from '../../lib/console/recommendation';
import { useSlider, useSliderStore } from '../../lib/console/slider-store';
import { Button } from '../ui';

/**
 * W06 brand agent panel, code-only part (HF-051a, features/09 §Logic 4): the recommendation card
 * and "Apply to slider". Applying sets the slider store's quantity (exact `clear()` at once); it
 * never clears. Numbers render from the JSON fields only. HF-051b adds Claude's `prose` under
 * the numbers (commentary; absent when Claude is down) and the Ask panel below the card.
 */
export function RecommendationCard({
  recommendation,
  disabled = false,
  prose = null,
}: {
  recommendation: Recommendation;
  disabled?: boolean;
  prose?: string | null;
}) {
  const store = useSliderStore();
  const slider = useSlider();
  const view = recommendationView(recommendation);
  const onSlider = (q: number) => slider.committedQuantity === q && !slider.dragging;
  const apply = (q: number) => store.setSliderQuantity(q);

  return (
    <section
      aria-label="Brand agent"
      className="flex flex-col gap-3 rounded-md border border-line bg-white p-4"
      data-testid="recommendation-card"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="label text-[11px] text-muted">Brand agent</h2>
        <span className="text-[12px] text-muted">Computed from the live book</span>
      </div>

      {view.kind === 'empty' && <p className="text-[15px] text-body">{view.message}</p>}

      {view.kind === 'below_guard' && <p className="text-[15px] text-body">{view.message}</p>}

      {view.kind === 'recommend' && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <p className="text-[18px] font-medium tracking-headline text-ink tabular-nums">
              {view.primary.label}
            </p>
            <p className="text-[14px] text-body tabular-nums">{view.primary.detail}</p>
            <p className="text-[12px] text-muted">{view.guardNote}</p>
          </div>
          <Button
            variant="secondary"
            onClick={() => apply(view.primary.quantity)}
            disabled={disabled || onSlider(view.primary.quantity)}
            data-testid="apply-recommendation"
          >
            {onSlider(view.primary.quantity) ? 'On the slider' : 'Apply to slider'}
          </Button>
        </div>
      )}

      {prose && view.kind === 'recommend' && (
        <p className="text-[14px] text-body" data-testid="recommendation-prose">
          {prose}
        </p>
      )}

      {view.kind !== 'empty' && view.alternatives.length > 0 && (
        <ul className="flex flex-col divide-y divide-line border-t border-line">
          {view.alternatives.map((a) => (
            <Alternative
              key={a.quantity}
              choice={a}
              current={onSlider(a.quantity)}
              disabled={disabled}
              onApply={() => apply(a.quantity)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function Alternative({
  choice,
  current,
  disabled,
  onApply,
}: {
  choice: RecommendationChoice;
  current: boolean;
  disabled: boolean;
  onApply(): void;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 pt-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-[14px] text-ink tabular-nums">{choice.label}</span>
        <span className="text-[13px] text-body tabular-nums">{choice.detail}</span>
        {choice.warning && <span className="text-[12px] text-orange">{choice.warning}</span>}
      </div>
      <Button variant="ghost" onClick={onApply} disabled={disabled || current}>
        {current ? 'On the slider' : 'Apply'}
      </Button>
    </li>
  );
}
