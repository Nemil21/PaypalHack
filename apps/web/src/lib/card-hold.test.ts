import { describe, expect, it } from 'vitest';
import { ApiError } from './api.js';
import { CardHold, type CardHoldPorts } from './card-hold.js';
import type { CardSubmitResult } from './paypal-sdk.js';

type AuthReply = { status: string } | ApiError;

function ports(opts: { submits?: CardSubmitResult['state'][]; auths?: AuthReply[] } = {}) {
  const submits = [...(opts.submits ?? [])];
  const auths = [...(opts.auths ?? [])];
  let n = 0;
  const calls = {
    placeBid: 0,
    submit: [] as string[],
    authorize: [] as string[],
    cancel: [] as string[],
  };
  const p: CardHoldPorts = {
    async placeBid() {
      calls.placeBid++;
      n++;
      return { bidId: `bid-${n}`, status: 'PENDING_APPROVAL', orderId: `order-${n}` };
    },
    async submit(orderId) {
      calls.submit.push(orderId);
      return { state: submits.shift() ?? 'succeeded' };
    },
    async authorize(bidId) {
      calls.authorize.push(bidId);
      const r = auths.shift() ?? { status: 'HELD' };
      if (r instanceof ApiError) throw r;
      return r;
    },
    async cancel(bidId) {
      calls.cancel.push(bidId);
      return {};
    },
  };
  return { p, calls };
}

const err5xx = () => new ApiError(502, 'PAYPAL_ERROR', 'later');

describe('CardHold (review: card authorize retries)', () => {
  it('happy path: place → submit → authorize → held', async () => {
    const { p, calls } = ports();
    const card = new CardHold();
    expect(await card.run(22_900, p)).toEqual({ kind: 'held', bidId: 'bid-1' });
    expect(calls).toMatchObject({ placeBid: 1, submit: ['order-1'], authorize: ['bid-1'] });
    expect(card.pending).toBeNull();
  });

  it('authorize fails with 5xx → Try again re-authorizes the same bid (no second POST /bids, no re-submit)', async () => {
    const { p, calls } = ports({ auths: [err5xx(), { status: 'HELD' }] });
    const card = new CardHold();
    await expect(card.run(22_900, p)).rejects.toMatchObject({ status: 502 });
    expect(card.pending).toMatchObject({ bidId: 'bid-1', submitted: true });

    expect(await card.run(22_900, p)).toEqual({ kind: 'held', bidId: 'bid-1' });
    expect(calls.placeBid).toBe(1);
    expect(calls.submit).toEqual(['order-1']);
    expect(calls.authorize).toEqual(['bid-1', 'bid-1']);
    expect(calls.cancel).toEqual([]);
  });

  it('network error and IN_PROGRESS keep the bid too; a non-HELD answer re-authorizes', async () => {
    const { p, calls } = ports({
      auths: [
        new ApiError(0, 'NETWORK_ERROR', 'offline'),
        new ApiError(409, 'IN_PROGRESS', 'running'),
        { status: 'PENDING_APPROVAL' },
        { status: 'HELD' },
      ],
    });
    const card = new CardHold();
    await expect(card.run(22_900, p)).rejects.toBeInstanceOf(ApiError);
    await expect(card.run(22_900, p)).rejects.toBeInstanceOf(ApiError);
    expect(await card.run(22_900, p)).toEqual({ kind: 'not_held' });
    expect(await card.run(22_900, p)).toEqual({ kind: 'held', bidId: 'bid-1' });
    expect(calls.placeBid).toBe(1);
    expect(calls.authorize).toEqual(['bid-1', 'bid-1', 'bid-1', 'bid-1']);
  });

  it('terminal authorize failure ends the bid: the next attempt is a new bid', async () => {
    const { p, calls } = ports({ auths: [new ApiError(422, 'HOLD_FAILED', 'declined')] });
    const card = new CardHold();
    await expect(card.run(22_900, p)).rejects.toMatchObject({ code: 'HOLD_FAILED' });
    expect(card.pending).toBeNull();
    expect(await card.run(22_900, p)).toEqual({ kind: 'held', bidId: 'bid-2' });
    expect(calls.placeBid).toBe(2);
    expect(calls.cancel).toEqual([]);
  });

  it('failed submit → retry re-submits the same order', async () => {
    const { p, calls } = ports({ submits: ['failed', 'succeeded'] });
    const card = new CardHold();
    expect(await card.run(22_900, p)).toEqual({ kind: 'submit_failed', cancelled: false });
    expect(await card.run(22_900, p)).toEqual({ kind: 'held', bidId: 'bid-1' });
    expect(calls.placeBid).toBe(1);
    expect(calls.submit).toEqual(['order-1', 'order-1']);
  });

  it('a different amount (or another method) cancels the pending bid first', async () => {
    const { p, calls } = ports({ submits: ['canceled'] });
    const card = new CardHold();
    expect(await card.run(22_900, p)).toEqual({ kind: 'submit_failed', cancelled: true });
    expect(await card.run(23_900, p)).toEqual({ kind: 'held', bidId: 'bid-2' });
    expect(calls.cancel).toEqual(['bid-1']);

    const other = ports({ auths: [err5xx()] });
    const c2 = new CardHold();
    await expect(c2.run(22_900, other.p)).rejects.toBeInstanceOf(ApiError);
    await c2.release(other.p);
    expect(other.calls.cancel).toEqual(['bid-1']);
    expect(c2.pending).toBeNull();
  });
});
