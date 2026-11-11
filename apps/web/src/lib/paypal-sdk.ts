/**
 * PayPal JS SDK v6 card fields (HF-019 Part 2; proven in spike S7, `spikes/s7-browser.html`).
 * Card data goes from PayPal's hosted fields straight to PayPal: our API only ever sees the
 * `orderId` it created and the bid id. Loaded on demand, only when the shopper picks "Card".
 */

const SDK_URL = {
  sandbox: 'https://www.sandbox.paypal.com/web-sdk/v6/core',
  live: 'https://www.paypal.com/web-sdk/v6/core',
} as const;

export type CardFieldType = 'name' | 'number' | 'expiry' | 'cvv';

export interface CardSubmitResult {
  state: 'succeeded' | 'failed' | 'canceled' | string;
  data?: { orderId?: string; liabilityShift?: string; message?: string } | null;
}

export interface CardFieldsSession {
  createCardFieldsComponent(opts: { type: CardFieldType; placeholder?: string }): HTMLElement;
  submit(
    orderId: string,
    opts?: { billingAddress?: { countryCode?: string; postalCode?: string } },
  ): Promise<CardSubmitResult>;
}

interface SdkInstance {
  findEligibleMethods(opts: { currencyCode: string }): Promise<{
    isEligible(method: string): boolean;
  }>;
  createCardFieldsOneTimePaymentSession(): CardFieldsSession;
}

interface PayPalGlobal {
  createInstance(opts: { clientId: string; components: string[] }): Promise<SdkInstance>;
}

declare global {
  interface Window {
    paypal?: PayPalGlobal;
  }
}

let loading: Promise<PayPalGlobal> | null = null;

function loadScript(sandbox: boolean): Promise<PayPalGlobal> {
  if (window.paypal) return Promise.resolve(window.paypal);
  loading ??= new Promise<PayPalGlobal>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = sandbox ? SDK_URL.sandbox : SDK_URL.live;
    s.async = true;
    s.onload = () =>
      window.paypal ? resolve(window.paypal) : reject(new Error('PayPal SDK did not load'));
    s.onerror = () => {
      loading = null;
      reject(new Error('PayPal SDK did not load'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/**
 * A card-fields session, or null when the merchant isn't eligible for advanced cards (the page
 * then offers PayPal and, in the demo, the sandbox test card).
 */
export async function createCardFieldsSession(opts: {
  clientId: string;
  sandbox: boolean;
}): Promise<CardFieldsSession | null> {
  const paypal = await loadScript(opts.sandbox);
  const sdk = await paypal.createInstance({ clientId: opts.clientId, components: ['card-fields'] });
  const methods = await sdk.findEligibleMethods({ currencyCode: 'USD' });
  if (!methods.isEligible('advanced_cards')) return null;
  return sdk.createCardFieldsOneTimePaymentSession();
}
