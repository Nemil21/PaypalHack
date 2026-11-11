/**
 * Lazy screens (HF-057) are hashed chunks. After a redeploy, a tab opened earlier asks for a chunk
 * that no longer exists; reloading once fetches the new index.html and its new hashes.
 */

const KEY = 'hf-chunk-reload-at';
/** A second failure within this window is a real outage, not a stale tab: don't loop. */
const WINDOW_MS = 30_000;

/** Chrome, Firefox and Safari word a failed dynamic import differently. */
export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(
    msg,
  );
}

/** True (and records the attempt) if we haven't reloaded for a chunk error in the last 30 s. */
export function claimChunkReload(storage: Storage | undefined, now = Date.now()): boolean {
  if (!storage) return false;
  try {
    const last = Number(storage.getItem(KEY) ?? 0);
    if (now - last < WINDOW_MS) return false;
    storage.setItem(KEY, String(now));
    return true;
  } catch {
    return false;
  }
}
