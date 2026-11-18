/**
 * @description What the flows of the set-aside questions (`questionSetAsideE2e.test.ts`, `questionSetAsideIdleE2e.test.ts`) assert
 * the same way: the words the agent read when its question was set aside, and how such a question looks in the topic.
 */

import assert from 'node:assert/strict';
import type { FakeTelegram, FakeTelegramMessage } from '../telegramE2e/fakeTelegram';
import type { TopicDriver } from '../telegramE2e/topicDriver';
import { fakeAskQuestion, type FakeClaudeControlResponse } from '../jiraE2e/fakeClaudeContract';
import { enDict } from '../../i18n/en';
import type { SetAsideQuestionRecord } from '../../types';

/** The question of the fake agent's `ask` mode as the topic shows it: its header, its text and its option labels. */
export interface ShownQuestion {
  header: string;
  question: string;
  labels: readonly string[];
}

export const firstAskedQuestion: ShownQuestion = { header: fakeAskQuestion.header, question: fakeAskQuestion.question, labels: [fakeAskQuestion.shortOptionLabel, fakeAskQuestion.longOptionLabel] };

/** What the set-aside text tells the agent, asserted on the message the fake read as its tool result. */
export function assertToldToGoOn(response: FakeClaudeControlResponse): void {
  assert.equal(response.behavior, 'deny', 'the question\'s tool call is denied, not answered');
  assert.ok(response.message?.startsWith('[Charness] The user has not answered yet (asked '), `the agent is told nobody answered: ${response.message}`);
  assert.ok(response.message?.includes('This is NOT an answer.'), 'and that this is not an answer');
  assert.ok(response.message?.includes('do not ask it again and do not wait for it'), 'not to ask it again or wait');
  assert.ok(response.message?.includes('Go on with work that does not depend on it'), 'to go on');
  assert.ok(response.message?.includes('[Late answer to your question …]'), 'and how the answer will come');
  assert.notEqual(response.message, 'User declined to answer the question.', 'it is not the abandonment\'s decline');
}

/** The question is on screen as set aside: as asked, the note last, the same options as buttons that name the record, still pinned. */
export function assertShownAsSetAside(
  fakeTelegram: FakeTelegram,
  topic: TopicDriver,
  message: FakeTelegramMessage,
  record: SetAsideQuestionRecord,
  question: ShownQuestion,
  optionCount: number,
): void {
  const current = fakeTelegram.getMessage(message.message_id);
  assert.ok(current && !current.isDeleted, `message ${message.message_id} is still in the topic`);
  for (const part of [question.header, question.question, ...question.labels]) assert.ok(current.text.includes(part), `the question's «${part.slice(0, 40)}…» stays: ${current.text}`);
  assert.ok(current.text.endsWith(`\n\n${enDict['agent.question_set_aside_note']}`), `the text ends with the set-aside note: ${current.text.slice(-120)}`);
  assert.notEqual(current.reply_markup, undefined, 'the buttons stay');
  assert.deepEqual(topic.getKeyboardData(current), Array.from({ length: optionCount }, (_, optionIndex) => [`qs_${record.id}_${optionIndex}`]), 'one button per option, naming the record');
  assert.ok(fakeTelegram.listPinnedMessageIds().includes(current.message_id), 'the pin stays');
}
