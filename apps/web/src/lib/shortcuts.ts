/**
 * Single-key shortcuts B (brand console) and P (place a bid), shown as chips on the nav buttons.
 *
 * They fire only when nothing is focused (the event target is the page body), so typing or
 * navigating inside any control never triggers them: inputs, AG Grid cells, AG Studio menus and
 * editors, and role-based widgets (textbox, combobox, grid, listbox, menu) all own focus while
 * in use. Modified keys (including Shift), key repeats and events a widget already handled
 * (`defaultPrevented`) are ignored. Users can turn shortcuts off (WCAG 2.1.4); the choice persists.
 */
export type Shortcut = 'brand' | 'bid';

const KEYS: Record<string, Shortcut> = { b: 'brand', p: 'bid' };

export interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  defaultPrevented: boolean;
  target: unknown;
}

export interface DocumentLike {
  body: unknown;
  documentElement: unknown;
}

export function shortcutFor(e: KeyEventLike, doc: DocumentLike): Shortcut | null {
  if (e.defaultPrevented || e.repeat) return null;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  if (e.target !== doc.body && e.target !== doc.documentElement) return null;
  return KEYS[e.key] ?? null;
}

const STORAGE_KEY = 'holdfast:shortcuts';

export function shortcutsEnabled(storage: Pick<Storage, 'getItem'> | undefined): boolean {
  try {
    return storage?.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setShortcutsEnabled(
  storage: Pick<Storage, 'setItem'> | undefined,
  enabled: boolean,
): void {
  try {
    storage?.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {
    // Storage unavailable (private mode): the toggle lasts for this page only.
  }
}
