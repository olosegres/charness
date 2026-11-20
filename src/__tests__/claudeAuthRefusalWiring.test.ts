/**
 * @description Where `bot.ts` wires the accounts the CLI cannot run a conversation on (`utils/claudeAuthRefusal.ts`) — the
 * composition root cannot be imported by a test (its module scope parses the environment and exits), so the places are pinned
 * in its source; the decisions themselves are unit-tested in `claudeAuthRefusal.test.ts` and `claudeAuthRefusalDetection.test.ts`:
 *
 *   • every spawn's config directory comes through the launch pick, which leaves an account known not to work and records the
 *     account it goes to as the conversation's own pick;
 *   • an `auth` error of a json-stream conversation is the move (the limit move's own function, the sign-in notice), not only the
 *     pinned notice — which stays for every other backend and for nowhere to go;
 *   • the profile scan the usage poll and `/accounts` run ends the refusals of accounts signed in again and logs the changes.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { botSource, getFunctionBody } from './botSource';

test('every spawn reads its account through the launch pick, which records a move as the conversation\'s own pick', () => {
  assert.match(getFunctionBody('resolveThreadClaudeConfigDir'), /const name = resolveThreadClaudeProfileForLaunch\(key\);/);
  assert.match(botSource, /registerClaudeConfigDirReader\(resolveThreadClaudeConfigDir\);/, 'the adapters\' one reader');
  const launch = getFunctionBody('resolveThreadClaudeProfileForLaunch');
  assert.ok(launch.indexOf('settleClaudeAuthRefusal(resolved)') < launch.indexOf('checkIsClaudeProfileKnownUnusable(record)'), 'a sign-in since the refusal is read first');
  assert.match(launch, /resolveClaudeProfileForLaunch\(/);
  assert.match(launch, /state\.setClaudeProfileOverride\(key, launch\.name\)/);
});

test('an `auth` error of a json-stream conversation is the move; every other backend keeps the pinned notice', () => {
  assert.match(getFunctionBody('handleApiError'), /if \(action\.action === 'surface'\) \{\s*if \(getThreadAdapter\(key\) instanceof ClaudeJsonStreamAdapter\) void handleClaudeAuthRefusal\(key, cls\);\s*else void surfaceLoggedOutNotice\(key\);/);
  const move = getFunctionBody('handleClaudeAuthRefusal');
  assert.match(move, /planClaudeAuthRefusalMove\(/);
  assert.ok(move.indexOf('state.setClaudeProfileAuthRefusal(from.profile, refusal)') < move.indexOf('switchTopicToFallbackEntry('), 'the account is marked before the move reads the accounts');
  assert.equal(move.match(/surfaceLoggedOutNotice\(key\)/g)?.length, 4, 'no Claude account, nothing to mark, nowhere to go, a move that failed');
});

test('the profile scan of the usage poll and of /accounts ends the refusals of accounts signed in again and logs the changes', () => {
  assert.match(botSource, /syncProfiles: \(\) => syncClaudeProfilesAndRefusals\(\),/);
  assert.match(botSource, /syncClaudeProfiles: \(options\) => syncClaudeProfilesAndRefusals\(options\),/);
  const scan = getFunctionBody('syncClaudeProfilesAndRefusals');
  assert.ok(scan.indexOf('claudeProfileSync.sync(options)') < scan.indexOf('settleClaudeAuthRefusal(name)'), 'the probes first, then the refusals they may end');
  assert.match(scan, /noteClaudeProfileUsability\(\);/);
});
