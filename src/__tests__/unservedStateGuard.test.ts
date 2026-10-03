/**
 * @description R13 (Jira connector plan J4b): an instance refuses to boot on a
 * `DATA_DIR` that holds conversations of a platform it does not serve — read
 * from a real state store, counted per platform and kind, never naming a key.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StateStore } from '../state';
import { getServedPlatforms } from '../platform/connectorSet';
import { getPersistedConversations, getUnservedStateError } from '../platform/unservedStateGuard';
import { createScheduleRecord } from '../scheduler/store';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { makeJiraKey } from '../connectors/jira/sessionKeyCodec';
import type { OpenRequestState } from '../requests/types';

const nowMs = Date.parse('2026-10-03T09:00:00Z');
const topicKey = makeTelegramKey(-1001111111111, 20);
const issueKey = makeJiraKey('PROJ-12');
const otherIssueKey = makeJiraKey('PROJ-13');

function createOpenRequest(id: string): OpenRequestState {
  return {
    id,
    origin: { kind: 'trackerEvent', attributes: {} },
    createdAt: nowMs,
    progressAnswerCount: 0,
    silentTurnCount: 0,
    wakeCount: 0,
  };
}

describe('the unserved-state guard (R13)', () => {
  let dataDir = '';
  let store: StateStore;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unserved-state-'));
    store = new StateStore(dataDir, { saveDebounceMs: 5 });
    await store.init();
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function addConversationsOfEveryKind(): Promise<void> {
    await store.setBinding(topicKey, 'topic-folder');
    await store.setBinding(issueKey, 'issue-folder');
    await store.setBinding(otherIssueKey, 'issue-folder');
    await store.updateOpenRequest(issueKey, () => createOpenRequest('req_issue'));
    await store.updateOpenRequest(topicKey, () => createOpenRequest('req_topic'));
    await store.upsertSchedule(createScheduleRecord({
      threadKey: issueKey,
      name: 'Nightly',
      spec: { kind: 'cron', cronExpr: '0 9 * * *' },
      prompt: 'check',
      createdBy: 'agent',
      nowMs,
    }));
    await store.setApiRetry(issueKey, { kind: 'transient', attempt: 1, fireAt: nowMs + 60_000 });
  }

  it('reads bindings, open requests, schedules and armed retries from the store', async () => {
    await addConversationsOfEveryKind();
    const kindsOfIssue = getPersistedConversations(store)
      .filter(({ key }) => key.platform === 'jira')
      .map(({ kind }) => kind)
      .sort();
    assert.deepEqual(kindsOfIssue, ['armed retries', 'bindings', 'bindings', 'open requests', 'schedules']);
  });

  it('a Telegram instance on a DATA_DIR with Jira conversations is refused, counted by kind, naming no key', async () => {
    await addConversationsOfEveryKind();
    const error = getUnservedStateError(getPersistedConversations(store), getServedPlatforms(['telegram']));
    assert.equal(
      error,
      'DATA_DIR holds conversations of a platform this instance does not serve — jira (bindings: 2, open requests: 1, schedules: 1, armed retries: 1). '
        + 'Start the instance that serves them on this DATA_DIR, or give this one a DATA_DIR of its own.',
    );
    assert.ok(!error?.includes('PROJ'), 'no issue key in the message');
  });

  it('a Jira instance on a DATA_DIR with Telegram conversations is refused the same way', async () => {
    await addConversationsOfEveryKind();
    assert.match(getUnservedStateError(getPersistedConversations(store), getServedPlatforms(['jira'])) ?? '', /— telegram \(bindings: 1, open requests: 1\)\./);
  });

  it('an instance serving every platform in its state, or an empty state, starts', async () => {
    assert.equal(getUnservedStateError(getPersistedConversations(store), getServedPlatforms(['jira'])), null);
    await addConversationsOfEveryKind();
    assert.equal(getUnservedStateError(getPersistedConversations(store), getServedPlatforms(['telegram', 'jira'])), null);
  });

  it('bot.ts refuses the start right after the store loads, before the request ledger or any session', () => {
    const botSource = fs.readFileSync(path.join(__dirname, '..', 'bot.ts'), 'utf8');
    const startBody = botSource.slice(botSource.indexOf('export async function startBot('));
    const check = startBody.indexOf('getUnservedStateError(getPersistedConversations(state), ENV.servedPlatforms)');
    const exit = startBody.indexOf('process.exit(1);', check);
    assert.ok(check > startBody.indexOf('state = await getStateStore();'), 'after the store loads');
    assert.ok(check >= 0 && exit > check && exit < startBody.indexOf('await requestLedger.load();'), 'and exits before the ledger loads');
  });
});
