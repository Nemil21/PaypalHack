# 10 — Pay Later Messaging Integration (JS SDK v6)

Sources: https://developer.paypal.com/pay-later/integrate · https://developer.paypal.com/pay-later/reference

The PayPal Messages SDK displays Pay Later messaging (Pay in 4, Pay Monthly…) on product, cart, and checkout pages, updating as cart values change, with a Learn More modal. **This guide is messaging only** — for the Pay Later *button*, set up JS SDK v6 (`/sdk/js/set-up`, see doc 06).

## Prerequisites
- Sandbox **Client ID** from https://developer.paypal.com/dashboard/ (preferred), *or* a server-generated **Client Token**. Not both.
- HTTPS page.

## Three configuration patterns
| Pattern | When |
|---|---|
| **HTML** | Simplest; everything via attributes on `<paypal-message>`, `auto-bootstrap` |
| **JavaScript** | Full control; bare tag + `fetchContent()` |
| **Hybrid** | Multiple placements / mixed logic; `getFetchContentOptions()` merges HTML attrs + JS |

## Steps

### 1. Load the SDK
```html
<script async src="https://www.sandbox.paypal.com/web-sdk/v6/core" onload="onPayPalWebSdkLoaded()"></script>
```
Load `paypal-messages` via `components` in `createInstance` (not a second script tag).
> Note: the official guide's step 1 snippet shows `clientToken: "YOUR_CLIENT_ID"` — that's a doc typo. Use `clientId: "YOUR_CLIENT_ID"`.

### 2. Add the element
```html
<!-- HTML pattern -->
<paypal-message auto-bootstrap amount="300.00" currency-code="USD"
  logo-type="MONOGRAM" text-color="MONOCHROME"></paypal-message>
<!-- JS pattern -->
<paypal-message></paypal-message>
<!-- Hybrid -->
<paypal-message amount="300.00"></paypal-message>
```
Invisible until content is fetched.

### 3. Create SDK + Messages instances
```js
const sdkInstance = await window.paypal.createInstance({
  clientId: "YOUR_CLIENT_ID",
  components: ["paypal-messages"],
});
const messagesInstance = sdkInstance.createPayPalMessages({ currencyCode: "USD" });
```

### 4. Fetch content
```js
// JS pattern
const el = document.querySelector('paypal-message');
const content = await messagesInstance.fetchContent({
  amount: "300.00", currencyCode: "USD",
  logoType: "MONOGRAM", textColor: "BLACK", logoPosition: "LEFT",
  onReady: (c) => el.setContent(c),
});
// Hybrid
const content = await messagesInstance.fetchContent({
  ...el.getFetchContentOptions(), logoType: "MONOGRAM", textColor: "BLACK",
});
```
HTML pattern with `auto-bootstrap` needs nothing here.

### 5. Dynamic amount updates (recalculate totals server-side first!)
```js
el.setAttribute('amount', newAmount);   // HTML pattern
content.update({ amount: newAmount });  // JS/Hybrid pattern
```

### 6. (Optional, recommended) Learn More
```js
const learnMore = await messagesInstance.createLearnMore({
  presentationMode: "MODAL", // AUTO | MODAL | POPUP | REDIRECT
  onShow, onApply, onCalculate: (amount) => {}, onClose,
});
el.addEventListener('paypal-message-click', (e) => {
  e.preventDefault();            // required
  learnMore.open(e.detail.config);
});
```

### 7. (Optional) Analytics
`fetchContent` callbacks: `onTemplateReady` (cached), `onContentReady` (fresh; takes precedence), `onReady` (fallback). Plus `paypal-message-click` and Learn More callbacks.

### 8. (Optional) Styling
```css
paypal-message {
  --paypal-message-font-size: 14px;   /* 10–16px, clamped */
  --paypal-message-text-align: center; /* left | right | center */
}
```

## Reference

### `<paypal-message>` attributes
| Attribute | Values | Default |
|---|---|---|
| `amount` | price string, ≤2 decimals | — |
| `auto-bootstrap` | boolean | `false` |
| `currency-code` | 3-letter ISO (USD, GBP, EUR, CAD…) | — |
| `logo-position` | `INLINE`, `LEFT`, `RIGHT`, `TOP` | `LEFT` |
| `logo-type` | `MONOGRAM` (needs LEFT), `TEXT` (needs INLINE), `WORDMARK` | `WORDMARK` |
| `presentation-mode` | `AUTO`, `MODAL`, `POPUP`, `REDIRECT` | `AUTO` |
| `text-color` | `BLACK`, `MONOCHROME`, `WHITE` | `BLACK` |
| `alternative-prefix` | `LOWERCASE_OR`, `UPPERCASE_OR` (forces INLINE) | — |
| `message-length` | `COMPACT` | — |

PayPal Debit Card / Cashback Mastercard can't use `INLINE` → falls back to `LEFT`.

### Element methods
`setContent(content)` · `getFetchContentOptions()`

### Messages instance
Methods: `fetchContent(opts)`, `createLearnMore(opts)`.
`createPayPalMessages` options: `currencyCode`, `shopperSessionId` (UUID format), `buyerCountry` (only for merchants approved for cross-border).

### `fetchContent` options
`amount`, `currencyCode`, `logoPosition`, `logoType`, `textColor`, `onContentReady`, `onReady`, `onTemplateReady`, `alternativePrefix`, `messageLength`.

### `createLearnMore` options
`amount`, `presentationMode`, `onApply`, `onCalculate`, `onShow`, `onClose`.

### `createInstance` options (messaging-relevant)
`clientId` (recommended) / `clientToken`, `pageType` (`cart`, `checkout`, `home`, `mini-cart`, `product`, `product-details`, `product-listing`, `search-results`), `partnerAttributionId`, `shopperSessionId`, `locale`.

## Error handling & troubleshooting
| Problem | Cause | Fix |
|---|---|---|
| Message doesn't appear | Scripts not loaded, bad `clientId`, HTTP page | Check Network tab for `/web-sdk/v6/core` and `/web-sdk/v6/paypal-messages`; verify clientId; use HTTPS; confirm element in DOM; check console |
| Learn More doesn't open | `createLearnMore()` not called / no listener / missing `preventDefault()` | Add all three |
| Wrong amount | Client-side-only calc | Recalculate server-side first |
| Doesn't render for some users | Unsupported country/currency | try/catch around `fetchContent()`, hide gracefully |
| Unsupported locale | Bad `locale` | Use supported value (e.g. `en-CA`, `fr-CA`); otherwise browser language |

- **No SSR.** Needs `window.paypal`; in React/Next load inside `useEffect` / a client component.
- **Mobile** works; use `presentationMode: "AUTO"`.
- **Testing:** sandbox business account → sandbox clientId → amounts ~$50–$1,000.

## Pre-production checklist (official)
- [ ] SDK scripts loaded (`core` and `paypal-messages`)
- [ ] `<paypal-message>` in HTML
- [ ] SDK instance with valid `clientId`/`clientToken`
- [ ] Messages instance created
- [ ] Content fetched and displayed
- [ ] Amount updates tested with user interactions
- [ ] Learn More configured (optional)
- [ ] Analytics callbacks (optional)
- [ ] Styling customized (optional)
- [ ] Sandbox tested with multiple amounts
- [ ] Load-time monitoring
- [ ] Error handling for network failures
- [ ] Lazy loading (if applicable)
- [ ] Browser compatibility verified
- [ ] Responsive design tested
- [ ] Production credentials configured
- [ ] Production deployment verified
