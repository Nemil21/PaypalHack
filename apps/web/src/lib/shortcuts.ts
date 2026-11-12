import type { ViewerRole } from './viewer';
import { shellNav } from './viewer';

/**
 * Role-specific single-key shortcuts (v4 §2.1), shown as chips on the nav buttons:
 * brand S → settings, P → payouts; buyer P → place a bid, S → buyer settings. The public nav has
 * none. The keys come from `shellNav`, so the chips and the listener can never disagree.
 *
 * They fire only when nothing is focused (the event target is the page body), so typing or
 * navigating inside any control never triggers them: inputs, AG Grid cells, AG Studio menus and
 * editors, and role-based widgets (textbox, combobox, grid, listbox, menu) all own focus while
 * in use. Modified keys (including Shift), key repeats and events a widget already handled
 * (`defaultPrevented`) are ignored. Users can turn shortcuts off (WCAG 2.1.4); the choice persists.
 */
export interface Shortcut {
  key: string;
  label: string;
  to: string;
}

/** The shortcuts live for a role, in nav order. */
export function shortcutsFor(role: ViewerRole): Shortcut[] {
  return shellNav(role).actions.map((a) => ({
    key: a.shortcut.toLowerCase(),
    label: a.label,
    to: a.to,
  }));
}

/** "S settings, P payouts" for the on/off toggle; null when the role has no shortcuts. */
export function shortcutsHint(role: ViewerRole): string | null {
  const list = shortcutsFor(role);
  return list.length
    ? list.map((s) => `${s.key.toUpperCase()} ${s.label.toLowerCase()}`).join(', ')
    : null;
}

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

export function shortcutFor(e: KeyEventLike, doc: DocumentLike, role: ViewerRole): Shortcut | null {
  if (e.defaultPrevented || e.repeat) return null;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  if (e.target !== doc.body && e.target !== doc.documentElement) return null;
  return shortcutsFor(role).find((s) => s.key === e.key) ?? null;
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
