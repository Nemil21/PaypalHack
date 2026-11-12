import { useState, type FormEvent } from 'react';
import { MAX_LISTING_QUANTITY, type PublishListingResponse } from '@holdfast/shared';
import { Button, useToast } from '../../components/ui';
import { cn } from '../../lib/cn';
import { submitErrorMessage } from '../../lib/listing-wizard';
import { useApiAction } from '../../lib/use-api-action';

/**
 * Publish · Edit on a saved draft (v4 §2.2, UI-GAPS #7): `POST /api/listings/:id/publish` and
 * `PATCH /api/listings/:id {quantity}` (a draft's units can go either way). Used in the My
 * listings table (`compact`, orange text links) and on the DRAFT console (buttons).
 */
export function DraftActions({
  listingId,
  quantity,
  verified,
  compact = false,
  onChanged,
}: {
  listingId: string;
  quantity: number;
  /** Publish needs a VERIFIED brand (HF-011a); unverified brands get the reason, not a 403. */
  verified: boolean;
  compact?: boolean;
  onChanged(): void;
}) {
  const toast = useToast();
  const publish = useApiAction<PublishListingResponse>();
  const edit = useApiAction<unknown>();
  const [editing, setEditing] = useState(false);
  const [units, setUnits] = useState(String(quantity));

  const id = encodeURIComponent(listingId);
  const error =
    publish.status === 'error'
      ? submitErrorMessage(publish.error)
      : edit.status === 'error'
        ? edit.error.message
        : null;

  async function onPublish() {
    const out = await publish.run({ method: 'POST', path: `/api/listings/${id}/publish` });
    if (!out) return;
    publish.reset();
    toast.show({ title: 'Window open', body: 'Your offer link is live.', tone: 'success' });
    onChanged();
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    const n = Number(units);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LISTING_QUANTITY) return;
    const out = await edit.run({
      method: 'PATCH',
      path: `/api/listings/${id}`,
      body: { quantity: n },
    });
    if (out === undefined) return;
    edit.reset();
    setEditing(false);
    onChanged();
  }

  const link = 'label text-[12px] text-orange hover:underline disabled:opacity-50';
  const pending = publish.status === 'pending' || edit.status === 'pending';

  return (
    <div className={cn('flex flex-col gap-2', compact && 'gap-1')}>
      {editing ? (
        <form onSubmit={onSave} className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-[13px] text-body">
            Units
            <input
              type="number"
              min={1}
              max={MAX_LISTING_QUANTITY}
              step={1}
              required
              value={units}
              onChange={(e) => setUnits(e.target.value)}
              className="h-8 w-24 rounded-sm border border-border px-2 text-[14px] text-ink tabular-nums"
              autoFocus
            />
          </label>
          {compact ? (
            <>
              <button type="submit" className={link} disabled={pending}>
                {edit.status === 'pending' ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                className="label text-[12px] text-body hover:underline"
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <Button type="submit" variant="secondary" disabled={pending}>
                {edit.status === 'pending' ? 'Saving…' : 'Save'}
              </Button>
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </>
          )}
        </form>
      ) : compact ? (
        <span className="flex items-center gap-1.5">
          <button
            type="button"
            className={link}
            disabled={pending || !verified}
            title={verified ? undefined : 'Your brand must be verified to publish.'}
            onClick={() => void onPublish()}
          >
            {publish.status === 'pending' ? 'Publishing…' : 'Publish'}
          </button>
          <span aria-hidden className="text-orange">
            ·
          </span>
          <button type="button" className={link} onClick={() => setEditing(true)}>
            Edit →
          </button>
        </span>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={pending || !verified}
            title={verified ? undefined : 'Your brand must be verified to publish.'}
            onClick={() => void onPublish()}
          >
            {publish.status === 'pending' ? 'Publishing…' : 'Publish'}
          </Button>
          <Button variant="outline" onClick={() => setEditing(true)}>
            Edit units
          </Button>
        </div>
      )}
      {error && <p className="text-[13px] text-danger">{error}</p>}
    </div>
  );
}
