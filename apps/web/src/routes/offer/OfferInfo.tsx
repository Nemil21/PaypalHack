/** W12 static blocks: how it works (3 steps), FAQ accordion, footer trust row. */

const STEPS = [
  {
    title: 'Name your price',
    body: 'Pick what you would pay. You pay exactly your bid, never more.',
  },
  {
    title: 'PayPal holds it',
    body: 'The amount is held on your card or PayPal account, not charged.',
  },
  {
    title: 'Charged only if you win',
    body: 'If your bid wins when the brand clears, you are charged your bid. Otherwise the hold is released.',
  },
];

export function HowItWorks() {
  return (
    <section aria-labelledby="how-it-works" className="flex flex-col gap-4">
      <h2 id="how-it-works" className="label text-[13px] text-muted">
        How it works
      </h2>
      <ol className="grid gap-3 sm:grid-cols-3">
        {STEPS.map((s, i) => (
          <li key={s.title} className="flex flex-col gap-2 rounded-md bg-surface p-4">
            <span className="font-mono text-[13px] text-orange">0{i + 1}</span>
            <span className="text-[16px] font-medium text-ink">{s.title}</span>
            <span className="text-[14px] leading-[21px] text-body">{s.body}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

const FAQ = [
  {
    q: 'Am I charged?',
    a: 'No, not now. PayPal places a hold for your bid. You are charged only if your bid wins, and only the amount you bid.',
  },
  {
    q: 'When?',
    a: 'When the bidding window closes the brand clears the book: winning bids are charged, every other hold is released. Your bank may show a released hold as pending for a few days.',
  },
  {
    q: 'Can I cancel?',
    a: 'Yes. Cancel any time before the brand clears and the hold is released. You can also raise your bid; to bid lower, cancel and bid again (your place in line resets).',
  },
  {
    q: 'What if it gets cheaper elsewhere?',
    a: 'Unless you turn it off, we release your hold when a store sells it for less than your bid.',
  },
];

export function Faq() {
  return (
    <section aria-labelledby="faq" className="flex flex-col gap-2">
      <h2 id="faq" className="label text-[13px] text-muted">
        FAQ
      </h2>
      <div className="divide-y divide-line border-y border-line">
        {FAQ.map((f) => (
          <details key={f.q} className="group py-3">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[15px] font-medium text-ink">
              {f.q}
              <span aria-hidden className="font-mono text-muted group-open:rotate-45">
                +
              </span>
            </summary>
            <p className="pt-2 text-[14px] leading-[21px] text-body">{f.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

export function TrustRow() {
  return (
    <p className="label flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
      <span>Payments by PayPal</span>
      <span>Held, not charged</span>
      <span>Pay exactly your bid</span>
      <span>Card details go to PayPal, never to us</span>
    </p>
  );
}
