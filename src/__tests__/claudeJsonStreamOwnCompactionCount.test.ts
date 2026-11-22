/**
 * @description The json-stream adapter's count of the compactions the CLI started ITSELF (`getOwnCompactionCount`) — the figure the idle
 * compaction compares between two readings to learn that the conversation's context was replaced (its baseline is then read again from
 * the new epoch). Load-bearing intent: the count belongs to the CONVERSATION, not to the process. A process starts counting at 0 on every
 * spawn, resume and adopt; were the count the process's, a conversation that compacted by itself in two processes in a row would read
 * 1 both times and the second compaction would go unseen, and one that compacted while the bot was down (the adopt replays the boundary)
 * would show 1 against a reading that never knew a count. So:
 *   • a boundary no bot compaction waits for counts, a bot-issued compaction's own boundary does not;
 *   • an idle stop (suspend) and the next process on the same conversation keep the count and go on from it;
 *   • an explicit stop (`/quit`, `/new`) or a process that died releases the conversation and its count, as the compaction module drops
 *     what it saw of the conversation at the same moments.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ClaudeJsonStreamAdapter, type StreamSession } from '../adapters/claudeJsonStreamAdapter';
import { getJsonStreamSessionPaths } from '../utils/jsonStreamHost';
import { keyToString } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { createStreamSessionFixture } from './claudeJsonStreamSessionFixture';

const key = makeTelegramKey(-100999777, 58);
const otherKey = makeTelegramKey(-100999777, 59);

function toLine(frame: Record<string, unknown>): string {
  return JSON.stringify(frame) + '\n';
}

const compactBoundaryLine = toLine({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 190_000, post_tokens: 12_000 } });
const resultLine = toLine({ type: 'result', subtype: 'success', is_error: false, result: 'OK' });

describe('json-stream own-compaction count — one per conversation, kept across processes', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A process of the conversation `sessionKey`: registered on the adapter as its current one, `append` writes into its stdout. */
  function startProcess(adapter: ClaudeJsonStreamAdapter, sessionKey = key): { session: StreamSession; append: (text: string) => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-own-compaction-'));
    dirs.push(dir);
    const session = createStreamSessionFixture({ key: sessionKey, sessionId: 'sess-own-compaction', paths: getJsonStreamSessionPaths(dir) });
    adapter['sessions'].set(keyToString(sessionKey), session);
    fs.writeFileSync(session.paths.stdoutFile, '');
    const append = (text: string): void => {
      fs.appendFileSync(session.paths.stdoutFile, text);
      adapter['drainStdoutTail'](session);
    };
    return { session, append };
  }

  function endProcess(adapter: ClaudeJsonStreamAdapter, session: StreamSession, how: 'suspend' | 'stop' | 'died'): void {
    session.isStopping = how !== 'died';
    session.isSuspending = how === 'suspend';
    adapter['finalizeExternalExit'](session, null);
  }

  it('a boundary no bot compaction waits for counts; the boundary of a bot-issued compaction does not', () => {
    const adapter = new ClaudeJsonStreamAdapter();
    const { session, append } = startProcess(adapter);
    assert.equal(adapter.getOwnCompactionCount(key), 0);

    append(compactBoundaryLine + resultLine);
    assert.equal(adapter.getOwnCompactionCount(key), 1, 'the CLI\'s own overflow compaction');

    // As `compactContext` leaves it: the bot's compaction waits for its boundary.
    session.pendingCompaction = { resolve: () => {}, timer: null, sawSuccess: true, startedAt: Date.now() };
    append(compactBoundaryLine + resultLine);
    assert.equal(adapter.getOwnCompactionCount(key), 1, 'a compaction the bot asked for is not the CLI\'s own');
  });

  it('the count survives an idle stop and goes on in the next process: two processes in a row that each compacted by themselves read 1, then 2', () => {
    const adapter = new ClaudeJsonStreamAdapter();
    const first = startProcess(adapter);
    first.append(compactBoundaryLine + resultLine);
    assert.equal(adapter.getOwnCompactionCount(key), 1);

    endProcess(adapter, first.session, 'suspend');
    assert.equal(adapter.getOwnCompactionCount(key), 1, 'the conversation sleeps, its count stays');

    // The next trigger resumes it: a new process of the same conversation. Before it says anything the count is what it was; its own
    // compaction (or the one an adopt replays from the downtime) moves it on instead of starting again from 0.
    const second = startProcess(adapter);
    assert.equal(adapter.getOwnCompactionCount(key), 1, 'a new process does not start the count over');
    second.append(compactBoundaryLine + resultLine);
    assert.equal(adapter.getOwnCompactionCount(key), 2, 'the second process\'s compaction differs from the first reading: a real change');
  });

  it('an explicit stop and a process that died release the conversation\'s count; other conversations are untouched', () => {
    const adapter = new ClaudeJsonStreamAdapter();
    const stopped = startProcess(adapter);
    const other = startProcess(adapter, otherKey);
    stopped.append(compactBoundaryLine + resultLine);
    other.append(compactBoundaryLine + resultLine);
    other.append(compactBoundaryLine + resultLine);

    endProcess(adapter, stopped.session, 'stop');
    assert.equal(adapter.getOwnCompactionCount(key), 0, 'released with the conversation');
    assert.equal(adapter.getOwnCompactionCount(otherKey), 2, 'another conversation keeps its own');

    const died = startProcess(adapter);
    died.append(compactBoundaryLine + resultLine);
    assert.equal(adapter.getOwnCompactionCount(key), 1, 'counted from 0 again');
    endProcess(adapter, died.session, 'died');
    assert.equal(adapter.getOwnCompactionCount(key), 0, 'a process that died: the module drops what it saw at the same moment (`closed`)');
  });
});
