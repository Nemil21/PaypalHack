import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { cn } from '../../lib/cn';

/**
 * Toast host. Wrap the app in <ToastProvider>; call `useToast().show(...)` anywhere. Used for
 * live events (e.g. `pricewatch.released` on the console) and action outcomes. Toasts announce
 * politely to screen readers and dismiss themselves.
 */
export type ToastTone = 'info' | 'success' | 'error';

export interface ToastInput {
  title: string;
  body?: string;
  tone?: ToastTone;
  /** Milliseconds; 0 keeps it until dismissed. */
  duration?: number;
}

interface ToastItem extends Required<Omit<ToastInput, 'body'>> {
  id: number;
  body?: string;
}

interface ToastApi {
  show(toast: ToastInput): number;
  dismiss(id: number): void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

const accent: Record<ToastTone, string> = {
  info: 'bg-charcoal',
  success: 'bg-success',
  error: 'bg-danger',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((all) => all.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    ({ title, body, tone = 'info', duration = 5000 }: ToastInput) => {
      const id = nextId.current++;
      setItems((all) => [...all.slice(-3), { id, title, body, tone, duration }]);
      if (duration > 0) setTimeout(() => dismiss(id), duration);
      return id;
    },
    [dismiss],
  );

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-stretch gap-2 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-[360px]"
      >
        {items.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            className="pointer-events-auto flex overflow-hidden rounded-md border border-line bg-white shadow-card"
          >
            <span aria-hidden className={cn('w-1 shrink-0', accent[t.tone])} />
            <div className="flex min-w-0 flex-1 flex-col gap-1 p-3">
              <span className="text-[14px] font-medium text-ink">{t.title}</span>
              {t.body && <span className="text-[13px] text-body">{t.body}</span>}
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="label px-3 text-[11px] text-muted hover:text-ink"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
