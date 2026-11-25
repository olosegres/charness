/**
 * @description The json-stream adapter's `refreshWorkingState`: the bot reads the process's `stdout.jsonl` on a poll with a backoff,
 * so an echo the CLI already wrote may not be read yet. An ending command's reading of what the agent took in calls it first
 * (`RequestWakeUpEngine.readPromptsReachedOrHeld`): an echo already written takes its message in, and a person whose message the
 * agent read is not told it never reached it (review 28, own pass: a switch moments after a message told its person while the bridge
 * carried it). It never reads from inside the adapter's own handling of a chunk — the lines behind the chunk would be handled ahead
 * of its own. The FIFO write is the adapter's test seam; the tail is a real `stdout.jsonl` in a temp dir.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeJsonStreamAdapter, type StreamSession } from '../adapters/claudeJsonStreamAdapter';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { getJsonStreamSessionPaths } from '../utils/jsonStreamHost';
import { createStreamSessionFixture } from './claudeJsonStreamSessionFixture';

const key: SessionKey = makeTelegramKey(-100999555, 61);
const messageText = 'RD-1 a message the agent works on';
/** The `--replay-user-messages` echo the CLI writes when it takes a message in. */
const echoLine = JSON.stringify({ type: 'user', message: { role: 'user', content: messageText }, parent_tool_use_id: null, isReplay: true }) + '\n';

describe('claude-json-stream refreshWorkingState', () => {
  let dir: string;
  const created: Array<{ adapter: ClaudeJsonStreamAdapter; session: StreamSession }> = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-refresh-'));
  });
  afterEach(() => {
    for (const { adapter, session } of created.splice(0)) adapter['clearTimers'](session);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A live session with `messageText` written to its process, and the process's echo of it in the log, not polled yet. */
  async function createSessionWithUnpolledEcho(): Promise<{ adapter: ClaudeJsonStreamAdapter; session: StreamSession }> {
    const adapter = new ClaudeJsonStreamAdapter({ lifecycle: 'idle', writeFifo: async () => {} });
    const session = createStreamSessionFixture({ key, pid: process.pid, sessionId: 'sess-refresh', paths: getJsonStreamSessionPaths(dir) });
    adapter['sessions'].set(keyToString(key), session);
    created.push({ adapter, session });
    await adapter.sendInputAndWait(key, messageText);
    fs.writeFileSync(session.paths.stdoutFile, echoLine);
    assert.equal(adapter.checkHasUnconsumedInput(key), true, 'precondition: the poll has not read the echo');
    return { adapter, session };
  }

  it('reads the echo the process already wrote: the message counts as taken in at once, not at the next poll', async () => {
    const { adapter } = await createSessionWithUnpolledEcho();

    adapter.refreshWorkingState(key);

    assert.equal(adapter.checkHasUnconsumedInput(key), false, 'the agent read it');
  });

  it('from inside the adapter\'s own handling of a chunk it reads nothing: the lines behind the chunk are not handled ahead of its own', async () => {
    const { adapter, session } = await createSessionWithUnpolledEcho();
    session.applyingChunk = { isPersistDeferred: false };

    adapter.refreshWorkingState(key);

    assert.equal(session.tail.consumedBytes, 0, 'nothing was consumed from the log');
    assert.equal(adapter.checkHasUnconsumedInput(key), true);
  });
});
