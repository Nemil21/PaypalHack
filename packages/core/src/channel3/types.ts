/**
 * Channel3 wire shapes (HF-009), from the public OpenAPI spec and checked against the recorded
 * fixtures in `fixtures/channel3/`. Only the fields Holdfast reads are typed; bodies are parsed
 * defensively, since Channel3 marks many fields optional or nullable.
 *
 * Channel3's model: prices live on offers, not products, and are decimals in `price.currency`.
 * Offers carry no GTIN and no merchant name. A colour is often its own product id
 * (`variants.options[].values[].product_id`); `variants.selected` pins the rest.
 */

export interface Channel3Price {
  price: number;
  compare_at_price?: number | null;
  currency: string;
}

/** `new` or `used`; `null` when Channel3 does not know. Other strings are treated as not new. */
export type Channel3Condition = 'new' | 'used' | (string & {}) | null;

export type Channel3Availability = 'InStock' | 'OutOfStock' | (string & {});

export interface Channel3Offer {
  /** Attributed `buy.trychannel3.com` link (the affiliate link; show `AFFILIATE_DISCLOSURE`). */
  url: string;
  domain: string;
  price: Channel3Price;
  availability: Channel3Availability;
  condition?: Channel3Condition;
}

/** One `{name, label}` per variant option, e.g. `{ name: 'Color', label: 'Green' }`. */
export interface Channel3SelectedOption {
  name: string;
  label: string;
}

export interface Channel3Variants {
  options: {
    name: string;
    values: { label: string; exists: boolean; product_id?: string | null }[];
  }[];
  selected: Channel3SelectedOption[];
}

export interface Channel3Image {
  url: string;
  cleaned_url?: string | null;
  is_main_image?: boolean;
}

export interface Channel3Product {
  id: string;
  title: string;
  brands?: { id: string; name: string }[];
  images?: Channel3Image[];
  offers?: Channel3Offer[];
  variants?: Channel3Variants | null;
  /** Keyed by attribute handle (kebab-case, e.g. `noise-cancellation-technology`). */
  structured_attributes?: Record<string, string[]>;
}

export interface Channel3SearchResponse {
  products: Channel3Product[];
  next_page_token?: string | null;
}

export type Channel3OfferEvent =
  'offer.price.changed' | 'offer.availability.changed' | 'offer.created' | 'offer.deleted';

export interface Channel3SubscriptionRequest {
  productId: string;
  /** The variant to watch; required by Channel3 when the product has variant options. */
  selection: Channel3SelectedOption[] | null;
  /** Merchant domains to watch (max 25; D17: `brands.authorized_domains`). Empty = every offer. */
  domains: readonly string[];
  events?: Channel3OfferEvent[];
}

export interface Channel3Subscription {
  subscriptionId: string;
  /** Differs from the requested id when the selection picked another product. */
  productId: string;
  domains: string[] | null;
  status: string;
}

/** `offer.price.changed` webhook body (OpenAPI `OfferPriceChangedEvent`). No condition: hydrate it. */
export interface Channel3PriceChangedEvent {
  id: string;
  timestamp: string;
  type: 'offer.price.changed';
  data: {
    subscription_id: string;
    subject: {
      product_id: string;
      domain: string;
      selection?: Channel3SelectedOption[] | null;
      locale?: { language?: string; country?: string | null; currency?: string };
    };
    previous: Channel3Price;
    current: Channel3Price;
  };
}
