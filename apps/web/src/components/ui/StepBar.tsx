import { cn } from '../../lib/cn';

/**
 * v4 wizard steps (frames 117:349 W03, 117:606 W05): one column per step with a 2 px top bar, ink
 * when done, orange for the current step, hairline ahead; mono "01 · COMPANY" under it. Each step
 * is a button, so a brand can jump back (the wizards validate before moving forward).
 */
export function StepBar({
  steps,
  step,
  onStep,
}: {
  steps: readonly string[];
  step: number;
  onStep(i: number): void;
}) {
  return (
    <ol
      className="grid gap-x-3 gap-y-2"
      style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
      aria-label="Steps"
    >
      {steps.map((label, i) => (
        <li key={label} className="min-w-0">
          <button
            type="button"
            onClick={() => onStep(i)}
            aria-current={i === step ? 'step' : undefined}
            className={cn(
              'label flex w-full flex-col items-start gap-2 border-t-2 pt-2 text-left text-[11px]',
              i === step
                ? 'border-orange text-orange'
                : i < step
                  ? 'border-ink text-ink hover:text-body'
                  : 'border-line text-muted hover:text-body',
            )}
          >
            <span className="truncate">
              {String(i + 1).padStart(2, '0')}
              <span className="hidden sm:inline"> · {label}</span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}
