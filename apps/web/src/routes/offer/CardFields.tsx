import { useEffect, useRef, useState } from 'react';
import {
  createCardFieldsSession,
  type CardFieldType,
  type CardFieldsSession,
} from '../../lib/paypal-sdk';

const FIELDS: Array<{ type: CardFieldType; placeholder: string; label: string }> = [
  { type: 'number', placeholder: 'Card number', label: 'Card number' },
  { type: 'expiry', placeholder: 'MM/YY', label: 'Expiry' },
  { type: 'cvv', placeholder: 'CVV', label: 'Security code' },
  { type: 'name', placeholder: 'Name on card', label: 'Name on card' },
];

/**
 * PayPal-hosted card fields (JS SDK v6). Each field is PayPal's own iframe: what the shopper types
 * never reaches our page script or our API. `onSession` hands the session up so the page can
 * `submit(orderId)` after `POST /api/bids` (CARD) returns the order.
 */
export function CardFields({
  clientId,
  sandbox,
  onSession,
}: {
  clientId: string;
  sandbox: boolean;
  onSession(session: CardFieldsSession | null): void;
}) {
  const slots = useRef<Partial<Record<CardFieldType, HTMLDivElement | null>>>({});
  const [state, setState] = useState<'loading' | 'ready' | 'ineligible' | 'error'>('loading');
  const onSessionRef = useRef(onSession);
  onSessionRef.current = onSession;

  useEffect(() => {
    let cancelled = false;
    const mounted: HTMLElement[] = [];
    createCardFieldsSession({ clientId, sandbox })
      .then((session) => {
        if (cancelled) return;
        if (!session) {
          setState('ineligible');
          onSessionRef.current(null);
          return;
        }
        for (const f of FIELDS) {
          const el = session.createCardFieldsComponent({
            type: f.type,
            placeholder: f.placeholder,
          });
          slots.current[f.type]?.appendChild(el);
          mounted.push(el);
        }
        setState('ready');
        onSessionRef.current(session);
      })
      .catch(() => {
        if (cancelled) return;
        setState('error');
        onSessionRef.current(null);
      });
    return () => {
      cancelled = true;
      for (const el of mounted) el.remove();
      onSessionRef.current(null);
    };
  }, [clientId, sandbox]);

  return (
    <div className="flex flex-col gap-2">
      {state === 'loading' && <p className="text-[13px] text-muted">Loading secure card fields…</p>}
      {state === 'ineligible' && (
        <p className="text-[13px] text-danger">Card payments aren't available here. Use PayPal.</p>
      )}
      {state === 'error' && (
        <p className="text-[13px] text-danger">
          We couldn't load PayPal's card fields. Use PayPal, or reload the page.
        </p>
      )}
      <div className={state === 'ready' ? 'grid grid-cols-2 gap-2' : 'hidden'}>
        {FIELDS.map((f) => (
          <div
            key={f.type}
            aria-label={f.label}
            className={f.type === 'number' || f.type === 'name' ? 'col-span-2' : ''}
            ref={(el) => {
              slots.current[f.type] = el;
            }}
          />
        ))}
      </div>
    </div>
  );
}
