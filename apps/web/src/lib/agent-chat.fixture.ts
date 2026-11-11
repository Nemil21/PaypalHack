import type { AgentEvent, ConfirmResultBody } from './agent-chat';

/**
 * A recorded `POST /api/agent/chat` turn (HF-039 stream, scripted Claude + Channel3 fixtures,
 * as apps/api/src/routes/agent.test.ts): "Aurel headphones under $230" → search → suggest →
 * place_bid → confirm_required. `/agent?fixture=1` replays it with no API key or database, and
 * the unit tests drive the reducer with it. Ids are fixed so the replay is deterministic.
 */

export const FIXTURE_CONVERSATION_ID = '00000000-0000-4000-8000-0000000c0041';
export const FIXTURE_ACTION_ID = '5f0c2a8e-41aa-5b7e-9c1d-2f6b8e0a4101';
export const FIXTURE_LISTING_ID = '7a1e0f4c-3b2d-4c5e-8f60-0a1b2c3d4e5f';
export const FIXTURE_PROMPT = 'Aurel headphones under $230';

export const FIXTURE_EVENTS: AgentEvent[] = [
  {
    type: 'tool_call',
    id: 'toolu_fx_search',
    name: 'search_open_books',
    input: { query: 'Aurel headphones' },
  },
  {
    type: 'tool_result',
    id: 'toolu_fx_search',
    name: 'search_open_books',
    ok: true,
    result: {
      listings: [
        {
          listingId: FIXTURE_LISTING_ID,
          slug: 'aurel-a7',
          brand: 'Aurel Audio',
          productTitle: 'Aurel A7 Wireless Noise Cancelling Headphones',
          status: 'OPEN',
          biddable: true,
          windowClosesAt: '2026-11-14T18:00:00.000Z',
          roundsEndAt: null,
          channel3Id: 'c17VkZV',
          publicOffer: {
            source: 'Channel3',
            priceCents: 27_900,
            price: '$279',
            merchant: 'bestbuy.com',
            updatedAt: '2026-11-11T09:00:00.000Z',
          },
          suggestedBidCents: 22_900,
          myBid: null,
        },
      ],
      publicMarket: [
        {
          channel3Id: 'c17VkZV',
          title: 'Aurel A7 Wireless Noise Cancelling Headphones',
          brand: 'Aurel Audio',
          cheapestPublicPriceCents: 27_900,
          cheapestPublicPrice: '$279',
          offerCount: 9,
        },
        {
          channel3Id: 'c17VkZW',
          title: 'Aurel A5 Wireless Headphones',
          brand: 'Aurel Audio',
          cheapestPublicPriceCents: 19_900,
          cheapestPublicPrice: '$199',
          offerCount: 5,
        },
      ],
    },
  },
  {
    type: 'tool_call',
    id: 'toolu_fx_suggest',
    name: 'suggest_bid',
    input: { listingId: FIXTURE_LISTING_ID },
  },
  {
    type: 'tool_result',
    id: 'toolu_fx_suggest',
    name: 'suggest_bid',
    ok: true,
    result: {
      listingId: FIXTURE_LISTING_ID,
      slug: 'aurel-a7',
      brand: 'Aurel Audio',
      productTitle: 'Aurel A7 Wireless Noise Cancelling Headphones',
      suggestedBidCents: 22_900,
      suggestedBid: '$229',
      likelyToClearBand: { fromCents: 21_500, toCents: 23_500, text: '$215–$235' },
    },
  },
  {
    type: 'text',
    text: 'Aurel Audio has an open book for the A7. Public low is $279 at bestbuy.com, and bids around $215–$235 are likely to clear. Bid $229 in Aurel Audio’s book?',
  },
  {
    type: 'tool_call',
    id: 'toolu_fx_place',
    name: 'place_bid',
    input: { listingId: FIXTURE_LISTING_ID, amountCents: 22_900 },
  },
  {
    type: 'tool_result',
    id: 'toolu_fx_place',
    name: 'place_bid',
    ok: true,
    result: {
      confirmRequired: true,
      actionId: FIXTURE_ACTION_ID,
      status: 'PENDING',
      note: 'Nothing has been held or charged. The shopper must confirm on the card; your turn ends now. Do not say it is placed.',
      amountCents: 22_900,
    },
  },
  {
    type: 'confirm_required',
    actionId: FIXTURE_ACTION_ID,
    tool: 'place_bid',
    amountCents: 22_900,
    amountFormatted: '$229',
    product: { title: 'Aurel A7 Wireless Noise Cancelling Headphones', imageUrl: null },
    listing: { id: FIXTURE_LISTING_ID, slug: 'aurel-a7', brandName: 'Aurel Audio' },
    confirmMode: 'INLINE',
    offerUrl: null,
    expiresAt: '2099-01-01T00:00:00.000Z',
  },
  { type: 'done', conversationId: FIXTURE_CONVERSATION_ID, reason: 'confirm_required' },
];

/** The recorded wire bytes: one `data:` frame per event. */
export const RECORDED_STREAM = FIXTURE_EVENTS.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

/** What the confirm endpoint answered for that action on FakePayPal (201, vault hold). */
export const FIXTURE_CONFIRM_RESULT: ConfirmResultBody = {
  bidId: '9b2f3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  status: 'HELD',
  amountCents: 22_900,
};
