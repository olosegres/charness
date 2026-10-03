/**
 * @description A conversation of another platform on the Telegram side of the
 * bot (Jira connector plan J2, D19): the locale and the preamble's group title
 * fall back instead of throwing, every Telegram I/O primitive is refused (logged
 * once per primitive and conversation), each platform's outbound is found by
 * the conversation key, and Jira's outbound drops stream content.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultLocale, type Locale } from '../i18n';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { makeJiraKey } from '../connectors/jira/sessionKeyCodec';
import {
  createTelegramPrimitiveGuard,
  getTelegramConversationLocale,
  getTelegramConversations,
  getTelegramPreambleGroupTitle,
  type TelegramChatLocaleStore,
} from '../connectors/telegram/foreignKeyFallbacks';
import { createJiraConnectorOutbound, jiraFileSendRefusal } from '../connectors/jira/outbound';
import { getConnectorOutbound, type ConnectorOutbound, type ConnectorOutbounds } from '../platform/outbound';
import { createTestConnector } from '../connectors/test/connector';
import { getSchedulerScopePlatform } from '../scheduler/mcpSurface';

const chatId = -1001234567890;
const topicKey = makeTelegramKey(chatId, 42);
const issueKey = makeJiraKey('PROJ-12');

/** A store whose every read is recorded, so a foreign key provably never reaches it. */
function createLocaleStore(locales: { override: Locale | null; telegram: Locale | null }): TelegramChatLocaleStore & { reads: number[] } {
  const reads: number[] = [];
  return {
    reads,
    getChatLocaleOverride: (id) => { reads.push(id); return locales.override; },
    getChatTelegramLocale: (id) => { reads.push(id); return locales.telegram; },
  };
}

describe('getTelegramConversationLocale', () => {
  it('a Telegram chat: the override, else the Telegram locale, else the default', () => {
    assert.equal(getTelegramConversationLocale(topicKey, createLocaleStore({ override: 'de', telegram: 'ru' })), 'de');
    assert.equal(getTelegramConversationLocale(topicKey, createLocaleStore({ override: null, telegram: 'ru' })), 'ru');
    assert.equal(getTelegramConversationLocale(topicKey, createLocaleStore({ override: null, telegram: null })), defaultLocale);
  });

  it('a Jira conversation gets the default without a Telegram chat lookup', () => {
    const store = createLocaleStore({ override: 'de', telegram: 'ru' });
    assert.equal(getTelegramConversationLocale(issueKey, store), defaultLocale);
    assert.deepEqual(store.reads, []);
  });

  it('before the state store exists, the default', () => {
    assert.equal(getTelegramConversationLocale(topicKey, null), defaultLocale);
  });
});

describe('getTelegramPreambleGroupTitle', () => {
  const sources = (cached: string | undefined, isDm: boolean) => ({
    getCachedGroupTitle: (id: number) => (id === chatId ? cached : undefined),
    checkIsDmKey: () => isDm,
    getBotName: () => 'example_bot',
  });

  it('the cached group title, else the bot name in the owner DM, else nothing', () => {
    assert.equal(getTelegramPreambleGroupTitle(topicKey, sources('ExampleGroup', false)), 'ExampleGroup');
    assert.equal(getTelegramPreambleGroupTitle(topicKey, sources(undefined, true)), 'example_bot');
    assert.equal(getTelegramPreambleGroupTitle(topicKey, sources(undefined, false)), undefined);
  });

  it('a Jira conversation has no group title and does not throw', () => {
    assert.equal(getTelegramPreambleGroupTitle(issueKey, sources('ExampleGroup', true)), undefined);
  });
});

describe('createTelegramPrimitiveGuard', () => {
  it('lets a Telegram key through silently and refuses a Jira key, logging once per primitive', () => {
    const lines: string[] = [];
    const guard = createTelegramPrimitiveGuard((line) => lines.push(line));

    assert.equal(guard(topicKey, 'replyToThread'), true);
    assert.equal(guard(issueKey, 'replyToThread'), false);
    assert.equal(guard(issueKey, 'replyToThread'), false);
    assert.equal(guard(issueKey, 'pinThreadQuestion'), false);

    assert.equal(lines.length, 2, 'one line per primitive and conversation');
    assert.match(lines[0], /replyToThread skipped: jira conversation PROJ\/PROJ-12/);
    assert.match(lines[1], /pinThreadQuestion/);
  });
});

describe('getTelegramConversations', () => {
  it('keeps the Telegram bindings in order and drops a Jira one, whose chat id would throw', () => {
    const otherTopicKey = makeTelegramKey(chatId, 7);
    const bindings = [
      { key: topicKey, data: { subdir: 'app' } },
      { key: issueKey, data: { subdir: 'proj' } },
      { key: otherTopicKey, data: { subdir: 'web' } },
    ];

    assert.deepEqual(
      getTelegramConversations(bindings).map(({ data }) => data.subdir),
      ['app', 'web'],
    );
    assert.equal(bindings.length, 3, 'the input list is left as it was');
  });
});

describe('getConnectorOutbound', () => {
  const telegramStandIn: ConnectorOutbound = createTestConnector();
  const jiraOutbound = createJiraConnectorOutbound();
  const outbounds: ConnectorOutbounds = new Map([['telegram', telegramStandIn], ['jira', jiraOutbound]]);

  it("finds the outbound of the conversation's own platform", () => {
    assert.equal(getConnectorOutbound(outbounds, topicKey), telegramStandIn);
    assert.equal(getConnectorOutbound(outbounds, issueKey), jiraOutbound);
  });

  it('a platform this process did not wire is a bug, not a silent drop', () => {
    assert.throws(() => getConnectorOutbound(new Map([['telegram', telegramStandIn]]), issueKey), /No connector outbound for platform "jira"/);
  });
});

describe('the Jira outbound', () => {
  it('drops stream content and activity, holds nothing to finalize, and refuses files with a reason', async () => {
    const outbound = createJiraConnectorOutbound();

    await outbound.deliver(issueKey, { text: 'streamed chunk', keepVisible: true });
    for (const activity of ['working', 'idle', 'starting'] as const) outbound.setActivity(issueKey, activity);
    assert.equal(outbound.checkIsDelivering(issueKey), false);
    assert.deepEqual(outbound.listUnfinalizedKeys(), []);
    assert.deepEqual(await outbound.deliverFile(issueKey, { paths: ['/tmp/report.png'] }), { ok: false, error: jiraFileSendRefusal });
    assert.equal(outbound.capabilities.attachments, false);
    assert.equal(outbound.capabilities.pinMessages, false);
  });
});

describe('getSchedulerScopePlatform', () => {
  it('a thread token names its key\'s platform; a folder token is an OpenCode (Telegram) one; an unreadable key none', () => {
    assert.equal(getSchedulerScopePlatform({ kind: 'thread', threadKey: '-1001234567890:42' }), 'telegram');
    assert.equal(getSchedulerScopePlatform({ kind: 'thread', threadKey: 'jira:PROJ:PROJ-12' }), 'jira');
    assert.equal(getSchedulerScopePlatform({ kind: 'dir', directory: '/home/user/projects/app' }), 'telegram');
    assert.equal(getSchedulerScopePlatform({ kind: 'thread', threadKey: 'not-a-key' }), null);
  });
});
