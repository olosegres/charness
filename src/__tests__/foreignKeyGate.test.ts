/**
 * @description The foreign-key gates of Jira connector plan J2b: the routing of
 * every adapter event for a conversation of another platform (R2), the send
 * queue's refusal of such a key without ever raising an unhandled rejection
 * (R2), and the native question turned off outside Telegram (R1).
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { makeJiraKey } from '../connectors/jira/sessionKeyCodec';
import {
  adapterEventNames,
  dispatchAdapterEvent,
  type AdapterEventName,
} from '../adapters/adapterEventRouting';
import { enqueueSend, ForeignKeySendRefusedError, sendUnpaced } from '../rateLimiter';
import { getClaudePlatformFlags } from '../adapters/claudePlatformFlags';

const topicKey = makeTelegramKey(-1001234567890, 42);
const issueKey = makeJiraKey('PROJ-12');

/** What a Jira conversation's event must run — written out here, not read from the module's table. */
const expectedJiraRoutes: Record<AdapterEventName, 'telegramHandler' | 'requestSideHandler' | 'nothing'> = {
  output: 'requestSideHandler',
  status: 'nothing',
  question: 'nothing',
  thinking: 'nothing',
  toolResult: 'nothing',
  subagentStatus: 'nothing',
  apiError: 'telegramHandler',
  noResponse: 'telegramHandler',
  questionGone: 'nothing',
  closed: 'requestSideHandler',
  started: 'nothing',
  stopped: 'requestSideHandler',
  error: 'requestSideHandler',
};

function getRanHandler(key: typeof topicKey, eventName: AdapterEventName): string {
  const ran: string[] = [];
  dispatchAdapterEvent(key, eventName, () => ran.push('telegramHandler'), () => ran.push('requestSideHandler'));
  assert.ok(ran.length <= 1, `${eventName}: at most one handler runs`);
  return ran[0] ?? 'nothing';
}

describe('dispatchAdapterEvent (R2)', () => {
  it('a Telegram conversation runs the Telegram handler of every event', () => {
    for (const eventName of adapterEventNames) assert.equal(getRanHandler(topicKey, eventName), 'telegramHandler', eventName);
  });

  it('a Jira conversation runs only what its request needs, event by event', () => {
    for (const eventName of adapterEventNames) {
      assert.equal(getRanHandler(issueKey, eventName), expectedJiraRoutes[eventName], eventName);
    }
  });

  it('every event the adapters are wired for has a route', () => {
    const wiring = fs.readFileSync(path.join(__dirname, '..', 'adapters', 'createAdapter.ts'), 'utf8');
    const wiredEvents = [...wiring.matchAll(/adapter\.on\('([A-Za-z]+)'/g)].map((match) => match[1]).sort();
    assert.deepEqual(wiredEvents, [...adapterEventNames].sort());
  });

  it('every event an adapter emits has a route', () => {
    const adaptersDir = path.join(__dirname, '..', 'adapters');
    const emittedEvents = new Set<string>();
    const dynamicEmitSites: string[] = [];
    for (const fileName of fs.readdirSync(adaptersDir).filter((name) => name.endsWith('.ts'))) {
      const source = fs.readFileSync(path.join(adaptersDir, fileName), 'utf8');
      for (const match of source.matchAll(/\.emit\(\s*(?:'([A-Za-z]+)'|([A-Za-z]+))/g)) {
        if (match[1]) emittedEvents.add(match[1]);
        else dynamicEmitSites.push(`${fileName}: ${match[2]}`);
      }
    }
    const unrouted = [...emittedEvents].filter((name) => !(adapterEventNames as readonly string[]).includes(name));
    assert.deepEqual(unrouted, [], 'an emitted event with no route is dropped for every platform');
    // The one name not written as a literal: `emitToAllActiveSessions`, whose parameter is typed `'error'`.
    assert.deepEqual(dynamicEmitSites, ['openCodeAdapter.ts: eventName']);
  });

  it('every handler the bot wires goes through the gate under its own event name', () => {
    const bot = fs.readFileSync(path.join(__dirname, '..', 'bot.ts'), 'utf8');
    const wiringStart = bot.indexOf('registerAdapterEventHandlers({');
    assert.notEqual(wiringStart, -1);
    const wiring = bot.slice(wiringStart, bot.indexOf('\n  });', wiringStart));
    const handlers = [...wiring.matchAll(/\n {4}on([A-Z][A-Za-z]*): \([^)]*\) => (\S+\([^,]*, '[A-Za-z]+')?/g)];
    const wiredEvents = handlers.map((match) => match[1].charAt(0).toLowerCase() + match[1].slice(1));
    assert.deepEqual([...wiredEvents].sort(), [...adapterEventNames].sort());
    for (const [index, match] of handlers.entries()) {
      assert.equal(match[2], `dispatchAdapterEvent(key, '${wiredEvents[index]}'`, `on${match[1]} bypasses the gate`);
    }
  });
});

describe('the send queue refuses a Jira conversation (R2)', () => {
  it('never runs the operation, and rejects like a failed Telegram call', async () => {
    let calls = 0;
    const operation = async (): Promise<string> => { calls += 1; return 'sent'; };

    await assert.rejects(enqueueSend(issueKey, operation), ForeignKeySendRefusedError);
    await assert.rejects(sendUnpaced(issueKey, operation), ForeignKeySendRefusedError);
    assert.equal(calls, 0);
  });

  it('a fire-and-forget refusal raises no unhandled rejection (that would end the process)', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      void enqueueSend(issueKey, async () => 'sent');
      void sendUnpaced(issueKey, async () => 'sent');
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    assert.deepEqual(unhandled, []);
  });
});

describe('getClaudePlatformFlags (R1, R7)', () => {
  it('outside Telegram: no user-level Claude setup, no native question; for Telegram: nothing', () => {
    assert.deepEqual(getClaudePlatformFlags(issueKey), [
      '--setting-sources', 'project,local',
      '--disallowedTools', 'AskUserQuestion',
    ]);
    assert.deepEqual(getClaudePlatformFlags(topicKey), []);
  });

  it('every Claude launch path passes them, right before another option, and the MCP flags (R8)', () => {
    // Each argv that names a session (`--session-id` / `--resume` / `--continue` /
    // `--fork-session`) is a launch.
    const launchArgRe = /'--(?:session-id|resume|continue|fork-session)'/g;
    let launchCount = 0;
    for (const file of ['claudeCliAdapter.ts', 'claudeJsonStreamAdapter.ts']) {
      const lines = fs.readFileSync(path.join(__dirname, '..', 'adapters', file), 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (!launchArgRe.test(line)) return;
        launchArgRe.lastIndex = 0;
        launchCount += 1;
        const argvStart = lines.slice(Math.max(0, index - 25), index).join('\n');
        const flagsUse = argvStart.lastIndexOf('...getClaudePlatformFlags(key),');
        assert.ok(flagsUse >= 0, `${file}:${index + 1} launches without the platform flags`);
        const nextArgument = argvStart.slice(flagsUse).split('\n').slice(1).find((next) => !next.trim().startsWith('//'));
        assert.match(nextArgument ?? '', /^\s*('--|\.\.\.claudePermissionArgs)/, `${file}:${index + 1}: an option must follow`);
        // `--strict-mcp-config` (the only thing keeping the account connectors out) rides these flags.
        const mcpFlagsName = /const (\w+) = await prepareMcpFlags\(\{ key,/.exec(argvStart)?.[1];
        assert.ok(mcpFlagsName, `${file}:${index + 1} launches without the MCP flags`);
        const argvAround = lines.slice(Math.max(0, index - 25), index + 5).join('\n');
        assert.ok(argvAround.includes(`...${mcpFlagsName}`), `${file}:${index + 1} does not pass ${mcpFlagsName}`);
      });
    }
    assert.ok(launchCount >= 3, 'tmux start, tmux resume and the json-stream spawn');
  });
});
