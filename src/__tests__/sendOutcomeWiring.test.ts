/**
 * @description Wiring guard for the Bot API calls of unknown outcome in `bot.ts` (which a test cannot import: its module-scope
 * `parseEnv()` exits the process). A call the Bot API did not answer within the send queue's deadline may have landed, so it is
 * never made again — not as a fresh send after an edit, not as a plain-text retry, not as a second notice. The rules live in
 * helpers with their own tests (`sendOutcome.test.ts`, `pinnedNoticeSlot.test.ts`); this pins that `bot.ts` goes through them.
 * The question's plain retry is also covered live by the `questionKeptE2e` flow.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const botSource = fs.readFileSync(path.join(__dirname, '..', 'bot.ts'), 'utf8');

/** A top-level function's body — up to the next top-level declaration. */
function getFunctionBody(name: string): string {
  const startIdx = botSource.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  assert.notEqual(startIdx, -1, `${name} must exist in bot.ts`);
  const nextIdx = botSource.slice(startIdx + 1).search(/\n(?:async function|function|interface|const|\/\*\*)/);
  return botSource.slice(startIdx, nextIdx === -1 ? undefined : startIdx + 1 + nextIdx);
}

test('an edit of unknown outcome counts as made for every caller of the edit helpers', () => {
  assert.match(getFunctionBody('editThreadMessageDetailed'), /return getCallerEditResult\(await editThreadMessageWithOutcome\(/);
  assert.match(getFunctionBody('editThreadMessage'), /return \(await editThreadMessageDetailed\([^)]*\)\) === 'edited';/);
});

test('the output flush lands its chunks through sendOutputChunks and hands its result to the backlog as it is', () => {
  const body = getFunctionBody('sendOutputImmediate');
  assert.match(body, /const result = await sendOutputChunks\(chunks, shouldEditFirstChunk, msgState, \{/);
  assert.match(body, /editLastMessage: \(messageId, chunk\) => editThreadMessageWithOutcome\(/);
  assert.match(body, /sendChunk: \(chunk\) => replyChunkDetailed\(/);
  assert.match(body, /return result;/);
  assert.equal(body.includes('replyToThread('), false, 'no send of its own');
});

test('a failed send says whether trying again may help, by the one rule the unpins use: a refusal for good is not retried for ever', () => {
  const body = getFunctionBody('replyToThreadDetailed');
  const failures = body.match(/return \{ kind: 'failed'[^}]*\}/g) ?? [];
  assert.deepEqual(failures, [
    "return { kind: 'failed', isRetryable: false }",
    "return { kind: 'failed', isRetryable: false }",
    "return { kind: 'failed', isRetryable: checkIsTelegramFailureRetryable(e2) }",
    "return { kind: 'failed', isRetryable: checkIsTelegramFailureRetryable(e) }",
  ], 'not a Telegram topic, aborted by the caller, then the Bot API failures');
});

test('a chunk of unknown outcome is not sent again as plain text', () => {
  assert.match(getFunctionBody('replyChunkDetailed'), /if \(outcome\.kind !== 'failed'\) return outcome;/);
});

test('the question is posted again as plain text only after a post that failed', () => {
  const body = getFunctionBody('postPendingQuestionAt');
  assert.match(body, /if \(outcome\.kind === 'failed'\) \{\n\s*outcome = await replyToThreadDetailed\(/);
  assert.equal(body.includes('await replyToThread('), false, 'no send that cannot tell an unknown outcome from a failure');
});

test('the logged-out and limit-resumed notices go through the one-notice slot', () => {
  assert.match(getFunctionBody('surfaceLoggedOutNotice'), /await surfacePinnedNotice\(authNoticePinnedMessageId, keyToString\(key\), getPinnedNoticePorts\(/);
  assert.match(getFunctionBody('surfaceLimitResumedNotice'), /await surfacePinnedNotice\(limitResumeNoticePinnedMessageId, keyToString\(key\), getPinnedNoticePorts\(/);
  assert.match(getFunctionBody('getPinnedNoticePorts'), /send: \(\) => replyToThreadDetailed\(key, text\),/);
});
