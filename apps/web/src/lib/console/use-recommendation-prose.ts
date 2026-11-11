import { useEffect, useState } from 'react';
import type { Recommendation } from '@holdfast/shared';
import { askBrandAgent, explainKey } from './brand-agent';

/** Prose already fetched this session, per recommendation (a refetched book reuses it). */
const cache = new Map<string, string | null>();

/**
 * Claude's explanation under the W06 recommendation card (HF-051b, features/09 §Logic 2). One
 * `POST /api/brand-agent/ask` without a question per distinct recommendation, not per bid. Claude
 * down, slow or unconfigured → null, and the card renders without prose.
 */
export function useRecommendationProse(
  listingId: string,
  rec: Recommendation | undefined,
): string | null {
  const key = explainKey(listingId, rec);
  const [prose, setProse] = useState<{ key: string; text: string | null } | null>(null);

  useEffect(() => {
    if (!key) return;
    if (cache.has(key)) {
      setProse({ key, text: cache.get(key)! });
      return;
    }
    const abort = new AbortController();
    askBrandAgent({ listingId }, { signal: abort.signal }).then(
      (res) => {
        // Only a real answer is cached; "unavailable" may recover on the next recommendation.
        if (res.answer && !res.unverifiedNumbers.length) cache.set(key, res.answer);
        setProse({ key, text: res.unverifiedNumbers.length ? null : res.answer });
      },
      () => {
        if (!abort.signal.aborted) setProse({ key, text: null });
      },
    );
    return () => abort.abort();
  }, [key, listingId]);

  return prose && prose.key === key ? prose.text : null;
}
