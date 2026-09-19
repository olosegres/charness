/**
 * @description Platform-seam S2 — the core's neutral command router.
 *
 * The router replaced per-command `bot.command(...)` registrations, so its
 * fall-through contract is what keeps behaviour identical: an UNREGISTERED name
 * must decline, because the Telegram trigger turns that decline into the
 * `next()` that lets the generic text handler see the message — exactly what an
 * unregistered `bot.command` always did.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createCommandRouter, splitCommandArgs } from '../platform/commandRouter';
import type { InboundCommand, InboundEvent } from '../platform/inbound';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

function makeEvent(command: InboundCommand | undefined): InboundEvent {
  return {
    key: makeTelegramKey(-100, 7),
    author: { id: '7', displayName: 'u7' },
    text: command ? `/${command.name} ${command.argsText}`.trim() : 'plain text',
    attachments: [],
    command,
    raw: null,
  };
}

function makeCommand(name: string, remainder = ''): InboundCommand {
  return { name, ...splitCommandArgs(remainder) };
}

test('dispatch runs the handler bound to the command name', async () => {
  const router = createCommandRouter();
  const seen: string[] = [];
  router.register('status', (_event, command) => {
    seen.push(command.argsText);
  });

  assert.equal(await router.dispatch(makeEvent(makeCommand('status', 'now'))), true);
  assert.deepEqual(seen, ['now']);
});

test('dispatch declines an unregistered name so the caller can fall through', async () => {
  const router = createCommandRouter();
  router.register('status', () => {
    assert.fail('must not run');
  });
  assert.equal(await router.dispatch(makeEvent(makeCommand('nosuch'))), false);
});

test('dispatch declines an event with no command at all', async () => {
  const router = createCommandRouter();
  router.register('status', () => {
    assert.fail('must not run');
  });
  assert.equal(await router.dispatch(makeEvent(undefined)), false);
});

test('an alias list binds every name to the same handler', async () => {
  const router = createCommandRouter();
  let runs = 0;
  router.register(['opencode', 'oc'], () => {
    runs += 1;
  });

  await router.dispatch(makeEvent(makeCommand('opencode')));
  await router.dispatch(makeEvent(makeCommand('oc')));
  assert.equal(runs, 2);
});

test('names match EXACTLY, case included', async () => {
  // Load-bearing: telegraf's own command matcher is a case-sensitive
  // `^name$` regex, so `/STATUS` used to fall through to the plain-text path
  // and reach the agent as a prompt. Folding case here would silently start
  // executing it as a command.
  const router = createCommandRouter();
  let runs = 0;
  router.register('status', () => {
    runs += 1;
  });

  assert.equal(router.checkIsRegistered('STATUS'), false);
  assert.equal(await router.dispatch(makeEvent(makeCommand('STATUS'))), false);
  assert.equal(await router.dispatch(makeEvent(makeCommand('Status'))), false);
  assert.equal(runs, 0);

  assert.equal(await router.dispatch(makeEvent(makeCommand('status'))), true);
  assert.equal(runs, 1);
});

test('a re-registered name replaces the previous handler', async () => {
  const router = createCommandRouter();
  router.register('status', () => {
    assert.fail('the replaced handler must not run');
  });
  let ran = false;
  router.register('status', () => {
    ran = true;
  });

  await router.dispatch(makeEvent(makeCommand('status')));
  assert.equal(ran, true);
});

test('a rejecting handler propagates so the caller can log it', async () => {
  const router = createCommandRouter();
  router.register('boom', async () => {
    throw new Error('handler blew up');
  });
  await assert.rejects(() => router.dispatch(makeEvent(makeCommand('boom'))), /handler blew up/);
});

// ─── splitCommandArgs ───────────────────────────────────────────────────

test('splitCommandArgs: trims the ends but keeps inner spacing in argsText', () => {
  assert.deepEqual(splitCommandArgs('  my  long  title  '), {
    argsText: 'my  long  title',
    args: ['my', 'long', 'title'],
  });
});

test('splitCommandArgs: an empty remainder yields no args', () => {
  assert.deepEqual(splitCommandArgs(''), { argsText: '', args: [] });
  assert.deepEqual(splitCommandArgs('   '), { argsText: '', args: [] });
});

test('splitCommandArgs: newlines separate args and survive in argsText', () => {
  // `/schedule` takes a multi-line prose body — collapsing it would corrupt it.
  const split = splitCommandArgs('every day\nat 9am');
  assert.equal(split.argsText, 'every day\nat 9am');
  assert.deepEqual(split.args, ['every', 'day', 'at', '9am']);
});
