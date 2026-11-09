---
title: Pay Later reference
description: Use this reference to configure advanced options and customize your
  Pay Later integration.
---

# Pay Later reference (/pay-later/reference)



The Pay Later Messages SDK helps you display Pay Later messaging, such as Pay in 4 or Pay Monthly, on your site. This reference supplements the [integration guide](./integrate) with additional configuration details. Use it as a lookup resource when you need details about a specific attribute, method, or option. For example, use this reference to customize message appearance, configure analytics callbacks, or adjust SDK behavior.

For an explanation of Pay Later offers, eligibility, and country availability, see the [Pay Later overview](/pay-later/overview). If you haven't integrated Pay Later messaging yet, start with the [integration guide](./integrate).

> **Info:** For information about handling errors and edge cases during integration, see 
>
> [Error handling](./integrate)
>
>  in the integration guide.

## The `<paypal-message>` SDK component [#the-paypal-message-sdk-component]

The `paypal-message` SDK component uses a custom Lit web component, `<paypal-message>`, to render Pay Later messages on a webpage.

The SDK operates in three stages: you initialize an SDK instance with your credentials, create a PayPal Messages instance to activate the messaging module, and then fetch content from PayPal's servers to populate the `<paypal-message>` element with the appropriate offer for the shopper's location and cart value. The component, instance, and fetch content options that this reference describes each correspond to one of these stages.

### Web component attributes [#web-component-attributes]

You set these attributes directly on the `<paypal-message>` HTML tag.

| HTML attribute       | Description                                                                                                                                                                                                                                                                                                                          | Default value |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| `amount`             | Price string with up to 2 decimal places (for example, `"300.00"`). Drives the installment calculation. Also settable via `fetchContent`.                                                                                                                                                                                            | None          |
| `auto-bootstrap`     | If `true`, PayPal automatically picks up the component and fetches content without you calling `fetchContent` manually. If `false`, you must call `fetchContent` yourself.                                                                                                                                                           | `false`       |
| `currency-code`      | 3-character currency code (for example, `"USD"`, `"GBP"`). Also settable as a PayPal Messages instance option and a `fetchContent` option.                                                                                                                                                                                           | None          |
| `logo-position`      | Where to place the PayPal logo relative to the message text. Also settable via `fetchContent`. Options: `INLINE`, `LEFT`, `RIGHT`, `TOP`. > **Info:** PayPal Debit Card and PayPal Cashback Mastercard are incompatible with the `INLINE` logo position. If `INLINE` is set for these payment methods, the SDK falls back to `LEFT`. | `LEFT`        |
| `logo-type`          | The logo style. Also settable via `fetchContent`. Options: `MONOGRAM` (requires `logo-position: LEFT`), `TEXT` (requires `logo-position: INLINE`), `WORDMARK`.                                                                                                                                                                       | `WORDMARK`    |
| `presentation-mode`  | How the Learn More overlay loads when a shopper clicks the message. Also settable via `createLearnMore`. Options: `AUTO`, `MODAL`, `POPUP`, `REDIRECT`.                                                                                                                                                                              | `AUTO`        |
| `text-color`         | Message text color. Also settable via `fetchContent`. Options: `BLACK`, `MONOCHROME`, `WHITE`.                                                                                                                                                                                                                                       | `BLACK`       |
| `alternative-prefix` | Adds an `or` prefix to the message. Options: `LOWERCASE_OR`, `UPPERCASE_OR`. > **Info:** Setting `alternative-prefix` forces `logo-position` to `INLINE`.                                                                                                                                                                            | None          |
| `message-length`     | Requests a shorter message variant. Option: `COMPACT`.                                                                                                                                                                                                                                                                               | None          |

### Web component methods [#web-component-methods]

These methods are available when you have a reference to the `<paypal-message>` element.

| Method                   | Description                                                                                                                                                | Arguments                            | Returns                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------- |
| `setContent`             | Manually sets the content of the message component. Used in the JavaScript configuration pattern.                                                          | Content returned by `fetchContent()` | `void`                                                  |
| `getFetchContentOptions` | Reads HTML attributes from the component and returns them as a JavaScript options object. Useful in the hybrid pattern to avoid duplicating configuration. | None                                 | Options object built from the element's HTML attributes |

## JavaScript interface [#javascript-interface]

Control PayPal Messages programmatically using these JavaScript methods and configuration options. Use these when building dynamic integrations or when you need fine-grained control over message behavior.

### Instance methods [#instance-methods]

A PayPal Messages instance has two primary methods.

| Method            | Description                                                                                      | Arguments                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `fetchContent`    | Fetches message content from PayPal's servers. Used when you're not relying on `auto-bootstrap`. | Optional object of [Fetch content options](#fetch-content-options) |
| `createLearnMore` | Initializes and returns a Learn More presentation (modal, popup, or redirect).                   | Optional object of [Learn More options](#learn-more-options)       |

### Instance options [#instance-options]

Configure global settings that apply to all PayPal Messages components on your page. Pass these into `sdkInstance.createPayPalMessages({...})` to avoid repeating the same configuration on individual message components.

| Option             | Description                                                                                                                                                      | Default value |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `currencyCode`     | 3-character currency code applied to all messages on the page. Also settable per component via the `currency-code` HTML attribute or as a `fetchContent` option. | None          |
| `shopperSessionId` | Represents the shopper's session. Format: `6B29FC40-CA47-1067-B21D-00DD010462DA`.                                                                                | None          |
| `buyerCountry`     | The country code for the buyer. This only applies to merchants approved for cross-border presentment.                                                            | None          |

### Fetch content options [#fetch-content-options]

Control how individual messages appear and behave when fetching content from PayPal's servers. Pass these into `messagesInstance.fetchContent({...})` to customize message appearance, handle callbacks, and set pricing information.

| Option              | Description                                                                                                                                                                                                                                                                                                 | Default value |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `amount`            | Price string with up to 2 decimal places. Also settable via the `amount` HTML attribute.                                                                                                                                                                                                                    | None          |
| `currencyCode`      | 3-character currency code. Also settable via the `currency-code` HTML attribute.                                                                                                                                                                                                                            | None          |
| `logoPosition`      | Logo placement. Options: `INLINE`, `LEFT`, `RIGHT`, `TOP`. Also settable via the `logo-position` HTML attribute. > **Info:** PayPal Debit Card and PayPal Cashback Mastercard are incompatible with the `INLINE` logo position. If `INLINE` is set for these payment methods, the SDK falls back to `LEFT`. | `LEFT`        |
| `logoType`          | Logo style. Options: `MONOGRAM`, `TEXT`, `WORDMARK`. Also settable via the `logo-type` HTML attribute.                                                                                                                                                                                                      | `WORDMARK`    |
| `textColor`         | Message color. Options: `BLACK`, `MONOCHROME`, `WHITE`. Also settable via the `text-color` HTML attribute.                                                                                                                                                                                                  | `BLACK`       |
| `onContentReady`    | Callback fired when fresh content arrives from the server. Takes precedence over `onReady`.                                                                                                                                                                                                                 | None          |
| `onReady`           | Callback fired when content is received from either the server or local cache. Used as a fallback if `onContentReady` and `onTemplateReady` are not set.                                                                                                                                                    | None          |
| `onTemplateReady`   | Callback fired when content arrives from local cache. Takes precedence over `onReady`.                                                                                                                                                                                                                      | None          |
| `alternativePrefix` | Adds an `or` prefix to the message. Options: `LOWERCASE_OR`, `UPPERCASE_OR`. > **Info:** Setting `alternativePrefix` forces `logoPosition` to `INLINE`.                                                                                                                                                     | None          |
| `messageLength`     | Requests a shorter message variant. Option: `COMPACT`.                                                                                                                                                                                                                                                      | None          |

### Learn More options [#learn-more-options]

Customize the Learn More experience that appears when shoppers click on Pay Later messages. Pass these into `messagesInstance.createLearnMore({...})` to control presentation mode, track user interactions, and set pricing context.

| Option             | Description                                                                                                                             | Default value |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `amount`           | Price string with up to 2 decimal places.                                                                                               | None          |
| `presentationMode` | How the Learn More UI appears. Options: `AUTO`, `MODAL`, `POPUP`, `REDIRECT`. Also settable via the `presentation-mode` HTML attribute. | `AUTO`        |
| `onApply`          | Callback fired when the shopper clicks Apply in the Learn More presentation.                                                            | None          |
| `onCalculate`      | Callback fired when the shopper enters a value in the Amount input in the Learn More presentation.                                      | None          |
| `onShow`           | Callback fired when the Learn More presentation opens.                                                                                  | None          |
| `onClose`          | Callback fired when the Learn More presentation closes.                                                                                 | None          |

## SDK instance options [#sdk-instance-options]

Authenticate with PayPal and configure your overall SDK integration. Pass these into `window.paypal.createInstance({...})` to establish your merchant identity, set page context, and enable PayPal services.

| Option                 | Description                                                                                                                                                                                    | Default value |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `clientId`             | **Recommended.** Your PayPal [client ID](/api/get-started/#1-get-your-client-id-and-client-secret). Cannot be used alongside `clientToken` — choose one.                                       | None          |
| `clientToken`          | A unique identifier for merchant authentication. Requires server-side token generation.                                                                                                        | None          |
| `pageType`             | The type of page the message appears on. Helps PayPal optimize messaging. Options: `cart`, `checkout`, `home`, `mini-cart`, `product`, `product-details`, `product-listing`, `search-results`. | None          |
| `partnerAttributionId` | An identifier for partner integrations.                                                                                                                                                        | None          |
| `shopperSessionId`     | Represents the shopper's session. Format: `6B29FC40-CA47-1067-B21D-00DD010462DA`.                                                                                                              | None          |

## Cascading Style Sheet (CSS) properties [#cascading-style-sheet-css-properties]

Customize the appearance of Pay Later messages using these CSS custom properties. Set these in your stylesheet targeting the `paypal-message` component.

| Property                      | Description                                                                                                                                                                         | Default value |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `--paypal-message-font-size`  | Font size for the message in `px`, from `10px` to `16px`. Values outside this range are clamped to the nearest valid value — for example, `4px` uses `10px` and `24px` uses `16px`. | `16px`        |
| `--paypal-message-text-align` | Alignment of the message text. Options: `left`, `right`, `center`.                                                                                                                  | `left`        |

## Message styling [#message-styling]

Customize how Pay Later messages appear on your site to match your brand. You can control appearance using CSS custom properties and logo and color configuration options.

**Right-aligned, 16px font, logo on top:**

```html
<style>
  paypal-message {
    --paypal-message-font-size: 16px;
    --paypal-message-text-align: right;
  }
</style>
<paypal-message
  auto-bootstrap
  amount="300.00"
  currency-code="USD"
  logo-position="TOP"
></paypal-message>
```

**Centered, 10px font, inline logo:**

```html
<style>
  paypal-message {
    --paypal-message-font-size: 10px;
    --paypal-message-text-align: center;
  }
</style>
<paypal-message
  auto-bootstrap
  amount="300.00"
  currency-code="USD"
  logo-type="TEXT"
  logo-position="INLINE"
></paypal-message>
```

**Prefixed, compact message:**

```html
<style>
  paypal-message {
    --paypal-message-font-size: 16px;
    --paypal-message-text-align: right;
  }
</style>
<paypal-message
  auto-bootstrap
  amount="300.00"
  currency-code="USD"
  alternative-prefix="LOWERCASE_OR"
  message-length="COMPACT"
></paypal-message>
```

## Pay Later message examples [#pay-later-message-examples]

Preview different visual styles to choose the look that works best for your site. The following table shows the full range of visual styles available using the logo and color options described in this guide.

| Settings                                                                    | Example                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `logoType: "MONOGRAM"`                                                      | <img src="https://www.paypalobjects.com/ppdevdocs/pl-monogram.png" alt="PayPal monogram message example" width="200" />                                                                                                        |
| `logoType: "MONOGRAM"`, `textColor: "MONOCHROME"`                           | <img src="https://www.paypalobjects.com/ppdevdocs/pl-monochrome-monogram.png" alt="PayPal monochrome monogram message example" width="200" />                                                                                  |
| `logoType: "MONOGRAM"`, `textColor: "WHITE"`                                | <img src="https://www.paypalobjects.com/ppdevdocs/pl-white-monogram.png" alt="PayPal white monogram message example" width="200" />                                                                                            |
| `logoType: "WORDMARK"`                                                      | <img src="https://www.paypalobjects.com/ppdevdocs/pl-monogram-wordmark.png" alt="PayPal monogram and PayPal wordmark message example" width="200" />                                                                           |
| `logoType: "WORDMARK"`, `textColor: "MONOCHROME"`                           | <img src="https://www.paypalobjects.com/ppdevdocs/pl-white-monogram-wordmark.png" alt="PayPal monochrome monogram and monochrome wordmark message example" width="200" />                                                      |
| `logoType: "WORDMARK"`, `textColor: "WHITE"`                                | <img src="https://www.paypalobjects.com/ppdevdocs/bnpl-learn-more.png" alt="PayPal white monogram and white wordmark message example" width="200" />                                                                           |
| `logoPosition: "INLINE"`, `logoType: "WORDMARK"`                            | <img src="https://www.paypalobjects.com/ppdevdocs/pl-inline-wordmark.png" alt="PayPal inline wordmark message example" width="200" />                                                                                          |
| `logoPosition: "INLINE"`, `logoType: "WORDMARK"`, `textColor: "MONOCHROME"` | <img src="https://www.paypalobjects.com/ppdevdocs/pl-inline-monochrome-wordmark.png" alt="PayPal inline monochrome wordmark message example" width="300" />                                                                    |
| `logoPosition: "INLINE"`, `logoType: "WORDMARK"`, `textColor: "WHITE"`      | <img src="https://www.paypalobjects.com/ppdevdocs/pl-inline-white-wordmark.png" alt="PayPal inline white wordmark message example" width="200" />                                                                              |
| `logoType: "TEXT"`                                                          | <img src="https://www.paypalobjects.com/ppdevdocs/pl-text.png" alt="PayPal text message example" width="300" />                                                                                                                |
| `logoType: "TEXT"`, `textColor: "WHITE"`                                    | <img src="https://www.paypalobjects.com/ppdevdocs/pl-white-text.png" alt="PayPal white text message example" width="300" />                                                                                                    |
| `logoType: "MONOGRAM"`                                                      | <img src="https://www.paypalobjects.com/ppdevdocs/pl-monogram-credit-wordmark.png" alt="PayPal monogram and credit wordmark message example" width="300" />                                                                    |
| `logoType: "MONOGRAM"`, `textColor: "MONOCHROME"`                           | <img src="https://www.paypalobjects.com/ppdevdocs/pl-monochrome-monogram-credit-wordmark.png" alt="PayPal monochrome monogram and credit monochrome wordmark message example" width="300" />                                   |
| `logoType: "MONOGRAM"`, `textColor: "WHITE"`                                | <img src="https://www.paypalobjects.com/ppdevdocs/pl-white-monogram-wordmark-credit-wordmark.png" alt="PayPal white monogram and white credit wordmark message example" width="300" />                                         |
| `logoType: "WORDMARK"`                                                      | <img src="https://www.paypalobjects.com/ppdevdocs/paypalcredit-wordmark.png" alt="PayPal white monogram with white wordmark and white credit wordmark message example" width="450" />                                          |
| `logoType: "WORDMARK"`, `textColor: "MONOCHROME"`                           | <img src="https://www.paypalobjects.com/ppdevdocs/pl-monochrome-monogram-wordmark-credit-wordmark.png" alt="PayPal monochrome monogram and monochrome wordmark with monochrome credit wordmark message example" width="300" /> |
| `logoType: "WORDMARK"`, `textColor: "WHITE"`                                | <img src="https://www.paypalobjects.com/ppdevdocs/paypalcredit-wordmark-white.png" alt="PayPal white monogram with white wordmark and white credit wordmark message example" width="450" />                                    |
| `logoPosition: "INLINE"`, `logoType: "WORDMARK"`                            | <img src="https://www.paypalobjects.com/ppdevdocs/pl-inline-wordmark-credit-wordmark.png" alt="PayPal inline wordmark and credit wordmark message example" width="450" />                                                      |
| `logoPosition: "INLINE"`, `logoType: "WORDMARK"`, `textColor: "MONOCHROME"` | <img src="https://www.paypalobjects.com/ppdevdocs/pl-inline-monochrome-wordmark-credit-wordmark.png" alt="PayPal inline monochrome wordmark and monochrome credit wordmark message example" width="450" />                     |
| `logoPosition: "INLINE"`, `logoType: "WORDMARK"`, `textColor: "WHITE"`      | <img src="https://www.paypalobjects.com/ppdevdocs/pl-inline-white-wordmark-credit-wordmark.png" alt="PayPal inline white wordmark and white credit wordmark message example" width="450" />                                    |
| `logoType: "TEXT"`                                                          | <img src="https://www.paypalobjects.com/ppdevdocs/pl-text-credit.png" alt="PayPal text credit message example" width="450" />                                                                                                  |
| `logoType: "TEXT"`, `textColor: "WHITE"`                                    | <img src="https://www.paypalobjects.com/ppdevdocs/pl-white-text-credit.png" alt="PayPal white text credit message example" width="450" />                                                                                      |

## Best practices [#best-practices]

Follow these guidelines to optimize your Pay Later implementation for security, performance, and user experience.

### Security and compliance [#security-and-compliance]

**Choose Client ID or Client Token**

Use `clientId` for most integrations — it's a public credential, safe to expose in frontend code, requires no server-side token generation, and is supported for all Messages SDK features.

Use `clientToken` only when your integration specifically requires it. This approach adds complexity and requires a backend endpoint to generate the token, but provides additional merchant control.

**Manage data retention**

PayPal automatically retains message interaction data for analytics and compliance. Do not store or duplicate this data locally unless required by your business logic.

### Checklist before going live [#checklist-before-going-live]

Before deploying to production, verify the following:

* SDK scripts loaded (`core` and `paypal-messages`)
* `<paypal-message>` component added to HTML
* SDK instance created with valid `clientId` or `clientToken`
* PayPal Messages instance created
* Message content fetched and displayed
* Amount updates tested with user interactions
* Learn More presentation configured (optional)
* Analytics callbacks implemented (optional)
* Message styling customized (optional)
* Sandbox testing completed with multiple amounts
* Load time monitoring configured
* Error handling implemented for network failures
* Lazy loading implemented (if applicable)
* Browser compatibility verified
* Responsive design tested across devices
* Production credentials configured
* Deployment to production verified

## Related content [#related-content]

The following resources provide additional information and guidance for your Pay Later integration:

* [Pay Later overview](/pay-later/overview) describes eligibility, offer types, and locale-specific offers.
* [Pay Later integration guide](/pay-later/integrate) provides a step-by-step guide for adding Pay Later messaging to your site.
