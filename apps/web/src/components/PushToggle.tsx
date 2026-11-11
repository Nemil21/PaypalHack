import { useEffect, useState } from 'react';
import { ApiError } from '../lib/api';
import { cn } from '../lib/cn';
import type { Audience } from '../lib/notifications';
import {
  currentEnvironment,
  disablePush,
  enablePush,
  pushState,
  PUSH_STATE_COPY,
  sendTestPush,
  type PushState,
} from '../lib/push';
import { Button } from './ui';

/**
 * "Phone alerts" switch (HF-054b; M11 header): turn web push on for this browser, off again, or
 * send a test alert to this account's devices. The permission prompt is only asked from the tap
 * (iOS requires it), never on page load.
 */
export function PushToggle({ audience, className }: { audience: Audience; className?: string }) {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void currentEnvironment()
      .then((env) => live && setState(pushState(env)))
      .catch(() => live && setState('unsupported'));
    return () => {
      live = false;
    };
  }, []);

  const act = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      await fn();
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : "Couldn't change phone alerts. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const on = state === 'on';
  const canToggle = state === 'on' || state === 'off';

  return (
    <section
      aria-label="Phone alerts"
      className={cn('flex flex-col gap-3 rounded-md border border-border bg-white p-4', className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[15px] font-medium text-ink">Phone alerts</p>
          <p className="text-[14px] text-body">{state ? PUSH_STATE_COPY[state] : 'Checking…'}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canToggle && (
            <Button
              variant={on ? 'outline' : 'primary'}
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  setState(on ? await disablePush(audience) : await enablePush(audience));
                })
              }
            >
              {busy ? '…' : on ? 'Turn off' : 'Turn on alerts'}
            </Button>
          )}
          {on && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const res = await sendTestPush(audience);
                  setNote(
                    res.sent > 0
                      ? `Test alert sent to ${res.sent} ${res.sent === 1 ? 'device' : 'devices'}.`
                      : 'No device took the test alert. Turn alerts off and on again.',
                  );
                })
              }
            >
              Send a test
            </Button>
          )}
        </div>
      </div>
      {note && (
        <p role="status" className="text-[13px] text-body">
          {note}
        </p>
      )}
    </section>
  );
}
