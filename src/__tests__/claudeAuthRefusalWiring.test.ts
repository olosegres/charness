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
  assert.ok(wait.indexOf('state.setWaitingForClaudeAccount(key, true)') < wait.indexOf('stopWakingForLimitWait(key)'));
  assert.match(wait, /if \(checkIsTelegramKey\(key\) \|\| !requestLimitWaitAnswerDeps\) \{\s*await surfaceLoggedOutNotice\(key\);/);
  assert.match(wait, /identity: 'claudeAccountWait',\s*body: t\('requests\.account\.noneUsableAnswer', \{ reasons \}\),\s*isWakeStopped: true,/);
});

test('every round of the accounts\' states tells the operator and resumes the waiting conversations — from the end of the boot on', () => {
  const round = getFunctionBody('noteClaudeProfileUsability');
  assert.match(round, /if \(!isOperatorAlertOpen\) return;\s*tellOperatorAboutClaudeAccounts\(current, backByStatusCheck\);\s*void resumeConversationsWaitingForAccount\(\);/);
  const restored = botSource.slice(botSource.indexOf('onSessionsRestored: () => {'));
  assert.ok(restored.indexOf('jiraConnector?.start(') < restored.indexOf('openOperatorAlerts();'), 'the connectors\' channels are known first');
  assert.match(botSource, /operatorAlertChannels = jiraConnector\?\.operatorChannel \? \[jiraConnector\.operatorChannel\] : \[\];/);
  const deliver = getFunctionBody('deliverClaudeAccountAlert');
  assert.match(deliver, /if \(ENV\.isTelegramServed\) posts\.push\(postClaudeAccountAlertToTelegram\(alert\)\);/);
  assert.match(deliver, /runWithLocale\('en', \(\) => renderClaudeAccountAlert\(alert, getHostClaudeSignInHow\)\)/, 'a connector\'s channel reads English and the host\'s sign-in');
  const resume = getFunctionBody('resumeConversationsWaitingForAccount');
  assert.ok(resume.indexOf('applyClaudeProfileToThread(key, { isAfterLimit: true })') < resume.indexOf('resumeTopicOnNewSession(key,'), 'moved onto an account that works before the continue prompt');
});

test('the profile scan of the usage poll and of /accounts ends the refusals of accounts signed in again and logs the changes', () => {
  assert.match(botSource, /syncProfiles: \(\) => syncClaudeProfilesAndRefusals\(\),/);
  assert.match(botSource, /syncClaudeProfiles: \(options\) => syncClaudeProfilesAndRefusals\(options\),/);
  const scan = getFunctionBody('syncClaudeProfilesAndRefusals');
  assert.ok(scan.indexOf('claudeProfileSync.sync(options)') < scan.indexOf('settleClaudeAuthRefusal(name)'), 'the probes first, then the refusals they may end');
  assert.match(scan, /noteClaudeProfileUsability\(\);/);
});

test('the private sign-out messages go BEFORE General\'s post (it must know a refusal), write back only their own ids, and an account signed in again turns its message', () => {
  const telegram = getFunctionBody('postClaudeAccountAlertToTelegram');
  assert.ok(
    telegram.indexOf('await sendClaudeAccountSignOutDms(alert)') < telegram.indexOf('postClaudeAccountAlertToGeneral(alert, { isPrivateChatClosed })'),
    'General\'s alert asks for a private chat only when the private message was refused: it needs the outcome first',
  );
  assert.match(telegram, /settleClaudeAccountSignOutDms\(alert\)/);
  const send = getFunctionBody('sendClaudeAccountSignOutDms');
  assert.doesNotMatch(send, /setClaudeAccountAlertState\(/, 'a send that waited on Telegram never writes back the record it read before');
  assert.match(send, /await state\.setClaudeAccountAlertSignOutMessageId\(name, outcome\.messageId\);/);
  assert.match(send, /outcome\.kind === 'failed' && outcome\.isForbidden === true\) \{\s*isPrivateChatClosed = true;/, 'only Telegram\'s 403 makes General ask for a private chat');
  const turn = getFunctionBody('markClaudeAccountSignOutDmSignedIn');
  assert.ok(turn.indexOf('setClaudeAccountAlertSignOutMessageId(name, null)') < turn.indexOf('editThreadMessage(privateKey, messageId, text)'), 'the id is dropped first: a failed edit is never retried');
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
