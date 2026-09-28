/**
 * @description How the json-stream adapter WAITS for a bot-issued `/compact` to
 * confirm, and how that wait ends.
 *
 * ROOT-CAUSE CONTEXT. The wait used to be a flat 3-minute cap on total elapsed
 * time. A real compaction measured at 3 min 15.6 s therefore "failed" while the
 * CLI was succeeding, the bot posted no notice, and the operator saw a session
 * that compacted itself in silence. The cap is now the SILENCE between stdout
 * frames (the CLI heartbeats `status:"compacting"` throughout), with an absolute
 * backstop only for a CLI that never finishes at all.
 *
 * Load-bearing intent (per `.claude/rules/tests.md`):
 *   - a teardown while a compaction is parked must SETTLE it, so the caller can
 *     never hang on a session whose process is already gone (before this, the
 *     only thing that freed it was the timeout it was waiting on);
 *   - the wait's watchdog must be a repeating interval that is CLEARED on every
 *     resolve path — a leaked interval would keep probing a dead session;
 *   - the silence clock must be fed by CONSUMED STDOUT, not by classified events:
 *     a compacting CLI emits only `status:"compacting"` frames, which classify to
 *     nothing, so an action-fed clock would read a healthy compaction as dead;
 *   - the outcome of a real confirmation still wins: the boundary frame resolves
 *     the wait with its token counts — and those counts must REACH the caller in
 *     the resolved `CompactionResult`, because the bot's completion message
 *     ("314150 → 12883 tokens") is rendered from them;
 *   - a wait that times out after `compact_status success` reports SUCCESS with
 *     unknown (`null`) counts, never a failure over an already-compacted session.
 *
 * The adapter's private session map is reached via runtime bracket access (tests
 * are type-stripped by tsx), same pattern as `claudeJsonStreamMcpHeal`. Stdin is
 * a plain file rather than a FIFO, so no `claude` process is involved.
 *
 * Test case: N/A — TelegramCode has no Jira tracker.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ClaudeJsonStreamAdapter } from '../adapters/claudeJsonStreamAdapter';
import { ClaudeStreamLineReader } from '../utils/claudeStreamJson';
import { createStdoutTailState, getJsonStreamSessionPaths } from '../utils/jsonStreamHost';
import { compactionSilenceTimeoutMs, compactionWaitPollMs } from '../utils/jsonStreamBusyWatchdog';
import { keyToString, type CompactionResult, type ThreadKey } from '../types';

// A key no live thread uses — every path derived from it is a no-op.
const key: ThreadKey = { chatId: -100999778, threadId: 78 };

/** A fake LIVE session whose stdin is an ordinary append-mode file. */
function createSession(adapter: ClaudeJsonStreamAdapter, dir: string) {
  const paths = getJsonStreamSessionPaths(dir);
  fs.writeFileSync(paths.stdinFifo, '');
  const session = {
    key,
    workDir: dir,
    sessionId: 'sess-compaction-wait',
    pid: process.pid,
    paths,
    fifoFd: fs.openSync(paths.stdinFifo, 'a'),
    stdinWriteChain: Promise.resolve(),
    tail: createStdoutTailState(0),
    pollTimer: null,
    pollDelayMs: 300,
    unchangedStreak: 0,
    isOversizeWarned: false,
    lastPersistedTailOffset: 0,
    reader: new ClaudeStreamLineReader(),
    isActive: true,
    isStopping: false,
    isRespawning: false,
    isBusy: false,
    lastStdoutActivityAt: Date.now(),
    outstandingToolUseIds: new Set<string>(),
    model: null,
    reportedModel: null,
    effort: null,
    currentResponseText: '',
    emittedLength: 0,
    outputTimer: null,
    reasoningText: '',
    reasoningStartedAt: null,
    reasoningTimer: null,
    reasoningActive: false,
    toolNamesById: new Map(),
    questionToolUseIds: new Set(),
    subagentActive: false,
    childResponseText: '',
    childEmittedLength: 0,
    childOutputTimer: null,
    pendingInitResolve: null as (() => void) | null,
    initRequestId: null as string | null,
    pendingControlRequests: new Map(),
    compactionInProgress: false,
    pendingCompaction: null,
    pendingQuestion: null,
    apiErrorFired: false,
    swallowNextAbortError: false,
    lastWatermarkOffset: -1,
  };
  adapter['sessions'].set(keyToString(key), session);
  return session;
}

/** Let queued microtasks/timers run so a settled promise records its result. */
async function settleTicks(): Promise<void> {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('json-stream compaction wait', () => {
  const dirs: string[] = [];
  const started: Array<{ adapter: ClaudeJsonStreamAdapter; session: { fifoFd: number } }> = [];

  function createTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-compaction-wait-'));
    dirs.push(dir);
    return dir;
  }

  function start(): { adapter: ClaudeJsonStreamAdapter; session: ReturnType<typeof createSession> } {
    const adapter = new ClaudeJsonStreamAdapter();
    const session = createSession(adapter, createTempDir());
    started.push({ adapter, session });
    return { adapter, session };
  }

  // `writeStdin` arms the tail poll, so a session left in the map keeps the event
  // loop alive and the whole FILE times out even with every case green.
  afterEach(() => {
    for (const { adapter, session } of started.splice(0)) {
      const live = adapter['sessions'].get(keyToString(key));
      if (live) adapter['clearTimers'](live);
      adapter['sessions'].delete(keyToString(key));
      try { fs.closeSync(session.fifoFd); } catch { /* already closed */ }
    }
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a teardown while the compaction is parked settles the caller instead of hanging it', async () => {
    // THE regression this guards: the wait's only escape used to be its own
    // timeout, so a session that stopped/respawned mid-compaction left the caller
    // parked for minutes on a process that no longer existed.
    const { adapter, session } = start();

    let settled: CompactionResult | undefined;
    const pending = adapter.compactContext(key).then((result) => { settled = result; });
    await settleTicks();
    assert.equal(settled, undefined, 'the wait is still parked while the session lives');
    assert.ok(session.pendingCompaction, 'a compaction awaiter is armed');

    adapter['clearTimers'](session);
    await pending;
    assert.ok(settled && !settled.ok, 'the caller was settled by the teardown, as a FAILURE');
    const reason = settled.ok ? '' : settled.error;
    assert.match(reason, /session ended/, `unexpected reason: ${reason}`);
    assert.ok(!reason.includes('{'), `the notice must be fully substituted: "${reason}"`);
    assert.equal(session.pendingCompaction, null, 'the awaiter was dropped');
  });

  it('the wait arms a repeating watchdog and clears it when the compaction confirms', async () => {
    // A leaked interval would keep probing a session that is already done with
    // its compaction, so the clear is part of the contract, not housekeeping.
    const { adapter, session } = start();

    let settled: CompactionResult | undefined;
    const pending = adapter.compactContext(key).then((result) => { settled = result; });
    await settleTicks();
    // Node stores an interval's PERIOD in `_repeat` and leaves it `null` for a
    // one-shot `setTimeout` — so the VALUE is the discriminating check. Merely
    // asserting the property EXISTS would pass against the old one-shot too
    // (both timer kinds own a `_repeat`), i.e. prove nothing.
    const armed = session.pendingCompaction as { timer: (NodeJS.Timeout & { _repeat?: number | null }) | null } | null;
    assert.ok(armed?.timer, 'a watchdog timer is armed for the wait');
    assert.equal(
      armed?.timer?._repeat,
      compactionWaitPollMs,
      'the watchdog must REPEAT every compactionWaitPollMs: a one-shot fires once, reads '
        + '"keepWaiting", and then nothing ever settles the wait',
    );

    // The real confirmation: the boundary frame carrying the token counts.
    adapter['handleCompactBoundary'](session, { kind: 'compactBoundary', trigger: 'manual', preTokens: 314150, postTokens: 12883 });
    await pending;
    // The counts are the POINT of the typed result: the bot's completion message
    // reports "314150 → 12883 tokens" from them. Asserting only `ok: true` would
    // pass against an adapter that resolved success and threw the numbers away —
    // which is exactly what the old `string | null` signature forced it to do.
    assert.deepEqual(
      settled,
      { ok: true, preTokens: 314150, postTokens: 12883 },
      'a confirmed compaction reports success WITH the boundary frame\'s token counts',
    );
    assert.equal(session.pendingCompaction, null, 'the awaiter and its watchdog were cleared');
  });

  it('a wait that times out AFTER compact_status success reports success with unknown counts', async () => {
    // `getCompactionTimeoutOutcome`'s `succeededWithoutTokenCounts` path, seen from
    // the caller: the CLI confirmed the compaction and only the boundary frame
    // (which carries the numbers) never arrived. Reporting a FAILURE here would
    // suppress the bot's notice over an already-compacted session — the very
    // silence this feature removes — so the counts must degrade to `null` while
    // the outcome stays `ok`.
    const { adapter, session } = start();

    let settled: CompactionResult | undefined;
    const pending = adapter.compactContext(key).then((result) => { settled = result; });
    await settleTicks();

    // The CLI said it worked, then went quiet past the silence bound.
    adapter['handleCompactStatus'](session, { kind: 'compactStatus', result: 'success' });
    assert.equal(session.pendingCompaction?.sawSuccess, true, 'the success was recorded');
    assert.equal(settled, undefined, 'a success status alone does not settle the wait');
    session.lastStdoutActivityAt = Date.now() - compactionSilenceTimeoutMs - 1_000;

    // Let the repeating watchdog tick past the silence bound.
    await new Promise((resolve) => setTimeout(resolve, compactionWaitPollMs + 50));
    await pending;
    assert.deepEqual(
      settled,
      { ok: true, preTokens: null, postTokens: null },
      'compacted, counts unknown — never a failure, and never a fabricated 0',
    );
  });

  it('a compacting heartbeat the classifier DROPS still feeds the silence clock', async () => {
    // The premise the whole bound rests on. While it compacts the CLI emits
    // `system/status status:"compacting"` frames, which classify to NO action at
    // all. If the clock were fed from classified actions instead of from raw
    // consumed stdout, that run would read as silence and a long compaction would
    // still be declared dead — the bug this change fixes, reintroduced.
    const { adapter, session } = start();
    const pending = adapter.compactContext(key);
    await settleTicks();

    const staleAt = Date.now() - compactionSilenceTimeoutMs - 1_000;
    session.lastStdoutActivityAt = staleAt;
    fs.appendFileSync(
      session.paths.stdoutFile,
      JSON.stringify({ type: 'system', subtype: 'status', status: 'compacting' }) + '\n',
    );
    assert.equal(adapter['drainStdoutTail'](session), true, 'the heartbeat frame was consumed');
    assert.ok(
      session.lastStdoutActivityAt > staleAt
        && Date.now() - session.lastStdoutActivityAt < compactionSilenceTimeoutMs,
      'an ignored frame still proves the process is alive, so the wait keeps waiting',
    );

    // Settle the wait so the case leaves nothing parked.
    adapter['handleCompactBoundary'](session, { kind: 'compactBoundary', trigger: 'manual', preTokens: 314150, postTokens: 12883 });
    assert.deepEqual(await pending, { ok: true, preTokens: 314150, postTokens: 12883 });
  });
});
