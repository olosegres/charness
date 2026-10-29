/**
 * @description Wiring guard for the one seam of the re-asked-question work that no end-to-end flow reaches. The function lives
 * in the side-effecting `bot.ts` entrypoint, which a test cannot import, so — like `voiceQuestionCancelWiring` — it is
 * asserted against the source. Everything an end-to-end flow DOES reach is covered by `questionKeptE2e.test.ts` (a person
 * writing, a session that ends, the conversation switches, the release of saved ids, the boot order, a typed number that
 * reaches no session) and `openCodeQuestionE2e.test.ts` (a new question asked while the re-asked copy waits, an error while
 * a question is open), and is not repeated here.
 *
 *   - a tap that reached no session puts its question back, or — when a newer re-ask took its place — closes the tapped copy.
 *     The put-back is covered end to end; the closing of the copy needs a newer re-ask to appear while a tap is in flight.
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

test('a tap that reached no session puts its question back, and closes the tapped copy when a newer re-ask is there', () => {
  const body = getFunctionBody('async function returnReAskedQuestionAfterTap');
  assert.match(body, /putBackReAskedQuestion\(key,\s*reAsked\)\s*\|\|\s*messageId\s*===\s*null/);
  assert.match(body, /closeQuestionMessage\(key,\s*messageId,\s*reAsked\.question,\s*'unanswered'\)/);
});
