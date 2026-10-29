/**
 * @description Wiring guards for the seams of the re-asked-question work that no end-to-end flow reaches. The functions live in
 * the side-effecting `bot.ts` entrypoint, which a test cannot import, so — like `voiceQuestionCancelWiring` — they are
 * asserted against the source. Everything an end-to-end flow DOES reach (a person writing, a session that ends, the conversation
 * switches, the release of saved ids, the boot order) is covered by `questionKeptE2e.test.ts` and is not repeated here.
 *
 *   - a question the agent asks anew closes the re-asked copy (`handleAgentQuestion`): the copy's buttons would answer the
 *     wrong question, and the fake agent cannot ask without a person's message, which closes the copy first;
 *   - `handleAgentError` closes the open question's message like `handleAgentClosed` does: it is raised by the OpenCode
 *     adapter only, which the json-stream flows cannot drive;
 *   - a tap that reached no session puts its question back, or — when a newer re-ask took its place — closes the tapped copy.
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

test('a question the agent asks anew closes it too, before anything of the new one is shown', () => {
  const body = getFunctionBody('function handleAgentQuestion');
  const closeIndex = body.search(/closeReAskedQuestion\(key\)/);
  assert.notEqual(closeIndex, -1, 'handleAgentQuestion closes the re-asked copy');
  assert.ok(closeIndex < body.indexOf('setPendingQuestion('), 'and does so before the new question is registered');
});

test('a tap that reached no session puts its question back, and closes the tapped copy when a newer re-ask is there', () => {
  const body = getFunctionBody('async function returnReAskedQuestionAfterTap');
  assert.match(body, /putBackReAskedQuestion\(key,\s*reAsked\)\s*\|\|\s*messageId\s*===\s*null/);
  assert.match(body, /closeQuestionMessage\(key,\s*messageId,\s*reAsked\.question,\s*'unanswered'\)/);
});

test('a session that errors closes the question that was open, not only clears it', () => {
  assert.match(getFunctionBody('function handleAgentError'), /retirePendingQuestionInBackground\(key\)/);
});
