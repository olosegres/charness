/**
 * @description Wiring guards for the places `bot.ts` closes the question the idle compaction re-asked. The functions live in
 * the side-effecting `bot.ts` entrypoint, which a test cannot import, so — like `voiceQuestionCancelWiring` — the seams are
 * asserted against the source; the behaviour of the closing itself is covered in `compaction.test.ts` and, end to end, by the
 * second flow of `questionKeptE2e.test.ts`.
 *
 *   - a person writing anything closes the re-asked copy (`notePersonActivity`);
 *   - a question the agent asks anew closes it too (`handleAgentQuestion`): the copy's buttons would answer the wrong question,
 *     and no person's message is needed for the agent to ask — a scheduled or resumed turn can;
 *   - the boot brings the saved copies back after the sessions reattached (`restoreReAskedQuestions`);
 *   - a message typed while a session is starting or stopping counts as a person writing (`bufferPromptDuringStartup`);
 *   - a tap that reached no session puts its question back, or — when a newer re-ask took its place — closes the tapped copy;
 *   - a session that ends or errors closes the question that was open (`handleAgentClosed`, `handleAgentError`; the latter is
 *     raised by the OpenCode adapter only, which the json-stream flows cannot drive);
 *   - leaving a conversation for another (a `/sessions` pick, a switch of backend) closes the re-asked copy it leaves behind;
 *   - every release of a conversation's ids goes through one helper that also closes the re-asked copy.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const botSource = fs.readFileSync(path.join(__dirname, '..', 'bot.ts'), 'utf8');

/** One function's body, so an unrelated call elsewhere in `bot.ts` cannot satisfy an assertion. */
function getFunctionBody(declaration: string): string {
  const startIndex = botSource.indexOf(declaration);
  assert.notEqual(startIndex, -1, `${declaration} must exist in bot.ts`);
  const after = botSource.slice(startIndex + 1);
  const nextDeclaration = after.search(/\n(?:async function|function) /);
  return after.slice(0, nextDeclaration === -1 ? undefined : nextDeclaration);
}

test('a person writing closes the question the idle compaction re-asked', () => {
  assert.match(getFunctionBody('function notePersonActivity'), /closeReAskedQuestion\(key\)/);
});

test('a question the agent asks anew closes it too, before anything of the new one is shown', () => {
  const body = getFunctionBody('function handleAgentQuestion');
  const closeIndex = body.search(/closeReAskedQuestion\(key\)/);
  assert.notEqual(closeIndex, -1, 'handleAgentQuestion closes the re-asked copy');
  assert.ok(closeIndex < body.indexOf('setPendingQuestion('), 'and does so before the new question is registered');
});

test('the boot restores the saved copies after it restored the pending questions', () => {
  const bootIndex = botSource.indexOf('restorePendingQuestions();\n');
  assert.notEqual(bootIndex, -1);
  assert.ok(botSource.indexOf('restoreReAskedQuestions();', bootIndex) > bootIndex, 'restoreReAskedQuestions() follows restorePendingQuestions()');
  assert.match(getFunctionBody('function restoreReAskedQuestions'), /getResumableSessionId\(key\) !== null/, 'a copy is kept only for a conversation that can be resumed');
});

test('a message buffered for a starting or stopping session counts as a person writing, before anything else is done with it', () => {
  const body = getFunctionBody('async function bufferPromptDuringStartup');
  const noteIndex = body.search(/notePersonActivity\(key\)/);
  assert.notEqual(noteIndex, -1, 'the startup twin of deliverActivePrompt notes the person');
  assert.ok(noteIndex < body.indexOf('openTopicRequest('), 'before the request is opened');
});

test('a tap that reached no session puts its question back, and closes the tapped copy when a newer re-ask is there', () => {
  const body = getFunctionBody('async function returnReAskedQuestionAfterTap');
  assert.match(body, /putBackReAskedQuestion\(key,\s*reAsked\)\s*\|\|\s*messageId\s*===\s*null/);
  assert.match(body, /closeQuestionMessage\(key,\s*messageId,\s*reAsked\.question,\s*'unanswered'\)/);
});

test('a session that ends or errors closes the question that was open, not only clears it', () => {
  for (const declaration of ['function handleAgentClosed', 'function handleAgentError']) {
    assert.match(getFunctionBody(declaration), /retirePendingQuestionInBackground\(key\)/, `${declaration} closes the open question's message`);
  }
});

test('leaving a conversation for another closes the re-asked copy it leaves behind', () => {
  assert.match(getFunctionBody('async function switchThreadAdapter'), /cancelConversationRequest\(key\)[\s\S]{0,300}closeReAskedQuestion\(key\)/, 'a switch to another backend');
  assert.match(getFunctionBody('async function resumeSessionByIndex'), /cancelConversationRequest\(key\)[\s\S]{0,200}closeReAskedQuestion\(key\)/, 'a pick from /sessions');
});

test('releasing a conversation\'s ids closes its re-asked copy, in one place', () => {
  const helperBody = getFunctionBody('async function releaseConversationIds');
  assert.match(helperBody, /state\.clearAgentSessionIds\(key\)/);
  assert.match(helperBody, /clearThreadCompaction\(key\)/);
  // The four releases of a conversation that may be asleep (no process, so no stop event to close the copy) use it.
  assert.match(getFunctionBody('async function releaseThreadSession'), /releaseConversationIds\(key\)/, '/new');
  assert.match(getFunctionBody('async function unbindThread'), /releaseConversationIds\(key\)/, 'leaving the folder');
  assert.match(botSource, /releaseConversationIds\(bKey\)/, '/quitall');
  assert.match(botSource, /await releaseConversationIds\(key\);\s*await replyToThread\(key, t\('agent\.sleeping_released'\)\)/, '/quit of a sleeping conversation');
  // No site pairs the two steps by hand any more: a new one would repeat the comment, or forget the second step.
  const outsideHelper = botSource.replace(helperBody, '');
  assert.doesNotMatch(outsideHelper, /clearAgentSessionIds\([^)]*\);\s*(?:\/\/[^\n]*\s*)*clearThreadCompaction\(/);
});
