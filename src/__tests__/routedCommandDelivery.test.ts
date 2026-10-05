/**
 * @description The PRODUCTION hand-off from the routed-command trigger to the
 * Telegram connector — `deliverRoutedCommand`, wired into the trigger as
 * `routedCommandTriggerDeps.deliverInbound`.
 *
 * `routedCommandTrigger.test.ts` proves the trigger's guard ORDER with injected
 * collaborators; this file proves the one collaborator the real `bot.on`
 * actually uses. It is the line that shipped wrong once (repaired in `c9b1da4`):
 * `InboundEvent.raw` must be the telegraf CONTEXT, because the not-yet-relocated
 * command handlers read Telegram fields off it and a handler reading
 * `ctx.message.message_id` finds `undefined` when `raw` is the bare message. The
 * seam types `raw` as `unknown` by design, so the compiler cannot catch a
 * regression here — only this test can.
 *
 * Its OWN file because it re-arms the shared connector's event handler, which
 * replaces the core dispatcher for the rest of the process. The runner gives
 * each test file its own process, so the swap cannot reach another suite.
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

import { deliverRoutedCommand, routedCommandTriggerDeps, telegramInbound } from '../bot';
import type { InboundEvent } from '../platform/inbound';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

const key = makeTelegramKey(-1001234567890, 42);

/** The telegraf context, reduced to what the hand-off touches plus a marker. */
interface TriggerContext {
  message: Message.TextMessage;
  marker: string;
}

function makeContext(): TriggerContext {
  return {
    marker: 'the telegraf context',
    message: {
      message_id: 908,
      date: 0,
      chat: { id: -1001234567890, type: 'supergroup', title: 'served' },
      from: { id: 7, is_bot: false, first_name: 'sender' },
      text: '/status',
      entities: [{ type: 'bot_command', offset: 0, length: 7 }],
    },
  };
}

test('the trigger delivers the telegraf CONTEXT as `raw`, never the bare message', async () => {
  const received: InboundEvent[] = [];
  await telegramInbound.start((event) => {
    received.push(event);
  });

  const context = makeContext();
  await deliverRoutedCommand(context, key);

  assert.equal(received.length, 1);
  assert.equal(
    received[0].raw,
    context,
    '`raw` must be the context itself — the handlers read `ctx.message.*` off it',
  );
  assert.notEqual(received[0].raw, context.message);
  // The rest of the event is still normalized from the message, so the handlers
  // that already moved onto `InboundEvent` keep working.
  assert.deepEqual(received[0].key, key);
  assert.equal(received[0].command?.name, 'status');
});

test('the registered trigger uses that hand-off, not a second inline path', () => {
  // Wiring assertion: replacing `deliverInbound` with an inline
  // `telegramInbound.deliver(ctx.message, key, ctx.message)` would compile and
  // pass every other test in the suite.
  assert.equal(routedCommandTriggerDeps.deliverInbound, deliverRoutedCommand);
});
