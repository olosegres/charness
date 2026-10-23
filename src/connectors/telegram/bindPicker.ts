/**
 * The folder picker of `/bind` — and of `/topic`, which shows the same keyboard with its buttons pointing at a
 * wizard instead of at the topic it sits in. A leaf module (no `bot.ts`, no environment): the command modules take it
 * as a plain import.
 */
import { Markup } from 'telegraf';
import { t } from '../../i18n';
import { paginateBindList } from '../../validation';

/** Inline-keyboard page size for `/bind`. 20 fits one phone screen comfortably. */
export const BIND_PAGE_SIZE = 20;

/**
 * «Create new folder» button of the `/bind` picker. The callback id deliberately does NOT start with `bind_`, so the
 * `bind_<subdir>` action regex can't mistake it for a folder pick.
 */
export const bindCreateFolderCallback = 'bindCreateFolder';

/**
 * «Leave current dir» button — the folded-in `/unbind`. Like {@link bindCreateFolderCallback}, the callback id
 * deliberately does NOT start with `bind_`. Only rendered in a bound topic.
 */
export const bindLeaveCurrentCallback = 'bindLeaveCurrent';

/** The middle «N/M» pill of the nav row: pure UI, answered without a state change (shared by every picker built here). */
export const bindPageNoopCallback = 'bind_page_noop';

/** The callback data of a picker's buttons: `/bind` acts on the topic the keyboard sits in, `/topic` on its wizard. */
export interface BindPickerCallbacks {
  /** The folder button of `subdir`, the `index`-th entry of the WHOLE list (not of its page). */
  getFolderCallback: (subdir: string, index: number) => string;
  getPageCallback: (page: number) => string;
  createFolderCallback: string;
  /** A full-width last row of its own — the way out of a wizard (`/bind`'s picker has none). */
  cancelButton?: { label: string; callback: string };
}

/** `/bind`'s own: the folder name rides in the data, pages are numbered. */
export const bindPickerCallbacks: BindPickerCallbacks = {
  getFolderCallback: (subdir) => `bind_${subdir}`,
  getPageCallback: (page) => `bind_page_${page}`,
  createFolderCallback: bindCreateFolderCallback,
};

/**
 * @description Build a `subdir`-suggestion keyboard for `/bind` and friends.
 *
 * Lists are paginated at {@link BIND_PAGE_SIZE} entries: a `WORK_ROOT` with
 * many subfolders (mono-repo workspace, packages dir, etc.) would otherwise
 * push the inline keyboard past Telegram's per-message height limit and
 * lose entries below the fold.
 *
 * The nav row appears only when there's more than one page. The middle
 * `pageLabel` button is a no-op ({@link bindPageNoopCallback}) — it exists
 * solely so the user sees "2/5" without us having to fake a divider with
 * a separate message.
 *
 * Subdirs whose callback_data exceeds 64 bytes are filtered out upstream
 * in `listAvailableSubdirs`. `page` is clamped to a valid index so a stale
 * callback (folders disappeared since the keyboard was sent) just lands
 * on the last available page.
 *
 * When `isBound` the FIRST row is a full-width «leave current dir» button
 * ({@link bindLeaveCurrentCallback}, the folded-in `/unbind`); the «create new folder»
 * button ({@link bindCreateFolderCallback}) follows. Both callbacks deliberately do
 * NOT start with `bind_`, so they can't be mistaken for a folder pick by the
 * `bind_<subdir>` action regex. They ride on every page so they're reachable
 * regardless of pagination.
 *
 * `callbacks` re-targets the buttons (the `/topic` wizard's, which adds a «cancel» row at the bottom); the layout
 * stays the one `/bind` has.
 */
export function buildBindKeyboard(
  subdirs: readonly string[],
  page: number = 0,
  pageSize: number = BIND_PAGE_SIZE,
  isBound: boolean = false,
  callbacks: BindPickerCallbacks = bindPickerCallbacks,
) {
  const { slice, currentPage, totalPages } = paginateBindList(subdirs, page, pageSize);
  const firstIndex = currentPage * pageSize;

  const rows = [
    [Markup.button.callback(t('bind.create_button'), callbacks.createFolderCallback)],
  ];
  // A bound topic gets a full-width «leave current dir» row PREPENDED above the
  // «create new folder» row — this is the folded-in `/unbind`. Its callback
  // deliberately avoids the `bind_` prefix so the `bind_<subdir>` action regex
  // can't catch it. The row is omitted when unbound (nothing to leave).
  if (isBound) {
    rows.unshift([Markup.button.callback(t('bind.leave_button'), bindLeaveCurrentCallback)]);
  }
  for (let i = 0; i < slice.length; i += 2) {
    const row = [Markup.button.callback(`📁 ${slice[i]}`, callbacks.getFolderCallback(slice[i], firstIndex + i))];
    if (slice[i + 1]) {
      row.push(Markup.button.callback(`📁 ${slice[i + 1]}`, callbacks.getFolderCallback(slice[i + 1], firstIndex + i + 1)));
    }
    rows.push(row);
  }

  if (totalPages > 1) {
    const nav = [];
    if (currentPage > 0) {
      nav.push(Markup.button.callback('⬅️ Prev', callbacks.getPageCallback(currentPage - 1)));
    }
    nav.push(Markup.button.callback(`${currentPage + 1}/${totalPages}`, bindPageNoopCallback));
    if (currentPage < totalPages - 1) {
      nav.push(Markup.button.callback('Next ➡️', callbacks.getPageCallback(currentPage + 1)));
    }
    rows.push(nav);
  }

  if (callbacks.cancelButton) {
    rows.push([Markup.button.callback(callbacks.cancelButton.label, callbacks.cancelButton.callback)]);
  }

  return Markup.inlineKeyboard(rows);
}
