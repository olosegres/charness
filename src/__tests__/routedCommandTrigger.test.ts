/**
 * @description The single `bot.on(message('text'))` trigger that replaced ~60
 * `bot.command(...)` registrations (platform seam S2).
 *
 * The pieces it composes are covered in isolation elsewhere
 * (`telegramInbound.test.ts` for recognition, `commandRouter.test.ts` for the
 * table); what is only provable HERE is the GUARD ORDER, which is what the
 * per-command registrations used to give for free:
 *
 *  1. recognition and the registration check run BEFORE authorisation, so an
 *     unrouted name reaches `next()` and the raw `bot.command('pair')` further
 *     down the middleware chain still fires in a group the bot is not paired
 *     with yet — the one command that MUST work before authorisation can pass;
 *  2. a rejected sender returns WITHOUT `next()`, so the update stops at the
 *     gate that refused it instead of walking on to the generic text handler
 *     for a second refusal;
 *  3. the post-authorisation effects run in order and only for a message that
 *     got past both guards.
 *
 * Recognition and the registration table are the REAL ones (`getTelegramCommand`
 * plus the router bot.ts actually registered into), so "`/pair` is not routed"
 * is asserted against production state rather than a fake. Only the
 * side-effecting collaborators are injected.
 *
 * `./reattachRecapPost.testSetup` is imported FIRST — the shared, side-effect-
 * only shim that sets `bot.ts`'s boot-time env before the module evaluates.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */
import './reattachRecapPost.testSetup';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { Message } from 'telegraf/typings/core/types/typegram';

import {
  checkIsRoutedCommand,
  getTalkerAllowedCommandNames,
  handleRoutedCommandMessage,
  type RoutedCommandTriggerDeps,
} from '../bot';
import type { TopicSpeaker } from '../connectors/telegram/commands/botCore';
import { getTelegramCommand } from '../connectors/telegram/inbound';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import type { SessionKey } from '../sessionKey';

const identity = { username: 'myCodeBot', userId: 1000 };
const servedChatId = -1001234567890;
const topicThreadId = 42;
const authorisedKey: SessionKey = makeTelegramKey(servedChatId, topicThreadId);

/** The only part of the telegraf context this trigger reads. */
interface TriggerContext {
  message: Message.TextMessage;
}

/** A text message carrying the `bot_command` entity Telegram really sends. */
function makeCommandContext(text: string): TriggerContext {
  return {
    message: {
      message_id: 11,
      date: 0,
      chat: { id: servedChatId, type: 'supergroup', title: 'served' },
      from: { id: 7, is_bot: false, first_name: 'sender' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: (text.split(' ')[0] ?? text).length }],
    },
  };
}

/** A message with no command entity — ordinary prose for the agent. */
function makePlainContext(text: string): TriggerContext {
  return {
    message: {
      message_id: 12,
      date: 0,
      chat: { id: servedChatId, type: 'supergroup', title: 'served' },
      from: { id: 7, is_bot: false, first_name: 'sender' },
      text,
    },
  };
}

interface TriggerRun {
  deps: RoutedCommandTriggerDeps<TriggerContext>;
  next: () => Promise<void>;
  /** Every collaborator the run reached, in call order. */
  calls: string[];
}

/** `authorisedAs: null` = the sender was rejected by the access policy; otherwise who they are in the topic. */
function makeRun(authorisedAs: SessionKey | null, role: TopicSpeaker['role'] = 'admin'): TriggerRun {
  const calls: string[] = [];
  return {
    calls,
    next: async () => {
      calls.push('next');
    },
    deps: {
      getCommand: (message) => getTelegramCommand(message, identity),
      checkIsRegistered: checkIsRoutedCommand,
      authorise: async () => {
        calls.push('authorise');
        return authorisedAs === null ? null : { key: authorisedAs, role };
      },
      // The REAL flags the bot registered, so the test proves what production decides.
      checkIsTalkerAllowed: (name) => getTalkerAllowedCommandNames().includes(name),
      refuseTalkerCommand: async () => {
        calls.push('refuseTalkerCommand');
      },
      exitPendingInputModes: async () => {
        calls.push('exitPendingInputModes');
      },
      noteActivity: () => {
        calls.push('noteActivity');
      },
      deliverInbound: async () => {
        calls.push('deliverInbound');
      },
    },
  };
}

test('an unauthorised sender of a routed command is dropped with NO fall-through', async () => {
  // A rejected update must stop at the gate that refused it. The generic text
  // handler re-authorises, so a stray `next()` would not by itself leak the
  // command — it would burn a second admin-cache round trip and log the same
  // refusal twice, which is how a real leak gets lost in the noise.
  const run = makeRun(null);

  await handleRoutedCommandMessage(makeCommandContext('/status'), run.next, run.deps);

  assert.deepEqual(run.calls, ['authorise']);
});

test('/interrupt is routed together with its older names /esc and /escape — one handler, no forward to the agent', () => {
  for (const name of ['interrupt', 'esc', 'escape']) {
    assert.equal(checkIsRoutedCommand(name), true, `/${name} is a bot-owned command`);
  }
});

test('`pair` is deliberately NOT on the router, so /pair falls through to its raw handler', async () => {
  // Two halves of one contract, asserted against the REAL registration table:
  // `pair` is absent from it (while a routed name like `status` is present),
  // and an absent name calls `next()` BEFORE authorisation — which is what lets
  // `bot.command('pair')` run in a group that cannot authorise anyone yet.
  assert.equal(checkIsRoutedCommand('pair'), false);
  assert.equal(checkIsRoutedCommand('status'), true);

  const run = makeRun(authorisedKey);

  await handleRoutedCommandMessage(makeCommandContext('/pair'), run.next, run.deps);

  assert.deepEqual(run.calls, ['next']);
});

test('a routed command from an authorised sender runs the full chain, without next()', async () => {
  const run = makeRun(authorisedKey);

  await handleRoutedCommandMessage(makeCommandContext('/status'), run.next, run.deps);

  assert.deepEqual(run.calls, [
    'authorise',
    'exitPendingInputModes',
    'noteActivity',
    'deliverInbound',
  ]);
});

test('plain prose is not a command and falls through untouched', async () => {
  const run = makeRun(authorisedKey);

  await handleRoutedCommandMessage(makePlainContext('status of the build?'), run.next, run.deps);

  assert.deepEqual(run.calls, ['next']);
});

test('a command addressed to ANOTHER bot falls through, never authorised', async () => {
  const run = makeRun(authorisedKey);

  await handleRoutedCommandMessage(makeCommandContext('/status@otherBot'), run.next, run.deps);

  assert.deepEqual(run.calls, ['next']);
});

test('the pending-input-mode reset sees the raw message text', async () => {
  // `/connect` continuing its own flow is distinguished from any other command
  // by the message TEXT, so the trigger must forward it verbatim (a truncated
  // or name-only value would cancel the connect the user is completing).
  const seenTexts: string[] = [];
  const run = makeRun(authorisedKey);
  const deps: RoutedCommandTriggerDeps<TriggerContext> = {
    ...run.deps,
    exitPendingInputModes: async (key, messageText) => {
      assert.deepEqual(key, authorisedKey);
      seenTexts.push(messageText);
    },
  };

  await handleRoutedCommandMessage(makeCommandContext('/connect openai sk-secret'), run.next, deps);

  assert.deepEqual(seenTexts, ['/connect openai sk-secret']);
});

// ─── talkers: a person an admin let talk to the agent in one topic ───────────────────

/** The commands a talker may run — the plan's set, and nothing else. A new command is admin-only until somebody flags it on purpose. */
const talkerCommandNames = ['esc', 'escape', 'help', 'interrupt', 'status', 'whoami'];

test('the commands a talker may run are EXACTLY the interrupt family, /status, /whoami and /help — a new command is admin-only until flagged on purpose', () => {
  assert.deepEqual(getTalkerAllowedCommandNames(), talkerCommandNames);
});

test('a talker runs each command flagged for talkers — the chain WITHOUT the input-mode reset: a talker\'s command never ends a step an admin armed', async () => {
  for (const name of talkerCommandNames) {
    const run = makeRun(authorisedKey, 'talker');
    await handleRoutedCommandMessage(makeCommandContext(`/${name}`), run.next, run.deps);
    assert.deepEqual(run.calls, ['authorise', 'noteActivity', 'deliverInbound'], `/${name}`);
  }
});

test('a talker\'s admin-only command gets the one refusal line and reaches nothing: no input-mode reset, no activity, no handler', async () => {
  // Every command of the plan\'s admin-only list that the router owns (the unowned ones are the text handler\'s: see its test).
  const adminOnly = [
    'claude', 'opencode', 'terminal', 'new', 'quit', 'sessions', 'model', 'effort', 'claude_mode', 'accounts', 'limits', 'limits_autoswitch',
    'thinking', 'tool_results', 'subagent', 'verbosity', 'compact', 'compact_on_idle', 'compact_summary', 'compact_self_review',
    'clear_messages', 'bind', 'topic', 'mcp', 'schedule', 'reminders', 'todo', 'stt', 'language', 'timezone', 'timestamps', 'trace',
    'output', 'c', 'y', 'n', 'enter', 'up', 'down', 'tab', 'ls', 'list', 'doctor', 'version', 'update', 'bot_skills', 'task_agents',
    'runners', 'quitall', 'start',
  ].filter((name) => checkIsRoutedCommand(name));
  assert.ok(adminOnly.length >= 40, `the list of commands the router owns shrank to ${adminOnly.length}`);
  for (const name of adminOnly) {
    const run = makeRun(authorisedKey, 'talker');
    await handleRoutedCommandMessage(makeCommandContext(`/${name} some argument`), run.next, run.deps);
    assert.deepEqual(run.calls, ['authorise', 'refuseTalkerCommand'], `/${name}`);
  }
});

test('an admin still runs every command — flagged for talkers or not — through the full chain', async () => {
  for (const name of ['model', 'status', 'bind']) {
    const run = makeRun(authorisedKey, 'admin');
    await handleRoutedCommandMessage(makeCommandContext(`/${name}`), run.next, run.deps);
    assert.deepEqual(run.calls, ['authorise', 'exitPendingInputModes', 'noteActivity', 'deliverInbound'], `/${name}`);
  }
});

test('a talker\'s command the router does not own falls through to the text handler (which refuses it) BEFORE any gate — like anybody\'s', async () => {
  const run = makeRun(authorisedKey, 'talker');
  await handleRoutedCommandMessage(makeCommandContext('/context'), run.next, run.deps);
  assert.deepEqual(run.calls, ['next']);
});

test('a stranger\'s routed command is dropped exactly as before, talkers or not', async () => {
  const run = makeRun(null, 'talker');
  await handleRoutedCommandMessage(makeCommandContext('/status'), run.next, run.deps);
  assert.deepEqual(run.calls, ['authorise']);
});
