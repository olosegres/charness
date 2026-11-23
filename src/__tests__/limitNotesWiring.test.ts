/**
 * Wiring guard for the accounts note in `bot.ts` (which a test cannot import: its module-scope `parseEnv()` exits the process).
 * What a flow shows only by luck is pinned here by reading the source, the way `forwardPromptWiring.test.ts` pins the forward:
 *  - L8: WHICH callers of the prompt forward mark their prompt a carrier — a person's message that opened a request, a tracker's post, a
 *    scheduled run — and that no other (a retry's nudge, a hand-over, a wedge replay, a request wake-up, the todo reminder, the lost-work
 *    note, the answer to the agent's question, a held prompt) does;
 *  - L13: that the forward marks the turn such a non-carrier prompt opens on an idle session, and the turn end clears it, for the
 *    mid-turn engine to skip (`limitNotesEngine.test.ts` has the engine's side);
 *  - where the forward attaches the note (the last block, after the todo lines, inside the ONE text it writes, no await of its own) and
 *    when it counts as delivered;
 *  - that the renderer hides it from a bot tool's result, and that the bot's MCP ports reach the same notes;
 *  - that the notes module imports nothing that could stamp activity, write to an agent or wake a session (README § Lifecycle safety);
 *  - that the mid-turn engine is built over the shared turn probe for Claude json-stream sessions only, started with the sessions and
 *    stopped at shutdown, that boot clears the inbox, and WHERE the accounts section of the inbox is withdrawn.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
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

/** The top-level declaration each line of `bot.ts` that holds `needle` sits in: `name`, or `command:<name>` for a registered command. */
function listEnclosingDeclarations(needle: string): string[] {
  const lines = botSource.split('\n');
  const declaration = /^(?:async )?function (\w+)\(|^const (\w+)\b|^command\('(\w+)'/;
  const names = new Set<string>();
  lines.forEach((line, index) => {
    if (!line.includes(needle)) return;
    let at = index;
    while (at >= 0 && !declaration.test(lines[at])) at -= 1;
    const match = declaration.exec(lines[at]);
    if (match === null) return;
    names.add(match[1] ?? match[2] ?? `command:${match[3]}`);
  });
  return [...names].sort();
}

describe('L8: which callers of the forward mark their prompt a carrier of the accounts note', () => {
  it('exactly the person\'s-request routes, the tracker / scheduler post and the plumbing that hands the flag on — no other caller of the forward', () => {
    assert.deepEqual(listEnclosingDeclarations('isAccountsNoteCarrier'), [
      // The routes that SET it: a person's message that opened a request (text, voice, label-less free text, a file, an album, /schedule,
      // one that arrived in a start's window — every one through `deliverPromptByState`, which sets it from its intake) and a session post
      // (a tracker's request or update, a scheduled run, a fired check's wake — a scheduled run that rides a request has its own forward,
      // `forwardScheduledRun`, and one that opens the scheduler's request in a topic `forwardTopicSchedulerRequestRun`).
      'cancelPendingQuestionAndForward',
      'createSessionPostDeps',
      'deliverPromptByState',
      // The plumbing that carries it from the caller to the live forward, buffered or not.
      'deliverPersonPromptAtWrite',
      'forwardPromptToAgent',
      'forwardPromptToLiveAgent',
      'forwardScheduledRun',
      'forwardTopicSchedulerRequestRun',
      'promptDeliveryDeps',
    ].sort());
    // The startup buffer's replay hands every buffered prompt's options on whole, the carrier flag among them.
    assert.ok(getFunctionBody('replayBufferedPrompts').includes('const outcome = await forwardPromptToAgent(key, adapter, prompt, undefined, options);'));
  });

  it('the answer to the agent\'s own question is no carrier (a tap\'s label arrives with no request), and a person\'s free text is', () => {
    const delivery = getFunctionBody('deliverPromptByState');
    assert.match(delivery, /await deliverPersonPromptAtWrite\(key, text, \{ opening, sentAtMs, messageContext, isAccountsNoteCarrier: intake !== null \}\);/);
    assert.match(getFunctionBody('deliverActivePrompt'), /cancelPendingQuestionAndForward\(key, adapter, text, sentAtMs, messageContext, opening, intake !== null\)/);
    assert.match(getFunctionBody('cancelPendingQuestionAndForward'), /isAccountsNoteCarrier = false,/, 'off unless the caller says it opened a request');
  });

  it('the bookkeeping prompts — a wake-up, the answer tail, the todo reminder, the lost-work note, a wedge replay, a held prompt — never carry the flag', () => {
    for (const name of ['forwardRequestWakeUp', 'remindAnswerTail', 'postTodoReminder', 'createLostWorkPostDeps', 'handleWedgeRecovery']) {
      const body = botSource.includes(`function ${name}(`) ? getFunctionBody(name) : '';
      assert.ok(body.length > 0 || name === 'handleWedgeRecovery', `${name} is in bot.ts`);
      assert.equal(body.includes('isAccountsNoteCarrier'), false, `${name} must not mark its prompt a carrier`);
    }
    assert.doesNotMatch(botSource, /isRecoveryReplay: true,\n\s*isAccountsNoteCarrier/, 'the wedge replay');
    // The held prompts of a usage-limit wait ride a replayable prompt (`limitHeldPrompts.releaseWithForward`) or are released as the
    // person's own (isPersonInput), never as a carrier.
    assert.match(getFunctionBody('replayBufferedPrompts'), /await forwardPromptToAgent\(key, adapter, heldText, undefined, \{ isPersonInput: true \}\);/);
  });

  it('a tracker\'s post shares one session post that marks the carrier, a scheduled run\'s forwards mark it the same way; the lost-work post overrides that forward and does not', () => {
    const postDeps = botSource.slice(botSource.indexOf('function createSessionPostDeps('), botSource.indexOf('function createSessionPostDeps(') + 3000);
    assert.match(postDeps, /, text, buffered\.settle, \{ isAccountsNoteCarrier: true \}\);/);
    assert.match(getFunctionBody('forwardScheduledRun'), /, text, buffered\.settle, \{ isAccountsNoteCarrier: true, lostWorkTelling \}\);/);
    assert.match(getFunctionBody('forwardTopicSchedulerRequestRun'), /\$\{text\}`, buffered\.settle, \{ isAccountsNoteCarrier: true \}\);/);
    assert.match(getFunctionBody('createLostWorkPostDeps'), /\.\.\.createSessionPostDeps\(\),\n\s*forwardPrompt: async \(conversationKey, text\) => \{/);
  });
});

describe('where the forward attaches the note, and when it counts as delivered', () => {
  const body = getFunctionBody('forwardPromptToLiveAgent');

  it('as the LAST block of the text it writes — after the todo board and reminder lines, before anything is sent — and only for a carrier on a backend that gets notes', () => {
    const todoReminder = body.indexOf('if (todoReminderLine !== null) promptText =');
    const note = body.indexOf('const accountsNote = checkIsAccountsNoteCarried({ isCarrier: options.isAccountsNoteCarrier, isSlashCommand, adapterName: adapter.name })');
    const append = body.indexOf('if (accountsNote !== null) promptText = appendLimitNote(promptText, accountsNote.text);');
    const write = body.indexOf('const written = adapter.sendInputAndWait');
    assert.ok(todoReminder > 0 && note > todoReminder && append > note && write > append, 'todo lines, then the note, then the one write');
    assert.equal(body.slice(note, append).includes('await'), false, 'the note is worked out in the caller\'s tick');
  });

  it('the quiet period is read from the last turn end while the session is idle — never from the activity stamp a person\'s own message moves', () => {
    assert.match(body, /getAccountsNoteQuietMs\(\{ lastTurnEndAt: state\.getCompactIdleTracking\(key\)\.lastTurnEndAt, isBusy: adapter\.checkIsBusy\?\.\(key\), nowMs: Date\.now\(\) \}\)/);
  });

  it('counts as delivered only once the prompt that carries it reached a live session — a failed write keeps it for the next prompt', () => {
    assert.match(body, /const noteToldIfDelivered = \(\): void => \{[^]*?if \(adapter\.checkIsActive\(key\)\) accountsNote\.markDelivered\(\);\n\s*else accountsNote\.release\(\);\n\s*\}\n\s*\};/);
  });

  it('a prompt that did not reach the session gives the note back — a failed write, a session that was gone — so two quick carriers never both carry one and a failed one never loses it', () => {
    assert.match(body, /if \(accountsNote !== null\) \{\n\s*if \(adapter\.checkIsActive\(key\)\) accountsNote\.markDelivered\(\);\n\s*else accountsNote\.release\(\);\n\s*\}/);
    assert.match(body, /if \(accountsNote !== null\) void written\.catch\(\(\) => accountsNote\.release\(\)\);/);
    assert.ok(body.indexOf('void written.catch(() => accountsNote.release());') < body.indexOf('if (options.isPersonInput === true) {'), 'armed before either branch settles the write');
  });

  it('adds no activity stamp, typing, busy flag or request of its own: the note block holds none of them', () => {
    const block = body.slice(body.indexOf('// The accounts note (`limitNotes/`)'), body.indexOf('markNeedsNewMessage(key);'));
    for (const forbidden of ['noteThreadActivity', 'noteThreadUserActivity', 'notePersonActivity', 'markThreadTurnProducedOutput', 'setActivity', 'requestRefresh', 'openTopicRequest', 'trackContinuationTurn', 'ensureAgentSession', 'sendInput']) {
      assert.equal(block.includes(forbidden), false, `the note block must not call ${forbidden}`);
    }
  });
});

describe('the topic never shows the note, and the bot\'s MCP ports reach the notes', () => {
  it('the tool-result renderer cuts it from a bot tool\'s output, for every verbosity, before the output is truncated or shown', () => {
    const body = getFunctionBody('handleAgentToolResult');
    assert.match(body, /const output = checkIsBotMcpToolName\(payload\.tool\) \? stripLimitNote\(payload\.output\) : payload\.output;/);
    assert.match(body, /getTruncatedToolResult\(output\)/);
    assert.match(body, /\{ text: output, isTruncated: false \}/);
    // The raw output is read twice: by the operator's own always-on trace, and by the cut — nothing that reaches the topic reads it.
    assert.equal(body.match(/payload\.output/g)?.length, 3, 'the trace, the cut and its fallback; the topic gets `output`');
  });

  it('the scheduler\'s MCP deps take the send-result note and record the two orchestration calls through the one notes object', () => {
    assert.match(botSource, /takeLimitNoteForSend: \(threadKeyStr\) => \{\n\s*const key = tryKeyFromString\(threadKeyStr\);\n\s*return key === null \? null : getLimitNotes\(\)\.takeSendResultNote\(key\);\n\s*\},/);
    assert.match(botSource, /noteLimitProfilesCall: \(threadKeyStr\) => \{\n\s*const key = tryKeyFromString\(threadKeyStr\);\n\s*if \(key === null\) return;\n(?:\s*\/\/[^\n]*\n)+\s*withdrawAccountsInbox\(key\);\n\s*getLimitNotes\(\)\.noteProfilesCall\(key\);\n\s*\},/);
    assert.match(botSource, /noteLimitWorkerWatch: \(threadKeyStr\) => \{\n\s*const key = tryKeyFromString\(threadKeyStr\);\n\s*if \(key !== null\) getLimitNotes\(\)\.noteWorkerWatch\(key\);\n\s*\},/);
  });

  it('the notes\' report is the one `claude_profiles` answers with: the credit report over the same views and `/limits` list, never a second ranking', () => {
    const notes = getFunctionBody('getLimitNotes');
    assert.match(notes, /getReport: \(nowMs\) => buildClaudeProfilesCreditReport\(getClaudeProfileUsageViews\(\), null, nowMs, \{ chainScope: getClaudeLaunchChainScope\(state\.getFallbackChain\(\)\) \}\),/);
    assert.match(notes, /getRecord: \(key\) => state\.getLimitNoteRecord\(key\),/);
  });

  it('the interval and the windows read the test timings — the seam, never an env var of their own', () => {
    assert.match(botSource, /ENV\.testTimings\.limitReminderIntervalMs/);
    assert.match(botSource, /ENV\.testTimings\.limitNoteQuietMs/);
    assert.match(botSource, /ENV\.testTimings\.limitNoteSummaryFloorMs/);
    assert.doesNotMatch(botSource, /process\.env\.CHARNESS_LIMIT/);
  });
});

describe('every reader of a stored user prompt cuts the glue through the ONE helper', () => {
  const readSource = (relativePath: string): string => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

  it('the resume context, the hand-over, both session-title builders and the OpenCode auto-rename use `getUserPromptWithoutGlue` — none strips the preamble by itself', () => {
    for (const reader of ['resumeContext.ts', 'utils/fallbackBridge.ts', 'utils/claudeSessionTitle.ts', 'openCodeSessionTitle.ts', 'adapters/openCodeAdapter.ts']) {
      const source = readSource(reader);
      assert.match(source, /getUserPromptWithoutGlue\(/, `${reader} cuts the glue through the shared helper`);
      assert.equal(/stripThreadContextPreamble|stripLimitNote/.test(source), false, `${reader} must not repeat the strip pair`);
    }
  });
});

describe('the notes module cannot reach what a note must never touch', () => {
  const importsOf = (file: string): string[] => [...fs.readFileSync(path.join(__dirname, '..', 'limitNotes', file), 'utf8').matchAll(/^import [^;]*? from '([^']+)';$/gm)].map((match) => match[1]).sort();

  it('the service imports only names, the clock-free planner and types: no compaction, forward, session, request or indicator module', () => {
    assert.deepEqual(importsOf('service.ts'), ['../adapters/adapterNames', '../sessionKey', '../utils/claudeUsage', './plan']);
  });

  it('the planner and the text helpers import only usage figures and formatting — no state, no adapter, no bot', () => {
    assert.deepEqual(importsOf('plan.ts'), ['../utils/claudeApiSpend', '../utils/claudeUsage', '../utils/openCodeUsage', '../utils/reminderWizard', '../utils/timezone', './noteText']);
    assert.deepEqual(importsOf('noteText.ts'), []);
    assert.deepEqual(importsOf('reminderChoices.ts'), []);
  });
});

describe('the mid-turn engine in the bot: Claude json-stream only, the shared turn probe, started with the sessions', () => {
  it('is built over the turn probe the wake-up and todo engines share, the one notes object and the one inbox, with the poll interval from the test timings', () => {
    const start = botSource.indexOf('limitNotesEngine = new LimitNotesEngine({');
    assert.notEqual(start, -1);
    const construction = botSource.slice(start, botSource.indexOf('});', start));
    assert.match(construction, /listConversations: \(\) => state\.listBindings\(\)\.map\(\(\{ key \}\) => key\),/);
    assert.match(construction, /probeTurn: probeThreadTurn,/);
    assert.match(construction, /notes: getLimitNotes\(\),/);
    assert.match(construction, /inbox: getMidTurnInbox\(\),/);
    assert.match(construction, /pollIntervalMs: ENV\.testTimings\.limitNoteEnginePollMs,/);
    // Only the deps the engine's contract names: no adapter, no state, no forward, no compaction.
    assert.deepEqual([...construction.matchAll(/^\s{4}(\w+):/gm)].map((match) => match[1]), ['listConversations', 'getClaudeSessionId', 'probeTurn', 'notes', 'inbox', 'pollIntervalMs']);
  });

  it('a conversation is offered a note only while its agent is a Claude json-stream session — the OpenCode path has none', () => {
    assert.match(botSource, /getClaudeSessionId: \(key\) => \{\n\s*const adapterName = getThreadAdapterNameRaw\(key\) \?\? state\.getAgent\(key\)\?\.name;\n\s*return adapterName !== undefined && checkIsJsonStreamBackend\(adapterName\) \? getResumableSessionId\(key\) : null;/);
  });

  it('starts with the restored sessions, stops at shutdown, and boot clears every inbox file before either', () => {
    assert.match(botSource, /todoReminderEngine\?\.start\(\);\n\s*limitNotesEngine\?\.start\(\);/);
    assert.match(botSource, /todoReminderEngine\?\.stop\(\);\n\s*limitNotesEngine\?\.stop\(\);/);
    assert.ok(botSource.indexOf('getMidTurnInbox().clearAll();') > botSource.indexOf('limitNotesEngine = new LimitNotesEngine({'));
    assert.ok(botSource.indexOf('getMidTurnInbox().clearAll();') < botSource.indexOf('limitNotesEngine?.start();'));
    assert.equal(botSource.match(/getMidTurnInbox\(\)\.clearAll\(\)/g)?.length, 1, 'once, at boot');
  });
});

describe('where the accounts section of the mid-turn inbox is withdrawn unseen', () => {
  it('exactly at a turn start the bot makes, a turn\'s end, a session\'s start, close, suspension and stop — nowhere else, and never to deliver', () => {
    assert.deepEqual(listEnclosingDeclarations('withdrawAccountsInbox(key)'), [
      'clearThreadContextMarker',
      'forwardPromptToLiveAgent',
      'handleAgentClosed',
      'handleAgentStarted',
      'handleAgentSuspended',
      'handleAgentTurnEnded',
      'noteConversationContextReset',
      // The `claude_profiles` tool's port, inside the composition root's deps (the enclosing declaration of that block).
      ...listEnclosingDeclarations('noteLimitProfilesCall: (threadKeyStr) => {'),
    ].sort());
    assert.match(getFunctionBody('withdrawAccountsInbox'), /getMidTurnInbox\(\)\.withdraw\(key, 'accounts'\);/);
  });

  it('the forward withdraws it BEFORE it works out the turn-start note, so a note in flight is given back and not held against the prompt\'s own', () => {
    const body = getFunctionBody('forwardPromptToLiveAgent');
    assert.ok(body.indexOf('withdrawAccountsInbox(key);') > 0 && body.indexOf('withdrawAccountsInbox(key);') < body.indexOf('const accountsNote = checkIsAccountsNoteCarried('));
  });

  it('the turn end withdraws before the activity stamp the person-facing handler makes, and stamps nothing itself', () => {
    const body = getFunctionBody('handleAgentTurnEnded');
    assert.ok(body.indexOf('withdrawAccountsInbox(key);') < body.indexOf('noteThreadActivity(key);'));
    assert.equal(getFunctionBody('withdrawAccountsInbox').includes('noteThread'), false);
  });
});

describe('L13: the turn a bookkeeping prompt opens is marked at the forward and cleared at the turn end — for the mid-turn engine to skip', () => {
  const body = getFunctionBody('forwardPromptToLiveAgent');

  it('the forward marks it right before the write, after the interrupt and the detach awaits — a bookkeeping prompt is one no person, tracker or scheduler sent and no slash command, and only a session that runs nothing opens a turn of its own', () => {
    const mark = body.indexOf('getLimitNotes().noteTurnStart(key, { isBookkeeping: options.isAccountsNoteCarrier !== true && !isSlashCommand, isSessionIdle: adapter.checkIsBusy?.(key) === false });');
    assert.ok(mark > 0, 'the mark is set from the carrier flag, the slash test and the idle read');
    assert.ok(mark > body.indexOf('await adapter.interruptAndWaitIdle(key);') && mark > body.indexOf('await adapter.detachRunningSubagents(key);'), 'after the awaits that may end a running turn');
    assert.ok(mark < body.indexOf('const written = adapter.sendInputAndWait'), 'before the write');
    assert.equal(body.slice(mark, body.indexOf('const written = adapter.sendInputAndWait')).includes('await'), false, 'no await between the read of idle and the write');
  });

  it('it is set in the forward alone and cleared in the turn end alone, which clears it before the activity stamp the person-facing handler makes', () => {
    assert.deepEqual(listEnclosingDeclarations('getLimitNotes().noteTurnStart('), ['forwardPromptToLiveAgent']);
    assert.deepEqual(listEnclosingDeclarations('getLimitNotes().noteTurnEnd('), ['handleAgentTurnEnded']);
    const turnEnd = getFunctionBody('handleAgentTurnEnded');
    assert.ok(turnEnd.indexOf('getLimitNotes().noteTurnEnd(key);') > 0 && turnEnd.indexOf('getLimitNotes().noteTurnEnd(key);') < turnEnd.indexOf('noteThreadActivity(key);'));
  });
});

describe('L11: the self-update idle verdict reads nothing a note moves', () => {
  it('the person\'s quiet period is stamped in ONE place, the inbound middleware — no note path reaches it — and the verdict reads only the adapters\' working and unconsumed-input state (unmoved by a note: `limitNotesEngine.test.ts`)', () => {
    assert.equal(botSource.match(/lastHumanInboundAt = /g)?.length, 1, 'one assignment');
    assert.match(botSource, /bot\.use\(async \(ctx, next\) => \{\n  if \(ctx\.message \|\| ctx\.callbackQuery\) lastHumanInboundAt = Date\.now\(\);/);
    const verdict = getFunctionBody('getUpdateIdleVerdict');
    assert.match(verdict, /adapter\.checkIsWorking \? adapter\.checkIsWorking\(key\) : adapter\.checkIsBusy\?\.\(key\) === true/);
    assert.match(verdict, /hasUnconsumedInput: keys\.some\(\(key\) => getThreadAdapter\(key\)\.checkHasUnconsumedInput\?\.\(key\) === true\),/);
    assert.match(verdict, /lastHumanMessageAt: lastHumanInboundAt,/);
    assert.equal(/limitNote|LimitNote|accountsNote/.test(verdict), false, 'the verdict knows nothing of notes');
  });
});

describe('the order of a withdrawal and the record it may write', () => {
  it('a fresh context withdraws BEFORE it clears the fingerprint — a file the hook already took is recorded by the withdrawal, and that record must not land after the reset', () => {
    for (const name of ['clearThreadContextMarker', 'noteConversationContextReset']) {
      const body = getFunctionBody(name);
      const withdraw = body.indexOf('withdrawAccountsInbox(key);');
      const clear = body.indexOf('state.clearLimitNoteFingerprint(key);');
      assert.ok(withdraw > 0 && clear > withdraw, `${name}: withdraw, then clear`);
    }
  });

  it('the `claude_profiles` port withdraws a waiting reminder first, then records the look: the stale reminder is gone before the tool\'s own hook runs, and the look is the last write', () => {
    const start = botSource.indexOf('noteLimitProfilesCall: (threadKeyStr) => {');
    const port = botSource.slice(start, botSource.indexOf('\n    },', start));
    const withdraw = port.indexOf('withdrawAccountsInbox(key);');
    assert.ok(withdraw > 0 && port.indexOf('getLimitNotes().noteProfilesCall(key);') > withdraw, 'withdraw, then the look');
  });
});

describe('the `claude_profiles` port hands the resume advice its inputs', () => {
  it('the report is built with the query\'s account, limit stop AND last-run time — the three the hand-over verdict reads — over the same `/limits` list as the notes\' report', () => {
    const body = getFunctionBody('listClaudeProfilesForAgent');
    assert.match(body, /currentProfile: query\.currentProfile,\n\s*isStoppedByLimit: query\.isStoppedByLimit,\n\s*lastRunEndedAtMs: query\.lastRunEndedAtMs,\n\s*chainScope: getClaudeLaunchChainScope\(state\.getFallbackChain\(\)\),/);
  });
});

describe('the `/limits_reminders` command in the bot', () => {
  it('reads General\'s value through the SAME reader the notes read their interval with — so the screen and the notes can never disagree', () => {
    assert.match(botSource, /createLimitReminders\(\{\n\s*\.\.\.botCore,\n\s*readInstanceLimitReminders: readLimitRemindersSettings,\n\s*getSettingsPath: \(\) => getInstanceSettingsPath\(\),\n\}\);/);
    assert.match(getFunctionBody('getConversationLimitReminderIntervalMs'), /resolveLimitRemindersMinutes\(readLimitRemindersSettings\(\), state\.getLimitRemindersOverride\(key\)\)/);
  });

  it('the `/limits` board is handed the module\'s row label and opener — the module is built BEFORE the board', () => {
    const reminders = botSource.indexOf('createLimitReminders({');
    const board = botSource.indexOf('createLimitsBoard({');
    assert.ok(reminders > 0 && board > reminders);
    assert.match(botSource, /getRemindersRowLabel: getLimitRemindersRowLabel,\n\s*openRemindersPicker: openLimitRemindersPicker,/);
  });

  it('its command and its buttons are registered, the name and the alias are bot commands (never forwarded to the agent), and the menu lists the command only', () => {
    assert.match(botSource, /registerLimitsBoardCommands\(\);\nregisterLimitRemindersCommands\(\);/);
    assert.match(botSource, /registerLimitsBoardCallbacks\(\);\nregisterLimitRemindersCallbacks\(\);/);
    const commandSet = botSource.slice(botSource.indexOf('const botCommands = new Set(['), botSource.indexOf(']);', botSource.indexOf('const botCommands = new Set([')));
    assert.ok(commandSet.includes("'limits_reminders'") && commandSet.includes("'limit_reminders'"));
    assert.ok(botSource.includes("{ command: 'limits_reminders', description:"));
    assert.equal(botSource.includes("{ command: 'limit_reminders'"), false, 'the alias is hidden');
  });
});

describe('the mid-turn engine and the inbox cannot reach what a note must never touch', () => {
  const importsOf = (file: string): string[] => [...fs.readFileSync(path.join(__dirname, '..', file), 'utf8').matchAll(/^import [^;]*? from '([^']+)';$/gm)].map((match) => match[1]).sort();

  it('the engine imports the session key, the probe\'s type, the inbox type and the notes\' type — no adapter, state, forward, compaction, request or indicator module', () => {
    assert.deepEqual(importsOf('limitNotes/engine.ts'), ['../requests/wakeUpRules', '../sessionKey', '../utils/midTurnInbox', './service']);
  });

  it('the inbox imports files, the session key, the todo dir and two process helpers: no activity, adapter or request module', () => {
    assert.deepEqual(importsOf('utils/midTurnInbox.ts'), ['../sessionKey', '../todos/store', './jsonStreamHost', './tmuxExec', 'fs', 'path']);
  });
});

