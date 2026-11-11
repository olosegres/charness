/**
 * @description Helpers for the structural wiring tests of `bot.ts`: the handlers live in the side-effecting entrypoint and
 * depend on Telegram, download and transcription I/O, so a test reads the SOURCE to lock the seams between pure pieces.
 * Not a test file (it matches no test glob).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert/strict';

export const botSource = fs.readFileSync(path.join(__dirname, '..', 'bot.ts'), 'utf8');

/** The source from `startMarker` up to (not including) the next `endMarker`. */
export function getSourceSlice(startMarker: string, endMarker: string): string {
  const startIdx = botSource.indexOf(startMarker);
  assert.notEqual(startIdx, -1, `${startMarker} must exist in bot.ts`);
  const endIdx = botSource.indexOf(endMarker, startIdx + startMarker.length);
  assert.notEqual(endIdx, -1, `${endMarker} must follow ${startMarker} in bot.ts`);
  return botSource.slice(startIdx, endIdx);
}

/** A top-level function's body — up to the next top-level declaration. */
export function getFunctionBody(name: string): string {
  const startIdx = botSource.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  assert.notEqual(startIdx, -1, `${name} must exist in bot.ts`);
  const after = botSource.slice(startIdx + 1);
  const nextDeclMatch = after.search(/\n(?:async function|function) /);
  return after.slice(0, nextDeclMatch === -1 ? undefined : nextDeclMatch);
}
