/**
 * @description External-process transport of the json-stream adapter (plan
 * 2026-07-05-jsonstream-restart-isolation, S2): exit detection via the
 * wrapper's pid/exitcode files, the final stdout drain, and the busy-state
 * reconstruction from replayed events.
 *
 * Load-bearing intent (per `.claude/rules/tests.md`):
 * - a poll tick that finds the exitcode file must FIRST drain the bytes claude
 *   flushed at exit (the final `result` still reaches the topic) and only then
 *   emit `closed` with the REAL wrapper-reported code — losing the last flush
 *   is exactly the "final answer discarded" bug class;
 * - an explicit stop converges through the same finalize but emits `stopped`;
 * - `textDelta`/`result` alone reconstruct `isBusy` (an ADOPTED session has no
 *   `sendInput` to set it), and the persisted tail offset lands on the line
 *   boundary so a restart replays nothing twice.
 *
 * The adapter's private members are reached via runtime bracket access (tests
 * are type-stripped by tsx), same pattern as claudeJsonStreamWatermarkAdvance.
 *
 * Test case: N/A — TelegramCode has no Jira tracker.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ClaudeJsonStreamAdapter, claudeJsonStreamUsageLogPrefix } from '../adapters/claudeJsonStreamAdapter';
import { ClaudeStreamLineReader } from '../utils/claudeStreamJson';
import { busyIdleWatchdogMs } from '../utils/jsonStreamBusyWatchdog';
import {
  createStdoutTailState,
  getJsonStreamSessionPaths,
} from '../utils/jsonStreamHost';
import { type JsonStreamTailOffset } from '../types';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

// A key no live thread uses — cleanup paths derived from it are guaranteed no-ops.
const key: SessionKey = makeTelegramKey(-100999777, 55);

/** A pid that is certainly dead: a reaped short-lived child of ours. */
function getDeadPid(): number {
  const child = spawnSync('true');
  return child.pid ?? 1;
}

function createSessionInDir(adapter: ClaudeJsonStreamAdapter, dir: string) {
  const paths = getJsonStreamSessionPaths(dir);
  const session = {
    key,
    workDir: '/tmp/jsonstream-transport-work',
    sessionId: 'sess-transport',
    pid: getDeadPid(),
    paths,
    fifoFd: -1, // closeFifo tolerates an invalid fd (EBADF swallowed)
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
    isSuspending: false,
    isRespawning: false,
    isBusy: false,
    lastStdoutActivityAt: Date.now(),
    outstandingToolUseIds: new Set<string>(),
    model: null,
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
    pendingInitResolve: null,
    initRequestId: null,
    // Bot-issued control requests awaiting their `control_response`; the teardown
    // path settles every entry, so the fixture must carry the real (empty) map.
    pendingControlRequests: new Map(),
    pendingQuestion: null,
    apiErrorFired: false,
    swallowNextAbortError: false,
    lastWatermarkOffset: -1,
    unconsumedInputCount: 0,
    compactionInProgress: false,
    backgroundTaskIds: new Set<string>(),
    claudeCodeVersion: null,
    applyingChunk: null,
    adoptCatchUpOffset: null,
    adoptCatchUpResolvers: [],
  };
  adapter['sessions'].set(keyToString(key), session);
  return session;
}

function buildBackgroundTasksLine(taskIds: string[]): string {
  return JSON.stringify({ type: 'system', subtype: 'background_tasks_changed', tasks: taskIds.map((taskId) => ({ task_id: taskId, task_type: 'local_bash', status: 'running' })) }) + '\n';
}

/** Capture `console.log` lines while `run` executes. */
function captureLog(run: () => void): string[] {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    run();
  } finally {
    console.log = originalLog;
  }
  return lines;
}

const resultLine =
  JSON.stringify({ type: 'result', is_error: false, result: 'final answer' }) + '\n';
const textDeltaLine =
  JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } }) + '\n';
// A terminal error result carrying NO `api_error_status`/`result` text — the
// shape the CLI emits for an interrupt-aborted turn. `claudeStreamJson` falls
// back to the literal `'API error'`, which `classifyAgentApiError` does NOT
// recognise (so it can only surface as the generic "Claude error:" line).
const abortErrorResultLine =
  JSON.stringify({ type: 'result', is_error: true }) + '\n';

describe('json-stream external transport — exit detection', () => {
  let dir: string;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('drains the final flush, then emits closed with the wrapper-reported code', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-exit-'));
    const adapter = new ClaudeJsonStreamAdapter();
    const session = createSessionInDir(adapter, dir);
    // Claude flushed a final result and exited; the wrapper recorded code 3.
    fs.writeFileSync(session.paths.stdoutFile, resultLine);
    fs.writeFileSync(session.paths.exitCodeFile, '3\n');

    const outputs: string[] = [];
    const closedKeys: SessionKey[] = [];
    const tailWrites: JsonStreamTailOffset[] = [];
    adapter.on('output', (_k: SessionKey, text: string) => outputs.push(text));
    adapter.on('closed', (k: SessionKey) => closedKeys.push(k));
    adapter.setJsonStreamTailWriter((_k, tail) => tailWrites.push(tail));
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      adapter['pollTailTick'](session);
    } finally {
      console.warn = originalWarn;
    }

    assert.deepEqual(outputs, ['final answer'], 'the exit-flushed result still reaches the topic');
    assert.deepEqual(closedKeys, [key], 'unexpected external exit emits closed');
    assert.ok(warnings.some((w) => w.includes('code=3')), `real exit code surfaces in the log: ${warnings}`);
    assert.equal(adapter['sessions'].size, 0, 'the session is deregistered');
    assert.equal(fs.existsSync(dir), false, 'the host dir is removed');
    // The tail offset persisted at the line boundary (== the whole result line).
    assert.deepEqual(tailWrites, [{ sessionId: 'sess-transport', offsetBytes: Buffer.byteLength(resultLine), backgroundTaskIds: [], isTurnInFlight: false }]);
  });

  it('an explicit stop converges through the same finalize but emits stopped', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-stop-'));
    const adapter = new ClaudeJsonStreamAdapter();
    createSessionInDir(adapter, dir);

    const events: string[] = [];
    adapter.on('stopped', () => events.push('stopped'));
    adapter.on('closed', () => events.push('closed'));
    await adapter['stopSessionInternal'](key);

    assert.deepEqual(events, ['stopped'], 'explicit stop must not read as an unexpected close');
    assert.equal(adapter['sessions'].size, 0);
    assert.equal(fs.existsSync(dir), false, 'the host dir is removed on stop');
  });

  it('a suspend converges through the same finalize but emits suspended — the session is kept resumable by the bot (L3)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-suspend-'));
    const adapter = new ClaudeJsonStreamAdapter();
    createSessionInDir(adapter, dir);

    const events: string[] = [];
    adapter.on('stopped', () => events.push('stopped'));
    adapter.on('suspended', () => events.push('suspended'));
    adapter.on('closed', () => events.push('closed'));
    await adapter.suspendSession(key);

    assert.deepEqual(events, ['suspended'], 'an idle stop must never read as an explicit stop or an unexpected close');
    assert.equal(adapter['sessions'].size, 0, 'the process bookkeeping is gone');
    assert.equal(adapter.checkIsActive(key), false);
    assert.equal(fs.existsSync(dir), false, 'the host dir is removed like on a stop (L-D13)');
  });

  it('holds the tail offset back while answer text sits in the batch, releases it on flush', () => {
    // Live seam-loss repro (2026-07-05): lines consumed into the
    // 350ms answer batch died with the killed bot while the persisted offset
    // had already moved past them — the adopting bot skipped them on replay
    // ("216–221 missing"). The offset must persist only once the batched text
    // has actually been emitted.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-defer-'));
    const adapter = new ClaudeJsonStreamAdapter();
    const session = createSessionInDir(adapter, dir);
    fs.writeFileSync(session.paths.stdoutFile, textDeltaLine);
    const tailWrites: JsonStreamTailOffset[] = [];
    adapter.setJsonStreamTailWriter((_k, tail) => tailWrites.push(tail));

    assert.equal(adapter['drainStdoutTail'](session), true, 'the delta line is consumed');
    assert.deepEqual(tailWrites, [], 'un-emitted batched text must hold the offset back');

    adapter['flushAnswer'](session, false);
    assert.deepEqual(
      tailWrites,
      // The delta marked a turn in flight: the record says so, for an adopt in a later silent stretch.
      [{ sessionId: 'sess-transport', offsetBytes: Buffer.byteLength(textDeltaLine), backgroundTaskIds: [], isTurnInFlight: true }],
      'the flush releases the boundary at the consumed line',
    );
  });

  it('tracks the background-task list from the stream and persists it with the tail offset (L1)', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-tasks-'));
    const adapter = new ClaudeJsonStreamAdapter();
    const session = createSessionInDir(adapter, dir);
    const tailWrites: JsonStreamTailOffset[] = [];
    adapter.setJsonStreamTailWriter((_k, tail) => tailWrites.push(tail));

    assert.equal(adapter.checkIsWorking(key), false, 'an idle session with no tasks is not working');
    const twoTasks = resultLine + buildBackgroundTasksLine(['b1', 'a2']);
    fs.writeFileSync(session.paths.stdoutFile, twoTasks);
    adapter['drainStdoutTail'](session);
    assert.deepEqual([...session.backgroundTaskIds], ['b1', 'a2']);
    assert.equal(adapter.checkIsWorking(key), true, 'a background task keeps the idle session working (L-D2)');
    assert.deepEqual(tailWrites.at(-1), { sessionId: 'sess-transport', offsetBytes: Buffer.byteLength(twoTasks), backgroundTaskIds: ['b1', 'a2'], isTurnInFlight: false },
      'the list rides along with the offset so an adopt restores it');

    // The list is re-sent WHOLE: a frame naming one task replaces, not merges.
    const oneTask = twoTasks + buildBackgroundTasksLine(['a2']);
    fs.writeFileSync(session.paths.stdoutFile, oneTask);
    adapter['drainStdoutTail'](session);
    assert.deepEqual([...session.backgroundTaskIds], ['a2']);

    const noTasks = oneTask + buildBackgroundTasksLine([]);
    fs.writeFileSync(session.paths.stdoutFile, noTasks);
    adapter['drainStdoutTail'](session);
    assert.deepEqual([...session.backgroundTaskIds], []);
    assert.equal(adapter.checkIsWorking(key), false, 'an empty list means nothing runs');
    assert.deepEqual(tailWrites.at(-1)?.backgroundTaskIds, []);
  });

  it('checkIsWorking: a busy turn, unconsumed input, or a compaction in flight each count as working; an unknown key does not', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-working-'));
    const adapter = new ClaudeJsonStreamAdapter();
    const session = createSessionInDir(adapter, dir);
    assert.equal(adapter.checkIsWorking(makeTelegramKey(-100999777, 56)), false, 'no session → not working');

    session.isBusy = true;
    assert.equal(adapter.checkIsWorking(key), true, 'a running turn');
    session.isBusy = false;

    session.unconsumedInputCount = 1;
    assert.equal(adapter.checkIsWorking(key), true, 'a prompt not yet taken in');
    session.unconsumedInputCount = 0;

    session.compactionInProgress = true;
    assert.equal(adapter.checkIsWorking(key), true, 'a compaction in flight');
    session.compactionInProgress = false;

    assert.equal(adapter.checkIsWorking(key), false);
    session.isActive = false;
    session.isBusy = true;
    assert.equal(adapter.checkIsWorking(key), false, 'an inactive session is never working');
  });

  it('logs every result\'s token accounting (L-D11) and captures the CLI version from init (L-D10)', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-usage-'));
    const adapter = new ClaudeJsonStreamAdapter();
    const session = createSessionInDir(adapter, dir);
    assert.equal(adapter.getClaudeCodeVersion(key), null, 'unknown until the first init');

    const initLine = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-transport', model: 'fake-model', claude_code_version: '2.1.287' }) + '\n';
    const usageResultLine = JSON.stringify({
      type: 'result', is_error: false, result: 'done',
      usage: { input_tokens: 3, cache_creation_input_tokens: 1422, cache_read_input_tokens: 24128, output_tokens: 57 },
    }) + '\n';
    const lines = captureLog(() => adapter['onStdout'](session, initLine + usageResultLine));

    assert.equal(adapter.getClaudeCodeVersion(key), '2.1.287');
    const usageLines = lines.filter((line) => line.startsWith(claudeJsonStreamUsageLogPrefix));
    assert.equal(usageLines.length, 1, `exactly one usage line per result: ${lines}`);
    assert.ok(usageLines[0].includes('input=3 cacheRead=24128 cacheWrite=1422 output=57'), usageLines[0]);

    // A result without usage logs nothing — no fabricated zeros.
    const silent = captureLog(() => adapter['onStdout'](session, resultLine));
    assert.deepEqual(silent.filter((line) => line.startsWith(claudeJsonStreamUsageLogPrefix)), []);
  });

  it('persists the turn in flight with the tail record: set when a turn is written, cleared by its result (L4 rework)', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-turnflag-'));
    const adapter = new ClaudeJsonStreamAdapter();
    const session = createSessionInDir(adapter, dir);
    const tailWrites: JsonStreamTailOffset[] = [];
    adapter.setJsonStreamTailWriter((_k, tail) => tailWrites.push(tail));
    const originalError = console.error;
    console.error = () => {}; // the fixture's fifo fd is invalid: the write itself is not under test
    try {
      adapter.sendInput(key, 'do the long thing');
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(tailWrites.at(-1), { sessionId: 'sess-transport', offsetBytes: 0, backgroundTaskIds: [], isTurnInFlight: true },
      'written at once, at the current offset: a restart in a silent tool call finds no frame to rebuild it from');

    fs.writeFileSync(session.paths.stdoutFile, resultLine);
    adapter['drainStdoutTail'](session);
    assert.deepEqual(tailWrites.at(-1), { sessionId: 'sess-transport', offsetBytes: Buffer.byteLength(resultLine), backgroundTaskIds: [], isTurnInFlight: false });
  });

  it('whenAdoptReplayed: settles once the tail consumed the adopt-time EOF, at once when nothing was behind, and when the session ends', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-catchup-'));
    const adapter = new ClaudeJsonStreamAdapter();
    const session = createSessionInDir(adapter, dir);
    await adapter.whenAdoptReplayed(key); // not adopted: immediate
    await adapter.whenAdoptReplayed(makeTelegramKey(-100999777, 56)); // unknown key: immediate

    // Adopted with two lines behind the tail: the second drain reaches the adopt-time EOF.
    const behind = textDeltaLine + resultLine;
    fs.writeFileSync(session.paths.stdoutFile, behind);
    session.adoptCatchUpOffset = Buffer.byteLength(behind);
    let isSettled = false;
    const replayed = adapter.whenAdoptReplayed(key).then(() => { isSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(isSettled, false, 'nothing consumed yet');
    adapter['pollTailTick'](session);
    await replayed;
    assert.equal(session.adoptCatchUpOffset, null, 'caught up: the state rebuilt by the replay is trustworthy now');
    assert.equal(session.isBusy, false, 'the replayed result cleared the turn');

    // A waiter never hangs on a session that ends first.
    const ending = createSessionInDir(adapter, fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-catchup-end-')));
    ending.adoptCatchUpOffset = 10_000;
    const waiter = adapter.whenAdoptReplayed(key);
    await adapter['stopSessionInternal'](key);
    await waiter;
    fs.rmSync(ending.paths.dir, { recursive: true, force: true });
  });

  it('reconstructs isBusy from replayed events (adopt has no sendInput)', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-busy-'));
    const adapter = new ClaudeJsonStreamAdapter();
    const session = createSessionInDir(adapter, dir);

    adapter['onStdout'](session, textDeltaLine);
    assert.equal(session.isBusy, true, 'a replayed mid-turn delta marks the session busy');
    adapter['onStdout'](session, resultLine);
    assert.equal(session.isBusy, false, 'the replayed result clears it');
  });
});

// tool_use assistant line (a normal, non-sub-agent tool) + its tool_result.
const toolUseLine =
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] } }) + '\n';
const toolResultLine =
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] } }) + '\n';

describe('json-stream idle watchdog — the stuck-busy / hung-typing backstop', () => {
  let dir: string;
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it('clears a busy session gone silent with nothing in flight (a missed terminal result)', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-wd-clear-'));
    const adapter = new ClaudeJsonStreamAdapter();
    const session = createSessionInDir(adapter, dir);
    // A delta arrived (busy=true) but the terminal `result` never did.
    adapter['onStdout'](session, textDeltaLine);
    adapter['flushAnswer'](session, false); // drain the batch (no un-emitted text)
    assert.equal(session.isBusy, true);
    // stdout has been silent past the threshold.
    session.lastStdoutActivityAt = Date.now() - busyIdleWatchdogMs - 1000;

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
    try {
      adapter['maybeClearBusyOnIdle'](session);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(session.isBusy, false, 'the stuck busy flag is cleared → typing indicator can stop');
    assert.ok(warnings.some((w) => w.includes('watchdog')), `the clear is logged: ${warnings}`);
  });

  it('does NOT clear while a tool is still outstanding (a long silent Bash is legitimately busy)', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-wd-tool-'));
    const adapter = new ClaudeJsonStreamAdapter();
    const session = createSessionInDir(adapter, dir);
    // A tool_use started but its tool_result has not come back yet.
    adapter['onStdout'](session, toolUseLine);
    assert.equal(session.isBusy, true);
    assert.equal(session.outstandingToolUseIds.size, 1, 'the tool is tracked as in flight');
    session.lastStdoutActivityAt = Date.now() - busyIdleWatchdogMs - 1000;

    adapter['maybeClearBusyOnIdle'](session);
    assert.equal(session.isBusy, true, 'an outstanding tool vetoes the idle clear');

    // Once the tool returns, the outstanding set drains and the watchdog may fire.
    adapter['onStdout'](session, toolResultLine);
    assert.equal(session.outstandingToolUseIds.size, 0, 'the returned tool leaves the in-flight set');
    session.lastStdoutActivityAt = Date.now() - busyIdleWatchdogMs - 1000;
    adapter['maybeClearBusyOnIdle'](session);
    assert.equal(session.isBusy, false, 'with no tool outstanding the stuck busy clears');
  });

  it('an explicit interrupt clears isBusy immediately (an aborted turn may emit no result)', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-wd-int-'));
    const adapter = new ClaudeJsonStreamAdapter();
    const session = createSessionInDir(adapter, dir);
    adapter['onStdout'](session, toolUseLine); // busy, one tool outstanding
    assert.equal(session.isBusy, true);

    adapter.sendEscape(session.key); // → sendInterrupt
    assert.equal(session.isBusy, false, 'interrupt drops busy without waiting on a result');
    assert.equal(session.outstandingToolUseIds.size, 0, 'interrupt clears the in-flight tool set');
  });
});

describe('json-stream interrupt-aborted turn — no bogus "Claude error" surfaces', () => {
  let dir: string;
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it('swallows the abort error result that an interrupt WE issued produced', () => {
    // Live repro: cancelling a pending question sends a SIGINT,
    // whose aborted-turn `result{is_error}` used to relay "Claude error: API
    // error" as a third bogus message on top of the two cancel notices.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-abort-swallow-'));
    const adapter = new ClaudeJsonStreamAdapter();
    const session = createSessionInDir(adapter, dir);
    const outputs: string[] = [];
    adapter.on('output', (_k: SessionKey, text: string) => outputs.push(text));

    adapter.sendSignal(session.key, 'SIGINT'); // arms swallowNextAbortError
    assert.equal(session.swallowNextAbortError, true, 'the interrupt arms the one-shot');
    adapter['onStdout'](session, abortErrorResultLine);

    assert.deepEqual(outputs, [], 'the abort result must not reach the topic as an error');
    assert.equal(session.swallowNextAbortError, false, 'the one-shot is consumed');
  });

  it('a genuine error result WITHOUT a preceding interrupt still surfaces', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-abort-real-'));
    const adapter = new ClaudeJsonStreamAdapter();
    const session = createSessionInDir(adapter, dir);
    const outputs: string[] = [];
    adapter.on('output', (_k: SessionKey, text: string) => outputs.push(text));

    adapter['onStdout'](session, abortErrorResultLine);

    assert.deepEqual(outputs, ['Claude error: API error'], 'a real error must still reach the topic');
  });

  it('the swallow is one-shot: a SECOND error result after the swallowed one surfaces', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-abort-oneshot-'));
    const adapter = new ClaudeJsonStreamAdapter();
    const session = createSessionInDir(adapter, dir);
    const outputs: string[] = [];
    adapter.on('output', (_k: SessionKey, text: string) => outputs.push(text));

    adapter.sendSignal(session.key, 'SIGINT');
    adapter['onStdout'](session, abortErrorResultLine); // swallowed
    adapter['onStdout'](session, abortErrorResultLine); // a later, unrelated error surfaces

    assert.deepEqual(outputs, ['Claude error: API error'], 'only the post-interrupt result is swallowed');
  });
});
