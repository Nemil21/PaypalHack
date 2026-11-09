---
title: Add Pay Later messaging with the PayPal JS SDK v6
description: Use the PayPal JS SDK v6 to render flexible financing messages on
  your site with minimal configuration.
---

# Add Pay Later messaging with the PayPal JS SDK v6 (/pay-later/integrate)



The PayPal Messages SDK lets you display Pay Later messaging, such as Pay in 4 or Pay Monthly, on your site. With minimal code, you can render customizable financing messages on product pages, cart pages, and at checkout. You also can update them automatically as cart values change. For more information about Pay Later offers, eligibility, and country availability, see [Pay Later overview](/pay-later/overview).

At the end of this integration, your site will include Pay Later messaging with a Learn More modal. You can also configure optional features such as analytics tracking and message style customization.

> **Note:** For a list of all configuration options, best practices, and other tips and examples, see the 
>
> [Pay Later reference](/pay-later/reference)
>
> .

## Before you begin [#before-you-begin]

First, if you're also adding a Pay Later payment button, implement it using the [JavaScript SDK v6 setup guide](/sdk/js/set-up). This guide focuses on Pay Later messaging and does not render the button itself.

Then, choose from these 3 integration patterns, depending on how much control you need:

* **HTML configuration:** Simpler to implement. Configure everything through HTML attributes on the `<paypal-message>` tag with minimal JavaScript.
* **JavaScript configuration:** Maximum control. Configure and fetch content entirely through JavaScript.
* **Hybrid (HTML with JavaScript) configuration:** Balances both approaches. Useful for advanced setups with multiple message placements or mixed HTML and JavaScript logic.

> **Note:** For a full example of each pattern, see 
>
> [Message configuration examples](/pay-later/integrate#message-configuration-examples)
>
> .

For this guide, you also need:

* A PayPal Client ID from the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/). This ID identifies your merchant account and authorizes PayPal to serve messages on your site. For most integrations, `clientId` is preferred.
* Alternatively, a **Client Token**, but this requires generating a token server-side. Use this approach only if your integration requires additional merchant control.

> **Warning:** You cannot use a 
>
> `clientId`
>
>  and a 
>
> `clientToken`
>
>  together. Choose 1.

## Step-by-step guide [#step-by-step-guide]

The following steps show how to build a complete Pay Later integration. [Steps 4](/pay-later/integrate#4-fetch-message-content), [5](/pay-later/integrate#5-handle-dynamic-amount-updates), and [6](/pay-later/integrate) include configuration-specific variations. For those steps, follow the option that matches your chosen integration pattern.

### 1. Load the SDK [#1-load-the-sdk]

Add the SDK v6 Core `<script>` tag inside the `<head>` of the merchant's webpage. Once this script loads, initialize the SDK and load the `paypal-messages` component using JavaScript.

Add the script tag

```html
<script
  async
  src="https://www.sandbox.paypal.com/web-sdk/v6/core"
  onload="onPayPalWebSdkLoaded()"
></script>
```

Initialize the SDK

```javascript
// Create the SDK Instance
async function onPayPalWebSdkLoaded() {
  try {
    const sdkInstance = await window.paypal.createInstance({
      clientToken: "YOUR_CLIENT_ID",
      // Include paypal-messages in the components list to load the module
      components: ["paypal-messages"],
    });
  } catch (error) {
    console.error(error);
  }
}
```

In this step:

* `/web-sdk/v6/core` is the base PayPal SDK engine. It's required for any v6 integration.
* `components: ["paypal-messages"]` tells `createInstance` which SDK components to load once the SDK script is loaded. In this example, you must load the `paypal-messages` component.

### 2. Add the `<paypal-message>` component to the page [#2-add-the-paypal-message-component-to-the-page]

Place the `<paypal-message>` custom HTML element where you want the financing message to appear. This is typically on product pages, cart pages, and at checkout. The tag is not visible until the SDK fills it with content in [step 4](/pay-later/integrate#4-fetch-message-content).

> **Info:** The attributes on the tag are configuration instructions that tell the SDK what the message should look like and what base price to use for the installment calculation. For a complete list of available attributes, see 
>
> [Web component attributes](./reference#web-component-attributes)
>
> .

#### HTML

```html
<paypal-message
    auto-bootstrap
    amount="300.00"
    currency-code="USD"
    logo-type="MONOGRAM"
    text-color="MONOCHROME"
></paypal-message>
```

> **Success:** With 
>
> `auto-bootstrap="true"`
>
> , PayPal's data layer automatically picks up this component and fetches content. If you don't use 
>
> `auto-bootstrap`
>
> , you must call 
>
> `fetchContent()`
>
>  manually in 
>
> [step 4](/pay-later/integrate#4-fetch-message-content)
>
> .

#### JavaScript

Add a `<paypal-message>` tag with no attributes. You complete all JavaScript configuration in [Steps 4](/pay-later/integrate#4-fetch-message-content).

```html
<paypal-message></paypal-message>
```

#### Hybrid

Set `amount` as an HTML attribute. You set other options, such as `currencyCode` and `logoType`, in JavaScript in [step 4](/pay-later/integrate#4-fetch-message-content).

```html
<paypal-message amount="300.00"></paypal-message>
```

When you complete this step, a `<paypal-message>` element is present in the DOM. It renders as invisible until you fetch content in [step 4](/pay-later/integrate#4-fetch-message-content).

### 3. Initialize the SDK and create a PayPal Messages instance [#3-initialize-the-sdk-and-create-a-paypal-messages-instance]

Create your SDK instance with your authentication credentials, then instantiate PayPal Messages.

```javascript
(async () => {
  // Step 2a: Create the SDK instance using your Client ID (recommended)
  const sdkInstance = await window.paypal.createInstance({
    clientId: "YOUR_CLIENT_ID",
    // OR: clientToken: "YOUR-CLIENT-TOKEN" // For server-side token generation
  });

  // Step 2b: Create the PayPal Messages instance
  const messagesInstance = sdkInstance.createPayPalMessages();
})();
```

In this step:

* `createInstance` authenticates the merchant with PayPal using their `clientId`. Without this authentication, PayPal won't serve any message content.
* `createPayPalMessages()` activates the messaging module. After you call this method, PayPal's servers are contacted in the background.

You also can pass global options to `createPayPalMessages` to avoid repeating shared configuration on each message component:

```javascript
const messagesInstance = sdkInstance.createPayPalMessages({
 currencyCode: "USD", // Applied to all messages on the page
});
```

For examples of additional SDK instance options, such as `pageType` and `shopperSessionId`, see [SDK instance options](./reference#sdk-instance-options).

With an authenticated `sdkInstance` and a `messagesInstance` now available, PayPal can serve message content to your page. For HTML configuration with `auto-bootstrap`, the `<paypal-message>` element begins populating with content automatically.

> **Warning:** **Canadian merchants:**
>
>  Pass a 
>
> `locale`
>
>  parameter to control the language of your site. Use 
>
> `locale: "fr-CA"`
>
>  on your French site and 
>
> `locale: "en-CA"`
>
>  on your English site. If you do not pass 
>
> `locale`
>
> , the shopper's browser language determines it, sending French-speaking shoppers to the French site and all other shoppers to the English site.

```javascript
(async () => {
 const sdkInstance = await window.paypal.createInstance({
  clientToken,
  locale: "fr-CA",
 });
})();
```

For more information about Pay Later for different Locales, see the [Pay Later overview](/pay-later/overview).

### 4. Fetch message content [#4-fetch-message-content]

With this step, you fetch message content from PayPal's servers. The content populates the `<paypal-message>` element you added in [step 2](/pay-later/integrate#2-add-the-paypal-message-component-to-the-page) with Pay Later messaging based on the options you set.

Select the tab for your configuration pattern.

#### HTML

If you used `auto-bootstrap` in [step 1](#1-add-the-paypal-message-component-to-the-page), PayPal fetches content automatically. You need no additional code for this step.

#### JavaScript

Configure all message options in JavaScript and manually fetch content from PayPal's servers. This gives you complete programmatic control over the message appearance and behavior. For a complete list of available options, see [Fetch content options](./reference#fetch-content-options).

```javascript
const messageElement = document.querySelector('paypal-message');

const content = await messagesInstance.fetchContent({
  amount: "300.00",
  currencyCode: "USD",
  logoType: "MONOGRAM",
  textColor: "BLACK",
  logoPosition: "LEFT",
  onReady: (content) => {
    // Called when content is ready (from cache or server)
    messageElement.setContent(content);
  },
});
```

#### Hybrid

Use `getFetchContentOptions()` to read HTML attributes from the component and merge them with JavaScript options, so you don't have to duplicate your configuration.

```javascript
const messageElement = document.querySelector('paypal-message');

// Combine HTML attributes with JavaScript options
const content = await messagesInstance.fetchContent({
  ...messageElement.getFetchContentOptions(),  // Extract HTML attributes
  logoType: "MONOGRAM",
  textColor: "BLACK",
  currencyCode: "USD",
});
```

After this step, the `<paypal-message>` element populates with Pay Later messaging content similar to the following screenshot:

<img src="https://www.paypalobjects.com/ppdevdocs/pay-later-messaging-4-interest.png" alt="Pay in 4 interest-free payments" width="500" />

### 5. Handle dynamic amount updates [#5-handle-dynamic-amount-updates]

Cart totals change when shoppers add or remove items, apply coupons, or update quantities. When they do, the Pay Later message updates to show the correct installment amount.

> **Warning:** Always recalculate cart totals server-side before updating the message amount. Do not rely on client-side calculations alone for amounts that affect payment flows.

#### HTML

Update the message amount by modifying the HTML attribute directly. The SDK automatically detects attribute changes and refreshes the message content.

```javascript
function updateMessageAmount(newAmount) {
  const messageElement = document.querySelector('paypal-message');
  messageElement.setAttribute('amount', newAmount);
}

// Update when user changes quantity
quantityInput.addEventListener('change', (event) => {
  const newAmount = calculateTotal(event.target.value);
  updateMessageAmount(newAmount);
});
```

#### JavaScript

Update the message amount using the content object's update method. This gives you direct programmatic control over the content without DOM manipulation.

```javascript
function updateMessageAmount(newAmount) {
  content.update({ amount: newAmount });
}

// Update when user changes quantity
quantityInput.addEventListener('change', (event) => {
  const newAmount = calculateTotal(event.target.value);
  updateMessageAmount(newAmount);
});
```

After this step, regardless of the configuration pattern you choose, you call `updateMessageAmount(newAmount)` whenever the cart total changes, and the message reflects the new installment amount without a page reload.

### 6. (Optional) Customize Learn More presentation [#6-optional-customize-learn-more-presentation]

Learn More links display additional financing details in a modal, popup, or new tab when shoppers select the message. &#x2A;*This step is optional but recommended.**

Create a Learn More instance and connect it to the message click event:

```javascript
// Create a Learn More instance
const learnMore = await messagesInstance.createLearnMore({
 presentationMode: "MODAL", // Options: AUTO, MODAL, POPUP, REDIRECT
});

// Connect message click to Learn More
const messageElement = document.querySelector('paypal-message');

messageElement.addEventListener('paypal-message-click', (event) => {
 event.preventDefault(); // Required — without this, the browser may navigate instead
 learnMore.open(event.detail.config);
});
```

You also can pass analytics callbacks to `createLearnMore`:

```javascript
(async () => {
 const learnMore = await messagesInstance.createLearnMore({
  amount: "300.00",
  presentationMode: "POPUP",
  onShow: () => trackEvent('paylater_learn_more_shown'), // Log when Learn More is displayed
  onApply: () => trackEvent('paylater_apply_clicked'), // Log when user selects Apply
  onCalculate: (amount) => trackEvent('paylater_calculate', { amount }), // Log when user enters amount
  onClose: () => trackEvent('paylater_learn_more_closed'), // Log when user closes Learn More
 });
})();
```

For a complete list of all Learn More options, see [Learn More options](./reference#learn-more-options).

Now, if a shopper selects the Pay Later message, it opens a Learn More presentation in the configured mode (modal, popup, or redirect).

### 7. (Optional) Add analytics and logging [#7-optional-add-analytics-and-logging]

To track user interactions with Pay Later messaging and optimize your conversion flow, use the callback functions that are available in `fetchContent()` and `createLearnMore()`.

To track message rendering, use the `onReady`, `onContentReady`, and `onTemplateReady` callbacks in `fetchContent()`. For details on each callback, see [Fetch content options](./reference#fetch-content-options):

```javascript
const content = await messagesInstance.fetchContent({
  amount: "300.00",
  currencyCode: "USD",
  onTemplateReady: (content) => {
    // Called when cached template loads
    console.log('Cached Template Rendered');
    trackEvent('paylater_cached_template_ready');
    messageElement.setContent(content);
  },
  onContentReady: (content) => {
    // Called when fresh content fetched from server
    console.log('Fetched Content Rendered');
    trackEvent('paylater_content_ready');
    messageElement.setContent(content);
  },
});
```

To track Learn More interactions, use the `paypal-message-click` event on the message element and the `onShow`, `onApply`, `onCalculate`, and `onClose` callbacks in `createLearnMore()`:

```javascript
messageElement.addEventListener('paypal-message-click', (event) => {
  event.preventDefault();
  console.log('Message Learn More Clicked');
  trackEvent('paylater_message_clicked');
  learnMore.open(event.detail.config);
});
```

For an analytics helper function, you can implement something like this to send events to your analytics platform:

```javascript
function trackEvent(eventName, eventData = {}) {
  // Example: Send to your analytics platform
  if (window.gtag) {
    gtag('event', eventName, eventData);
  }

  // Or use your custom analytics
  if (window.analytics) {
    window.analytics.track(eventName, eventData);
  }
}
```

With these additions, Pay Later message interactions are logged to your analytics platform whenever shoppers view, click, or interact with the Learn More presentation.

### 8. (Optional) Customize message styling [#8-optional-customize-message-styling]

You can customize the message appearance using CSS custom properties and configuration options. For example, to set the font size to 14px and center-align the text:

```html
<style>
 paypal-message {
   --paypal-message-font-size: 14px;
   --paypal-message-text-align: center;
 }
</style>
```

For styling examples, see [Message styling](./reference#message-styling). For a complete list of all CSS properties, see [CSS properties](./reference#cascading-style-sheet-css-properties).

With these CSS properties and attribute options applied, the Pay Later message renders with your custom font size, alignment, and logo configuration.

## Message configuration examples [#message-configuration-examples]

Choose the configuration pattern that best fits your development approach. The following examples show complete implementations of each pattern with all required code.

#### HTML

This configuration pattern is best for simple integrations with minimal JavaScript. You configure everything through HTML attributes on the `<paypal-message>` tag. The only JavaScript you write is to initialize the SDK and create a PayPal Messages instance.

```html
<head>
  <script
    async
    src="https://www.sandbox.paypal.com/web-sdk/v6/core"
    onload="onPayPalWebSdkLoaded()"
  ></script>
</head>
<body>
  <paypal-message
    auto-bootstrap
    amount="300.00"
    logo-type="MONOGRAM"
    text-color="MONOCHROME"
  ></paypal-message>

  <script>
    async function onPayPalWebSdkLoaded() {
      try {
        const sdkInstance = await window.paypal.createInstance({
          clientId: "YOUR_CLIENT_ID",
          components: ["paypal-messages"]
        });

        const messagesInstance = sdkInstance.createPayPalMessages({
          currencyCode: "USD"
        });

        function triggerAmountUpdate(amount) {
          const messageElement = document.querySelector('paypal-message');
          messageElement.setAttribute('amount', amount);
        }

        // Configure Learn More as a popup instead of the default (optional)
        const learnMore = await messagesInstance.createLearnMore({
          presentationMode: "POPUP",
        });

        // Intercept the message click event and open Learn More manually (optional)
        messageElement.addEventListener("paypal-message-click", (event) => {
          event.preventDefault();
          learnMore.open(event.detail.config);
        });

      } catch (error) {
        console.error(error);
      }
    }
  </script>
</body>
```

#### JavaScript

This configuration pattern is best for dynamic pages where you want full JavaScript control over message content. You add a bare `<paypal-message>` tag to the HTML with no attributes, then you configure and fetch content entirely through JavaScript using `fetchContent()`.

```html
<head>
  <script
    async
    src="https://www.sandbox.paypal.com/web-sdk/v6/core"
    onload="onPayPalWebSdkLoaded()"
  ></script>
</head>
<body>
  <paypal-message></paypal-message>

  <script>
    async function onPayPalWebSdkLoaded() {
      try {
        const sdkInstance = await window.paypal.createInstance({
          clientId: "YOUR_CLIENT_ID",
          components: ["paypal-messages"]
        });

        const messagesInstance = sdkInstance.createPayPalMessages({
          currencyCode: "USD"
        });

        const messageElement = document.querySelector('paypal-message');

        // Fetch content and push it into the component manually
        const content = await messagesInstance.fetchContent({
          amount: "300.00",
          logoType: "MONOGRAM",
          textColor: "MONOCHROME",
          onReady: (content) => messageElement.setContent(content),
        });

        // Update amount when cart changes
        function triggerAmountUpdate(amount) {
          content.update({ amount });
        }

        // Configure Learn More as a popup instead of the default (optional)
        const learnMore = await messagesInstance.createLearnMore({
          presentationMode: "POPUP",
        });

        // Intercept the message click event and open Learn More manually (optional)
        messageElement.addEventListener("paypal-message-click", (event) => {
          event.preventDefault();
          learnMore.open(event.detail.config);
        });
        
      } catch (error) {
        console.error(error);
      }
    }
  </script>
</body>
```

#### Hybrid

This configuration pattern is best for advanced setups. For example, when you have multiple message placements or need to mix HTML-driven config with JavaScript-driven logic, this is the recommended approach.

You set some options (for example, `amount`) as HTML attributes and others (for example, `currencyCode` and `logoType`) in JavaScript. The `getFetchContentOptions()` method bridges the 2; it reads the HTML attributes from the component and passes them to `fetchContent` automatically, so you don't have to duplicate them.

> **Info:** In the hybrid pattern, load only the 
>
> `core`
>
>  script in 
>
> `<head>`
>
> . You load the 
>
> `paypal-messages`
>
>  component through JavaScript in the 
>
> `components`
>
>  array of 
>
> `createInstance`
>
> , not as a second 
>
> `<script>`
>
>  tag.

```html
<head>
  <script
    async
    src="https://www.sandbox.paypal.com/web-sdk/v6/core"
    onload="onPayPalWebSdkLoaded()"
  ></script>
</head>
<body>
  <paypal-message amount="300.00"></paypal-message>

  <script>
    async function onPayPalWebSdkLoaded() {
      try {
        const sdkInstance = await window.paypal.createInstance({
          clientId: "YOUR_CLIENT_ID",
          components: ["paypal-messages"],
        });

        const messagesInstance = sdkInstance.createPayPalMessages({
          currencyCode: "USD",
        });

        const messageElement = document.querySelector('paypal-message');

        // getFetchContentOptions() reads the `amount` attribute from the HTML element
        // and merges it with the JS options below
        const content = await messagesInstance.fetchContent({
          ...messageElement.getFetchContentOptions(),
          logoType: "MONOGRAM",
          textColor: "MONOCHROME",
          onReady: (content) => messageElement.setContent(content),
        });

        // Update amount when cart changes
        function triggerAmountUpdate(amount) {
          content.update({ amount });
        }

        // Configure Learn More as a popup instead of the default (optional)
        const learnMore = await messagesInstance.createLearnMore({
          presentationMode: "POPUP",
        });

        // Intercept the message click event and open Learn More manually (optional)
        messageElement.addEventListener("paypal-message-click", (event) => {
          event.preventDefault();
          learnMore.open(event.detail.config);
        });

      } catch (error) {
        console.error(error);
      }
    }
  </script>
</body>
```

## Error handling [#error-handling]

The following sections describe how to handle common integration issues, platform errors, and edge cases when integrating Pay Later messaging.
Each scenario below includes the cause of the issue and the recommended fix. Implementing error handling ensures a smoother user experience and helps you debug issues during development.

### Pay Later not available for customer's location [#pay-later-not-available-for-customers-location]

**Cause:** The shopper's country or currency is not supported by Pay Later. In this case, `fetchContent()` throws an error and the message does not render.

**Fix:** Wrap the message initialization in a `try`/`catch` block and handle the error gracefully — for example, by hiding the message element or showing an alternative payment option.

```javascript
async function initPayLaterMessage() {
  try {
    const content = await messagesInstance.fetchContent({
      amount: "300.00",
      currencyCode: "USD",
    });
  } catch (error) {
    console.log("Pay Later not available for this customer:", error.message);
    // Hide message element or show alternative payment option
  }
}

initPayLaterMessage();
```

### Unsupported locale [#unsupported-locale]

**Cause:** The `locale` value passed to `createInstance()` is not one that PayPal supports. The SDK falls back to the shopper's browser language.

**Fix:** Verify that the `locale` value you pass matches a supported option (for example, `en-CA` or `fr-CA`).

```javascript
(async () => {
  const sdkInstance = await window.paypal.createInstance({
    clientToken,
    locale: "fr-CA", // Must be a supported locale value
  });
})();
```

### Additional error conditions [#additional-error-conditions]

The following table summarizes additional error conditions that you might encounter during integration, along with their causes and resolutions.

| Error condition                            | Cause                                                                                            | Resolution                                                                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Message does not appear                    | Scripts not loaded, invalid `clientId`, or page served over HTTP                                 | Verify both SDK scripts load successfully in the Network tab, confirm `clientId` is correct in `createInstance()`, and ensure the page is served over HTTPS            |
| Learn More modal does not open             | `createLearnMore()` not called, event listener not attached, or `event.preventDefault()` missing | Confirm `createLearnMore()` is called, verify the `paypal-message-click` listener is attached, and ensure `event.preventDefault()` is called before `learnMore.open()` |
| Message renders but shows wrong amount     | Amount updated client-side without server validation                                             | Recalculate cart totals server-side before calling `setAttribute('amount', ...)` or `content.update({ amount })`                                                       |
| Message does not render for some customers | Customer's location or currency not supported by Pay Later                                       | Use `try`/`catch` around `fetchContent()` and handle gracefully; verify the `currencyCode` is a supported 3-letter ISO code                                            |

## Troubleshooting [#troubleshooting]

The following questions address common issues that may arise during integration. For platform errors such as authentication and rate limiting, see the Common Errors reference.

If you encounter an issue that is not covered here, check the console for errors, and see the [Error handling](#error-handling) section.

### Why doesn't the message appear on my page? [#why-doesnt-the-message-appear-on-my-page]

Check these in this order:

1. **Verify that scripts are loaded.**
   1. Open DevTools (F12) and check the Network tab.
   2. Look for successful requests to `https://www.paypal.com/web-sdk/v6/core` and `https://www.paypal.com/web-sdk/v6/paypal-messages`.
2. **Check for a valid `clientId`.** Ensure `clientId` is correctly set in `createInstance()`.
3. **Check for HTTPS.** Messages only render on HTTPS pages.
4. **Verify the web component is present.** Open DevTools, and look for the `<paypal-message>` element in the DOM.
5. **Check the console for errors.** The DevTools Console tab will show JavaScript errors that prevent the SDK from loading.

### Why doesn't the Learn More modal open when I click the message? [#why-doesnt-the-learn-more-modal-open-when-i-click-the-message]

Verify the following:

1. You have called `createLearnMore()`.
2. The `paypal-message-click` event listener is attached to the message element.
3. `event.preventDefault()` is called — without it, the browser may navigate instead of opening Learn More.

### How do I update the message when the cart changes? [#how-do-i-update-the-message-when-the-cart-changes]

See [step 5](/pay-later/integrate#5-handle-dynamic-amount-updates) in the [step-by-step guide](#step-by-step-guide). The method that you use depends on your configuration: an HTML configuration uses `setAttribute('amount', newAmount)`, while JavaScript configuration uses `content.update({ amount: newAmount })`.

### Can I use server-side rendering with the Messages SDK? [#can-i-use-server-side-rendering-with-the-messages-sdk]

No. The Messages SDK is a client-side component and requires the browser's `window.paypal` global object. If you're using server-side rendering frameworks such as Next.js or Nuxt, load the SDK scripts in a client component only:

```javascript
// React example
useEffect(() => {
  const initMessages = async () => {
    const sdkInstance = await window.paypal.createInstance({
      clientId: "YOUR-CLIENT-ID"
    });
    const messagesInstance = sdkInstance.createPayPalMessages();
  };
  initMessages();
}, []);
```

### What currencies do Pay Later messages support? [#what-currencies-do-pay-later-messages-support]

The supported currencies depend on the shopper's location and PayPal's supported markets. Use the 3-letter ISO code (`USD`, `GBP`, `EUR`, `CAD`, and others). If you set an unsupported currency, the message won't render.

### Does Pay Later work on mobile devices? [#does-pay-later-work-on-mobile-devices]

Yes. The Messages SDK renders on mobile browsers. The Learn More presentation mode may vary by browser. Use `presentationMode: "AUTO"` to let PayPal choose the best mode for each device.

### How do I test Pay Later in my development environment? [#how-do-i-test-pay-later-in-my-development-environment]

1. Create a sandbox business account at [PayPal](https://developer.paypal.com/).
2. Get your sandbox `clientId` from the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/).
3. Use the sandbox `clientId` in your `createInstance()` call.
4. Test with amounts that typically qualify for Pay Later offers (for example, $50 to $1,000).

## Related content [#related-content]

For a complete list of all configuration options, best practices, and other tips, including a pre-production checklist, see the [Pay Later reference](./reference).
