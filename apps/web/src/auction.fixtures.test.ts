import { clear } from '@holdfast/shared';
import { describe, expect, it } from 'vitest';
import { books, summarize, toClearBid } from '../../../packages/shared/fixtures/books.js';

// HF-005: the console imports the same clear() as the server (never a UI re-implementation) and
// must agree with the shared fixtures that packages/core runs against Postgres.
describe('web: clear() from @holdfast/shared matches the shared fixtures', () => {
  it.each(books.map((b) => [b.name, b] as const))('%s', (_name, book) => {
    expect(summarize(clear(book.bids.map(toClearBid), book.q, book.floorCents))).toEqual(
      book.expect,
    );
  });
});
