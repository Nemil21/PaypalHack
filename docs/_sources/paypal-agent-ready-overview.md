---
title: Agent Ready overview
---

# Agent Ready overview (/agent-ready/overview)



Agent Ready helps Braintree and PayPal merchants accept payments from AI shopping assistants across major platforms, including ChatGPT, Google AI Mode, and Gemini, without building separate integrations for each.

PayPal supports two agentic commerce protocols across three integration paths:

| Protocol                                                                                                    | AI platform            | Integration path                                                            |
| ----------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------- |
| [Agentic Commerce Protocol (ACP)](/agent-ready/agentic-commerce-protocol)                                   | ChatGPT, OpenAI        | Delegated payment tokens through Braintree                                  |
| [Universal Commerce Protocol (UCP) with Braintree](/agent-ready/universal-commerce-protocol-with-braintree) | Google AI Mode, Gemini | Google Pay payment handler through Braintree                                |
| [Universal Commerce Protocol (UCP) with PayPal](/agent-ready/universal-commerce-protocol-with-paypal)       | Google AI Mode, Gemini | Google Pay payment handler through PayPal's [Orders v2 API](/api/orders/v2) |

## How it works [#how-it-works]

When a customer shops through an AI assistant, the assistant handles product discovery and checkout orchestration. Agent Ready connects your Braintree or PayPal integration to these AI surfaces so you can:

* Accept payments initiated by AI agents on behalf of customers.
* Leverage your existing Braintree or PayPal merchant account and processing relationship.

## Choose your integration [#choose-your-integration]

### [Agentic Commerce Protocol integration](/agent-ready/agentic-commerce-protocol)

Enable instant checkout in ChatGPT Apps using delegated payment tokens
through Braintree.

### [Universal Commerce Protocol integration with Braintree](/agent-ready/universal-commerce-protocol-with-braintree)

Enable the Buy button in Google AI Mode and Gemini using the Google Pay
payment handler through Braintree.

### [Universal Commerce Protocol integration with PayPal](/agent-ready/universal-commerce-protocol-with-paypal)

Enable checkout in Google AI Mode and Gemini using the Google Pay payment handler
through PayPal's Orders v2 API.

The key difference between these integrations is the AI platform they support, the payment provider, and how payment credentials are obtained and processed.

|                    | Agentic Commerce Protocol integration                                                                                              | Universal Commerce Protocol integration with Braintree                                                                    | Universal Commerce Protocol integration with PayPal                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Best for**       | Merchants building ChatGPT Apps or enabling their products for discovery in ChatGPT shopping.                                      | Braintree merchants with an existing Google Pay integration who want to be discoverable in Google's AI shopping surfaces. | PayPal merchants on direct, connected, or embedded integration paths with Google Pay enabled who want to support checkout in Google's AI shopping surfaces. |
| **How it works**   | Customers authorize PayPal as their payment method. Your app receives a delegated token to process transactions through Braintree. | Customers pay using their Google Wallet. Google returns a single-use payment token that you process through Braintree.    | Google sends an encrypted Google Pay credential in the checkout session. You forward it to PayPal through the Orders v2 API for decryption and processing.  |
| **AI platform**    | ChatGPT, OpenAI                                                                                                                    | Google AI Mode, Gemini                                                                                                    | Google AI Mode, Gemini                                                                                                                                      |
| **Payment method** | Delegated payment tokens through Braintree.                                                                                        | Google Pay payment handler through Braintree.                                                                             | Google Pay payment handler through PayPal's [Orders v2 API](/api/orders/v2).                                                                                |
