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
 *   - the failed-turn reconciliation stays: an error `result` forgets the queue.
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
import { compactionAbsoluteTimeoutMs } from '../utils/jsonStreamBusyWatchdog';
import { unconsumedInputGraceMs } from '../utils/jsonStreamPendingWork';
import { createStreamSessionFixture } from './claudeJsonStreamSessionFixture';

const key: SessionKey = makeTelegramKey(-100999333, 79);

const echoFrame = (text: string): string => JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, isReplay: true }) + '\n';
/** The CLI's own marker after an interrupt: a user line with array content, no `isReplay`, nothing of ours. */
const interruptMarkerFrame = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, parent_tool_use_id: null }) + '\n';
const resultFrame = (isError = false): string => JSON.stringify({ type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError, result: isError ? '' : 'done' }) + '\n';
const initFrame = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-merged', model: 'fake-model' }) + '\n';
const idleStateFrame = JSON.stringify({ type: 'system', subtype: 'session_state_changed', state: 'idle' }) + '\n';

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
