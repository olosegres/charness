/**
 * @description Where `bot.ts` wires the boot recovery of a parked limit error (`utils/limitEpisodeRecovery.ts`) — the composition
 * root cannot be imported by a test, so the places are pinned in its source; the decisions are unit-tested in
 * `limitEpisodeRecovery.test.ts` and `claudeUsage.test.ts`, the whole path in `limitRecoveryE2e.test.ts`:
 *
 *   • the recovery and a settled wait stamp the EPISODE — the parked error's place in the log and the stamp of its whole `result`
 *     line, read off the tail — so the reply to the `mcp_status` request every boot sends an adopted session, appended after the
 *     stamp, does not re-arm it at the next boot, and a new process's limit at the same place is still a new one;
 *   • a recovered episode hands its own time on, and an unconfirmed wording is confirmed only by a usage reading taken no earlier
 *     than it — never by one the boot's usage poll, which runs beside the reattach, has not re-read or marked stale yet.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionBody } from './botSource';

test('the episode evidence is the tail\'s parked error with its place in the log', () => {
  const evidence = getFunctionBody('readLimitEpisodeEvidence');
  assert.match(evidence, /const tailStart = Math\.max\(0, log\.sizeBytes - limitEpisodeTailMaxBytes\);/);
  assert.match(evidence, /findParkedTerminalError\(readFileByteRange\(stdoutFile, tailStart, log\.sizeBytes\), tailStart\)/);
});

test('the recovery decides on the parked error\'s place and stamps that episode before it hands the error on', () => {
  const recovery = getFunctionBody('recoverLimitEpisodesFromDisk');
  assert.match(recovery, /const evidence = readLimitEpisodeEvidence\(stdoutFile\);/);
  assert.match(recovery, /errorEndOffset: parked\?\.endOffset \?\? null,/);
  assert.match(recovery, /errorStamp: parked\?\.stamp \?\? null,/);
  const stamp = recovery.indexOf('.setLimitEpisodeRecovered(key, buildLimitEpisodeMarker(log, parked))');
  const handOn = recovery.indexOf('handleApiError(key, decision.cls, { isRecoveredEpisode: true, episodeWrittenAtMs })');
  assert.ok(stamp > 0 && handOn > stamp, 'stamped first, then handed to the live-error path with the episode\'s own time');
  assert.match(recovery, /const episodeWrittenAtMs = errorWrittenAtMs \?\? log\.mtimeMs;/);
});

test('a wait settled without its resume stamps the same episode marker', () => {
  const settle = getFunctionBody('markLimitEpisodeSettled');
  assert.match(settle, /\.setLimitEpisodeRecovered\(key, buildLimitEpisodeMarker\(evidence\.log, evidence\.parked\)\)/);
});

test('a recovered unconfirmed wording is confirmed only by a reading taken no earlier than its error; a live one as before', () => {
  assert.match(getFunctionBody('handleApiError'), /handleUnconfirmedLimit\(key, options\.isRecoveredEpisode === true \? options\.episodeWrittenAtMs : undefined\)/);
  assert.match(getFunctionBody('handleUnconfirmedLimit'), /isUsageExhausted: checkIsTopicAccountUsageExhausted\(key, readingNotBeforeMs\)/);
  assert.match(getFunctionBody('checkIsTopicAccountUsageExhausted'), /checkIsClaudeUsageExhausted\(info\?\.usage, getThreadClaudeModel\(key\), nowMs, \{ readNotBeforeMs: readingNotBeforeMs \}\)/);
});
