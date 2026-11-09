---
title: Set up JavaScript SDK v6
description: Configure the SDK for your integration.
badges:
  - type: neutral
    text: JavaScript SDK
---

# Set up JavaScript SDK v6 (/sdk/js/set-up)



The PayPal JavaScript SDK v6 enables you to accept the following payment methods on your website:

* [PayPal](/checkout/integrate) and [Pay Later](/pay-later/integrate)
* [Venmo](/venmo) (US only)
* [Google Pay](/google-pay/integrate)
* [Apple Pay](/apple-pay/integrate)
* [Fastlane guest checkout](/fastlane/enable)
* [Credit and debit cards](/expanded/card-fields)

The v6 SDK is faster and more secure than previous versions. It also supports standalone button integrations and iframe-based integrations.

> **Success:** [Check out a sample integration in GitHub](https://github.com/paypal-examples/v6-web-sdk-sample-integration)
>
> .

## Prerequisites [#prerequisites]

Before you start, make sure to [get your PayPal client ID and secret](/api/rest/#1-get-client-id-and-client-secret).

## Include the SDK script [#include-the-sdk-script]

Include the v6 SDK script on each page of your site that needs to accept payments.

```html
<script src="https://www.paypal.com/web-sdk/v6/core"></script>
```

For sandbox and testing environments:

```html
<script src="https://www.sandbox.paypal.com/web-sdk/v6/core"></script>
```

## Authenticate the SDK [#authenticate-the-sdk]

Authenticate with a client ID or a client token. Most integrations should authenticate with a client ID.

**Option A: client ID (recommended)**

### Option A: client ID (recommended) [#option-a-client-id-recommended]

For most integrations, use your PayPal client ID to authenticate the SDK. You can think of the client ID as your application's user name. This static client ID value is safe to include in your front-end code.

When to use client ID:

* Standard checkout integrations (PayPal, cards, Venmo, digital wallets)
* One-time payments
* Card vaulting (save card payment methods)
* Most payment integrations (this is the default)

Replace `"YOUR_CLIENT_ID"` with your client ID.

```javascript lines
const sdkInstance = await window.paypal.createInstance({
  clientId: "YOUR_CLIENT_ID",
  components: ["paypal-payments"],
});
```

**Option B: client token (for Fastlane only)**

### Option B: client token (for Fastlane only) [#option-b-client-token-for-fastlane-only]

> **Warning:** Client token authentication is required for Fastlane integrations. For all other use cases, use 
>
> **Option A: client ID**
>
> .

A client token is a secure, browser-safe access token generated server-side from your PayPal client ID and secret. This call returns an `access_token` which you use as the client token when you initialize the v6 SDK. Use `expires_in` for caching management on the server side.

> **Info:** **Endpoint:**
>
>  
>
> `/v1/oauth2/token/`

```bash lines
curl -X POST 'https://api-m.sandbox.paypal.com/v1/oauth2/token' \
-u 'PAYPAL_CLIENT_ID:PAYPAL_CLIENT_SECRET' \
-H 'Content-Type: application/x-www-form-urlencoded' \
-d 'grant_type=client_credentials' \
-d 'domains[]=YOUR_URL1_FOR_THE_SESSION,YOUR_URL2_FOR_THE_SESSION' \
-d 'response_type=client_token'
```

**Sample 200 response**

```json lines
{
   "access_token" : "A21AAJrhF-LjFoXzGPJlszGfKg4omnKy5e_eeRXPYzHLb3OdbjtCB3w89nm_6wCCbqn7qSdzjW77VGE7NAJAbXw53ZVpiX5tQ",
   "app_id" : "APP-80W284485P519543T",
   "expires_in" : 32400,
   "nonce" : "2025-10-22T14:32:24ZNpKbSPKuOEA75fCkaNqAcQC_7GbyY1wYSpE1qTeMDaQ",
   "scope" : "https://uri.paypal.com/services/invoicing https://uri.paypal.com/services/payments/futurepayments https://uri.paypal.com/services/vault/payment-tokens/read https://uri.paypal.com/services/disputes/read-buyer https://uri.paypal.com/services/payments/realtimepayment https://uri.paypal.com/services/payments/client-payments-eligibility https://uri.paypal.com/services/identity/activities https://api.paypal.com/v1/vault/credit-card https://api.paypal.com/v1/payments/.* https://uri.paypal.com/services/reporting/search/read https://uri.paypal.com/services/vault/payment-tokens/readwrite https://api.paypal.com/v1/payments/refund https://uri.paypal.com/services/applications/webhooks https://uri.paypal.com/services/credit/client-offer-presentment/read https://uri.paypal.com/services/paypalhere https://uri.paypal.com/services/disputes/update-seller openid https://uri.paypal.com/services/payments/payment/authcapture Braintree:Vault https://uri.paypal.com/services/disputes/read-seller https://uri.paypal.com/services/payments/orders/client_sdk_orders_api https://uri.paypal.com/services/payments/refund https://uri.paypal.com/payments/payouts https://api.paypal.com/v1/vault/credit-card/.* https://uri.paypal.com/services/shipping/trackers/readwrite https://uri.paypal.com/services/subscriptions https://api.paypal.com/v1/payments/sale/.*/refund",
   "token_type" : "Bearer"
}
```

The following server-side endpoint returns the client token to your client application. Call this endpoint from your frontend:

```javascript lines
async function getBrowserSafeClientToken() {
  const response = await fetch("/paypal-api/auth/browser-safe-client-token", {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
    },
  });
  const { accessToken } = await response.json();
  return accessToken;
}
```

## Initialize the v6 SDK [#initialize-the-v6-sdk]

Use `window.paypal.createInstance()` to initialize the SDK with your server-generated client token and configure components, locale, and page type settings. The method returns an SDK instance that provides access to payment eligibility checking and session creation methods.

### `window.paypal.createInstance(options)` [#windowpaypalcreateinstanceoptions]

Use `paypal.createInstance` to initialize the PayPal SDK with your client token and configuration. This method configures the SDK for your specific integration needs and returns an SDK instance that you'll use to create payment sessions.

#### Parameters [#parameters]

Parameter

Required

Description

clientToken

yes

string.

 A secure, browser-safe token that your server generates using your PayPal client ID and secret. This token authenticates all SDK operations and is bound to your domain for security. This token expires after 15 minutes. You must generate a new token when needed.

components

no

string[].

 An array of SDK components to load for your integration. Each component enables specific payment functionality.

Available components:

paypal-payments

 — PayPal and Pay Later checkout

venmo-payments

 — Venmo payments (US only)

googlepay-payments

 — Google Pay integration

applepay-payments

 — Apple Pay integration

fastlane

 — Fastlane guest checkout

paypal-messages

 — Promotional messaging

Default: 

\["paypal-payments"]

pageType

no

string.

 The type of page where the SDK is being initialized. This helps PayPal optimize the payment experience and provide better analytics.

Accepted values:

checkout

 — Checkout or payment page

product-details

 — Individual product page

cart

 — Shopping cart page

mini-cart

 — Mini cart or side cart

home

 — Homepage

locale

no

string.

 The locale for the UI components, specified as a BCP-47 language tag, for example, 

`"en-US"`

, 

`"fr-FR"`

, 

`"de-DE"`

. If not specified, the SDK automatically detects the buyer's locale from their browser settings.

clientMetadataId

no

string.

 A unique identifier for tracking and debugging. You can generate this using 

crypto.randomUUID()

 or your own ID generation system. This ID helps correlate SDK sessions with your server-side logs.

partnerAttributionId

no

string.

 PayPal issues this 

BN_CODE

 to you during partner onboarding.

#### Returns [#returns]

Returns a promise that resolves to an SDK instance object. This instance provides methods for checking payment eligibility and creating payment sessions.

* `findEligibleMethods()` - Check payment method availability
* `createPayPalOneTimePaymentSession()` - Create a payment session
* `createFastlane()` - Initialize accelerated guest checkout (Fastlane)

### Example [#example]

```javascript expandable
// Basic initialization
const sdkInstance = await window.paypal.createInstance({
  clientToken: "YOUR_CLIENT_TOKEN",
});

// Full configuration
const sdkInstance = await window.paypal.createInstance({
  clientToken: "YOUR_CLIENT_TOKEN",
  components: ["paypal-payments", "venmo-payments"],
  pageType: "checkout",
  locale: "en-US",
  clientMetadataId: crypto.randomUUID(),
});

// With error handling
try {
  const sdkInstance = await window.paypal.createInstance({
    clientToken: clientToken,
  });
  console.log("PayPal SDK initialized successfully");
} catch (error) {
  console.error("Failed to initialize PayPal SDK:", error);
}
```

## Recommended frontend setup [#recommended-frontend-setup]

This is the recommended approach for most implementations. It includes all payment methods with eligibility logic and automatic fallback handling. The following are key components of the integration:

### PayPal SDK instance [#paypal-sdk-instance]

* **Purpose**: Main entry point for PayPal functionality
* **Components**: Includes `paypal-payments` component
* **Authentication**: Requires client token from server

### Eligibility check [#eligibility-check]

* **Purpose**: Determines payment methods available to the buyer
* **Factors**: User location, currency, account status, device type
* **Implementation**: Always check before showing payment buttons

### Payment sessions [#payment-sessions]

* **PayPal**: Standard PayPal payments
* **Pay Later**: Financing options with specific product codes
* **PayPal Credit**: Credit-based payments with country-specific configuration

### Web components [#web-components]

* `<paypal-button>`: Standard PayPal payment button
* `<paypal-pay-later-button>`: Pay Later financing button
* `<paypal-credit-button>`: PayPal Credit button

To customize button colors, see the [JavaScript SDK reference](/sdk/js/reference#web-components).

### Example [#example-1]

The following is an example of what an `app.js` file might look like when implementing the recommended setup.

```javascript
async function onPayPalWebSdkLoaded() {
  try {
    // Get client token for authentication
    const clientToken = await getBrowserSafeClientToken();
    
    // Create PayPal SDK instance
    const sdkInstance = await window.paypal.createInstance({
      clientToken,
      components: ["paypal-payments"],
      pageType: "checkout",
    });

    // Check eligibility for all payment methods
    const paymentMethods = await sdkInstance.findEligibleMethods({
      currencyCode: "USD",
    });

    // Set up PayPal button if eligible
    if (paymentMethods.isEligible("paypal")) {
      configurePayPalButton(sdkInstance);
    }

    // Set up Pay Later button if eligible
    if (paymentMethods.isEligible("paylater")) {
      const payLaterPaymentMethodDetails = paymentMethods.getDetails("paylater");
      setUpPayLaterButton(sdkInstance, payLaterPaymentMethodDetails);
    }

    // Set up PayPal Credit button if eligible
    if (paymentMethods.isEligible("credit")) {
      const paypalCreditPaymentMethodDetails = paymentMethods.getDetails("credit");
      setUpPayPalCreditButton(sdkInstance, paypalCreditPaymentMethodDetails);
    }
  } catch (error) {
    console.error("SDK initialization error:", error);
  }
}

// Shared payment session options for all payment methods
const paymentSessionOptions = {
  // Called when user approves a payment 
  async onApprove(data) {
    console.log("Payment approved:", data);
    try {
      const orderData = await captureOrder({
        orderId: data.orderId,
      });
      console.log("Payment captured successfully:", orderData);
    } catch (error) {
      console.error("Payment capture failed:", error);
    }
  },
  
  // Called when user cancels a payment
  onCancel(data) {
    console.log("Payment cancelled:", data);
  },
  
  // Called when an error occurs during payment
  onError(error) {
    console.error("Payment error:", error);
  },
};

// Set up standard PayPal button
async function configurePayPalButton(sdkInstance) {
  const paypalPaymentSession = sdkInstance.createPayPalOneTimePaymentSession(
    paymentSessionOptions,
  );

  const paypalButton = document.querySelector("paypal-button");
  paypalButton.removeAttribute("hidden");

  paypalButton.addEventListener("click", async () => {
    try {
      await paypalPaymentSession.start(
        { presentationMode: "auto" }, // Auto-detects best presentation mode
        createOrder(),
      );
    } catch (error) {
      console.error("PayPal payment start error:", error);
    }
  });
}

// Set up Pay Later button
async function setUpPayLaterButton(sdkInstance, payLaterPaymentMethodDetails) {
  const payLaterPaymentSession = sdkInstance.createPayLaterOneTimePaymentSession(
    paymentSessionOptions
  );

  const { productCode, countryCode } = payLaterPaymentMethodDetails;
  const payLaterButton = document.querySelector("paypal-pay-later-button");

  // Configure button with Pay Later specific details
  payLaterButton.productCode = productCode;
  payLaterButton.countryCode = countryCode;
  payLaterButton.removeAttribute("hidden");

  payLaterButton.addEventListener("click", async () => {
    try {
      await payLaterPaymentSession.start(
        { presentationMode: "auto" },
        createOrder(),
      );
    } catch (error) {
      console.error("Pay Later payment start error:", error);
    }
  });
}

// Set up PayPal Credit button
async function setUpPayPalCreditButton(sdkInstance, paypalCreditPaymentMethodDetails) {
  const paypalCreditPaymentSession = sdkInstance.createPayPalCreditOneTimePaymentSession(
    paymentSessionOptions
  );

  const { countryCode } = paypalCreditPaymentMethodDetails;
  const paypalCreditButton = document.querySelector("paypal-credit-button");

  // Configure button with PayPal Credit specific details
  paypalCreditButton.countryCode = countryCode;
  paypalCreditButton.removeAttribute("hidden");

  paypalCreditButton.addEventListener("click", async () => {
    try {
      await paypalCreditPaymentSession.start(
        { presentationMode: "auto" },
        createOrder(),
      );
    } catch (error) {
      console.error("PayPal Credit payment start error:", error);
    }
  });
}
```

## Return order ID to SDK [#return-order-id-to-sdk]

The `createOrder()` function must return a promise that resolves to `{ orderId: "YOUR_ORDER_ID" }`. This is a key difference between v6 and previous versions of the SDK.

```javascript
// In v6, this must return an object with the shape: { orderId: "YOUR_ORDER_ID" }
  return fetch("/paypal-api/checkout/orders/create", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(orderPayload),
  })
    .then(response => response.json())
    .then(data => ({ orderId: data.id })); // <-- Required return value
} // End createOrder
```

## Best practices [#best-practices]

The following are best practices for integrating the v6 SDK.

Keep sensitive operations server-side and validate all payment data. Provide clear feedback to users throughout the payment flow.

### Security [#security]

* Obtain client tokens from your secure server
* Never expose PayPal client secrets in frontend code
* All payment processing happens through PayPal's secure servers
* Never pass up item total from browser - this can be manipulated
* Validate order details on your server before capture

### User experience [#user-experience]

* Always check eligibility before showing payment buttons
* Provide clear loading states during payment processing
* Handle popup blockers gracefully with `{ presentationMode:auto }`
* Show appropriate error messages for different failure scenarios

### Performance [#performance]

* Initialize the SDK early, but avoid blocking page load
* Cache client tokens appropriately
* Use presentation mode fallback strategies

## See also [#see-also]

For all available SDK methods, see the [JavaScript SDK v6 reference](/sdk).
