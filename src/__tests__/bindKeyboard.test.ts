/**
 * `buildBindKeyboard` conditional «leave current dir» row (S1 of the
 * command-surface cleanup).
 *
 * Load-bearing facts proven here (not just "renders"):
 *   • isBound=true  → the FIRST inline row is the «leave current dir» button
 *     (callback `bindLeaveCurrent`), and the «create new folder» row follows.
 *   • isBound=false → there is NO `bindLeaveCurrent` button anywhere, and the
 *     FIRST row is «create new folder» (callback `bindCreateFolder`).
 *
 * The same keyboard is the `/topic` wizard's folder picker: its callbacks can be re-targeted
 * (`BindPickerCallbacks`) while the layout — create row, folder grid, nav row — stays the one `/bind` has.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BIND_PAGE_SIZE, buildBindKeyboard, type BindPickerCallbacks } from '../connectors/telegram/bindPicker';

/** Wire identifiers the `bot.action(...)` handlers match — must stay in lockstep. */
const leaveCallback = 'bindLeaveCurrent';
const createCallback = 'bindCreateFolder';

/** Flatten the keyboard's first row into its callback_data list. */
function getRowCallbacks(
  keyboard: ReturnType<typeof buildBindKeyboard>,
  rowIndex: number,
): string[] {
  const rows = keyboard.reply_markup.inline_keyboard;
  return rows[rowIndex].map((button) =>
    'callback_data' in button ? button.callback_data : '',
  );
}

function getAllCallbacks(keyboard: ReturnType<typeof buildBindKeyboard>): string[] {
  return keyboard.reply_markup.inline_keyboard.flatMap((row) =>
    row.map((button) => ('callback_data' in button ? button.callback_data : '')),
  );
}

describe('buildBindKeyboard — «leave current dir» row', () => {
  const subdirs = ['alpha', 'beta'];

  it('bound topic: first row is the leave button, then create-folder', () => {
    const keyboard = buildBindKeyboard(subdirs, 0, 20, true);

    // First row = the leave button, alone (full-width).
    assert.deepEqual(getRowCallbacks(keyboard, 0), [leaveCallback]);
    // Second row = the create-folder button.
    assert.deepEqual(getRowCallbacks(keyboard, 1), [createCallback]);
  });

  it('unbound topic: no leave button anywhere, create-folder is first', () => {
    const keyboard = buildBindKeyboard(subdirs, 0, 20, false);

    const allCallbacks = getAllCallbacks(keyboard);
    assert.ok(
      !allCallbacks.includes(leaveCallback),
      `unbound keyboard must not carry "${leaveCallback}"`,
    );
    // First row = the create-folder button (the leave row is omitted).
    assert.deepEqual(getRowCallbacks(keyboard, 0), [createCallback]);
  });

  it('isBound defaults to false (no leave button when omitted)', () => {
    const keyboard = buildBindKeyboard(subdirs);
    assert.ok(!getAllCallbacks(keyboard).includes(leaveCallback));
    assert.deepEqual(getRowCallbacks(keyboard, 0), [createCallback]);
  });
});

describe('buildBindKeyboard — default callbacks (what /bind acts on)', () => {
  it('a folder button carries its name, the nav row its page numbers', () => {
    const subdirs = Array.from({ length: BIND_PAGE_SIZE + 3 }, (_, index) => `folder${index.toString().padStart(2, '0')}`);
    const firstPage = buildBindKeyboard(subdirs, 0);
    assert.deepEqual(getRowCallbacks(firstPage, 1), ['bind_folder00', 'bind_folder01']);
    const navRow = firstPage.reply_markup.inline_keyboard.at(-1) ?? [];
    assert.deepEqual(navRow.map((button) => ('callback_data' in button ? button.callback_data : '')), ['bind_page_noop', 'bind_page_1']);
  });
});

describe('buildBindKeyboard — re-targeted callbacks (the /topic wizard)', () => {
  const wizardCallbacks: BindPickerCallbacks = {
    getFolderCallback: (_subdir, index) => `wiz_folder_${index}`,
    getPageCallback: (page) => `wiz_page_${page}`,
    createFolderCallback: 'wiz_create',
  };
  const subdirs = Array.from({ length: BIND_PAGE_SIZE + 3 }, (_, index) => `folder${index.toString().padStart(2, '0')}`);

  it('the create row and every folder button point at the wizard; none keeps a /bind callback', () => {
    const keyboard = buildBindKeyboard(subdirs, 0, BIND_PAGE_SIZE, false, wizardCallbacks);
    assert.deepEqual(getRowCallbacks(keyboard, 0), ['wiz_create']);
    assert.deepEqual(getRowCallbacks(keyboard, 1), ['wiz_folder_0', 'wiz_folder_1']);
    const own = getAllCallbacks(keyboard).filter((data) => data !== 'bind_page_noop');
    assert.ok(own.every((data) => data.startsWith('wiz_')), `a /bind callback leaked into the wizard's keyboard: ${own.join(', ')}`);
  });

  it('a folder button carries the index in the WHOLE list, so a second page does not restart at 0', () => {
    const keyboard = buildBindKeyboard(subdirs, 1, BIND_PAGE_SIZE, false, wizardCallbacks);
    assert.deepEqual(getRowCallbacks(keyboard, 1), [`wiz_folder_${BIND_PAGE_SIZE}`, `wiz_folder_${BIND_PAGE_SIZE + 1}`]);
    const navRow = keyboard.reply_markup.inline_keyboard.at(-1) ?? [];
    assert.deepEqual(navRow.map((button) => ('callback_data' in button ? button.callback_data : '')), ['wiz_page_0', 'bind_page_noop']);
  });

  it('a cancel button is the last row, below the nav row; without one there is none', () => {
    const withCancel = buildBindKeyboard(subdirs, 0, BIND_PAGE_SIZE, false, { ...wizardCallbacks, cancelButton: { label: 'Cancel', callback: 'wiz_cancel' } });
    const rows = withCancel.reply_markup.inline_keyboard;
    assert.deepEqual(getRowCallbacks(withCancel, rows.length - 1), ['wiz_cancel']);
    assert.deepEqual(getRowCallbacks(withCancel, rows.length - 2), ['bind_page_noop', 'wiz_page_1'], 'the nav row stays above it');
    assert.ok(!getAllCallbacks(buildBindKeyboard(subdirs, 0, BIND_PAGE_SIZE, false, wizardCallbacks)).includes('wiz_cancel'));
  });
});
