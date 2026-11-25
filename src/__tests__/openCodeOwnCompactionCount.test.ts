/**
 * @description The OpenCode adapter's count of the compactions the SERVER started itself (`getOwnCompactionCount`) — the figure the idle
 * compaction compares between two readings to learn that the conversation's context was replaced under the bot (its baseline is then
 * read again from the new epoch). The event is `session.compacted`, the one the fake server plays at the end of a compaction
 * (`emitCompactionSummary`; the two OpenCode compaction flows run it over the real SSE stream, a server overflow and a bot-issued one).
 * Load-bearing intent:
 *   • a `session.compacted` with no bot compaction open is the server's own and counts, once each;
 *   • one that arrives while the bot's own compaction is open does not (the bot already knows that compaction);
 *   • `session.next.compaction.ended` may come with the same compaction and never counts twice;
 *   • the count belongs to the conversation: it is dropped only when the adapter lets the conversation go (an explicit stop).
 *
 * Harness mirrors openCodeWatermarkAdvance.test.ts: a session is injected, a real `/global/event` envelope goes through `routeSseData`.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeAdapter, type OpenCodeSession } from '../adapters/openCodeAdapter';
import { keyToString } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { createOpenCodeSessionFixture } from './openCodeSessionFixture';

const ownSessionId = 'ses_own_compaction';
const key = makeTelegramKey(-100999222, 556);
const workDir = '/tmp/work';

function createAdapterWithSession(): { adapter: OpenCodeAdapter; session: OpenCodeSession } {
  const adapter = new OpenCodeAdapter();
  const session = createOpenCodeSessionFixture({ key, sessionId: ownSessionId, workDir });
  adapter['sessions'].set(keyToString(key), session);
  return { adapter, session };
}

function feedEvent(adapter: OpenCodeAdapter, type: string, sessionID: string = ownSessionId, directory: string = workDir): void {
  adapter['routeSseData'](JSON.stringify({ directory, project: 'proj', payload: { type, properties: { sessionID } } }));
}

describe('OpenCode own-compaction count — `session.compacted` the bot did not ask for', () => {
  it('a compaction the server started counts once each; the bot\'s own, open at the time, does not', () => {
    const { adapter, session } = createAdapterWithSession();
    assert.equal(adapter.getOwnCompactionCount(key), 0);

    feedEvent(adapter, 'session.compacted');
    assert.equal(adapter.getOwnCompactionCount(key), 1, 'a context overflow compaction of the server');
    feedEvent(adapter, 'session.compacted');
    assert.equal(adapter.getOwnCompactionCount(key), 2);

    // `compactContext` holds this open while `POST /summarize` runs: the compaction is the bot's.
    session.isBotCompactionInFlight = true;
    feedEvent(adapter, 'session.compacted');
    assert.equal(adapter.getOwnCompactionCount(key), 2, 'the bot\'s own compaction is not the server\'s');
  });

  it('`session.next.compaction.ended` alone never counts (it may accompany the same compaction), and a compaction in a folder no topic is bound to is not ours', () => {
    const { adapter } = createAdapterWithSession();
    feedEvent(adapter, 'session.next.compaction.ended');
    assert.equal(adapter.getOwnCompactionCount(key), 0);
    feedEvent(adapter, 'session.compacted', 'ses_someone_else', '/tmp/a-folder-no-topic-is-bound-to');
    assert.equal(adapter.getOwnCompactionCount(key), 0, 'a by-hand OpenCode\'s compaction in a folder the bot does not own');
  });

  it('the count is dropped with the conversation when the adapter lets it go', () => {
    const { adapter } = createAdapterWithSession();
    feedEvent(adapter, 'session.compacted');
    assert.equal(adapter.getOwnCompactionCount(key), 1);
    adapter['stopSessionInner'](key);
    assert.equal(adapter.getOwnCompactionCount(key), 0, 'released with the conversation');
  });
});
