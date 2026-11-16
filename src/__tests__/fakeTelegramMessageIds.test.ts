/**
 * @description The fake Bot API's message ids never meet a thread id a flow hard-codes. A topic's id is the id of its root
 * message, and the bot rightly ignores a reply to that root (`extractReplyQuote`: a reply "in the topic"), so a message whose
 * id equalled its flow's hard-coded topic id was quoted by nobody — which message that was depended on how many the bot had
 * sent before, and `topicTalkersE2e` lost the quote of an admin's reply in about one full run of six under load. The ranges are
 * kept apart by the fake's first message id (`fakeTelegramFirstMessageId`).
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram, fakeTelegramFirstMessageId } from './telegramE2e/fakeTelegram';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** A hard-coded thread id of a flow: `const docsThreadId = 241;`, `topicThreadId = 151`, and in an object literal `{ threadId: 151, … }`. */
const hardCodedThreadIdPattern = /\b\w*[tT]hreadId\w*\s*[:=]\s*(\d+)\b/g;

function listTestFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listTestFiles(entryPath);
    return entry.name.endsWith('.ts') ? [entryPath] : [];
  });
}

function listHardCodedThreadIds(): number[] {
  // Not this file: its sample source holds an id beyond the bound on purpose.
  return listTestFiles(__dirname).filter((file) => file !== __filename).flatMap((file) =>
    [...fs.readFileSync(file, 'utf8').matchAll(hardCodedThreadIdPattern)].map((match) => Number(match[1])));
}

test('every thread id a flow hard-codes is below the first message id of the fake', () => {
  const threadIds = listHardCodedThreadIds();
  // Not vacuous: the scan really finds the flows' ids.
  assert.ok(threadIds.length > 20, `the scan found ${threadIds.length} hard-coded thread ids`);
  assert.ok(Math.max(...threadIds) < fakeTelegramFirstMessageId, `the highest hard-coded thread id is ${Math.max(...threadIds)}, the fake's messages start at ${fakeTelegramFirstMessageId}`);
});

test('the scan reads both forms of a hard-coded thread id: an assignment and an object-literal field', () => {
  const source = 'const docsThreadId = 241;\nconst topics = [{ threadId: 150000, folder: \'x\' }, { threadId : 7 }];\nconst someOtherId = 5;';
  assert.deepEqual([...source.matchAll(hardCodedThreadIdPattern)].map((match) => Number(match[1])), [241, 150000, 7]);
});

test('the fake numbers its messages and the topics it creates from its first message id', () => {
  const fake = new FakeTelegram({ botUser, operator, group });
  const firstMessageId = fake.pushOperatorMessage(111, 'first');
  const secondMessageId = fake.pushOperatorMessage(111, 'second');
  assert.equal(firstMessageId, fakeTelegramFirstMessageId);
  assert.equal(secondMessageId, fakeTelegramFirstMessageId + 1);
  assert.equal(fake.pushTopicCreated('a topic'), fakeTelegramFirstMessageId + 2, 'a topic id comes from the same sequence');
});
