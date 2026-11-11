import { useEffect, useState } from 'react';
import type { Recommendation } from '@holdfast/shared';
import { askBrandAgent, explainKey } from './brand-agent';
import { createProseScheduler, type ProseScheduler } from './prose-scheduler';

/**
 * Claude's explanation under the W06 recommendation card (HF-051b, features/09 §Logic 2): a
 * `POST /api/brand-agent/ask` without a question, once the recommendation has settled and at most
 * every 30 s (`prose-scheduler.ts`), so a bid burst does not spend the brand's `agent` rate budget.
 * Claude down, slow or unconfigured → null, and the card renders without prose.
 */
export function useRecommendationProse(
  listingId: string,
  rec: Recommendation | undefined,
): string | null {
  const key = explainKey(listingId, rec);
  const [prose, setProse] = useState<string | null>(null);
  const [scheduler, setScheduler] = useState<ProseScheduler | null>(null);

  useEffect(() => {
    const s = createProseScheduler({
      explain: async () => {
        const res = await askBrandAgent({ listingId });
        // Prose quoting a number no tool returned is not shown under the card.
        return res.unverifiedNumbers.length ? null : res.answer;
      },
      onProse: setProse,
    });
    setScheduler(s);
    return () => s.dispose();
  }, [listingId]);

  useEffect(() => scheduler?.update(key), [scheduler, key]);

  return key ? prose : null;
}
