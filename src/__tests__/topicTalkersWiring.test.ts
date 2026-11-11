/**
 * @description Wiring guard for the speaker gate of `bot.ts` — the seams that make a talker (a person an admin let talk to
 * the agent in ONE topic) safe, read from the source because the handlers live in the side-effecting entrypoint (the
 * process-level proof is `topicTalkersE2e.test.ts`):
 *
 *   - ONLY the routes a talker may use ask the speaker gate: the text, voice, file/album and edited-message handlers and the
 *     agent's question taps; every other handler and button keeps asking the admin gate (default-deny);
 *   - a talker's text takes ONE early branch that cannot reach an armed input step, a command, a start phrase, the bind
 *     picker or a shell;
 *   - a talker's tap on any other button is refused in one middleware with a toast;
 *   - leaving the group and a re-pair drop talkers' entries.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { botSource, getFunctionBody, getSourceSlice } from './botSource';

/** Every call site of the speaker gate: this list IS the surface a talker can reach, and a new entry is a decision. */
const speakerGateCallSiteMarkers = [
  "bot.on(message('text'), async (ctx) => {",
  "bot.on(message('voice'), async (ctx) => {",
  '  incomingFileMessageFilter,\n  async (ctx) => {',
  "bot.on('edited_message', async (ctx) => {",
  'bot.action(/^qa_(\\d+)_(\\d+)$/, async (ctx) => {',
];

test('the speaker gate is asked by the text, voice, file, edited-message and question-tap routes — as their first act', () => {
  assert.equal(speakerGateCallSiteMarkers.length, 5, 'text, voice, file, edited message, and the `qa_` question button');
  for (const marker of speakerGateCallSiteMarkers) {
    const startIdx = botSource.indexOf(marker);
    assert.notEqual(startIdx, -1, `${marker} must exist`);
    const firstLines = botSource.slice(startIdx + marker.length, startIdx + marker.length + 120);
    assert.match(firstLines, /const speaker = await authoriseTopicSpeaker\(ctx\);/, marker);
  }
});

test('nothing else asks the speaker gate except the two commands that show a talker their own role (and the gate\'s own helpers) — every other route stays admin-only', () => {
  const callers = [...botSource.matchAll(/authoriseTopicSpeaker\(ctx\)/g)].length;
  // 6 routes above + /whoami, /help and /esc (they read the role to word their answer) + the botCore port is a reference, not a call.
  assert.equal(callers, speakerGateCallSiteMarkers.length + 3, 'a new caller of authoriseTopicSpeaker widens what a talker can reach');
  assert.match(botSource, /authoriseSpeaker:\s*authoriseTopicSpeaker,/, 'the compaction module\'s re-asked question tap is the one more route, through its port');
  assert.match(botSource, /async function authoriseContext\(ctx: Context\)[^]*?if \(!userId \|\| !\(await checkIsAllowedUser\(ctx\)\)\)/, 'the admin gate itself is unchanged');
});

test('a talker\'s text takes ONE early branch, before any armed step of the admin path', () => {
  const handler = getSourceSlice("bot.on(message('text'), async (ctx) => {", 'const text = stripCommandBotMention(ctx.message.text.trim());');
  assert.match(handler, /if \(speaker\.role === 'talker'\) \{\s*await handleTalkerText\(ctx, key\);\s*return;\s*\}/);
});

test('the talker branch reaches no armed input step, no start phrase, no bind picker, no shell, no model or session pick', () => {
  const body = getFunctionBody('handleTalkerText');
  const adminOnlyRoutes = [
    'checkIsAuthLoginAwaitingCode', 'checkIsOpenCodeOAuthAwaitingReply', 'checkIsAwaitingProfileName', 'checkIsAwaitingTopicInput',
    'getAwaitedSttStep', 'pendingProviderConnects', 'claimReminderTextCapture', 'handleRunnersAddressText', 'awaitingFolderName',
    'awaitingModelSelection', 'awaitingSessionSelection', 'checkIsStartAgentPhrase', 'ensureAgentSession', 'buildBindKeyboard',
    'listAvailableSubdirs', 'autoBindTopicByName', 'getClaudeReplyRoute', 'adapter.sendInput', 'submit', 'cancelProfileNameCapture',
  ];
  for (const route of adminOnlyRoutes) assert.ok(!body.includes(route), `a talker's text must not reach ${route}`);
});

test('the talker branch refuses a slash text (a forward\'s is words), deletes a pasted OAuth callback, refuses a shell and otherwise delivers like any prompt', () => {
  const body = getFunctionBody('handleTalkerText');
  assert.match(body, /!checkIsTelegramForward\(ctx\.message\)\s*&&\s*text\.startsWith\('\/'\)\)\s*\{\s*await replyToThread\(key, t\('access\.adminOnlyCommandRefusal'\)\);\s*return;/);
  assert.match(body, /parseOAuthCallbackFromReply\(text\)\)\s*\{\s*await deleteThreadMessage/);
  assert.match(body, /if \(await refuseTalkerInTerminalTopic\(key\)\) return;/);
  assert.match(body, /bufferPromptDuringStartup\(key, text, intake, messageContext\)/);
  assert.match(body, /deliverActivePrompt\(key, adapter, text, intake, sentAtMs, messageContext\)/);
  assert.match(body, /resumeSleepingSessionForPrompt\(key\)/);
  assert.match(body, /t\('access\.noAgentForTalkerNotice'\)/);
  assert.match(getFunctionBody('refuseTalkerInTerminalTopic'), /getThreadAdapter\(key\)\.name !== 'terminal'[^]*t\('access\.terminalTopicRefusal'\)/);
});

test('a talker\'s voice note and file are refused in a raw shell, and with no agent they get one line, never the bind picker', () => {
  assert.match(getSourceSlice("bot.on(message('voice'), async (ctx) => {", 'const sttSettings'), /speaker\.role === 'talker' && await refuseTalkerInTerminalTopic\(key\)/);
  assert.match(getSourceSlice('  incomingFileMessageFilter,\n  async (ctx) => {', 'handleIncomingFile(ctx, key, isFromTalker)'), /isFromTalker && await refuseTalkerInTerminalTopic\(key, /);
  const guidance = getFunctionBody('sendNoAgentGuidance');
  assert.ok(guidance.indexOf('isFromTalker') < guidance.indexOf('buildBindKeyboard'), 'the talker line comes before — and instead of — the folder picker');
  assert.match(guidance, /if \(isFromTalker\) \{\s*await sendHint\(t\('access\.noAgentForTalkerNotice'\)\);\s*return;/);
  assert.match(getFunctionBody('processVoiceJob'), /sendNoAgentGuidance\(key, messageContext\?\.nonOperatorSender !== undefined,/);
  assert.match(getFunctionBody('checkFileIntakeGatePassed'), /sendNoAgentGuidance\(key, isFromTalker, sendHint\)/);
});

test('every button but the agent\'s own question buttons is refused to a talker in ONE middleware, with a toast, before any handler', () => {
  const middleware = getSourceSlice('// Default-deny for talkers on buttons', '//  Constants');
  assert.match(middleware, /ctx\.callbackQuery && \(await checkIsTalkerTapRefused\(ctx\)\)[^]*answerCbQuery\(t\('access\.adminOnlyButtonToast'\)\)[^]*return;/);
  assert.match(getFunctionBody('checkIsTalkerTapRefused'), /checkIsTalkerCallback\(callbackData\)\) return false;[^]*role === 'talker'/);
  assert.ok(botSource.indexOf('// Default-deny for talkers on buttons') < botSource.indexOf("bot.action('open_sessions'"), 'registered before the first button handler');
  assert.ok(botSource.indexOf('// Locale is a Telegram-chat concern') < botSource.indexOf('// Default-deny for talkers on buttons'), 'after the locale scope, so the toast speaks the topic\'s language');
});

test('every update of the served group teaches the bot who wrote — before any handler gates it', () => {
  const middleware = getSourceSlice('// What the bot learns from every message of the served group', '// Default-deny for talkers on buttons');
  assert.match(middleware, /await noteServedGroupSender\(ctx\)/);
  const body = getFunctionBody('noteServedGroupSender');
  assert.match(body, /seenGroupSenders\.noteSender\(person\)/);
  assert.match(body, /state\.updateTalkerIdentity\(person\)/);
  assert.match(body, /if \(groupSpeaker\.role === 'admin'\) return;[^]*state\.resolveTopicInvites\(person\)/, 'an admin is never invited');
  assert.match(body, /groupSpeaker\.role === 'none' && !isTalkerNow\) recentTopicWriters\.noteIgnoredWriter/, 'only a stranger is offered to the add screen');
  assert.match(body, /!ctx\.message \|\| !user \|\| user\.is_bot \|\| ctx\.message\.sender_chat\) return/, 'a bot is nobody\'s talker, a tap is not writing, a post made as a chat is no person');
});

test('a member who leaves the group loses every entry; a re-pair drops the other chats\' lists', () => {
  const leave = getSourceSlice("bot.on('chat_member', async (ctx) => {", '// ═══');
  assert.match(leave, /checkHasLeftGroup\(new_chat_member\)[^]*state\.removeUserFromAllTopics\(\{ userId: user\.id\.toString\(\), username: user\.username, name: getDisplayName\(user\) \}\)/);
  assert.equal(botSource.match(/await state\.dropTopicTalkersOfOtherChats\(/g)?.length, 2, 'the auto-pair and the /pair command');
  assert.match(botSource, /await state\.setPairedGroupId\(candidate\);\s*await state\.dropTopicTalkersOfOtherChats\(candidate\);/);
  assert.match(botSource, /await state\.setPairedGroupId\(routeChat\.id\);\s*await state\.dropTopicTalkersOfOtherChats\(routeChat\.id\);/);
});

test('a talker\'s /esc only interrupts the turn: the admin\'s pending sign-in and name prompts are not cancelled by it', () => {
  const esc = getSourceSlice('command(escapeCommandNames, async (ctx, key) => {', "command('output'");
  assert.match(esc, /if \(\(await authoriseTopicSpeaker\(ctx\)\)\?\.role !== 'talker'\) \{[^]*cancelProfileNameCapture\(key\)[^]*cancelPendingLogin\(key\)[^]*cancelTopicWizard\(key\)[^]*\}\s*const adapter/);
  assert.match(esc, /\{ isTalkerAllowed: true \}\);\s*$/);
});

test('the commands flagged for a talker are registered with the flag where they are defined', () => {
  for (const marker of ["command('status', async (_ctx, key) => {", "command('whoami', async (ctx, key) => {", "command('help', async (ctx, key) => {", 'command(escapeCommandNames, async (ctx, key) => {']) {
    const startIdx = botSource.indexOf(marker);
    assert.notEqual(startIdx, -1, marker);
    const rest = botSource.slice(startIdx);
    const handlerEnd = rest.search(/\n\}(, \{ isTalkerAllowed: true \})?\);\n/);
    assert.match(rest.slice(handlerEnd, handlerEnd + 40), /isTalkerAllowed: true/, `${marker} carries the talker flag`);
  }
});

test('`opt_` — the Claude TUI selector\'s digit — stays behind the ADMIN gate: nothing builds that button, and its handler types into whatever the TUI shows', () => {
  const handler = getSourceSlice('bot.action(/^opt_(\\d+)$/, async (ctx) => {', 'const optNum');
  assert.match(handler, /const key = await authoriseContext\(ctx\);/);
  assert.doesNotMatch(handler, /authoriseTopicSpeaker/);
});

test('a talker\'s voice note feeds no reminder step of an admin — it neither fills it nor closes it when it has expired', () => {
  const voice = getFunctionBody('processVoiceJob');
  assert.match(voice, /const reminderVoiceRoute = checkIsForeignWords\(messageContext\) \? null : claimReminderTextCapture\(key\);/);
  // The wiring above is the only claim of a reminder step in the voice route, and the text route's is inside the admin path only.
  assert.equal(voice.match(/claimReminderTextCapture\(/g)?.length, 1);
  assert.ok(!getFunctionBody('handleTalkerText').includes('claimReminderTextCapture'));
});

test('an answer a topic member chose says so, on every route that gives one: the button, the typed number, the re-asked question\'s tap and number', () => {
  const tap = getSourceSlice("bot.action(/^qa_(\\d+)_(\\d+)$/, async (ctx) => {", 'Buffer a free-form prompt');
  assert.match(tap, /const answeredBy = speaker\.role === 'talker' && ctx\.from \? getTelegramTalkerContext\(ctx\.from\)\.nonOperatorSender : undefined;/);
  assert.match(tap, /applyQuestionAnswer\(key, \[selectedLabel\], answeredBy\)/);
  assert.match(getFunctionBody('deliverActivePrompt'), /await applyQuestionAnswer\(key, route\.labels, messageContext\?\.nonOperatorSender\);/);
  assert.match(getFunctionBody('applyQuestionAnswerInner'), /recordAnswerAndAdvance\(pending, answeredBy === undefined \? answerForCurrent : getAnswerWithAttribution\(answerForCurrent, answeredBy\)\)/);
  // The note the topic shows is still the chosen label, and only the label.
  assert.match(getFunctionBody('applyQuestionAnswerInner'), /t\('agent\.question_answered_note', \{ answer: answerForCurrent\.join\(', '\) \}\)/);
  assert.match(botSource, /deliverLabel: \(key, label, messageContext\) => withThreadLocale\(key, \(\) => deliverActivePrompt\(key, getThreadAdapter\(key\), label, null, undefined, messageContext\)\)/);
});

test('the re-asked question\'s tap hands the label on with the context of the talker who tapped, and the number with the message\'s', () => {
  const compaction = fs.readFileSync(path.join(__dirname, '..', 'connectors', 'telegram', 'commands', 'compaction.ts'), 'utf8');
  assert.match(compaction, /const outcome = await deliverLabel\(key, label, speaker\.role === 'talker' && ctx\.from \? getTelegramTalkerContext\(ctx\.from\) : undefined\);/);
  assert.match(compaction, /async function answerReAskedQuestionByNumber\(key: SessionKey, text: string, messageContext\?: MessageContext\)/);
  assert.match(compaction, /const outcome = await deliverLabel\(key, label, messageContext\);/);
});

test('the sender tracking ignores a post made as a chat (a linked channel\'s carries Telegram\'s service user) and rereads the role after a grant', () => {
  const body = getFunctionBody('noteServedGroupSender');
  assert.match(body, /!ctx\.message \|\| !user \|\| user\.is_bot \|\| ctx\.message\.sender_chat\) return;/);
  assert.match(body, /const isTalkerNow = state\.getEffectiveTalkerIds\(groupSpeaker\.key, getGroupGeneralKey\(groupSpeaker\.key\)\)\.has\(person\.userId\);/);
  assert.match(body, /groupSpeaker\.role === 'none' && !isTalkerNow\) recentTopicWriters\.noteIgnoredWriter/);
  assert.ok(body.indexOf('ctx.message.sender_chat') < body.indexOf('seenGroupSenders.noteSender'), 'before the person is remembered anywhere');
});

test('an album a talker sends into a raw-shell topic is refused ONCE, through the album\'s one-shot guard', () => {
  const handler = getSourceSlice('  incomingFileMessageFilter,\n  async (ctx) => {', 'handleIncomingFile(ctx, key, isFromTalker)');
  assert.match(handler, /refuseTalkerInTerminalTopic\(key, async \(text\) => \{\s*if \(!mediaGroupId \|\| albumCollector\.checkShouldAnnounceOnce\(buildAlbumGroupKey\(key, mediaGroupId\)\)\) await replyToThread\(key, text\);/);
  assert.match(getFunctionBody('refuseTalkerInTerminalTopic'), /sendRefusal: \(text: string\) => Promise<unknown>/);
});

test('/access is built over the shared core, the admin cache and the in-memory writers, registered with its commands and its callbacks, and listed as a bot command and in the menu', () => {
  const build = getSourceSlice('const { registerTopicAccessCommands, registerTopicAccessCallbacks } = createTopicAccess({', 'registerTopicAccessCommands();');
  assert.match(build, /\.\.\.botCore,/);
  assert.match(build, /getAdminIds: \(\) => adminCache\.getAdminIds\(\),\s*getAdminUsernames: \(\) => adminCache\.getAdminHandles\(\),/, 'an admin\'s @username is refused from the same cache as their id');
  assert.match(build, /getBotUsername: \(\) => bot\.botInfo\?\.username,/);
  assert.match(build, /getGroupGeneralKey,/);
  assert.match(build, /recentWriters: recentTopicWriters,\s*seenSenders: seenGroupSenders,/, 'the memory the sender tracking feeds is the one the add screen reads');
  assert.match(botSource, /registerTopicAccessCallbacks\(\);/);
  assert.match(botSource, /const botCommands = new Set\(\[[^\]]*'update', 'access',\s*\]\);/, 'a slash text must not be re-forwarded to the agent');
  assert.match(botSource, /\{ command: 'access', description: '[^']*' \}/);
});

test('/access is admin-only by default: the command is registered with no talker flag', () => {
  const module = fs.readFileSync(path.join(__dirname, '..', 'connectors', 'telegram', 'commands', 'topicAccess.ts'), 'utf8');
  assert.match(module, /command\('access', async \(ctx, key, parsed\) => \{/);
  assert.doesNotMatch(module, /isTalkerAllowed/);
});

test('a bind tells the topic how many people may talk to the agent there and where they now reach it — the list belongs to the topic, not the folder', () => {
  const welcome = getFunctionBody('sendBindingWelcome');
  assert.match(welcome, /const reachCount = state\.getTopicReachCount\(key, getGroupGeneralKey\(key\)\);\s*if \(reachCount > 0\) lines\.push\(t\('access\.bindNote', \{ count: reachCount, subdir \}\)\);/, 'General\'s list and the waiting invitations reach the new folder too');
});

test('the admin cache fetches the admins\' @usernames with their ids, through the connector\'s one membership path', () => {
  const cache = getSourceSlice('const adminCache = new AdminCache({', 'ttlMs: ADMIN_CACHE_TTL_MS,');
  assert.match(cache, /fetchElevatedMemberIds: \(\) => \{/);
  assert.match(cache, /fetchElevatedMemberHandles: \(\) => \{[^}]*telegramInbound\.listHandlesOfMembersWithElevatedRights\(groupId\.toString\(\)\);/s);
});
