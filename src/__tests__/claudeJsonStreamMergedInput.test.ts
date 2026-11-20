/**
 * @description Input the bot wrote while a turn ran must stop counting as "not taken in" once the CLI took it in — also
 * when the CLI took several messages in at ONCE.
 *
 * Live incident (a topic's idle compaction never ran, the process was kept "working" for hours): the owner sent several
 * voice notes while the agent worked. Measured on the real CLI 2.1.329 (`-p`, stream-json, `--replay-user-messages`): messages
 * written while a turn runs and still queued when it ends are drained as ONE turn, and that turn's single echo carries
 * their texts joined by a newline — four writes, two echoes. The adapter counted writes minus echoes, so two stayed
 * "unconsumed" for good and `checkIsWorking` never went false.
 *
 * Load-bearing intent:
 *   - an echo that carries several queued messages takes all of them in; one that carries one takes one;
 *   - a user line that is not an echo of anything written (the CLI's own `[Request interrupted…]` marker) takes nothing in;
 *   - input the CLI never echoes holds a turn-less process only briefly (`unconsumedInputGraceMs`) — never for good — and
 *     a running turn still holds it as before;
 *   - the failed-turn reconciliation stays: an error `result` forgets the queue;
 *   - an echo nothing here can match (a "phantom": the CLI changed the text, an array-shaped content) is a message the turn that
 *     echoed it took in: it is dropped at that turn's end, so the two readers that decide AT a turn end (the claude-per-turn stop,
 *     a deferred account switch) are not held off by it for good. A turn that carried no echo of ours (a finished task's
 *     notification, run by the CLI ahead of a queued message) took nothing in and drops nothing: the message behind it stays
 *     counted until its own echo, or its grace is out.
 *
 * Frames are the shapes of that measurement. The FIFO write is the adapter's test seam; no `claude` process is involved.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeJsonStreamAdapter, type StreamSession } from '../adapters/claudeJsonStreamAdapter';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { busyIdleWatchdogMs, compactionAbsoluteTimeoutMs } from '../utils/jsonStreamBusyWatchdog';
import { unconsumedInputGraceMs } from '../utils/jsonStreamPendingWork';
import { createStreamSessionFixture } from './claudeJsonStreamSessionFixture';

const key: SessionKey = makeTelegramKey(-100999333, 79);

const echoFrame = (text: string): string => JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, isReplay: true }) + '\n';
/** The CLI's own marker after an interrupt: a user line with array content, no `isReplay`, nothing of ours. */
const interruptMarkerFrame = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, parent_tool_use_id: null }) + '\n';
const resultFrame = (isError = false): string => JSON.stringify({ type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError, result: isError ? '' : 'done' }) + '\n';
const initFrame = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-merged', model: 'fake-model' }) + '\n';
const idleStateFrame = JSON.stringify({ type: 'system', subtype: 'session_state_changed', state: 'idle' }) + '\n';
/** `session_state_changed`: `running` opens a turn, and comes back in the MIDDLE of one after a permission or a question (`requires_action` → `running`). */
const stateFrame = (state: 'running' | 'requires_action'): string => JSON.stringify({ type: 'system', subtype: 'session_state_changed', state }) + '\n';

let nowMs = 0;
const created: Array<{ adapter: ClaudeJsonStreamAdapter; session: StreamSession }> = [];

function createAdapter(): { adapter: ClaudeJsonStreamAdapter; session: StreamSession } {
  const adapter = new ClaudeJsonStreamAdapter({ lifecycle: 'idle', writeFifo: async () => {} });
  const session = createStreamSessionFixture({ key, pid: process.pid, sessionId: 'sess-merged', lastTurnEndedAt: nowMs });
  adapter['sessions'].set(keyToString(key), session);
  created.push({ adapter, session });
  return { adapter, session };
}

beforeEach(() => {
  nowMs = 1_000_000;
  mock.method(Date, 'now', () => nowMs);
});

afterEach(() => {
  for (const { adapter, session } of created.splice(0)) adapter['clearTimers'](session);
  mock.restoreAll();
});

describe('json-stream adapter — what the CLI took in is no longer "unconsumed"', () => {
  it('REGRESSION: three messages written mid-turn and drained as one echoed turn leave nothing unconsumed (4 writes, 2 echoes on the real CLI)', async () => {
    const { adapter, session } = createAdapter();
    await adapter.sendInputAndWait(key, 'Write a numbered list of 40 short facts about the ocean, one per line, no tools.');
    adapter['onStdout'](session, echoFrame('Write a numbered list of 40 short facts about the ocean, one per line, no tools.'));
    // Three messages while that turn streams: nothing to take them in at, so they wait for the turn to end.
    await adapter.sendInputAndWait(key, 'TEXTONLY-A: then reply with the word AAA');
    await adapter.sendInputAndWait(key, 'TEXTONLY-B: and the word BBB');
    await adapter.sendInputAndWait(key, 'TEXTONLY-C: and the word CCC');
    assert.equal(adapter.checkHasUnconsumedInput(key), true, 'precondition: the three are queued');

    adapter['onStdout'](session, resultFrame() + initFrame);
    assert.equal(adapter.checkHasUnconsumedInput(key), true, 'between the turn end and the echo they are on their way');
    adapter['onStdout'](session, echoFrame('TEXTONLY-A: then reply with the word AAA\nTEXTONLY-B: and the word BBB\nTEXTONLY-C: and the word CCC'));
    adapter['onStdout'](session, resultFrame() + idleStateFrame);

    assert.equal(adapter.checkHasUnconsumedInput(key), false, 'the one echo took all three in');
    assert.equal(adapter.checkIsWorking(key), false, 'nothing holds the process: the idle fire may compact and stop it');
  });

  it('a merged echo keeps its whitespace: leading spaces, blank lines and trailing spaces of the texts are matched as written', async () => {
    const { adapter, session } = createAdapter();
    await adapter.sendInputAndWait(key, '  A leading spaces\n\nsecond paragraph\n\n');
    await adapter.sendInputAndWait(key, 'B привет "quotes" \\ backslash\n```code\nx\n```');
    await adapter.sendInputAndWait(key, 'C trailing spaces   ');
    adapter['onStdout'](session, echoFrame('  A leading spaces\n\nsecond paragraph\n\n\nB привет "quotes" \\ backslash\n```code\nx\n```\nC trailing spaces   '));
    assert.equal(adapter.checkHasUnconsumedInput(key), false);
  });

  it('messages the CLI takes in one by one (at a tool boundary) are each taken in by their own echo', async () => {
    const { adapter, session } = createAdapter();
    await adapter.sendInputAndWait(key, 'MIDTURN-A');
    await adapter.sendInputAndWait(key, 'MIDTURN-B');
    await adapter.sendInputAndWait(key, 'MIDTURN-C');
    adapter['onStdout'](session, echoFrame('MIDTURN-A'));
    assert.equal(session.unconsumedInputs.length, 2);
    adapter['onStdout'](session, echoFrame('MIDTURN-B'));
    adapter['onStdout'](session, echoFrame('MIDTURN-C'));
    assert.equal(session.unconsumedInputs.length, 0);
  });

  it('an echo of the first two leaves the third unconsumed: only what the echo carries is taken in', async () => {
    const { adapter, session } = createAdapter();
    await adapter.sendInputAndWait(key, 'ONE');
    await adapter.sendInputAndWait(key, 'TWO');
    await adapter.sendInputAndWait(key, 'THREE');
    adapter['onStdout'](session, echoFrame('ONE\nTWO'));
    assert.deepEqual(session.unconsumedInputs.map((pending) => pending.text), ['THREE']);
  });

  it('the CLI\'s own interrupt marker is not an echo: it takes nothing in', async () => {
    const { adapter, session } = createAdapter();
    await adapter.sendInputAndWait(key, 'QUEUED-A');
    adapter['onStdout'](session, interruptMarkerFrame);
    assert.deepEqual(session.unconsumedInputs.map((pending) => pending.text), ['QUEUED-A']);
  });

  it('an error result forgets the queue (a limit may never echo it): kept from the earlier reconciliation', async () => {
    const { adapter, session } = createAdapter();
    await adapter.sendInputAndWait(key, 'QUEUED-A');
    await adapter.sendInputAndWait(key, 'QUEUED-B');
    adapter['onStdout'](session, resultFrame(true));
    assert.equal(session.unconsumedInputs.length, 0);
  });
});

describe('json-stream adapter — input nobody echoes never holds a turn-less process for good', () => {
  it('a message the CLI never echoes holds the process for the grace after its write, then no more', async () => {
    const { adapter, session } = createAdapter();
    await adapter.sendInputAndWait(key, 'a message the CLI drops');
    session.isBusy = false; // the CLI showed no turn for it
    assert.equal(adapter.checkIsWorking(key), true, 'inside the grace it may still be on its way');
    nowMs += unconsumedInputGraceMs - 1;
    assert.equal(adapter.checkIsWorking(key), true);
    nowMs += 1;
    assert.equal(adapter.checkIsWorking(key), false, 'past the grace with no turn it is stale');
    assert.equal(adapter.checkHasUnconsumedInput(key), false, 'every reader of the input count sees the bound, not only the idle fire');
  });

  it('a running turn still holds it however long the input waits: the turn takes it in or ends', async () => {
    const { adapter, session } = createAdapter();
    await adapter.sendInputAndWait(key, 'a message queued behind a long turn');
    session.isBusy = true;
    nowMs += 10 * unconsumedInputGraceMs;
    assert.equal(adapter.checkHasUnconsumedInput(key), true);
  });

  it('a turn end restarts the grace: the queued message gets time to start its own turn', async () => {
    const { adapter, session } = createAdapter();
    await adapter.sendInputAndWait(key, 'queued behind a long turn');
    nowMs += 10 * unconsumedInputGraceMs;
    adapter['onStdout'](session, resultFrame());
    assert.equal(session.isBusy, false);
    assert.equal(adapter.checkIsWorking(key), true, 'the next turn is on its way (it starts within a second on the real CLI)');
    nowMs += unconsumedInputGraceMs;
    assert.equal(adapter.checkIsWorking(key), false, 'and when it never starts, the hold ends');
  });

  it('a new write drops what went stale before it: the old phantom does not come back to life with the new message', async () => {
    const { adapter, session } = createAdapter();
    await adapter.sendInputAndWait(key, 'phantom');
    session.isBusy = false;
    nowMs += unconsumedInputGraceMs;
    await adapter.sendInputAndWait(key, 'fresh');
    assert.deepEqual(session.unconsumedInputs.map((pending) => pending.text), ['fresh']);
  });
});

/** What the readers that decide at a turn end see: `checkIsWorking` in the tick of `turnEnded` (the claude-per-turn stop reads it so). */
function recordWorkingAtTurnEnds(adapter: ClaudeJsonStreamAdapter): boolean[] {
  const workingAtTurnEnds: boolean[] = [];
  adapter.on('turnEnded', () => { workingAtTurnEnds.push(adapter.checkIsWorking(key)); });
  return workingAtTurnEnds;
}

describe('json-stream adapter — the turn-end readers are neither held for good by an echo nothing can match nor released over a real queued message (review)', () => {
  const unrecognisedEchoFrame = echoFrame('the message, as the CLI echoes it after changing its text');

  it('the claude-per-turn stop: a message whose echo nothing can match is dropped at the end of the turn that carried that echo', async () => {
    const { adapter, session } = createAdapter();
    const workingAtTurnEnds = recordWorkingAtTurnEnds(adapter);
    await adapter.sendInputAndWait(key, 'the message as the bot wrote it');
    adapter['onStdout'](session, unrecognisedEchoFrame);
    adapter['onStdout'](session, resultFrame());
    assert.deepEqual(workingAtTurnEnds, [false], 'the turn took the message in, in a shape no one can match: nothing is queued, the stop is not held off');
    assert.deepEqual(session.unconsumedInputs, []);
  });

  it('a deferred account switch fires at that turn end', async () => {
    const { adapter, session } = createAdapter();
    const respawns: Array<string | null | undefined> = [];
    adapter['respawnWithChange'] = async (_session, change) => { respawns.push(change.configDir); };
    adapter.setClaudeConfigDirReader(() => '/profiles/perf');
    await adapter.sendInputAndWait(key, 'the message as the bot wrote it');
    adapter['onStdout'](session, unrecognisedEchoFrame);
    assert.equal(await adapter.applyClaudeConfigDir(key), 'deferred');
    adapter['onStdout'](session, resultFrame());
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(respawns, ['/profiles/perf']);
  });

  it('a REAL message queued behind a turn the CLI runs of its own (a finished task\'s notification) is kept at that turn\'s end: it is not stopped over, not switched over, and its own turn takes it in', async () => {
    const { adapter, session } = createAdapter();
    const workingAtTurnEnds = recordWorkingAtTurnEnds(adapter);
    const respawns: Array<string | null | undefined> = [];
    adapter['respawnWithChange'] = async (_session, change) => { respawns.push(change.configDir); };
    adapter.setClaudeConfigDirReader(() => '/profiles/perf');
    await adapter.sendInputAndWait(key, 'the user message, queued behind a running turn');
    assert.equal(await adapter.applyClaudeConfigDir(key), 'deferred');
    adapter['onStdout'](session, resultFrame());
    // The CLI runs the task's notification turn ahead of the message: no echo of ours in it, so it cannot have taken the message in.
    adapter['onStdout'](session, initFrame + resultFrame());
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(workingAtTurnEnds, [true, true], 'the message is still queued at both ends: neither the per-turn stop nor the wake engine may read it as done');
    assert.deepEqual(respawns, [], 'a re-spawn here would kill the process with the message in its queue');
    // Its own turn.
    adapter['onStdout'](session, initFrame + echoFrame('the user message, queued behind a running turn') + resultFrame());
    assert.deepEqual(workingAtTurnEnds, [true, true, false]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(respawns, ['/profiles/perf'], 'the switch waits for that one');
  });

  it('a turn end drops at most as many messages as unmatched echoes arrived in it, the oldest first', async () => {
    const { adapter, session } = createAdapter();
    await adapter.sendInputAndWait(key, 'the older message: its echo comes in a shape nothing matches');
    await adapter.sendInputAndWait(key, 'the newer message, still queued');
    adapter['onStdout'](session, unrecognisedEchoFrame);
    adapter['onStdout'](session, resultFrame());
    assert.deepEqual(session.unconsumedInputs.map((pending) => pending.text), ['the newer message, still queued']);
  });

  it('an unmatched line is tied to the entry it was counted against: a message written LATER in the same turn is not dropped with it (review)', async () => {
    const { adapter, session } = createAdapter();
    const workingAtTurnEnds = recordWorkingAtTurnEnds(adapter);
    await adapter.sendInputAndWait(key, 'M, queued behind the turn');
    // The CLI's own interrupt marker: array content, so no text, while M is listed — an unmatched line that is not an echo of M.
    adapter['onStdout'](session, interruptMarkerFrame);
    // M is taken in (matched) later in the same turn — NO turn-start frame between the steps, so what keeps N is the tie of the mark to
    // M (which leaves with M), not a reset; the user writes N meanwhile.
    adapter['onStdout'](session, echoFrame('M, queued behind the turn'));
    await adapter.sendInputAndWait(key, 'N, written later in that turn');
    adapter['onStdout'](session, resultFrame());
    assert.deepEqual(session.unconsumedInputs.map((pending) => pending.text), ['N, written later in that turn'], 'the line could not have carried N');
    assert.deepEqual(workingAtTurnEnds, [true], 'N is still queued: the per-turn stop must not kill the process over it');
  });

  it('an unmatched line of a turn that never reports a result is forgotten when the next turn starts: it does not drop a real message at the next turn end (review)', async () => {
    const { adapter, session } = createAdapter();
    await adapter.sendInputAndWait(key, 'M, queued behind an aborted turn');
    adapter['onStdout'](session, interruptMarkerFrame); // the aborted turn: no `result` follows
    adapter['onStdout'](session, initFrame);            // the next turn starts
    adapter['onStdout'](session, resultFrame());        // a turn with no echo of ours
    assert.deepEqual(session.unconsumedInputs.map((pending) => pending.text), ['M, queued behind an aborted turn']);
  });

  it('an interrupt forgets what the aborted turn marked: the marker that follows it is not an echo of anything queued (review)', async () => {
    const { adapter, session } = createAdapter();
    await adapter.sendInputAndWait(key, 'M, queued behind the turn');
    adapter['onStdout'](session, unrecognisedEchoFrame); // marks M for the end of this turn
    adapter.sendEscape(key);
    adapter['onStdout'](session, resultFrame());
    assert.deepEqual(session.unconsumedInputs.map((pending) => pending.text), ['M, queued behind the turn']);
  });

  it('a turn that asks for a permission or a question keeps its marks: `requires_action` → `running` inside the turn is no new turn (review)', async () => {
    const { adapter, session } = createAdapter();
    const workingAtTurnEnds = recordWorkingAtTurnEnds(adapter);
    await adapter.sendInputAndWait(key, 'the message whose echo nothing can match');
    adapter['onStdout'](session, stateFrame('running') + initFrame);
    adapter['onStdout'](session, unrecognisedEchoFrame);
    adapter['onStdout'](session, stateFrame('requires_action') + stateFrame('running'));
    adapter['onStdout'](session, resultFrame());
    assert.equal(session.unconsumedInputs.length, 0, 'dropped at the end of the turn that echoed it');
    assert.deepEqual(workingAtTurnEnds, [false], 'the claude-per-turn stop is not held off for the 30 s of a grace nothing re-asks after');
  });

  it('/esc, then the marker the CLI writes AFTER it, then the next turn: the marker\'s mark is forgotten at that turn\'s start, so its own unmatched echo drops one entry, not two (review)', async () => {
    const { adapter, session } = createAdapter();
    await adapter.sendInputAndWait(key, 'M, queued behind the aborted turn');
    await adapter.sendInputAndWait(key, 'N, queued behind it too');
    adapter.sendEscape(key);
    adapter['onStdout'](session, interruptMarkerFrame); // arrives after the interrupt request: marks M
    adapter['onStdout'](session, initFrame);             // M's turn opens: the marker's mark is void
    adapter['onStdout'](session, unrecognisedEchoFrame); // M taken in, in a shape nothing matches: marks M again — the oldest unmarked
    adapter['onStdout'](session, resultFrame());
    assert.deepEqual(session.unconsumedInputs.map((pending) => pending.text), ['N, queued behind it too']);
  });

  it('/esc, the marker, then the next turn that takes M in (matched): nothing is dropped', async () => {
    const { adapter, session } = createAdapter();
    await adapter.sendInputAndWait(key, 'M, queued behind the aborted turn');
    await adapter.sendInputAndWait(key, 'N, queued behind it too');
    adapter.sendEscape(key);
    adapter['onStdout'](session, interruptMarkerFrame);
    adapter['onStdout'](session, initFrame + echoFrame('M, queued behind the aborted turn') + resultFrame());
    assert.deepEqual(session.unconsumedInputs.map((pending) => pending.text), ['N, queued behind it too']);
  });

  it('a turn the busy watchdog clears (no `result` ever came) leaves no marks behind either (review)', async () => {
    const { adapter, session } = createAdapter();
    await adapter.sendInputAndWait(key, 'M, queued behind a turn that never ends');
    adapter['onStdout'](session, unrecognisedEchoFrame);
    assert.equal(session.unconsumedInputs[0].hasUnmatchedEcho, true, 'precondition: marked');
    session.lastStdoutActivityAt = nowMs - busyIdleWatchdogMs;
    adapter['maybeClearBusyOnIdle'](session);
    assert.equal(session.isBusy, false, 'precondition: the watchdog cleared the turn');
    assert.deepEqual(session.unconsumedInputs.map((pending) => [pending.text, pending.hasUnmatchedEcho]), [['M, queued behind a turn that never ends', false]]);
  });

  it('the mark is gone with the turn: a message queued behind the NEXT turn is not dropped at that turn\'s end either (review)', async () => {
    const { adapter, session } = createAdapter();
    await adapter.sendInputAndWait(key, 'the message whose echo nothing can match');
    adapter['onStdout'](session, unrecognisedEchoFrame);
    adapter['onStdout'](session, resultFrame());
    assert.equal(session.unconsumedInputs.length, 0, 'dropped at its own turn\'s end');
    await adapter.sendInputAndWait(key, 'queued behind the next turn');
    adapter['onStdout'](session, initFrame + resultFrame()); // a turn of the CLI\'s own: no echo of ours
    assert.deepEqual(session.unconsumedInputs.map((pending) => pending.text), ['queued behind the next turn']);
  });

  it('a user line of the CLI\'s own while nothing is listed takes no message written after it with it', async () => {
    const { adapter, session } = createAdapter();
    adapter['onStdout'](session, echoFrame('<local-command-stdout>nothing of ours</local-command-stdout>'));
    await adapter.sendInputAndWait(key, 'written after that line, queued');
    adapter['onStdout'](session, resultFrame());
    assert.deepEqual(session.unconsumedInputs.map((pending) => pending.text), ['written after that line, queued']);
  });

  it('the bot\'s own /compact turn is not a turn that took a message in: its (swallowed) echo drops nothing queued behind it', async () => {
    const { adapter, session } = createAdapter();
    await adapter.sendInputAndWait(key, 'queued behind the compaction');
    session.compactionInProgress = true;
    session.pendingCompaction = { resolve: () => {}, timer: null, sawSuccess: false, startedAt: nowMs };
    adapter['onStdout'](session, echoFrame('/compact'));
    adapter['onStdout'](session, resultFrame());
    assert.deepEqual(session.unconsumedInputs.map((pending) => pending.text), ['queued behind the compaction']);
    assert.equal(adapter.checkHasUnconsumedInput(key), true, 'the compaction\'s end leaves it its grace: its own turn starts a moment later');
  });

  it('a message the CLI never echoes at all is no longer counted once nothing has run for the grace — and is not revived by a turn the bot never wrote to', async () => {
    const { adapter, session } = createAdapter();
    await adapter.sendInputAndWait(key, 'the message the CLI drops');
    adapter['onStdout'](session, resultFrame());
    nowMs += 3 * unconsumedInputGraceMs;
    // A running turn counts every listed message as queued behind it: the one that started with no read before it must not.
    adapter['onStdout'](session, initFrame);
    assert.equal(session.isBusy, true);
    assert.equal(adapter.checkHasUnconsumedInput(key), false);
  });

  it('every read drops what is no longer on its way, not only the next write', async () => {
    const { adapter, session } = createAdapter();
    await adapter.sendInputAndWait(key, 'the message as the bot wrote it');
    session.isBusy = false;
    nowMs += unconsumedInputGraceMs;
    assert.equal(adapter.checkHasUnconsumedInput(key), false);
    assert.deepEqual(session.unconsumedInputs, [], 'dropped by the read');
  });
});

describe('json-stream adapter — a compaction flag nobody cleared never holds a process for good', () => {
  it('the flag holds only while the bot itself still waits for the compaction (its absolute timeout), then no more', () => {
    const { adapter, session } = createAdapter();
    session.compactionInProgress = true;
    session.pendingCompaction = { resolve: () => {}, timer: null, sawSuccess: false, startedAt: nowMs };
    assert.deepEqual(adapter.getBackgroundWorkSignals(key), [{ kind: 'compaction' }]);
    nowMs += compactionAbsoluteTimeoutMs;
    assert.deepEqual(adapter.getBackgroundWorkSignals(key), [], 'past what the bot itself waits for a compaction, the flag is stale');
  });

  it('a flag with no compaction behind it (nothing awaits it) holds nothing', () => {
    const { adapter, session } = createAdapter();
    session.compactionInProgress = true;
    assert.deepEqual(adapter.getBackgroundWorkSignals(key), []);
  });
});
