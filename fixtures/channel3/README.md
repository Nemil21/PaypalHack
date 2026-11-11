# Channel3 fixtures (HF-009)

Used when `CHANNEL3_MODE=fixtures` (CI, clean clones, offline demos) by `packages/core/src/channel3`.

| Path | What | Source |
|---|---|---|
| `search/<slug>.json` | `POST /v1/search` request + response | recorded |
| `products/<id>.json` | `GET /v1/products/{id}` (free detail endpoint) for every search hit | recorded |
| `webhooks/offer.price.changed.json` | price-change webhook body | **schema-derived** from the OpenAPI spec; replace with a live delivery in HF-042b |

Searches (D15: the seeded listing is the fictional Aurel A7, so its comparison search is generic):

- `over-ear-anc-headphones`: "wireless noise cancelling over-ear headphones" (Aurel A7 comparison)
- `portable-bluetooth-speaker`: "portable bluetooth speaker waterproof"
- `anc-earbuds`: "true wireless noise cancelling earbuds"

Re-record: `node scripts/channel3-record-fixtures.mjs` (REST when `CHANNEL3_API_KEY` is set, 3 search
credits; otherwise the keyless MCP free tier, which returns the same `Product` schema). Each file's
`_recording` says which path produced it. Prices, offers and buy links go stale: tests must not assume
today's prices, only the shapes and the values in these files.

What the live data showed (vs. the original api.md guess):

- No GTIN or MPN on any of the 24 products: `structured_attributes` are kebab-case feature handles
  (`noise-cancellation-technology`, `headphone-style`, ...). Manual GTIN/MPN entry is the common path.
- Offers are `{url, domain, price{price, compare_at_price, currency}, availability, condition}`;
  `condition` is `new`, `used` or `null`; out-of-stock offers are returned.
- Variants: `variants.selected` is `[{name, label}]`; colour options often point at a sibling
  product id (`options[].values[].product_id`), so a colour is its own Channel3 product.
- The webhook carries `subject.{product_id, domain, selection}` and `previous` / `current` prices,
  with no condition.
