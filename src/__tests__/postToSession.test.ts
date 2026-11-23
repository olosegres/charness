/**
 * @description `postToSession` (Jira plan J5, D21): a session is ensured — the
 * ensure itself resumes a conversation's sleeping session (a Jira issue keeps
 * one for good, D5; a topic's sleeps after the idle stop, L-D4) — then the
 * prompt is forwarded; a usage-limit wait holds the prompt before either (R23).
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { postToSession, type PostToSessionDeps, type SessionPromptText } from '../postToSession';

function createDeps(calls: string[], overrides: Partial<PostToSessionDeps> = {}): PostToSessionDeps {
  return {
    checkBusy: () => false,
    ensureSession: async (conversationKey, fallbackAdapterName) => {
      calls.push(`ensure ${conversationKey} ${fallbackAdapterName ?? '-'}`);
      return { ok: true, isFresh: false };
    },
    forwardPrompt: async (conversationKey, text) => {
      calls.push(`forward ${conversationKey} ${text}`);
    },
    now: () => 0,
    sleep: async () => {},
    ...overrides,
  };
}

describe('postToSession', () => {
  it('ensures a session (with the caller\'s fallback adapter), then forwards — one session step, no separate resume', async () => {
    const calls: string[] = [];
    assert.deepEqual(await postToSession(createDeps(calls), 'jira:PROJ:PROJ-1', 'the prompt', 'claude-json-stream'), { ok: true, isHeld: false });
    assert.deepEqual(calls, ['ensure jira:PROJ:PROJ-1 claude-json-stream', 'forward jira:PROJ:PROJ-1 the prompt']);
    const bare: string[] = [];
    assert.deepEqual(await postToSession(createDeps(bare), 'k', 'p'), { ok: true, isHeld: false });
    assert.deepEqual(bare, ['ensure k -', 'forward k p']);
  });

  it('the engine settles the watches whose turn ended right before the text is built — after the wait for a busy turn — so the pick and the header see what the settle decided, and the new turn never runs under the old watch (review 14 #1)', async () => {
    const calls: string[] = [];
    let isBusy = true;
    const prompt: SessionPromptText = {
      fullText: 'full',
      buildText: () => {
        calls.push('build');
        return 'built';
      },
    };
    const deps = createDeps(calls, {
      checkBusy: () => isBusy,
      sleep: async () => { isBusy = false; },
      settleEndedTurns: async (conversationKey) => {
        calls.push(`settle ${conversationKey}`);
        return async () => { calls.push('deliver the settled wakes'); };
      },
    });
    assert.deepEqual(await postToSession(deps, 'k', prompt), { ok: true, isHeld: false });
    // The settle's reminders come AFTER the waited prompt: that prompt starts the turn (review 15 #2).
    assert.deepEqual(calls, ['ensure k -', 'settle k', 'ensure k -', 'build', 'forward k built', 'deliver the settled wakes']);

    const idle: string[] = [];
    await postToSession(createDeps(idle, { settleEndedTurns: async () => { idle.push('settle'); return async () => { idle.push('deliver'); }; } }), 'k', 'p');
    assert.deepEqual(idle, ['ensure k -', 'settle', 'forward k p', 'deliver'], 'an idle session too: a turn may have ended seconds before');
  });

  it('the settled wakes are delivered on every way out after the settle — a hold, a failed ensure, a forward that throws: a decision already persisted is never left undelivered', async () => {
    const outcomes: string[] = [];
    const withSettle = (overrides: Partial<PostToSessionDeps>): PostToSessionDeps => createDeps(outcomes, {
      settleEndedTurns: async () => async () => { outcomes.push('deliver'); },
      ...overrides,
    });
    let holds = 0;
    await postToSession(withSettle({ holdForLimitResume: () => { holds += 1; return holds > 1; } }), 'k', 'p');
    assert.deepEqual(outcomes.at(-1), 'deliver', 'held after the settle');
    outcomes.length = 0;
    await postToSession(withSettle({ forwardPrompt: async () => { throw new Error('write failed'); } }), 'k', 'p');
    assert.deepEqual(outcomes.at(-1), 'deliver', 'a forward that failed');
  });

  it('the post is IN FLIGHT from its first step to its last: a reminder decided meanwhile waits for its write, the caller\'s `afterForward` (it watches the turn the write started) runs before the settled reminders, and the release comes after everything (review 16 #2)', async () => {
    const calls: string[] = [];
    let isBusy = true;
    const deps = createDeps(calls, {
      checkBusy: () => isBusy,
      sleep: async () => { isBusy = false; },
      notePostInFlight: (conversationKey) => {
        calls.push(`in flight ${conversationKey}`);
        return async () => { calls.push('release'); };
      },
      settleEndedTurns: async () => {
        calls.push('settle');
        return async () => { calls.push('deliver the settled and handed-over wakes'); };
      },
    });
    const afterForward = async (): Promise<void> => { calls.push('watch the post\'s turn'); };
    assert.deepEqual(await postToSession(deps, 'k', 'p', undefined, { afterForward }), { ok: true, isHeld: false });
    assert.deepEqual(calls, ['in flight k', 'ensure k -', 'settle', 'ensure k -', 'forward k p', 'watch the post\'s turn', 'deliver the settled and handed-over wakes', 'release']);
  });

  it('`afterForward` runs only for a prompt that was written — never for a hold or a failed forward — and every way out releases the post (review 16 #2)', async () => {
    const calls: string[] = [];
    const withPorts = (overrides: Partial<PostToSessionDeps>): PostToSessionDeps => createDeps(calls, {
      notePostInFlight: () => async () => { calls.push('release'); },
      ...overrides,
    });
    const afterForward = async (): Promise<void> => { calls.push('afterForward'); };
    await postToSession(withPorts({ holdForLimitResume: () => true }), 'k', 'p', undefined, { afterForward });
    await postToSession(withPorts({ ensureSession: async () => ({ ok: false, reason: 'start-failed' }) }), 'k', 'p', undefined, { afterForward });
    await postToSession(withPorts({ forwardPrompt: async () => { throw new Error('write failed'); } }), 'k', 'p', undefined, { afterForward });
    assert.deepEqual(calls.filter((call) => call === 'release' || call === 'afterForward'), ['release', 'release', 'release'], 'released three times, never past a write that did not happen');
    const thrown: string[] = [];
    const failingWatch = async (): Promise<void> => { throw new Error('the watch could not be stored'); };
    await assert.rejects(postToSession(createDeps(thrown, { notePostInFlight: () => async () => { thrown.push('release'); } }), 'k', 'p', undefined, { afterForward: failingWatch }), /could not be stored/);
    assert.deepEqual(thrown.at(-1), 'release', 'a failing `afterForward` is the post\'s error, and the post is still released');
  });

  it('a session that cannot be ensured is never forwarded to', async () => {
    const calls: string[] = [];
    const deps = createDeps(calls, { ensureSession: async () => ({ ok: false, reason: 'start-failed' }) });
    assert.deepEqual(await postToSession(deps, 'k', 'p'), { ok: false, reason: 'start-failed' });
    assert.deepEqual(calls, []);
  });

  it('R23: during an armed usage-limit wait the prompt is held — no session resumed or started, nothing forwarded', async () => {
    const calls: string[] = [];
    const deps = createDeps(calls, {
      holdForLimitResume: (conversationKey, text) => {
        calls.push(`hold ${conversationKey} ${text}`);
        return true;
      },
    });
    assert.deepEqual(await postToSession(deps, 'k', 'p', 'claude-json-stream'), { ok: true, isHeld: true });
    assert.deepEqual(calls, ['hold k p']);
  });

  it('R23: a wait armed while the post waited for the busy turn holds the prompt — it is not forwarded into the limit', async () => {
    const calls: string[] = [];
    let isBusy = true;
    let isLimitWaitArmed = false;
    const deps = createDeps(calls, {
      checkBusy: () => isBusy,
      sleep: async () => {
        // The running turn hits the usage limit: the wait is armed and the turn goes idle.
        isLimitWaitArmed = true;
        isBusy = false;
      },
      holdForLimitResume: () => {
        calls.push(`hold? ${isLimitWaitArmed}`);
        return isLimitWaitArmed;
      },
    });
    assert.deepEqual(await postToSession(deps, 'k', 'p'), { ok: true, isHeld: true });
    assert.deepEqual(calls, ['hold? false', 'ensure k -', 'hold? true']);
  });

  it('R27: a hold gets the run as posted at once AND what it says when late; a forward only the former', async () => {
    const calls: string[] = [];
    let isLimitWaitArmed = true;
    const deps = createDeps(calls, {
      holdForLimitResume: (_conversationKey, text, heldText) => {
        calls.push(`hold? ${text} | ${heldText ?? '-'}`);
        return isLimitWaitArmed;
      },
    });
    assert.deepEqual(await postToSession(deps, 'k', 'p', undefined, { heldText: 'p, was due at 09:00' }), { ok: true, isHeld: true });
    isLimitWaitArmed = false;
    assert.deepEqual(await postToSession(deps, 'k', 'p', undefined, { heldText: 'p, was due at 09:05' }), { ok: true, isHeld: false });
    assert.deepEqual(calls, [
      'hold? p | p, was due at 09:00',
      'hold? p | p, was due at 09:05',
      'ensure k -',
      'hold? p | p, was due at 09:05',
      'forward k p',
    ]);
  });

  it('R23: no wait armed — the post goes on as usual', async () => {
    const calls: string[] = [];
    const deps = createDeps(calls, { holdForLimitResume: () => false });
    assert.deepEqual(await postToSession(deps, 'k', 'p'), { ok: true, isHeld: false });
    assert.deepEqual(calls, ['ensure k -', 'forward k p']);
  });

  it('a forward that rejects — the agent never got the prompt (a stdin write that failed) — is `forward-failed` with its message, never a delivered post', async () => {
    const calls: string[] = [];
    const deps = createDeps(calls, {
      forwardPrompt: async () => {
        throw new Error('EAGAIN: the reader took nothing for 120 s (0 of 9 bytes written)');
      },
    });
    assert.deepEqual(await postToSession(deps, 'k', 'p'), {
      ok: false,
      reason: 'forward-failed',
      error: 'EAGAIN: the reader took nothing for 120 s (0 of 9 bytes written)',
    });
  });

  describe('a session that changed while the post waited for the busy turn', () => {
    it('is ensured again before the forward: the per-turn stop that follows the turn ended its process, and a forward now would be dropped', async () => {
      const calls: string[] = [];
      let isBusy = true;
      let isProcessAlive = true;
      const deps = createDeps(calls, {
        checkBusy: () => isBusy,
        // The wait ends with the turn; the per-turn stop has put the session to sleep by the time it looks again.
        sleep: async () => {
          isBusy = false;
          isProcessAlive = false;
        },
        ensureSession: async (conversationKey) => {
          calls.push(`ensure ${conversationKey} (process alive: ${isProcessAlive})`);
          isProcessAlive = true;
          return { ok: true, isFresh: false };
        },
        forwardPrompt: async (conversationKey, text) => {
          calls.push(`forward ${conversationKey} ${text} (process alive: ${isProcessAlive})`);
        },
      });
      assert.deepEqual(await postToSession(deps, 'k', 'p'), { ok: true, isHeld: false });
      assert.deepEqual(calls, ['ensure k (process alive: true)', 'ensure k (process alive: false)', 'forward k p (process alive: true)']);
    });

    it('a post that did not wait ensures once', async () => {
      const calls: string[] = [];
      assert.deepEqual(await postToSession(createDeps(calls), 'k', 'p'), { ok: true, isHeld: false });
      assert.deepEqual(calls, ['ensure k -', 'forward k p']);
    });

    it('a session the second ensure had to start fresh counts as fresh: the builder is told, though the first ensure found it live', async () => {
      const calls: string[] = [];
      let isBusy = true;
      let ensureCount = 0;
      const deps = createDeps(calls, {
        checkBusy: () => isBusy,
        sleep: async () => { isBusy = false; },
        ensureSession: async () => {
          ensureCount += 1;
          return { ok: true, isFresh: ensureCount === 2 };
        },
      });
      const prompt: SessionPromptText = {
        fullText: 'the whole issue',
        buildText: ({ isFresh }) => {
          calls.push(`build isFresh=${isFresh}`);
          return isFresh ? 'the whole issue' : 'only what changed';
        },
      };
      await postToSession(deps, 'k', prompt);
      assert.deepEqual(calls, ['build isFresh=true', 'forward k the whole issue']);
    });

    it('a session that cannot be ensured again is never forwarded to; the reason is the second ensure\'s', async () => {
      const calls: string[] = [];
      let isBusy = true;
      let ensureCount = 0;
      const deps = createDeps(calls, {
        checkBusy: () => isBusy,
        sleep: async () => { isBusy = false; },
        ensureSession: async () => {
          ensureCount += 1;
          return ensureCount === 1 ? { ok: true, isFresh: false } : { ok: false, reason: 'start-failed' };
        },
      });
      assert.deepEqual(await postToSession(deps, 'k', 'p'), { ok: false, reason: 'start-failed' });
      assert.deepEqual(calls, []);
    });
  });

  describe('a prompt built for the session it lands in (Jira prompt context C5)', () => {
    /** A prompt whose builder records when it ran and what it was told. */
    function createSessionPrompt(calls: string[]): SessionPromptText {
      return {
        fullText: 'the whole issue',
        buildText: ({ isFresh }) => {
          calls.push(`build isFresh=${isFresh}`);
          return isFresh ? 'the whole issue' : 'only what changed';
        },
      };
    }

    it('is built after the ensure, the wait for the busy turn, the second hold check and the ensure that follows the wait — right before the forward', async () => {
      const calls: string[] = [];
      let busyChecks = 0;
      const deps = createDeps(calls, {
        checkBusy: () => {
          busyChecks += 1;
          calls.push(`busy? ${busyChecks <= 2}`);
          return busyChecks <= 2;
        },
        holdForLimitResume: (_conversationKey, text) => {
          calls.push(`hold? ${text}`);
          return false;
        },
      });
      assert.deepEqual(await postToSession(deps, 'k', createSessionPrompt(calls)), { ok: true, isHeld: false });
      assert.deepEqual(calls, [
        'hold? the whole issue',
        'ensure k -',
        'busy? true',
        'busy? true',
        'busy? false',
        'hold? the whole issue',
        'ensure k -',
        'build isFresh=false',
        'forward k only what changed',
      ]);
    });

    it('a session the ensure started is fresh: the builder is told so', async () => {
      const calls: string[] = [];
      const deps = createDeps(calls, { ensureSession: async () => ({ ok: true, isFresh: true }) });
      await postToSession(deps, 'k', createSessionPrompt(calls));
      assert.deepEqual(calls, ['build isFresh=true', 'forward k the whole issue']);
    });

    it('a hold keeps the full text and builds nothing — before the ensure, and after the wait', async () => {
      for (const holdAtCheck of [1, 2]) {
        const calls: string[] = [];
        let holdChecks = 0;
        const deps = createDeps(calls, {
          holdForLimitResume: (_conversationKey, text) => {
            holdChecks += 1;
            calls.push(`hold? ${text}`);
            return holdChecks === holdAtCheck;
          },
        });
        assert.deepEqual(await postToSession(deps, 'k', createSessionPrompt(calls)), { ok: true, isHeld: true });
        assert.ok(!calls.some((call) => call.startsWith('build') || call.startsWith('forward')), calls.join(' | '));
        assert.ok(calls.every((call) => !call.startsWith('hold?') || call === 'hold? the whole issue'));
      }
    });

    it('a session that cannot be ensured builds nothing', async () => {
      const calls: string[] = [];
      const deps = createDeps(calls, { ensureSession: async () => ({ ok: false, reason: 'start-failed' }) });
      await postToSession(deps, 'k', createSessionPrompt(calls));
      assert.deepEqual(calls, []);
    });
  });
});
