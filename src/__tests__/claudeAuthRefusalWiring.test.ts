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

/**
 * Assert that `first` stands before `second` in `body`, and that BOTH stand there: `indexOf` answers -1 for a missing text, so a bare
 * `first.indexOf < second.indexOf` passes without checking anything when `first` was rewritten away.
 */
function assertOrder(body: string, first: string, second: string, message: string): void {
  const firstIndex = body.indexOf(first);
  const secondIndex = body.indexOf(second);
  assert.ok(firstIndex >= 0, `${first} is in the source (${message})`);
  assert.ok(secondIndex >= 0, `${second} is in the source (${message})`);
  assert.ok(firstIndex < secondIndex, message);
}

test('every spawn reads its account through the launch pick, which records a move as the conversation\'s own pick', () => {
  assert.match(getFunctionBody('resolveThreadClaudeConfigDir'), /const name = resolveThreadClaudeProfileForLaunch\(key\);/);
  assert.match(botSource, /registerClaudeConfigDirReader\(resolveThreadClaudeConfigDir\);/, 'the adapters\' one reader');
  const launch = getFunctionBody('resolveThreadClaudeProfileForLaunch');
  assertOrder(launch, 'settleClaudeAuthRefusal(resolved)', 'checkIsClaudeProfileKnownUnusable(record)', 'a sign-in since the refusal is read first');
  assert.match(launch, /resolveClaudeProfileForLaunch\(/);
  assert.match(launch, /state\.setClaudeProfileOverride\(key, launch\.name\)/);
});

test('an `auth` error of a json-stream conversation is the move; every other backend keeps the pinned notice', () => {
  // The turn end stays held until the move, the wait or the notice has landed (review 16 #1: `forwardPromptWiring.test.ts`).
  assert.match(getFunctionBody('handleApiError'), /if \(action\.action === 'surface'\) \{\s*holdTurnEndWhileHandlingApiError\(key, getThreadAdapter\(key\) instanceof ClaudeJsonStreamAdapter \? handleClaudeAuthRefusal\(key, cls\) : surfaceLoggedOutNotice\(key\)\);/);
  const move = getFunctionBody('handleClaudeAuthRefusal');
  assert.match(move, /planClaudeAuthRefusalMove\(/);
  assertOrder(move, 'state.setClaudeProfileAuthRefusal(from.profile, refusal)', 'switchTopicToFallbackEntry(', 'the account is marked before the move reads the accounts');
  assert.equal(move.match(/surfaceLoggedOutNotice\(key\)/g)?.length, 3, 'no Claude account, nothing to mark, a move that failed');
  assert.match(move, /if \(instead === null\) \{[^]*?await waitForClaudeAccount\(key\);\s*return;/, 'nowhere to go: the conversation waits for an account');
});

test('a tracker issue hears the move in plain words before it happens; a topic hears the move\'s own notice', () => {
  const move = getFunctionBody('handleClaudeAuthRefusal');
  const notice = move.indexOf("t('requests.account.movedAnswer'");
  assert.ok(notice > 0 && notice < move.indexOf('switchTopicToFallbackEntry('));
  assert.match(move, /if \(!checkIsTelegramKey\(key\) && requestLimitWaitAnswerDeps\) \{\s*await answerOpenRequestsWithBotNotice\(/);
});

test('with nowhere to go the conversation waits: marked, its requests no longer woken, a tracker issue told why in plain words', () => {
  const wait = getFunctionBody('waitForClaudeAccount');
  assertOrder(wait, 'state.setWaitingForClaudeAccount(key, true)', 'stopWakingForLimitWait(key)', 'the conversation is marked waiting before its requests stop being woken');
  assert.match(wait, /if \(checkIsTelegramKey\(key\) \|\| !requestLimitWaitAnswerDeps\) \{\s*await surfaceLoggedOutNotice\(key\);/);
  assert.match(wait, /identity: 'claudeAccountWait',\s*body: t\('requests\.account\.noneUsableAnswer', \{ reasons \}\),\s*isWakeStopped: true,/);
});

test('every round of the accounts\' states tells the operator and resumes the waiting conversations — from the end of the boot on', () => {
  const round = getFunctionBody('noteClaudeProfileUsability');
  assert.match(round, /if \(!isOperatorAlertOpen\) return;\s*tellOperatorAboutClaudeAccounts\(current, backByStatusCheck\);\s*void resumeConversationsWaitingForAccount\(\);/);
  const restored = botSource.slice(botSource.indexOf('onSessionsRestored: () => {'));
  assertOrder(restored, 'jiraConnector?.start(', 'openOperatorAlerts();', 'the connectors\' channels are known first');
  assert.match(botSource, /operatorAlertChannels = jiraConnector\?\.operatorChannel \? \[jiraConnector\.operatorChannel\] : \[\];/);
  const deliver = getFunctionBody('deliverClaudeAccountAlert');
  assert.match(deliver, /if \(ENV\.isTelegramServed\) posts\.push\(postClaudeAccountAlertToTelegram\(alert\)\);/);
  assert.match(deliver, /runWithLocale\('en', \(\) => renderClaudeAccountAlert\(alert, getHostClaudeSignInHow\)\)/, 'a connector\'s channel reads English and the host\'s sign-in');
  const resume = getFunctionBody('resumeConversationsWaitingForAccount');
  assertOrder(resume, 'applyClaudeProfileToThread(key, { isAfterLimit: true })', 'resumeTopicOnNewSession(key,', 'moved onto an account that works before the continue prompt');
});

test('the profile scan of the usage poll and of /accounts ends the refusals of accounts signed in again and logs the changes', () => {
  assert.match(botSource, /syncProfiles: \(\) => syncClaudeProfilesAndRefusals\(\),/);
  assert.match(botSource, /syncClaudeProfiles: \(options\) => syncClaudeProfilesAndRefusals\(options\),/);
  const scan = getFunctionBody('syncClaudeProfilesAndRefusals');
  assertOrder(scan, 'claudeProfileSync.sync(options)', 'settleClaudeAuthRefusal(name)', 'the probes first, then the refusals they may end');
  assert.match(scan, /noteClaudeProfileUsability\(\);/);
});

test('the private sign-out messages go BEFORE General\'s post (it must know a refusal), write back only their own ids, and an account signed in again turns its message', () => {
  const telegram = getFunctionBody('postClaudeAccountAlertToTelegram');
  assertOrder(
    telegram,
    'await sendClaudeAccountSignOutDms(alert)',
    'postClaudeAccountAlertToGeneral(alert, { isPrivateChatClosed })',
    'General\'s alert asks for a private chat only when the private message was refused: it needs the outcome first',
  );
  assert.match(telegram, /settleClaudeAccountSignOutDms\(alert\)/);
  const send = getFunctionBody('sendClaudeAccountSignOutDms');
  assert.doesNotMatch(send, /setClaudeAccountAlertState\(/, 'a send that waited on Telegram never writes back the record it read before');
  assert.match(send, /await state\.setClaudeAccountAlertSignOutMessageId\(name, outcome\.messageId\);/);
  assert.match(send, /outcome\.kind === 'failed' && outcome\.isForbidden === true\) \{\s*isPrivateChatClosed = true;/, 'Telegram\'s 403 makes General ask for a private chat');
  assert.equal(send.match(/isPrivateChatClosed = true/g)?.length, 1, 'and nothing else does: a network error or any other failed send must not');
  const turn = getFunctionBody('markClaudeAccountSignOutDmSignedIn');
  assertOrder(turn, 'setClaudeAccountAlertSignOutMessageId(name, null)', 'editThreadMessage(privateKey, messageId, text)', 'the id is dropped first: a failed edit is never retried');
});

test('the General post writes back ONLY its pin, read after its waits — never the record it read before them', () => {
  const post = getFunctionBody('postClaudeAccountAlertToGeneral');
  assert.doesNotMatch(post, /setClaudeAccountAlertState\(/);
  const pinned = post.indexOf('await pinMessageQuiet(generalKey, messageId');
  const read = post.indexOf('state.getClaudeAccountAlertState()?.pinnedMessageId');
  assert.ok(pinned > 0 && read > pinned && read < post.indexOf('await state.setClaudeAccountAlertPinnedMessageId(messageId)'), 'the previous pin is read after the waits');
  const release = getFunctionBody('releaseClaudeAccountAlertPin');
  assert.match(release, /current\.alerted\.length > 0/);
  assert.match(release, /await state\.setClaudeAccountAlertPinnedMessageId\(null\);/);
  assert.match(getFunctionBody('tellOperatorAboutClaudeAccounts'), /if \(alert !== null\) void deliverClaudeAccountAlert\(alert\);\s*\/\/[^\n]*\n\s*else void releaseClaudeAccountAlertPin\(\);/, 'a quiet return still drops the pin');
});

test('a refusal a status check ended is kept as such, and a repeat of it is marked from that record', () => {
  const settle = getFunctionBody('settleClaudeAuthRefusal');
  assert.match(settle, /const end = getClaudeAuthRefusalEnd\(/);
  assert.match(settle, /end === 'statusCheck'\s*\? state\.endClaudeProfileAuthRefusalByStatusCheck\(name, new Date\(\)\.toISOString\(\)\)\s*: state\.setClaudeProfileAuthRefusal\(name, null\)/);
  assert.match(getFunctionBody('buildClaudeAuthRefusal'), /endedByStatusCheck: state\.getClaudeProfileInfo\(name\)\?\.authRefusalEndedByStatusCheck,/);
  const round = getFunctionBody('noteClaudeProfileUsability');
  assert.match(round, /if \(checkIsClaudeProfileBackByStatusCheck\(record, nowMs\)\) backByStatusCheck\.add\(view\.name\);/);
  assert.match(round, /tellOperatorAboutClaudeAccounts\(current, backByStatusCheck\);/);
});

test('a sign-in through /accounts runs the accounts\' round at once', () => {
  assert.match(botSource, /noteClaudeAccountsChanged: \(\) => noteClaudeProfileUsability\(\),/);
});
