import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api';
import { paths } from '../routes';
import { createClearFlow, type ClearFlow, type ClearState } from './clear';

/**
 * The Clear flow for one listing (HF-028; reused by HF-061's M10 sheet). One flow per listing,
 * so a retried Clear keeps its Idempotency-Key even across closing and reopening the modal.
 * When the listing is cleared (a 202, or a lost success found as NOT_CLEARABLE + CLEARING) it
 * switches to W08 unless `onCleared` takes over.
 */
export function useClear(
  listingId: string,
  opts: { onCleared?: (state: ClearState) => void } = {},
): ClearState & Omit<ClearFlow, 'get' | 'subscribe'> {
  const navigate = useNavigate();
  const flow = useMemo(() => createClearFlow(api), [listingId]);
  const state = useSyncExternalStore(flow.subscribe, flow.get, flow.get);
  const { onCleared } = opts;

  useEffect(() => {
    if (state.step !== 'cleared') return;
    if (onCleared) onCleared(state);
    else navigate(paths.listingSettlement(listingId));
  }, [state, onCleared, navigate, listingId]);

  useEffect(() => () => flow.close(), [flow]);

  return {
    ...state,
    open: flow.open,
    confirm: flow.confirm,
    retry: flow.retry,
    releaseAll: flow.releaseAll,
    close: flow.close,
  };
}
