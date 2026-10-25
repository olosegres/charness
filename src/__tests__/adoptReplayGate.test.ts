/**
 * @description The wait before a prompt is forwarded to an adopted session (`utils/adoptReplayGate`): the downtime tail is
 * replayed first. Against the real json-stream adapter: a session with a replay behind its tail holds the forward until the
 * poll has consumed it, and what the replay emitted (its text, its error) has gone out by then — before the prompt resets
 * the answer and error state the replayed frames use. The bound only matters for a tail that never settles.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ClaudeJsonStreamAdapter } from '../adapters/claudeJsonStreamAdapter';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { getJsonStreamSessionPaths } from '../utils/jsonStreamHost';
import { waitForAdoptedReplay } from '../utils/adoptReplayGate';
import { createStreamSessionFixture } from './claudeJsonStreamSessionFixture';

const key: SessionKey = makeTelegramKey(-100999777, 57);
const textDeltaLine =
  JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'old text' } } }) + '\n';
const usageLimitResultLine =
  JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your session limit · resets 10:20am (UTC)" }) + '\n';
/** The gate's bound in these tests: long enough that a replay which settles never loses the race, short enough to wait out. */
const shortBoundMs = 40;

/** Let queued promise callbacks run. */
const settleMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('the wait before a prompt reaches an adopted session', () => {
  let dir: string;
  let sessionProcess: ChildProcess | null = null;
  let endSession: () => void = () => {};
  afterEach(() => {
    endSession();
    endSession = () => {};
    sessionProcess?.kill('SIGKILL');
    sessionProcess = null;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * An adapter holding an adopted session whose downtime turn (text, then a usage-limit error) is still behind its tail.
   * The session's process is a live `sleep`: a dead one would end the session on the first poll, which settles the wait too.
   */
  function createAdoptedWithReplayBehind(): { adapter: ClaudeJsonStreamAdapter; pollTick: () => void } {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-adoptgate-'));
    sessionProcess = spawn('sleep', ['60'], { stdio: 'ignore' });
    assert.ok(sessionProcess.pid, 'the session\'s process started');
    const adapter = new ClaudeJsonStreamAdapter();
    const session = createStreamSessionFixture({ key, workDir: '/tmp/jsonstream-adoptgate-work', sessionId: 'sess-adoptgate', pid: sessionProcess.pid, paths: getJsonStreamSessionPaths(dir) });
    adapter['sessions'].set(keyToString(key), session);
    const replayedLog = textDeltaLine + usageLimitResultLine;
    fs.writeFileSync(session.paths.stdoutFile, replayedLog);
    session.adoptCatchUpOffset = Buffer.byteLength(replayedLog);
    // The poll reschedules itself: stop its timer with the test.
    endSession = () => adapter['clearTimers'](session);
    return { adapter, pollTick: () => adapter['pollTailTick'](session) };
  }

  it('an adapter that never adopts, and a session that was not adopted, forward at once', async () => {
    await waitForAdoptedReplay({}, key);
    const adapter = new ClaudeJsonStreamAdapter();
    await waitForAdoptedReplay(adapter, key); // no session
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-adoptgate-plain-'));
    adapter['sessions'].set(keyToString(key), createStreamSessionFixture({ key, paths: getJsonStreamSessionPaths(dir) }));
    await waitForAdoptedReplay(adapter, key); // not adopted
  });

  it('holds the forward until the poll has replayed the downtime tail — whose text and error have gone out by then', async () => {
    const { adapter, pollTick } = createAdoptedWithReplayBehind();
    const events: string[] = [];
    adapter.on('output', (_k: SessionKey, text: string) => events.push(`output:${text}`));
    adapter.on('apiError', (_k: SessionKey, error: { kind: string }) => events.push(`apiError:${error.kind}`));

    let isForwarded = false;
    const forwarded = waitForAdoptedReplay(adapter, key).then(() => { events.push('forward'); isForwarded = true; });
    await settleMicrotasks();
    assert.equal(isForwarded, false, 'the replay has not been read yet: the prompt waits');
    assert.deepEqual(events, []);

    pollTick();
    await forwarded;

    assert.deepEqual(events, ['output:old text', 'apiError:usageLimit', 'forward'], 'the replayed turn is done before the prompt is let through');
  });

  it('a tail that never settles does not hold the prompt for good: it goes out after the bound, with a warning', async () => {
    const { adapter } = createAdoptedWithReplayBehind();
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      await waitForAdoptedReplay(adapter, key, shortBoundMs); // no poll runs: the replay never settles
    } finally {
      console.warn = originalWarn;
    }
    assert.ok(warnings.some((line) => line.includes(`${shortBoundMs} ms`)), `the bound is logged: ${warnings}`);
  });
});
