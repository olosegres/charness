/**
 * @description Wiring guard for the wait of a post on the text the agent streamed before it (`bot.ts`, which a test cannot import:
 * its module-scope `parseEnv()` exits the process). What the agent's tool call posts — the «🔧 tool» status frame, a question, an
 * answer, the messages of `send_messages_to_user` — waits until that text has landed, so it lands below it; but at most
 * `streamedOutputLandingLimitMs`, so a landing that never ends holds nothing for ever. The limit itself is covered by
 * `streamedOutputLanding.test.ts`; this pins that every such wait goes through it.
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

/** The lines of `source` that are not comments. */
function getCodeLines(source: string): string[] {
  return source.split('\n').filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'));
}

test('the «🔧 tool» status frame waits for the streamed text at most the landing limit', () => {
  const body = getFunctionBody('handleAgentStatus');
  assert.match(body, /await landStreamedOutputWithinLimit\(\(\) => getOutboundFor\(key\)\.finalize\(key\), keyToString\(key\)\);/);
  assert.deepEqual(getCodeLines(body).filter((line) => line.includes('await getOutboundFor(key).finalize(key)')), [], 'no wait without the limit');
});

test('every wait of a post on the streamed text goes through the landing limit', () => {
  // The bare landing is awaited in exactly one place, the one that every capped wait wraps.
  const bareLandings = getCodeLines(botSource).filter((line) => line.includes('await getOutboundFor(key).finalize(key)'));
  assert.equal(bareLandings.length, 1, bareLandings.join('\n'));
  assert.match(getFunctionBody('landStreamedOutputOfThread'), /await getOutboundFor\(key\)\.finalize\(key\);/);
  // Its callers: the question path wraps it; `send_messages_to_user` and the answer get it as their port, which
  // `sendMessagesToThread` wraps (`utils/messageSendService.ts`).
  const callers = getCodeLines(botSource).filter((line) => line.includes('landStreamedOutputOfThread') && !line.includes('async function landStreamedOutputOfThread'));
  assert.deepEqual(callers.map((line) => line.trim()), [
    'const streamedOutputLanding = landStreamedOutputWithinLimit(() => landStreamedOutputOfThread(key), keyToString(key));',
    'landStreamedOutput: landStreamedOutputOfThread,',
  ]);
  const messageSendSource = fs.readFileSync(path.join(__dirname, '..', 'utils', 'messageSendService.ts'), 'utf8');
  assert.match(messageSendSource, /await landStreamedOutputWithinLimit\(\(\) => deps\.landStreamedOutput\(target\), threadKey\);/);
});
