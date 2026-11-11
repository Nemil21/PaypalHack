import { useEffect, useId, useState } from 'react';
import { formatUsd } from '@holdfast/shared';
import { dollarsText, parseDollarInput, stepAmount } from '../../lib/offer';

/**
 * Price input + slider (W12) with the M01 big ± $5 stepper. The text field opens the numeric
 * keypad on phones (`inputMode="decimal"`). The parent owns the amount in cents.
 */
export function PriceInput({
  amount,
  onChange,
  range,
  hint,
  label = 'Your price',
  disabled,
}: {
  amount: number;
  onChange(cents: number): void;
  range: { min: number; max: number };
  hint?: string | null;
  label?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const [text, setText] = useState(() => dollarsText(amount));
  const [invalid, setInvalid] = useState(false);

  // Follow outside changes (slider, stepper, deep link) unless the field is mid-edit.
  useEffect(() => {
    setText((t) => (parseDollarInput(t) === amount ? t : dollarsText(amount)));
    setInvalid(false);
  }, [amount]);

  const stepper =
    'label flex h-14 w-14 shrink-0 items-center justify-center rounded-sm border border-border bg-white text-[22px] text-charcoal hover:bg-surface disabled:opacity-50';

  return (
    <div className="flex flex-col gap-3">
      <label htmlFor={id} className="label text-[12px] text-muted">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={stepper}
          aria-label="Lower by $5"
          disabled={disabled}
          onClick={() => onChange(stepAmount(amount, -1))}
        >
          −
        </button>
        <div className="relative min-w-0 flex-1">
          <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[28px] font-medium text-muted">
            $
          </span>
          <input
            id={id}
            inputMode="decimal"
            autoComplete="off"
            disabled={disabled}
            aria-invalid={invalid}
            aria-describedby={hint ? `${id}-hint` : undefined}
            className="h-14 w-full rounded-sm border border-border bg-white pr-3 pl-8 text-[30px] font-medium tracking-title text-ink tabular-nums focus:border-orange focus:outline-none aria-[invalid=true]:border-danger"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              const cents = parseDollarInput(e.target.value);
              setInvalid(cents === null);
              if (cents !== null) onChange(cents);
            }}
            onBlur={() => {
              setText(dollarsText(amount));
              setInvalid(false);
            }}
          />
        </div>
        <button
          type="button"
          className={stepper}
          aria-label="Raise by $5"
          disabled={disabled}
          onClick={() => onChange(stepAmount(amount, 1))}
        >
          +
        </button>
      </div>
      <input
        type="range"
        aria-label={`${label} slider`}
        min={range.min}
        max={range.max}
        step={100}
        value={Math.min(range.max, Math.max(range.min, amount))}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-orange"
      />
      <div className="flex justify-between font-mono text-[12px] text-muted">
        <span>{formatUsd(range.min)}</span>
        <span>{formatUsd(range.max)}</span>
      </div>
      {invalid && (
        <p className="text-[13px] text-danger">Enter an amount between $1 and $10,000.</p>
      )}
      {hint && (
        <p id={`${id}-hint`} className="text-[14px] text-body">
          {hint}
        </p>
      )}
    </div>
  );
}
