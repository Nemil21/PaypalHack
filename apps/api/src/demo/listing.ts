import { isUuid, type Queryable } from '@holdfast/core';
import { AUREL_A7 } from './aurel-fixture.js';

export interface DemoListingRef {
  id: string;
  slug: string | null;
  status: string;
  quantity: number;
}

/**
 * The listing a demo script acts on: by id or slug, else the live Aurel A7 demo listing, else the
 * newest live (OPEN / ROUNDS) demo listing.
 */
export async function findDemoListing(
  q: Queryable,
  ref?: string | null,
): Promise<DemoListingRef | null> {
  const sql = ref
    ? `SELECT id, slug, status, quantity FROM listings WHERE ${isUuid(ref) ? 'id' : 'slug'} = $1`
    : `SELECT l.id, l.slug, l.status, l.quantity
         FROM listings l JOIN brands b ON b.id = l.brand_id
        WHERE l.status IN ('OPEN', 'ROUNDS')
          AND (l.demo_run_id IS NOT NULL OR b.name ILIKE '%(demo)%')
        ORDER BY (l.slug = $1) DESC, l.published_at DESC NULLS LAST, l.created_at DESC
        LIMIT 1`;
  const { rows } = await q.query<DemoListingRef>(sql, [ref ?? AUREL_A7.slug]);
  return rows[0] ?? null;
}
