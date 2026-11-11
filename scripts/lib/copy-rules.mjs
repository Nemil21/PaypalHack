// Copy rules shared by the Devpost draft linter (HF-050a) and the video script linter (HF-050b).

// D14: pay-your-bid copy only.
export const UNIFORM_PRICE = [
  /one fair price/i,
  /uniform(-| )price/i,
  /single clearing price/i,
  /everyone pays/i,
  /all winners pay/i,
  /pays? the cutoff/i,
  /charged \$219/i,
];

// D15: fictional brand only; no real brands, retailers or competitors.
const TRADEMARKS = [
  'Sony', 'Bose', 'Sennheiser', 'AirPods', 'JBL', 'Samsung', 'Patagonia', 'North Face', 'Best Buy',
  'Walmart', 'Costco', 'eBay', 'Shopify', 'B-Stock', 'Greentoe', 'Priceline', 'WebHouse',
];
// Brands that are also ordinary words ("beats the liquidator", "an apple") match case-sensitively only.
const COMMON_WORD_TRADEMARKS = ['Apple', 'Beats', 'Amazon', 'Target'];

/** The D15 trademarks found in `text`. */
export function trademarksIn(text) {
  return [
    ...TRADEMARKS.filter((tm) => new RegExp(`\\b${tm}\\b`, 'i').test(text)),
    ...COMMON_WORD_TRADEMARKS.filter((tm) => new RegExp(`\\b${tm}\\b`).test(text)),
  ];
}

/** The D14 uniform-price patterns that match `text`. */
export function uniformPriceIn(text) {
  return UNIFORM_PRICE.filter((re) => re.test(text));
}
