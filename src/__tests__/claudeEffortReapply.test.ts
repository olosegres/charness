/**
 * @description S7 — Claude re-applies the thread's stored `/effort` on every
 * FRESH TUI spawn (startSession / resumeSession), at the moment the TUI input
 * box is ready and BEFORE buffered user prompts.
 *
 * Why this test: claude persists effort GLOBALLY in its own settings.json, so a
 * fresh TUI (start / `/new` / resume) inherits the LAST globally-set level —
 * possibly chosen in another topic. The bot keeps the real per-thread choice in
 * `.claude-effort-prefs.json`; on spawn it must re-type `/effort <level>` once,
 * ahead of any replayed prompt. No stored pref → nothing typed.
 *
 * BUG fixed 2026-06-05: the first cut typed `/effort` immediately at the end of
 * `startSession` — but a fresh tmux session returns while the claude TUI is
 * still painting its boot banner, so the keystrokes interleaved with the paint
 * and the command sat UNSUBMITTED. The mechanism is now a two-step seam:
 *   1. `applyStoredEffortOnSpawn(key)` ARMS `session.pendingEffortReapply` from
 *      the on-disk pref (no keystroke).
 *   2. the poll loop calls `consumePendingEffortReapply(session)` the FIRST time
 *      the pane is ready (`checkIsClaudePromptReady`), typing once and clearing
 *      the flag (one-shot).
 *
 * Driving the real `startSession` would spawn a real tmux + claude process, so
 * we exercise both halves of the seam directly with a session injected into the
 * private map and `sendInput` spied — the same keystroke path a manual
 * `/effort` uses. The adopt-exclusion is verified structurally (adopt never
 * calls `applyStoredEffortOnSpawn`, so its `pendingEffortReapply` stays null);
 * the pure readiness predicate is locked by `claudePromptReady.test.ts` and the
 * pure keystroke decision by `effortStartupKeystroke.test.ts`.
 *
 * Harness mirrors `openCodeSetModelNoSession.test.ts`: the testSetup module is
 * imported FIRST so the adapter reads its prefs file from a temp `DATA_DIR`;
 * private members reached via bracket access.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  seededThreadKeyString,
  seededEffortLevel,
  noPrefThreadKeyString,
} from './claudeEffortReapply.testSetup';
import { ClaudeCliAdapter, checkIsClaudePromptReady, type ClaudeSession } from '../adapters/claudeCliAdapter';
import { defaultEffortLevel, setInstanceDefaultEffortReader } from '../effortLevels';
import { keyToString, keyFromString, type SessionKey } from '../sessionKey';

const seededKey: SessionKey = keyFromString(seededThreadKeyString);
const noPrefKey: SessionKey = keyFromString(noPrefThreadKeyString);

/** A captured pane that the readiness predicate accepts (input box up, no gate). */
const readyPane = 'Some prior output\n\n❯ ';

/**
 * @description Build an adapter with a live session injected for `key` (so the
 * `sendInput` active-session guard passes) and `sendInput` replaced by a spy
 * that records every typed string instead of touching tmux. Returns the live
 * session too, so a test can read/poke `pendingEffortReapply`.
 */
function createAdapterWithSession(key: SessionKey): {
  adapter: ClaudeCliAdapter;
  typed: string[];
  session: ClaudeSession;
} {
  const adapter = new ClaudeCliAdapter();
  const session = adapter['createSession']({
    key,
    workDir: '/tmp/work',
    sessionName: `claude-${keyToString(key)}`,
    claudeSessionId: '00000000-0000-4000-8000-000000000000',
    configDir: null,
    isActive: true,
    handledAutoEnter: false,
    handledAutoAccept: false,
  });
  adapter['sessions'].set(keyToString(key), session);

  const typed: string[] = [];
  adapter['sendInput'] = (_key: SessionKey, input: string) => {
    typed.push(input);
  };
  return { adapter, typed, session };
}

describe('Claude effort re-apply on fresh spawn (S7)', () => {
  let adapter: ClaudeCliAdapter;
  let typed: string[];
  let session: ClaudeSession;

  describe('arm step — applyStoredEffortOnSpawn', () => {
    it('arms the pending flag from the stored pref WITHOUT typing', () => {
      ({ adapter, typed, session } = createAdapterWithSession(seededKey));
      adapter['applyStoredEffortOnSpawn'](seededKey);
      assert.equal(
        session.pendingEffortReapply,
        seededEffortLevel,
        'a fresh spawn must STASH the per-thread level, not type it into a booting TUI',
      );
      assert.deepEqual(typed, [], 'arming must not touch the pane — that is the booting-paint bug');
    });

    it('arms the bot default when there is no stored pref', () => {
      ({ adapter, typed, session } = createAdapterWithSession(noPrefKey));
      assert.equal(adapter.getEffort(noPrefKey), null, 'precondition: no pref for this thread');
      adapter['applyStoredEffortOnSpawn'](noPrefKey);
      // No explicit pref arms the bot's default (medium: no settings.json in this test), not nothing — so a
      // fresh spawn types `/effort medium` instead of inheriting claude's global.
      assert.equal(
        session.pendingEffortReapply,
        defaultEffortLevel,
        'no pref ⇒ the bot default is armed for re-apply',
      );
      assert.deepEqual(typed, [], 'arming must not touch the pane — that is the booting-paint bug');
    });

    it('the consume step types the default for a no-pref spawn', () => {
      ({ adapter, typed, session } = createAdapterWithSession(noPrefKey));
      adapter['applyStoredEffortOnSpawn'](noPrefKey);
      adapter['consumePendingEffortReapply'](session);
      assert.deepEqual(
        typed,
        [`/effort ${defaultEffortLevel}`],
        'a no-pref fresh spawn must type the bot default once the box is ready',
      );
      assert.equal(session.pendingEffortReapply, null, 'consumed flag must be cleared');
    });
  });

  describe('consume step — consumePendingEffortReapply', () => {
    beforeEach(() => {
      ({ adapter, typed, session } = createAdapterWithSession(seededKey));
      adapter['applyStoredEffortOnSpawn'](seededKey);
    });

    it('types the armed level once and clears the flag (one-shot)', () => {
      adapter['consumePendingEffortReapply'](session);
      assert.deepEqual(
        typed,
        [`/effort ${seededEffortLevel}`],
        'readiness must re-type the per-thread effort claude lost to its global state',
      );
      assert.equal(session.pendingEffortReapply, null, 'consumed flag must be cleared');
    });

    it('does NOT fire a second time (flag already consumed)', () => {
      adapter['consumePendingEffortReapply'](session);
      adapter['consumePendingEffortReapply'](session);
      assert.equal(typed.length, 1, 'a one-shot must type exactly once across repeated poll ticks');
    });

    it('does nothing when nothing is armed', () => {
      session.pendingEffortReapply = null;
      adapter['consumePendingEffortReapply'](session);
      assert.deepEqual(typed, [], 'no armed level ⇒ no keystroke');
    });
  });

  describe('readiness-gated poll loop (arm → poll → consume)', () => {
    /** Mirrors the poll-loop guard: pending + ready ⇒ consume. */
    function runPollTick(paneText: string): void {
      if (session.pendingEffortReapply && checkIsClaudePromptReady(paneText)) {
        adapter['consumePendingEffortReapply'](session);
      }
    }

    it('arms on spawn but stays silent until a poll sees a ready pane', () => {
      ({ adapter, typed, session } = createAdapterWithSession(seededKey));
      adapter['applyStoredEffortOnSpawn'](seededKey);

      // Booting pane (no input box) → predicate false → still silent.
      runPollTick('Claude Code v2.1.165\nbooting…');
      assert.deepEqual(typed, [], 'no keystroke while the TUI is still painting its banner');
      assert.equal(session.pendingEffortReapply, seededEffortLevel, 'still armed for a later ready poll');

      // Ready pane → predicate true → consume.
      runPollTick(readyPane);
      assert.deepEqual(typed, [`/effort ${seededEffortLevel}`], 'typed once the input box is ready');
      assert.equal(session.pendingEffortReapply, null, 'consumed');

      // A further ready poll must NOT re-type (one-shot survives the loop).
      runPollTick(readyPane);
      assert.equal(typed.length, 1, 'one-shot: the loop never re-types after consumption');
    });
  });
  describe('the instance default (settings.json) and «as in General»', () => {
    afterEach(async () => {
      setInstanceDefaultEffortReader(() => null);
      await adapter.clearEffort(noPrefKey);
    });

    it('a no-pref fresh spawn arms the INSTANCE default, not the code fallback', () => {
      setInstanceDefaultEffortReader(() => 'low');
      ({ adapter, typed, session } = createAdapterWithSession(noPrefKey));
      adapter['applyStoredEffortOnSpawn'](noPrefKey);
      assert.equal(session.pendingEffortReapply, 'low');
      assert.notEqual(defaultEffortLevel, 'low', 'the fixture default differs from the fallback, or the test proves nothing');
    });

    it('the topic\'s own pick still wins over the instance default', () => {
      setInstanceDefaultEffortReader(() => 'low');
      ({ adapter, typed, session } = createAdapterWithSession(seededKey));
      adapter['applyStoredEffortOnSpawn'](seededKey);
      assert.equal(session.pendingEffortReapply, seededEffortLevel);
    });

    it('clearing a pick on a live session removes it and types the instance default into the TUI', async () => {
      setInstanceDefaultEffortReader(() => 'low');
      ({ adapter, typed, session } = createAdapterWithSession(noPrefKey));
      assert.deepEqual(await adapter.setEffort(noPrefKey, 'max'), { status: 'applied' });
      assert.equal(adapter.getOwnEffort(noPrefKey), 'max');
      typed.length = 0;

      await adapter.clearEffort(noPrefKey);
      assert.equal(adapter.getOwnEffort(noPrefKey), null, 'the pick is gone from disk');
      assert.equal(adapter.getEffort(noPrefKey), null);
      assert.deepEqual(typed, ['/effort low'], 'the live TUI is brought to the default, like a pick would be');
    });

    it('setEffort says what it did: applied in a live TUI, stored with a notice when none runs, refused for an unknown level', async () => {
      ({ adapter, typed, session } = createAdapterWithSession(noPrefKey));
      assert.deepEqual(await adapter.setEffort(noPrefKey, 'high'), { status: 'applied' });
      assert.deepEqual(typed, ['/effort high']);

      session.isActive = false;
      typed.length = 0;
      const stored = await adapter.setEffort(noPrefKey, 'max');
      assert.equal(stored.status, 'stored');
      assert.ok(stored.status === 'stored' && stored.notice.length > 0);
      assert.equal(adapter.getOwnEffort(noPrefKey), 'max');
      assert.deepEqual(typed, [], 'nothing is typed where nothing runs');

      const refused = await adapter.setEffort(noPrefKey, 'turbo');
      assert.equal(refused.status, 'refused');
      assert.equal(adapter.getOwnEffort(noPrefKey), 'max', 'a refusal leaves the pick as it was');
    });

    it('clearing without a running session only removes the pick: the next spawn arms the default', async () => {
      setInstanceDefaultEffortReader(() => 'low');
      ({ adapter, typed, session } = createAdapterWithSession(noPrefKey));
      await adapter.setEffort(noPrefKey, 'max');
      typed.length = 0;
      session.isActive = false;

      await adapter.clearEffort(noPrefKey);
      assert.deepEqual(typed, []);
      assert.equal(adapter.getOwnEffort(noPrefKey), null);
    });

    it('getEffortState: nothing is running until the bot has typed a level; the next start is the pick, else the instance default', () => {
      setInstanceDefaultEffortReader(() => 'low');
      ({ adapter, typed, session } = createAdapterWithSession(noPrefKey));
      assert.deepEqual(adapter.getEffortState(noPrefKey), { running: null, nextStart: 'low' }, 'a fresh or adopted pane: its in-TUI level is not known');

      adapter['applyStoredEffortOnSpawn'](noPrefKey);
      adapter['consumePendingEffortReapply'](session);
      assert.deepEqual(adapter.getEffortState(noPrefKey), { running: 'low', nextStart: 'low' }, 'the spawn typed the default');

      setInstanceDefaultEffortReader(() => 'max');
      assert.deepEqual(adapter.getEffortState(noPrefKey), { running: 'low', nextStart: 'max' }, 'a default change never reaches the running TUI');
    });

    it('getEffortState follows every level the bot types: a pick, «as in General», a model switch with no pick', async () => {
      setInstanceDefaultEffortReader(() => 'low');
      ({ adapter, typed, session } = createAdapterWithSession(noPrefKey));
      await adapter.setEffort(noPrefKey, 'max');
      assert.deepEqual(adapter.getEffortState(noPrefKey), { running: 'max', nextStart: 'max' });
      await adapter.clearEffort(noPrefKey);
      assert.deepEqual(adapter.getEffortState(noPrefKey), { running: 'low', nextStart: 'low' });
      setInstanceDefaultEffortReader(() => 'high');
      await adapter.setModel(noPrefKey, 'sonnet');
      assert.deepEqual(adapter.getEffortState(noPrefKey), { running: 'high', nextStart: 'high' }, 'a model switch re-applies the default and the display follows');
    });
  });
});
