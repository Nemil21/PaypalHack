import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';
import { cn } from '../../lib/cn';

/**
 * v3 button: Geist Mono uppercase label, square corners, optional keyboard-shortcut chip.
 * `primary` is the orange main action, `secondary` the charcoal one; `outline` matches
 * "COPY MCP SETUP". There is deliberately no spinner: a pending button reads "…" and is disabled.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost';
export type ButtonSize = 'md' | 'lg';

interface StyleProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Keyboard shortcut shown in a chip, e.g. "P". Display only. */
  shortcut?: string;
  block?: boolean;
}

const base =
  'label inline-flex shrink-0 items-center justify-center gap-3.5 rounded-sm whitespace-nowrap transition-colors select-none disabled:cursor-not-allowed disabled:opacity-50';

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-orange text-white hover:bg-orange/90',
  secondary: 'bg-charcoal text-white hover:bg-ink',
  outline: 'border border-border bg-white text-charcoal hover:bg-surface',
  ghost: 'text-body hover:bg-surface hover:text-ink',
};

const sizes: Record<ButtonSize, string> = {
  md: 'h-9 pl-4 pr-3 text-[13px]',
  lg: 'h-[42px] pl-4 pr-3 text-[14px]',
};

const chipTone: Record<ButtonVariant, string> = {
  primary: 'bg-white/18 text-orange-key',
  secondary: 'bg-white/18 text-charcoal-key',
  outline: 'bg-surface text-muted',
  ghost: 'bg-surface text-muted',
};

export function buttonClass({ variant = 'primary', size = 'md', shortcut, block }: StyleProps) {
  return cn(base, variants[variant], sizes[size], !shortcut && 'pr-4', block && 'w-full');
}

function Content({
  children,
  shortcut,
  variant = 'primary',
}: StyleProps & { children: ReactNode }) {
  return (
    <>
      <span>{children}</span>
      {shortcut && (
        <kbd
          className={cn(
            'rounded-sm px-[5px] py-px font-mono text-[11px] font-normal',
            chipTone[variant],
          )}
          aria-hidden
        >
          {shortcut}
        </kbd>
      )}
    </>
  );
}

export function Button({
  variant,
  size,
  shortcut,
  block,
  className,
  children,
  type = 'button',
  ...rest
}: StyleProps & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={cn(buttonClass({ variant, size, shortcut, block }), className)}
      {...rest}
    >
      <Content shortcut={shortcut} variant={variant}>
        {children}
      </Content>
    </button>
  );
}

export function ButtonLink({
  variant,
  size,
  shortcut,
  block,
  className,
  children,
  ...rest
}: StyleProps & LinkProps) {
  return (
    <Link className={cn(buttonClass({ variant, size, shortcut, block }), className)} {...rest}>
      <Content shortcut={shortcut} variant={variant}>
        {children}
      </Content>
    </Link>
  );
}
