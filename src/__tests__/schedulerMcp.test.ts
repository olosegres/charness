/**
 * @description Coverage for `scheduler/mcpSurface.ts` (S5):
 *
 *   - token helpers: build/verify round-trip, tampered scope/signature rejected,
 *     malformed tokens rejected, timing-safe compare used (read from source).
 *   - buildSpecFromCreateArgs: exactly-one-of (+ recipe hint), one-shot tolerates
 *     a redundant repeatCount (ignored, not an error), empty-string normalization,
 *     bad cron.
 *   - resolveTargetThreadKey: thread scope (match/mismatch), dir scope
 *     (0 / 1 / >1 bound threads, threadKey requirement + validation).
 *   - END-TO-END over real HTTP: start the server on port 0, connect with the
 *     SDK Client + StreamableHTTPClientTransport using a valid thread-scope
 *     token → create (cron + once + N-times) → list → cancel → list empty;
 *     invalid token rejected; dir-scope with 2 bound threads requires threadKey;
 *     thread-scope create with a mismatching threadKey arg errors; the real
 *     file-send service routes single MP4, mixed photo/video album, and
 *     `as_file` MP4 calls through the exact typed Telegram gateway methods.
 *
 * The end-to-end test uses a REAL StateStore (state.test.ts fake-HOME idiom) and
 * fake armJob/disarmJob + Telegram gateway capturing calls, so the assertions
 * are load-bearing: a broken token verify, scope resolution, tool handler, or
 * MP4/media-group routing fails the round-trip.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { splitMessage } from '../connectors/telegram/messageSplit';
import { beforeEach, afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { StateStore } from '../state';
import { keyToString } from '../sessionKey';
import {
  buildSchedulerMcpToken,
  verifySchedulerMcpToken,
  buildSpecFromCreateArgs,
  resolveTargetThreadKey,
  buildBotMcpToolDigest,
  createSchedulerMcpServer,
  getBotMcpToolDigest,
  getBotMcpToolDefinitions,
  buildMcpServerInstructions,
  serializeSchedulerScope,
  parseSchedulerScope,
  getSchedulerMcpPort,
  resolveSchedulerMcpPort,
  defaultSchedulerMcpPort,
  createSchedulerMcpCancellationLifecycle,
  legacySchedulerMcpClientIdHeader,
  schedulerMcpClientIdHeader,
  schedulerMcpPendingCancellationMax,
  schedulerMcpPendingCancellationTtlMs,
  type ClaudeProfilesQuery,
  type SchedulerScope,
  type SchedulerMcpHandle,
  type SchedulerMcpDeps,
} from '../scheduler/mcpSurface';
import { claudeProfileNameMaxLength } from '../utils/claudeProfiles';
import { resetLegacyNameState } from '../legacyNames';
import { request, type ClientRequest } from 'node:http';
import { connect, Server } from 'node:net';
import type { ScheduleRecord } from '../scheduler/types';
import {
  createSendFilesToThread,
  type SendFilesToThread,
  type SendFilesToThreadOptions,
} from '../utils/fileSendService';
import {
  createSendMessagesToThread,
  type SendMessagesToThread,
  type SendMessagesToThreadOptions,
} from '../utils/messageSendService';
import {
  createFileSendTestRecorderGateway,
  type RecordedFileSendGatewayCall,
} from './fileSendTestRecorder';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { holdPort } from './e2e/isolatedCharness';
import { formatLocalDateAndClock } from '../utils/localClock';
import {
  workerWatchCheckCommand,
  workerWatchCheckCron,
  workerWatchStatusArguments,
} from '../scheduler/workerWatch';

/** The plan's budget for the always-loaded orchestration bullet of the Telegram instructions. */
const maxOrchestrationBulletLength = 450;

const secret = 'a'.repeat(64);
const threadAKey = keyToString(makeTelegramKey(-1001234567890, 11));
const threadBKey = keyToString(makeTelegramKey(-1001234567890, 22));
const nowMs = new Date(2026, 5, 6, 10, 0, 0).getTime();
const schedulerMcpStopTimeoutMs = 1_000;
const incompleteRequestBody = '{"jsonrpc":"2.0"';
const linuxIt = process.platform === 'linux' ? it : it.skip;

interface IncompleteHttpRequest {
  request: ClientRequest;
  connected: Promise<void>;
}

function checkPromiseResolvesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    promise.then(
      () => {
        clearTimeout(timeout);
        resolve(true);
      },
      (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function createIncompleteHttpRequest(port: number, token: string): IncompleteHttpRequest {
  const activeRequest = request({
    host: '127.0.0.1',
    port,
    path: '/mcp',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': (incompleteRequestBody.length + 1).toString(),
    },
  });
  // Destroying the request during test cleanup reports ECONNRESET asynchronously.
  activeRequest.on('error', () => {});
  const connected = new Promise<void>((resolve) => {
    activeRequest.once('socket', (socket) => {
      if (socket.connecting) socket.once('connect', resolve);
      else resolve();
    });
  });
  activeRequest.write(incompleteRequestBody);
  return { request: activeRequest, connected };
}

// ─── port resolution + reuse ─────────────────────────────────────────

describe('resolveSchedulerMcpPort', () => {
  it('an explicit env port wins over a persisted one', () => {
    assert.equal(resolveSchedulerMcpPort(4107, 5555), 4107);
  });
  it('reuses the persisted port when no env override is set', () => {
    assert.equal(resolveSchedulerMcpPort(defaultSchedulerMcpPort, 5555), 5555);
  });
  it('falls back to ephemeral (0) when neither env nor a persisted port exist', () => {
    assert.equal(resolveSchedulerMcpPort(defaultSchedulerMcpPort, undefined), defaultSchedulerMcpPort);
  });
  it('ignores a non-positive persisted port', () => {
    assert.equal(resolveSchedulerMcpPort(defaultSchedulerMcpPort, 0), defaultSchedulerMcpPort);
  });
});

describe('the bot-MCP tool digest (lifecycle plan L4)', () => {
  function createDigestDeps(): SchedulerMcpDeps {
    return {
      store: {} as SchedulerMcpDeps['store'],
      armJob: () => {},
      disarmJob: () => {},
      getThreadsForDirectory: () => [],
      getThreadAdapterName: () => 'claude',
      unpinMessages: async () => [],
      deleteMessage: async () => {},
      sendFilesToThread: async () => ({ ok: true, summary: 'unused', sentKinds: [] }),
      sendMessagesToThread: async () => ({ ok: true, summary: 'unused', undeliveredCount: 0, sentMessageIds: [] }),
      compactConversation: () => ({ ok: true, message: 'unused' }),
      answerRequest: async () => ({ ok: false, error: 'unused' }),
      whenSessionsRestored: async () => {},
      getSecret: async () => secret,
    };
  }

  it('is stable for one platform, differs between the Telegram and the neutral tool set, and is what the handle reports', () => {
    const deps = createDigestDeps();
    const telegram = getBotMcpToolDigest(deps, 'telegram', true);
    assert.equal(getBotMcpToolDigest(deps, 'telegram', true), telegram, 'deterministic');
    assert.notEqual(getBotMcpToolDigest(deps, 'jira', true), telegram, 'an issue gets the two neutral tools only');
    // The one difference from the neutral set: a Jira session's answer_request takes the comments it replies to.
    assert.notEqual(getBotMcpToolDigest(deps, 'jira', true), getBotMcpToolDigest(deps, null, true), 'a Jira session\'s answer_request has the reply field');
    assert.equal(getBotMcpToolDigest(deps, 'test', true), getBotMcpToolDigest(deps, null, true), 'any other platform gets the neutral set');
    assert.equal(createSchedulerMcpServer(deps).getToolDigest('telegram', true), telegram);
  });

  it('C10: with the Jira connector\'s attachment port a Jira session gets its own tool set — its digest differs from the neutral one, no other platform\'s moves', () => {
    const without = createDigestDeps();
    const withPort: SchedulerMcpDeps = { ...without, fetchJiraAttachment: async () => ({ ok: false, error: 'unused' }) };
    assert.notEqual(getBotMcpToolDigest(withPort, 'jira', true), getBotMcpToolDigest(without, 'jira', true));
    assert.notEqual(getBotMcpToolDigest(withPort, 'jira', true), getBotMcpToolDigest(withPort, null, true));
    assert.equal(getBotMcpToolDigest(withPort, 'telegram', true), getBotMcpToolDigest(without, 'telegram', true));
    assert.equal(getBotMcpToolDigest(withPort, null, true), getBotMcpToolDigest(without, null, true));
  });

  it('the claude_profiles port adds its tool on EVERY platform (a child process is launched the same way everywhere), so each digest moves', () => {
    const without = createDigestDeps();
    const withPort: SchedulerMcpDeps = { ...without, listClaudeProfiles: async ({ model }) => ({ model, relevantBuckets: [], recommended: null, pickReason: 'none', nextAvailable: null, profiles: [] }) };
    for (const platform of ['telegram', 'jira', null] as const) {
      assert.notEqual(getBotMcpToolDigest(withPort, platform, true), getBotMcpToolDigest(without, platform, true), `${platform ?? 'neutral'} digest`);
    }
  });

  it('schedule_create teaches the worker watch: both signals, the cron, never kill -0 alone', () => {
    const scheduleCreate = getBotMcpToolDefinitions(createDigestDeps(), 'telegram').find((definition) => definition.name === 'schedule_create');
    const description = scheduleCreate?.description ?? '';
    assert.ok(description.includes(`checkCommand \`${workerWatchCheckCommand}\``), description);
    assert.ok(description.includes(`cron \`${workerWatchCheckCron}\``));
    assert.ok(!description.includes('isPinSilent'), 'nothing a check posts is pinned, so the recipe has no pin argument');
    assert.match(description, /never the command/, 'the topic reads «worker finished» / «worker silent»');
    assert.ok(description.includes(`\`${workerWatchStatusArguments}\``), 'the status arguments: the bot posts the topic\'s status lines');
    assert.match(description, /never arm a schedule of your own for status lines/);
    assert.match(description, /Never `kill -0` alone/);
  });

  it('a tracker conversation is pointed at the manager skill but gets no scheduling recipe — it has no scheduling tools', () => {
    for (const platform of ['jira', null] as const) {
      const instructions = buildMcpServerInstructions(platform, { isJiraAttachmentToolOffered: false, isTodoToolOffered: false, remoteRunRunnerLines: [] }, true);
      assert.ok(instructions.includes('`charness-manager`'), `${platform ?? 'neutral'}`);
      assert.ok(!instructions.includes(workerWatchCheckCommand), `${platform ?? 'neutral'}`);
      assert.doesNotMatch(instructions, /schedule_create/);
    }
  });

  it('every bot tool the shipped skills name is one a bot session really gets', () => {
    const deps: SchedulerMcpDeps = {
      ...createDigestDeps(),
      fetchJiraAttachment: async () => ({ ok: false, error: 'unused' }),
      listClaudeProfiles: async ({ model }) => ({ model, relevantBuckets: [], recommended: null, pickReason: 'none', nextAvailable: null, profiles: [] }),
    };
    const offered = new Set((['telegram', 'jira'] as const).flatMap((platform) => getBotMcpToolDefinitions(deps, platform).map((definition) => definition.name)));
    const skillsDir = path.join(__dirname, '..', '..', 'agent-plugin', 'skills');
    const botToolPattern = /\b(?:schedule_[a-z]+|claude_profiles|answer_request|send_[a-z_]+_to_user|compact_conversation|jira_[a-z_]+)\b/g;
    for (const folder of fs.readdirSync(skillsDir)) {
      const text = fs.readFileSync(path.join(skillsDir, folder, 'SKILL.md'), 'utf8');
      for (const named of new Set(text.match(botToolPattern) ?? [])) {
        assert.ok(offered.has(named), `${folder} names ${named}, which no bot session gets`);
      }
    }
    assert.ok(offered.has('schedule_create') && offered.has('claude_profiles'), 'the tools the manager leans on');
  });

  it('every claude_profiles input the shipped skills name is one the tool takes', () => {
    const deps: SchedulerMcpDeps = {
      ...createDigestDeps(),
      listClaudeProfiles: async ({ model }) => ({ model, relevantBuckets: [], recommended: null, pickReason: 'none', nextAvailable: null, profiles: [] }),
    };
    const takenInputs = getBotMcpToolDefinitions(deps, 'telegram').find((definition) => definition.name === 'claude_profiles')?.inputKeys ?? [];
    assert.deepEqual(takenInputs, ['currentProfile', 'isStoppedByLimit', 'model']);
    const skillsDir = path.join(__dirname, '..', '..', 'agent-plugin', 'skills');
    const resumeInputs = takenInputs.filter((input) => input !== 'model');
    const namedInputs = new Set<string>();
    for (const folder of fs.readdirSync(skillsDir)) {
      const text = fs.readFileSync(path.join(skillsDir, folder, 'SKILL.md'), 'utf8');
      for (const input of resumeInputs) if (text.includes(input)) namedInputs.add(input);
      assert.doesNotMatch(text, /isStoppedBy(?!Limit)|currentProfil(?!e)/, `${folder} misspells a claude_profiles input`);
    }
    assert.deepEqual([...namedInputs].sort(), ['currentProfile', 'isStoppedByLimit'], 'the skills teach the resume inputs');
  });

  it('the orchestration add-on and the Claude delegate skill say what to do when nothing is usable AND no account names when it frees up', () => {
    const skillsDir = path.join(__dirname, '..', '..', 'agent-plugin', 'skills');
    for (const folder of ['charness-delegate-claude', 'charness-orchestration']) {
      const text = fs.readFileSync(path.join(skillsDir, folder, 'SKILL.md'), 'utf8');
      assert.match(text, /`nextAvailable`\s+(?:is\s+)?null\s+too/, `${folder} covers a null nextAvailable`);
      assert.match(text, /native\s+question/, `${folder} sends the user a native question`);
      assert.match(text, /30\s+minutes/, `${folder} schedules the retry`);
    }
  });

  it('changes when the instructions change or a tool is added, renamed, re-described or re-shaped; registration order does not matter', () => {
    const base = [
      { name: 'answer_request', title: 'Answer a request', description: 'Send your answer', inputKeys: ['body', 'kind', 'requestId'] },
      { name: 'compact_conversation', title: 'Compact', description: 'Compact this conversation', inputKeys: ['reason'] },
    ];
    const instructions = 'Use these tools.';
    const digest = buildBotMcpToolDigest(instructions, base);
    assert.equal(buildBotMcpToolDigest(instructions, [base[1], base[0]]), digest, 'order-independent');
    assert.notEqual(buildBotMcpToolDigest(instructions, [...base, { name: 'schedule_list', title: 'List', description: 'List', inputKeys: [] }]), digest, 'a tool added');
    assert.notEqual(buildBotMcpToolDigest(instructions, [{ ...base[0], name: 'answer' }, base[1]]), digest, 'a tool renamed');
    assert.notEqual(buildBotMcpToolDigest(instructions, [{ ...base[0], description: 'Send your answer, please' }, base[1]]), digest, 'a description changed');
    assert.notEqual(buildBotMcpToolDigest(instructions, [{ ...base[0], inputKeys: ['body', 'kind'] }, base[1]]), digest, 'a parameter dropped');
    assert.notEqual(buildBotMcpToolDigest('Use these tools, please.', base), digest, 'the connect-time instructions changed');
  });
});

describe('createSchedulerMcpServer port binding', () => {
  const retryDelayMs = 10;
  const spentRetryCount = 3;
  const unspentRetryCount = 100;
  /** A product that stops retrying or never reports must fail these cases, not hang the run. */
  const testTimeoutMs = 10_000;
  /** Long enough for a retry still running after a stop() to have bound the freed port. */
  const settleWaitMs = 500;

  afterEach(() => {
    mock.restoreAll();
  });

  function checkIsPortListening(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
  }

  function createBindingDeps(port: number, portBindRetry: SchedulerMcpDeps['portBindRetry']): SchedulerMcpDeps {
    return {
      store: {} as SchedulerMcpDeps['store'],
      armJob: () => {},
      disarmJob: () => {},
      getThreadsForDirectory: () => [],
      getThreadAdapterName: () => 'claude',
      unpinMessages: async () => [],
      deleteMessage: async () => {},
      sendFilesToThread: async () => ({ ok: true, summary: 'unused', sentKinds: [] }),
      sendMessagesToThread: async () => ({ ok: true, summary: 'unused', undeliveredCount: 0, sentMessageIds: [] }),
      compactConversation: () => ({ ok: true, message: 'unused' }),
      answerRequest: async () => ({ ok: false, error: 'unused' }),
      whenSessionsRestored: async () => {},
      getSecret: async () => secret,
      port,
      portBindRetry,
    };
  }

  it('retries a port that is in use a bounded number of times, then falls back to an ephemeral one and says what that costs', { timeout: testTimeoutMs }, async () => {
    const holder = await holdPort(0);
    const listen = mock.method(Server.prototype, 'listen');
    const warn = mock.method(console, 'warn', () => {});
    const error = mock.method(console, 'error', () => {});
    const handle = createSchedulerMcpServer(createBindingDeps(holder.port, { count: spentRetryCount, delayMs: retryDelayMs }));
    try {
      await handle.start();
      assert.ok(handle.port > 0, 'a port was bound');
      assert.notEqual(handle.port, holder.port, 'did not bind the occupied port');
      assert.deepEqual(
        listen.mock.calls.map((call) => call.arguments[0]),
        [...Array<number>(spentRetryCount + 1).fill(holder.port), 0],
        'the requested port is tried once and retried the allowed number of times, then one ephemeral listen',
      );
      assert.equal(warn.mock.callCount(), 1, 'one line for the whole wait, not one per retry');
      assert.equal(error.mock.callCount(), 1);
      assert.match(error.mock.calls[0].arguments[0], new RegExp(`port ${holder.port} is still in use`));
      assert.match(error.mock.calls[0].arguments[0], /Claude session that was already running keeps the MCP address of its launch .*loses the bot's tools/);
    } finally {
      await handle.stop();
      await holder.release();
    }
  });

  it('binds the requested port once its holder lets go during the retries: no fallback, no error', { timeout: testTimeoutMs }, async () => {
    const holder = await holdPort(0);
    // The first conflict is the cue to let go, so the test does not depend on a clock.
    const warn = mock.method(console, 'warn', () => {
      void holder.release();
    });
    const error = mock.method(console, 'error', () => {});
    const handle = createSchedulerMcpServer(createBindingDeps(holder.port, { count: unspentRetryCount, delayMs: retryDelayMs }));
    try {
      await handle.start();
      assert.equal(handle.port, holder.port, 'the port every launched session points at');
      assert.match(warn.mock.calls[0].arguments[0], new RegExp(`port ${holder.port} is in use; retrying`));
      assert.equal(error.mock.callCount(), 0);
    } finally {
      await handle.stop();
      await holder.release();
    }
  });

  it('a stop() during the wait leaves nothing bound afterwards, and start() fails instead of hanging', { timeout: testTimeoutMs }, async () => {
    const holder = await holdPort(0);
    const listen = mock.method(Server.prototype, 'listen');
    const conflictSeen = new Promise<void>((resolve) => {
      mock.method(console, 'warn', () => resolve());
    });
    mock.method(console, 'error', () => {});
    const handle = createSchedulerMcpServer(createBindingDeps(holder.port, { count: unspentRetryCount, delayMs: retryDelayMs }));
    const starting = handle.start().then(() => 'bound', () => 'refused');
    await conflictSeen;
    await handle.stop();
    // Free now: a retry that still ran would bind it and leave a listener nobody can stop.
    await holder.release();
    const settleDeadline = new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), settleWaitMs));
    assert.equal(await Promise.race([starting, settleDeadline]), 'refused');
    assert.equal(await checkIsPortListening(holder.port), false, 'no listener was left on the requested port');
    assert.equal(listen.mock.calls.filter((call) => call.arguments[0] === holder.port).length, 1, 'the requested port was not retried after the stop');
  });
});

// ─── cancellation correlation lifecycle ─────────────────────────────

describe('scheduler MCP cancellation correlation lifecycle', () => {
  const clientIdentity = 'token:verified-token:client:test-client';
  let currentTimeMs = 1_000;

  const invalidMaxTombstoneCases = [
    { label: 'zero', value: 0 },
    { label: 'negative', value: -1 },
    { label: 'fractional', value: 1.5 },
    { label: 'NaN', value: Number.NaN },
    { label: 'Infinity', value: Number.POSITIVE_INFINITY },
    { label: 'unsafe integer', value: Number.MAX_SAFE_INTEGER + 1 },
  ];

  function getNowMs(): number {
    return currentTimeMs;
  }

  beforeEach(() => {
    currentTimeMs = 1_000;
  });

  for (const invalidCase of invalidMaxTombstoneCases) {
    it(`rejects a ${invalidCase.label} maxTombstones bound`, () => {
      assert.throws(
        () => createSchedulerMcpCancellationLifecycle({
          getNowMs,
          maxTombstones: invalidCase.value,
        }),
        /maxTombstones must be a positive safe integer/,
      );
    });
  }

  it('expires a pending cancellation before a later request registers', () => {
    const lifecycle = createSchedulerMcpCancellationLifecycle({ getNowMs });
    lifecycle.cancelRequest(clientIdentity, 41, 'cancel before registration');
    currentTimeMs += schedulerMcpPendingCancellationTtlMs;

    const requestRegistration = lifecycle.registerRequest(clientIdentity, 41);
    assert.equal(requestRegistration.controller.signal.aborted, false);
    requestRegistration.unregister();
  });

  it('bounds pending cancellations and evicts the oldest tombstone first', () => {
    assert.equal(schedulerMcpPendingCancellationMax, 1_000, 'production keeps the 1,000-entry bound');
    const lifecycle = createSchedulerMcpCancellationLifecycle({
      getNowMs,
      maxTombstones: 2,
    });
    lifecycle.cancelRequest(clientIdentity, 1, 'oldest');
    lifecycle.cancelRequest(clientIdentity, 2, 'middle');
    lifecycle.cancelRequest(clientIdentity, 3, 'newest');

    const oldest = lifecycle.registerRequest(clientIdentity, 1);
    const middle = lifecycle.registerRequest(clientIdentity, 2);
    const newest = lifecycle.registerRequest(clientIdentity, 3);
    assert.equal(oldest.controller.signal.aborted, false, 'the oldest pending cancellation must be evicted');
    assert.equal(middle.controller.signal.aborted, true);
    assert.equal(newest.controller.signal.aborted, true);
    oldest.unregister();
    middle.unregister();
    newest.unregister();
  });

  it('isolates pending cancellations by token, client, and typed request ID', () => {
    const lifecycle = createSchedulerMcpCancellationLifecycle({ getNowMs });
    lifecycle.cancelRequest(clientIdentity, 7, 'exact correlation only');

    const otherToken = lifecycle.registerRequest('token:other-token:client:test-client', 7);
    const otherClient = lifecycle.registerRequest('token:verified-token:client:other-client', 7);
    const stringId = lifecycle.registerRequest(clientIdentity, '7');
    const exactMatch = lifecycle.registerRequest(clientIdentity, 7);
    assert.equal(otherToken.controller.signal.aborted, false);
    assert.equal(otherClient.controller.signal.aborted, false);
    assert.equal(stringId.controller.signal.aborted, false);
    assert.equal(exactMatch.controller.signal.aborted, true);
    otherToken.unregister();
    otherClient.unregister();
    stringId.unregister();
    exactMatch.unregister();
  });

  it('expires a recent completion before an unmatched cancellation arrives', () => {
    const lifecycle = createSchedulerMcpCancellationLifecycle({ getNowMs });
    const completed = lifecycle.registerRequest(clientIdentity, 51);
    completed.markTerminal();
    completed.unregister();
    currentTimeMs += schedulerMcpPendingCancellationTtlMs;

    lifecycle.cancelRequest(clientIdentity, 51, 'late cancellation after completion expiry');
    const laterRequest = lifecycle.registerRequest(clientIdentity, 51);
    assert.equal(laterRequest.controller.signal.aborted, true, 'the expired completion must not suppress cancellation');
    laterRequest.unregister();
  });

  it('cancels an active reused request even while a recent completion remains', () => {
    const lifecycle = createSchedulerMcpCancellationLifecycle({ getNowMs });
    const completed = lifecycle.registerRequest(clientIdentity, 52);
    completed.markTerminal();
    completed.unregister();

    const reused = lifecycle.registerRequest(clientIdentity, 52);
    assert.equal(reused.controller.signal.aborted, false);
    lifecycle.cancelRequest(clientIdentity, 52, 'cancel active reused generation');
    assert.equal(reused.controller.signal.aborted, true, 'an active controller must take precedence over a tombstone');
    reused.unregister();
  });

  it('ignores a late cancellation for an inactive recently completed request', () => {
    const lifecycle = createSchedulerMcpCancellationLifecycle({ getNowMs });
    const completed = lifecycle.registerRequest(clientIdentity, 53);
    completed.markTerminal();
    completed.unregister();

    lifecycle.cancelRequest(clientIdentity, 53, 'late cancellation for completed generation');
    const reused = lifecycle.registerRequest(clientIdentity, 53);
    assert.equal(reused.controller.signal.aborted, false, 'late cancellation must not create a pending tombstone');
    reused.unregister();
  });

  it('does not refresh recent-completion expiry when terminal marking repeats', () => {
    const lifecycle = createSchedulerMcpCancellationLifecycle({ getNowMs });
    const completed = lifecycle.registerRequest(clientIdentity, 54);
    const terminalTimeMs = currentTimeMs;
    completed.markTerminal();
    currentTimeMs += 1;
    completed.markTerminal();
    completed.unregister();
    currentTimeMs = terminalTimeMs + schedulerMcpPendingCancellationTtlMs;

    lifecycle.cancelRequest(clientIdentity, 54, 'late cancellation after original terminal expiry');
    const reused = lifecycle.registerRequest(clientIdentity, 54);
    assert.equal(reused.controller.signal.aborted, true, 'repeated terminal marking must not extend the tombstone TTL');
    reused.unregister();
  });

  it('bounds recent completions and evicts the oldest tombstone first', () => {
    const lifecycle = createSchedulerMcpCancellationLifecycle({
      getNowMs,
      maxTombstones: 2,
    });
    for (const requestId of [61, 62, 63]) {
      const registration = lifecycle.registerRequest(clientIdentity, requestId);
      registration.markTerminal();
      registration.unregister();
    }

    lifecycle.cancelRequest(clientIdentity, 62, 'retained completion suppresses this inactive cancellation');
    lifecycle.cancelRequest(clientIdentity, 61, 'oldest completion was evicted');
    const oldestReused = lifecycle.registerRequest(clientIdentity, 61);
    const retainedReused = lifecycle.registerRequest(clientIdentity, 62);
    assert.equal(oldestReused.controller.signal.aborted, true);
    assert.equal(retainedReused.controller.signal.aborted, false, 'the retained completion must suppress a late cancellation');
    oldestReused.unregister();
    retainedReused.unregister();
  });
});

// ─── token helpers ───────────────────────────────────────────────────

describe('scheduler MCP token', () => {
  it('round-trips a thread scope', () => {
    const scope: SchedulerScope = { kind: 'thread', threadKey: threadAKey };
    const token = buildSchedulerMcpToken(secret, scope);
    assert.deepEqual(verifySchedulerMcpToken(secret, token), scope);
  });

  it('round-trips a dir scope', () => {
    const scope: SchedulerScope = { kind: 'dir', directory: '/work/project-x' };
    const token = buildSchedulerMcpToken(secret, scope);
    assert.deepEqual(verifySchedulerMcpToken(secret, token), scope);
  });

  it('rejects a tampered signature', () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const [scopeB64, sig] = token.split('.');
    // Flip the last hex char of the signature.
    const lastChar = sig[sig.length - 1];
    const flipped = sig.slice(0, -1) + (lastChar === '0' ? '1' : '0');
    assert.equal(verifySchedulerMcpToken(secret, `${scopeB64}.${flipped}`), null);
  });

  it('rejects a tampered scope (signature no longer matches)', () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const sig = token.split('.')[1];
    const forgedScope = Buffer.from(`thread:${threadBKey}`, 'utf8').toString('base64url');
    assert.equal(verifySchedulerMcpToken(secret, `${forgedScope}.${sig}`), null);
  });

  it('rejects a wrong secret', () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    assert.equal(verifySchedulerMcpToken('b'.repeat(64), token), null);
  });

  it('rejects malformed tokens', () => {
    assert.equal(verifySchedulerMcpToken(secret, 'no-dot'), null);
    assert.equal(verifySchedulerMcpToken(secret, '.onlysig'), null);
    assert.equal(verifySchedulerMcpToken(secret, 'onlyscope.'), null);
    assert.equal(verifySchedulerMcpToken(secret, ''), null);
  });

  it('uses a constant-time compare (timingSafeEqual), per source', () => {
    // Load-bearing static check: a plain === compare would be a timing oracle on
    // the HMAC. Assert the implementation imports and calls timingSafeEqual.
    const source = fs.readFileSync(path.join(__dirname, '..', 'scheduler', 'mcpSurface.ts'), 'utf8');
    assert.match(source, /timingSafeEqual/);
    assert.match(source, /import\s*\{[^}]*timingSafeEqual[^}]*\}\s*from\s*'node:crypto'/);
  });

  it('serialize / parse scope round-trip and reject junk', () => {
    assert.equal(serializeSchedulerScope({ kind: 'thread', threadKey: threadAKey }), `thread:${threadAKey}`);
    assert.equal(serializeSchedulerScope({ kind: 'dir', directory: '/d' }), 'dir:/d');
    assert.deepEqual(parseSchedulerScope(`thread:${threadAKey}`), { kind: 'thread', threadKey: threadAKey });
    assert.deepEqual(parseSchedulerScope('dir:/x'), { kind: 'dir', directory: '/x' });
    assert.equal(parseSchedulerScope('bogus:x'), null);
    assert.equal(parseSchedulerScope('nocolon'), null);
    assert.equal(parseSchedulerScope('thread:'), null);
  });
});

describe('getSchedulerMcpPort', () => {
  const original = process.env.SCHEDULER_MCP_PORT;
  afterEach(() => {
    if (original === undefined) delete process.env.SCHEDULER_MCP_PORT;
    else process.env.SCHEDULER_MCP_PORT = original;
  });
  it('uses an ephemeral port when unset / invalid, and accepts explicit ports', () => {
    delete process.env.SCHEDULER_MCP_PORT;
    assert.equal(getSchedulerMcpPort(), defaultSchedulerMcpPort);
    process.env.SCHEDULER_MCP_PORT = 'nope';
    assert.equal(getSchedulerMcpPort(), defaultSchedulerMcpPort);
    process.env.SCHEDULER_MCP_PORT = '0';
    assert.equal(getSchedulerMcpPort(), 0);
    process.env.SCHEDULER_MCP_PORT = '5099';
    assert.equal(getSchedulerMcpPort(), 5099);
  });
});

// ─── spec building ───────────────────────────────────────────────────

describe('buildSpecFromCreateArgs', () => {
  it('builds a cron spec', () => {
    const result = buildSpecFromCreateArgs({ cron: '0 9 * * *' }, nowMs);
    assert.ok(result.ok);
    assert.deepEqual(result.spec, { kind: 'cron', cronExpr: '0 9 * * *' });
  });

  it('builds a cron N-times spec via repeatCount', () => {
    const result = buildSpecFromCreateArgs({ cron: '0 9 * * *', repeatCount: 3 }, nowMs);
    assert.ok(result.ok);
    assert.deepEqual(result.spec, { kind: 'cron', cronExpr: '0 9 * * *', remainingRuns: 3 });
  });

  it('builds a once spec', () => {
    const future = new Date(nowMs + 60_000).toISOString();
    const result = buildSpecFromCreateArgs({ onceAt: future }, nowMs);
    assert.ok(result.ok);
    assert.deepEqual(result.spec, { kind: 'once', onceAtIso: future });
  });

  it('rejects cron + onceAt together, with the recipe hint', () => {
    const future = new Date(nowMs + 5 * 60_000).toISOString();
    const result = buildSpecFromCreateArgs({ cron: '0 9 * * *', onceAt: future }, nowMs);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /not both/);
      assert.match(result.error, /Recipes/);
    }
  });

  it('rejects neither cron nor onceAt, with the recipe hint', () => {
    const result = buildSpecFromCreateArgs({}, nowMs);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /exactly one/);
      assert.match(result.error, /Recipes/);
    }
  });

  // The live bug: the agent reached for repeatCount:1 to mean "run once". That is
  // now ACCEPTED (a one-shot always runs once) — repeatCount is ignored, not an error.
  it('ignores repeatCount:1 on a one-shot (the natural "run once" call)', () => {
    const future = new Date(nowMs + 60_000).toISOString();
    const result = buildSpecFromCreateArgs({ onceAt: future, repeatCount: 1 }, nowMs);
    assert.ok(result.ok);
    assert.deepEqual(result.spec, { kind: 'once', onceAtIso: future });
    assert.match(result.note ?? '', /ignored/i);
  });

  it('ignores an absurd repeatCount on a one-shot', () => {
    const future = new Date(nowMs + 60_000).toISOString();
    const result = buildSpecFromCreateArgs({ onceAt: future, repeatCount: 8842354424542 }, nowMs);
    assert.ok(result.ok);
    assert.deepEqual(result.spec, { kind: 'once', onceAtIso: future });
  });

  it('treats an empty-string cron on a one-shot as omitted', () => {
    const future = new Date(nowMs + 60_000).toISOString();
    const result = buildSpecFromCreateArgs({ onceAt: future, cron: '' }, nowMs);
    assert.ok(result.ok);
    assert.deepEqual(result.spec, { kind: 'once', onceAtIso: future });
    assert.equal(result.note, undefined);
  });

  it('treats an empty/whitespace onceAt on a cron as omitted', () => {
    const result = buildSpecFromCreateArgs({ cron: '0 9 * * *', onceAt: '   ' }, nowMs);
    assert.ok(result.ok);
    assert.deepEqual(result.spec, { kind: 'cron', cronExpr: '0 9 * * *' });
  });

  it('surfaces a bad cron message', () => {
    const result = buildSpecFromCreateArgs({ cron: 'not a cron' }, nowMs);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /cron/i);
  });

  it('rejects a too-frequent cron (min interval)', () => {
    const result = buildSpecFromCreateArgs({ cron: '* * * * *' }, nowMs);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /too often|minimum/i);
  });

  it('rejects a past one-shot', () => {
    const past = new Date(nowMs - 60_000).toISOString();
    const result = buildSpecFromCreateArgs({ onceAt: past }, nowMs);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /past/i);
  });
});

// ─── thread resolution ───────────────────────────────────────────────

describe('resolveTargetThreadKey', () => {
  const noThreads = () => [];

  it('thread scope resolves to its own thread', () => {
    const result = resolveTargetThreadKey({ kind: 'thread', threadKey: threadAKey }, undefined, noThreads);
    assert.deepEqual(result, { ok: true, threadKey: threadAKey });
  });

  it('thread scope accepts a matching threadKey arg', () => {
    const result = resolveTargetThreadKey({ kind: 'thread', threadKey: threadAKey }, threadAKey, noThreads);
    assert.deepEqual(result, { ok: true, threadKey: threadAKey });
  });

  it('thread scope rejects a mismatching threadKey arg', () => {
    const result = resolveTargetThreadKey({ kind: 'thread', threadKey: threadAKey }, threadBKey, noThreads);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /does not match/);
  });

  it('dir scope with 0 bound threads errors', () => {
    const result = resolveTargetThreadKey({ kind: 'dir', directory: '/d' }, undefined, () => []);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /no thread is bound/);
  });

  it('dir scope with exactly 1 bound thread is implicit', () => {
    const result = resolveTargetThreadKey({ kind: 'dir', directory: '/d' }, undefined, () => [threadAKey]);
    assert.deepEqual(result, { ok: true, threadKey: threadAKey });
  });

  it('dir scope with >1 bound thread requires threadKey', () => {
    const result = resolveTargetThreadKey({ kind: 'dir', directory: '/d' }, undefined, () => [threadAKey, threadBKey]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /2 bound threads/);
  });

  it('dir scope with >1 bound thread accepts a valid threadKey', () => {
    const result = resolveTargetThreadKey({ kind: 'dir', directory: '/d' }, threadBKey, () => [threadAKey, threadBKey]);
    assert.deepEqual(result, { ok: true, threadKey: threadBKey });
  });

  it('dir scope rejects a threadKey not bound to the directory', () => {
    const result = resolveTargetThreadKey({ kind: 'dir', directory: '/d' }, threadBKey, () => [threadAKey]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /not bound/);
  });
});

// ─── end-to-end over real HTTP ───────────────────────────────────────

interface ServerFixture {
  handle: SchedulerMcpHandle;
  store: StateStore;
  armed: ScheduleRecord[];
  disarmed: string[];
  boundThreads: Map<string, string[]>;
  fileWorkDir: string;
  fileSendGatewayCalls: Array<RecordedFileSendGatewayCall<string>>;
  recordedMessageIds: number[];
  fileSendCalls: Array<{ threadKey: string; options: SendFilesToThreadOptions }>;
  fileSendHandler: { current: SendFilesToThread };
  messageSendCalls: Array<{ threadKey: string; options: SendMessagesToThreadOptions }>;
  messageSendHandler: { current: SendMessagesToThread };
  /** What each `claude_profiles` call asked for (`null` = omitted). */
  claudeProfilesCalls: ClaudeProfilesQuery[];
  /** Every `unpinMessages` call the surface made (schedule_cancel of a check that pinned alerts). */
  unpinCalls: Array<{ threadKey: string; messageIds: number[] }>;
  /** The message ids the `unpinMessages` port reports as STILL pinned (Telegram did not answer): the test fills it, empty by default. */
  stillPinnedMessageIds: number[];
  /** Every `deleteMessage` call the surface made (schedule_cancel of a check that had a status line). */
  deleteCalls: Array<{ threadKey: string; messageId: number }>;
}

const mcpSingleMessageId = 301;
const mcpAlbumMessageIds = [401, 402];
const mcpSingleMessageIds = {
  sendPhoto: mcpSingleMessageId,
  sendAnimation: mcpSingleMessageId,
  sendVideo: mcpSingleMessageId,
  sendDocument: mcpSingleMessageId,
};

async function buildClient(
  port: number,
  token: string | null,
  clientId?: string,
  clientIdHeader: string = schedulerMcpClientIdHeader,
): Promise<Client> {
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  if (clientId !== undefined) headers[clientIdHeader] = clientId;
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers },
  });
  await client.connect(transport);
  return client;
}

function sendCancellationNotification(
  port: number,
  token: string,
  clientId: string,
  requestId: number,
  reason = 'pre-cancelled by test',
): Promise<void> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId, reason },
  });
  return new Promise((resolve, reject) => {
    const cancellationRequest = request({
      host: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        [schedulerMcpClientIdHeader]: clientId,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(body).toString(),
      },
    }, (response) => {
      response.resume();
      response.once('end', () => {
        if ((response.statusCode ?? 500) >= 400) {
          reject(new Error(`cancellation notification failed with ${response.statusCode}`));
          return;
        }
        resolve();
      });
    });
    cancellationRequest.once('error', reject);
    cancellationRequest.end(body);
  });
}

interface RawHttpResponse {
  statusCode: number;
  body: string;
}

interface RawFileSendCall {
  request: ClientRequest;
  response: Promise<RawHttpResponse>;
}

function startRawFileSendCall(
  port: number,
  token: string,
  clientId: string,
  requestId: number,
  filePath: string,
): RawFileSendCall {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: requestId,
    method: 'tools/call',
    params: {
      name: 'send_file_to_user',
      arguments: { paths: [filePath] },
    },
  });
  let resolveResponse = (_response: RawHttpResponse): void => {};
  let rejectResponse = (_error: Error): void => {};
  const response = new Promise<RawHttpResponse>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const fileSendRequest = request({
    host: '127.0.0.1',
    port,
    path: '/mcp',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      [schedulerMcpClientIdHeader]: clientId,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Content-Length': Buffer.byteLength(body).toString(),
    },
  }, (incomingResponse) => {
    const chunks: string[] = [];
    incomingResponse.setEncoding('utf8');
    incomingResponse.on('data', (chunk: string) => chunks.push(chunk));
    incomingResponse.once('end', () => {
      resolveResponse({
        statusCode: incomingResponse.statusCode ?? 500,
        body: chunks.join(''),
      });
    });
  });
  fileSendRequest.once('error', rejectResponse);
  fileSendRequest.end(body);
  return { request: fileSendRequest, response };
}

/**
 * Issue a bare `GET /mcp` and resolve once the response has ENDED. A response
 * that never ends (the standalone SSE stream this server must not open) leaves
 * the promise pending, so the test times out instead of passing vacuously.
 */
function getMcpEndpoint(port: number, token: string | null): Promise<RawHttpResponse & { contentType: string }> {
  const headers: Record<string, string> = { Accept: 'text/event-stream' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Promise((resolve, reject) => {
    const getRequest = request({ host: '127.0.0.1', port, path: '/mcp', method: 'GET', headers }, (response) => {
      const chunks: string[] = [];
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => chunks.push(chunk));
      response.once('end', () => {
        resolve({
          statusCode: response.statusCode ?? 500,
          body: chunks.join(''),
          contentType: response.headers['content-type'] ?? '',
        });
      });
    });
    getRequest.once('error', reject);
    getRequest.end();
  });
}

/** First text content block of a tool result. */
function firstText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const parsedResult = CallToolResultSchema.parse(result);
  const block = parsedResult.content.find((content) => content.type === 'text');
  return block?.text ?? '';
}

/** The «next: …» stamp a creation line carries: the job's first run as the instance-local date and time. */
function getExpectedNextStamp(record: ScheduleRecord): string {
  assert.notEqual(record.nextRunAt, null, 'a cron has a next run');
  return formatLocalDateAndClock(record.nextRunAt ?? 0);
}

describe('scheduler MCP server end-to-end (real HTTP)', () => {
  let fakeHome: string;
  let originalHome: string | undefined;
  let fixture: ServerFixture;

  async function startFixture(): Promise<ServerFixture> {
    const dataDir = path.join(fakeHome, '.charness');
    fs.mkdirSync(dataDir, { recursive: true });
    const store = new StateStore(dataDir, { saveDebounceMs: 20 });
    await store.init();

    const armed: ScheduleRecord[] = [];
    const disarmed: string[] = [];
    const boundThreads = new Map<string, string[]>();
    const fileWorkDir = path.join(fakeHome, 'bound-project');
    fs.mkdirSync(fileWorkDir);
    const fileSendGatewayCalls: Array<RecordedFileSendGatewayCall<string>> = [];
    const recordedMessageIds: number[] = [];
    const defaultSendFilesToThread = createSendFilesToThread({
      resolveTargetAndWorkDir: (threadKey) =>
        threadKey === threadAKey
          ? { ok: true, target: threadKey, workDir: fileWorkDir }
          : { ok: false, error: `invalid threadKey "${threadKey}"` },
      gateway: createFileSendTestRecorderGateway(fileSendGatewayCalls, {
        singleMessageIds: mcpSingleMessageIds,
        albumMessageIds: mcpAlbumMessageIds,
      }),
      recordMessageIds: async (_target, messageIds) => {
        recordedMessageIds.push(...messageIds);
      },
    });
    const fileSendCalls: Array<{ threadKey: string; options: SendFilesToThreadOptions }> = [];
    const fileSendHandler = { current: defaultSendFilesToThread };
    const sendFilesToThread: SendFilesToThread = (threadKey, options) => {
      fileSendCalls.push({ threadKey, options });
      return fileSendHandler.current(threadKey, options);
    };

    // Record the FULL options (per-item objects + authorizedWorkDir) so the
    // MCP-layer mapping in registerMessageSendTool (`as_file`→`asFile`, dir-scope
    // `authorizedWorkDir` injection) is observable at this boundary.
    const messageSendCalls: Array<{ threadKey: string; options: SendMessagesToThreadOptions }> = [];
    const claudeProfilesCalls: ClaudeProfilesQuery[] = [];
    const unpinCalls: Array<{ threadKey: string; messageIds: number[] }> = [];
    const stillPinnedMessageIds: number[] = [];
    const deleteCalls: Array<{ threadKey: string; messageId: number }> = [];
    const defaultSendMessagesToThread: SendMessagesToThread = async (threadKey, options) => {
      if (threadKey !== threadAKey) return { ok: false, error: `invalid threadKey "${threadKey}"` };
      return { ok: true, summary: `Delivered ${options.messages.length} messages to the topic.`, undeliveredCount: 0, sentMessageIds: [] };
    };
    const messageSendHandler = { current: defaultSendMessagesToThread };
    const sendMessagesToThread: SendMessagesToThread = (threadKey, options) => {
      messageSendCalls.push({ threadKey, options });
      return messageSendHandler.current(threadKey, options);
    };

    const deps: SchedulerMcpDeps = {
      store,
      armJob: (record) => armed.push(record),
      disarmJob: (jobId) => disarmed.push(jobId),
      getThreadsForDirectory: (directory) => boundThreads.get(directory) ?? [],
      getThreadAdapterName: () => 'claude',
      unpinMessages: async (threadKey, messageIds) => {
        unpinCalls.push({ threadKey, messageIds: [...messageIds] });
        return messageIds.filter((messageId) => stillPinnedMessageIds.includes(messageId));
      },
      deleteMessage: async (threadKey, messageId) => {
        deleteCalls.push({ threadKey, messageId });
      },
      sendFilesToThread,
      sendMessagesToThread,
      compactConversation: () => ({ ok: true, message: 'unused' }),
      answerRequest: async () => ({ ok: false, error: 'unused' }),
      whenSessionsRestored: async () => {},
      getSecret: async () => secret,
      // `claude_profiles`: a canned report that records what it was asked for — the pick follows the query the way the
      // real one does (a warm session stays, one stopped by a limit moves, the model `exhausted` has nothing usable).
      listClaudeProfiles: async (query) => {
        claudeProfilesCalls.push(query);
        const { model, currentProfile, isStoppedByLimit } = query;
        const isNothingUsable = model === 'exhausted' || model === 'nowhere';
        const isWarmAccountGone = model === 'gone';
        // The /limits list leaves «work» out for this model: the report says why, and the verdict line repeats it.
        const isWorkUnlisted = model === 'unlisted';
        const pickReason = isNothingUsable ? 'none'
          : currentProfile === null ? 'soonestWeeklyReset'
            : isStoppedByLimit ? 'movedFromLimited'
              : isWarmAccountGone ? 'movedFromUnavailable'
                : 'warm';
        const recommended = isNothingUsable ? null : pickReason === 'warm' ? currentProfile : model === 'fable' ? 'work' : 'default';
        return {
          model,
          relevantBuckets: ['session', model === 'fable' ? 'weekly_scoped' : 'weekly_all'],
          recommended,
          pickReason,
          nextAvailable: model === 'exhausted' ? { profile: 'work', at: '2026-10-20T10:00:00.000Z' } : null,
          profiles: [
            { name: 'default', configDir: null, email: 'me@example.com', kind: 'personal', subscriptionType: 'max', loggedIn: true, buckets: [], usageFetchedAt: null, isUsageStale: false, limitedUntil: null, billing: null, creditExhaustedAt: null, spentUsd: null, remainingEstimateUsd: null, expiresOn: null, probablyUsedUp: false, renewedAt: null, isEligible: true, chainExclusion: null, headroomPercent: 19, isRecommended: recommended === 'default' },
            { name: 'work', configDir: '/data/profiles/work', email: 'w@example.com', kind: 'personal', subscriptionType: 'pro', loggedIn: true, buckets: [], usageFetchedAt: null, isUsageStale: false, limitedUntil: null, billing: null, creditExhaustedAt: null, spentUsd: null, remainingEstimateUsd: null, expiresOn: null, probablyUsedUp: false, renewedAt: null, isEligible: !isWorkUnlisted, chainExclusion: isWorkUnlisted ? 'notListed' as const : null, headroomPercent: 90, isRecommended: recommended === 'work' },
          ],
        };
      },
      port: 0,
    };
    const handle = createSchedulerMcpServer(deps);
    await handle.start();
    return {
      handle,
      store,
      armed,
      claudeProfilesCalls,
      unpinCalls,
      stillPinnedMessageIds,
      deleteCalls,
      disarmed,
      boundThreads,
      fileWorkDir,
      fileSendGatewayCalls,
      recordedMessageIds,
      fileSendCalls,
      fileSendHandler,
      messageSendCalls,
      messageSendHandler,
    };
  }

  beforeEach(async () => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-mcp-'));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    fixture = await startFixture();
  });

  afterEach(async () => {
    await fixture.handle.stop();
    await fixture.store.flush();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('binds an ephemeral port', () => {
    assert.ok(fixture.handle.port > 0);
  });

  it('refuses GET with 405 instead of opening a standalone SSE stream', async () => {
    // THE restart regression. Answering a GET the SDK's way parks an SSE stream
    // that carries nothing (this server never initiates a message) and dies with
    // the bot's next hot reload; a client that exhausts its reconnect budget
    // latches the whole server `failed`, so an agent session that deliberately
    // survived the restart loses the bot's tools. 405 is the spec's answer for a
    // server with no server-initiated stream, and the SDK client expects it.
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const response = await getMcpEndpoint(fixture.handle.port, token);
    assert.equal(response.statusCode, 405);
    assert.ok(
      !response.contentType.includes('text/event-stream'),
      `no stream was opened (content-type: ${response.contentType})`,
    );
  });

  it('answers an unauthenticated GET with 401, not 405', async () => {
    // The refusal above sits BEHIND the token check, so an unauthenticated
    // prober still learns exactly what it learned before: nothing but 401.
    const response = await getMcpEndpoint(fixture.handle.port, null);
    assert.equal(response.statusCode, 401);
  });

  it('still serves tool calls over POST after refusing GET', async () => {
    // The refusal must scope to GET only — a client that gets 405 on the stream
    // goes on to POST every request, which is the whole transport that matters.
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    await getMcpEndpoint(fixture.handle.port, token);
    const client = await buildClient(fixture.handle.port, token);
    try {
      const tools = await client.listTools();
      assert.ok(
        tools.tools.some((tool) => tool.name === 'schedule_list'),
        'the scheduler tools are reachable over POST',
      );
    } finally {
      await client.close();
    }
  });

  it('destroys active sockets while an initialized client remains connected', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    const activeRequest = createIncompleteHttpRequest(fixture.handle.port, token);
    let stopPromise: Promise<void> | null = null;
    try {
      await activeRequest.connected;
      stopPromise = fixture.handle.stop();
      assert.equal(
        await checkPromiseResolvesWithin(stopPromise, schedulerMcpStopTimeoutMs),
        true,
        'stop must destroy the active request socket instead of waiting for its unfinished body',
      );
    } finally {
      if (stopPromise === null) stopPromise = fixture.handle.stop();
      activeRequest.request.destroy();
      await client.close();
      await stopPromise;
    }
  });

  it('rejects a connection with no token', async () => {
    await assert.rejects(buildClient(fixture.handle.port, null));
  });

  it('rejects a connection with an invalid token', async () => {
    await assert.rejects(buildClient(fixture.handle.port, 'garbage.token'));
  });

  it('reports connect-time server instructions on initialize', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    try {
      const instructions = client.getInstructions();
      assert.ok(instructions, 'server should report instructions on initialize');
      // Use-case pointer, not recipe repetition: names the tools + the fresh-session caveat.
      assert.match(instructions, /schedule_create/);
      assert.match(instructions, /send_file_to_user/);
      assert.match(instructions, /send_messages_to_user/);
      assert.match(instructions, /fresh session/);
      // Watchdogs go through a check, never a hand-made watcher.
      assert.match(instructions, /checkCommand/);
      assert.match(instructions, /NEVER build your own watcher/);
      // An orchestrating agent loads the bot's manager skill and watches each worker the schedule_create way. The
      // always-loaded bullet stays short: the recipe itself lives in the tool description, never twice in the context.
      const orchestrationBullet = instructions.split('\n').find((line) => line.includes('`charness-manager`')) ?? '';
      assert.ok(orchestrationBullet, 'names the bot\'s manager skill');
      assert.ok(orchestrationBullet.length <= maxOrchestrationBulletLength, `${orchestrationBullet.length} characters`);
      assert.match(orchestrationBullet, /checkCommand, cron, status arguments/, 'the recipe\'s arguments are named');
      assert.doesNotMatch(orchestrationBullet, /isPinSilent/);
      assert.match(orchestrationBullet, /never `kill -0` alone/);
      assert.ok(!instructions.includes(workerWatchCheckCommand), 'the recipe is in the tool description only');
    } finally {
      await client.close();
    }
  });

  it('exposes the file-send tool under its agent-facing name send_file_to_user', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    const toolNames = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(toolNames.includes('send_file_to_user'), 'file-send tool should be listed as send_file_to_user');
    assert.ok(!toolNames.includes('send_file'), 'the old send_file name must not be exposed anymore');
  });

  it('exposes the discrete-message tool as send_messages_to_user', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    try {
      const toolNames = (await client.listTools()).tools.map((tool) => tool.name);
      assert.ok(toolNames.includes('send_messages_to_user'), 'message-send tool should be listed');
    } finally {
      await client.close();
    }
  });

  it('claude_profiles: listed for a thread AND a directory scope, passes the query through, answers a verdict line + the report JSON', async () => {
    const callProfiles = async (client: Awaited<ReturnType<typeof buildClient>>, args: Record<string, string | boolean>): Promise<string> =>
      ((await client.callTool({ name: 'claude_profiles', arguments: args })).content as Array<{ type: string; text: string }>)[0].text;
    for (const scope of [{ kind: 'thread' as const, threadKey: threadAKey }, { kind: 'dir' as const, directory: fixture.fileWorkDir }]) {
      const client = await buildClient(fixture.handle.port, buildSchedulerMcpToken(secret, scope));
      try {
        const tool = (await client.listTools()).tools.find((candidate) => candidate.name === 'claude_profiles');
        assert.ok(tool, `claude_profiles is offered to a ${scope.kind} scope`);
        assert.match(tool.description ?? '', /CLAUDE_CONFIG_DIR/);
        const description = tool.description ?? '';
        // The opening is what an agent reads: the list rule comes first, then the order it implies (API credit, then the soonest weekly reset).
        assert.match(
          description,
          /^The Claude account profiles[^]*?`recommended` follows the operator's \/limits auto-switch list: once it names a Claude account, only accounts with an enabled rung there are offered[^]*?A NEW agent \(omit `currentProfile`\) goes to an `api`-billed account of the list first while its credit lasts[^]*?, then to the usable subscription whose weekly limit resets SOONEST/,
          'the list rule, then API first, then the soonest weekly reset — in that order',
        );
        assert.ok(description.indexOf('/limits auto-switch list') < description.indexOf('A NEW agent'), 'the list is introduced before any "list" wording and before the new-agent rule');
        assert.doesNotMatch(description, /NEVER picked|unless the operator asked|goes to the usable account whose weekly/, 'the old «never an API account unless asked» opening is gone');
        assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), ['currentProfile', 'isStoppedByLimit', 'model']);
        assert.equal((tool.inputSchema.properties?.currentProfile as { maxLength?: number } | undefined)?.maxLength, claudeProfileNameMaxLength, 'a profile name is never longer than the registry allows');
        const [verdict, ...rest] = (await callProfiles(client, { model: 'fable' })).split('\n');
        assert.equal(verdict, 'recommended: work → CLAUDE_CONFIG_DIR=/data/profiles/work (soonest weekly reset)');
        const report = JSON.parse(rest.join('\n')) as { model: string | null; recommended: string | null; pickReason: string; nextAvailable: unknown; profiles: Array<{ name: string }> };
        assert.equal(report.model, 'fable');
        assert.equal(report.pickReason, 'soonestWeeklyReset');
        assert.deepEqual(report.profiles.map((profile) => profile.name), ['default', 'work']);
        assert.match(await callProfiles(client, {}), /^recommended: default → default profile, set no CLAUDE_CONFIG_DIR \(soonest weekly reset\)\n/);
        assert.match(
          await callProfiles(client, { currentProfile: 'work' }),
          /^recommended: work → CLAUDE_CONFIG_DIR=\/data\/profiles\/work \(stays on the warm account\)\n/,
          'a warm session stays on its account',
        );
        assert.match(
          await callProfiles(client, { currentProfile: ' work ', isStoppedByLimit: true }),
          /^recommended: default → default profile, set no CLAUDE_CONFIG_DIR \(moved: work stopped on a limit\)\n/,
          'a session stopped by a limit moves, and the name is trimmed',
        );
        const none = await callProfiles(client, { model: 'exhausted' });
        assert.equal(none.split('\n')[0], 'none usable — next: work at 2026-10-20T10:00:00.000Z');
        assert.equal(
          (await callProfiles(client, { model: 'gone', currentProfile: 'work' })).split('\n')[0],
          'recommended: default → default profile, set no CLAUDE_CONFIG_DIR (moved: work can no longer run)',
          'a warm session whose account can no longer run is reported as moved, not as a new agent',
        );
        assert.equal((await callProfiles(client, { model: 'nowhere' })).split('\n')[0], 'none usable — no account names a time it frees up');
        const unlisted = await callProfiles(client, { model: 'unlisted' });
        assert.equal(
          unlisted.split('\n')[0],
          'recommended: default → default profile, set no CLAUDE_CONFIG_DIR (soonest weekly reset) [not offered — not in the /limits list: work]',
          'an account the list leaves out is named with its reason on the first line',
        );
        assert.match(unlisted, /"chainExclusion": "notListed"/);
        for (const args of [{ isStoppedByLimit: true }, { isStoppedByLimit: true, currentProfile: '   ' }]) {
          const refusal = await client.callTool({ name: 'claude_profiles', arguments: args });
          assert.equal(refusal.isError, true, `${JSON.stringify(args)} is refused: a stop on a limit needs the account that was stopped`);
          assert.match((refusal.content as Array<{ type: string; text: string }>)[0].text, /isStoppedByLimit needs currentProfile/);
        }
        const tooLong = await client.callTool({ name: 'claude_profiles', arguments: { currentProfile: 'x'.repeat(claudeProfileNameMaxLength + 1) } }).catch(() => ({ isError: true }));
        assert.equal(tooLong.isError, true, 'a name over the registry\'s length is refused at the boundary');
        const noneReport = JSON.parse(none.split('\n').slice(1).join('\n')) as { recommended: string | null; nextAvailable: { profile: string; at: string } | null };
        assert.equal(noneReport.recommended, null);
        assert.deepEqual(noneReport.nextAvailable, { profile: 'work', at: '2026-10-20T10:00:00.000Z' }, 'nextAvailable rides in the JSON');
      } finally {
        await client.close();
      }
    }
    const callsOfOneScope: ClaudeProfilesQuery[] = [
      { model: 'fable', currentProfile: null, isStoppedByLimit: false },
      { model: null, currentProfile: null, isStoppedByLimit: false },
      { model: null, currentProfile: 'work', isStoppedByLimit: false },
      { model: null, currentProfile: 'work', isStoppedByLimit: true },
      { model: 'exhausted', currentProfile: null, isStoppedByLimit: false },
      { model: 'gone', currentProfile: 'work', isStoppedByLimit: false },
      { model: 'nowhere', currentProfile: null, isStoppedByLimit: false },
      { model: 'unlisted', currentProfile: null, isStoppedByLimit: false },
    ];
    assert.deepEqual(fixture.claudeProfilesCalls, [...callsOfOneScope, ...callsOfOneScope], 'the refused calls never reached the port');
  });

  it('send_messages_to_user routes each message to the scope-resolved thread', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    try {
      const result = await client.callTool({
        name: 'send_messages_to_user',
        arguments: { messages: ['🗞 Digest', '📅 4 September', 'headline one https://t.me/x/1'] },
      });
      assert.notEqual(result.isError, true, firstText(result));
      assert.equal(fixture.messageSendCalls.length, 1);
      assert.equal(fixture.messageSendCalls[0].threadKey, threadAKey);
      assert.deepEqual(fixture.messageSendCalls[0].options.messages, [
        '🗞 Digest',
        '📅 4 September',
        'headline one https://t.me/x/1',
      ]);
      assert.match(firstText(result), /Delivered 3 messages/);
    } finally {
      await client.close();
    }
  });

  it('send_messages_to_user rejects a cross-thread threadKey (scope isolation)', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    try {
      const result = await client.callTool({
        name: 'send_messages_to_user',
        arguments: { messages: ['x'], threadKey: threadBKey },
      });
      assert.equal(result.isError, true);
      assert.equal(fixture.messageSendCalls.length, 0, 'no send when the threadKey is out of scope');
    } finally {
      await client.close();
    }
  });

  it('directory-scoped send_messages_to_user maps as_file→asFile and injects the authorized directory', async () => {
    // MCP-layer mapping only (the stub does not touch the fs), so no Linux gate / real file needed.
    fixture.boundThreads.set(fixture.fileWorkDir, [threadAKey]);
    const token = buildSchedulerMcpToken(secret, { kind: 'dir', directory: fixture.fileWorkDir });
    const client = await buildClient(fixture.handle.port, token);
    try {
      const result = await client.callTool({
        name: 'send_messages_to_user',
        arguments: { messages: [{ path: 'clip.mp4', text: 'a caption', as_file: true }] },
      });
      assert.notEqual(result.isError, true, firstText(result));
      assert.equal(fixture.messageSendCalls.length, 1);
      assert.equal(fixture.messageSendCalls[0].threadKey, threadAKey);
      assert.deepEqual(fixture.messageSendCalls[0].options.messages, [
        { path: 'clip.mp4', text: 'a caption', asFile: true },
      ]);
      assert.equal(fixture.messageSendCalls[0].options.authorizedWorkDir, fixture.fileWorkDir);
    } finally {
      await client.close();
    }
  });

  it('thread-scoped send_messages_to_user maps as_file→asFile but injects no authorized directory', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    try {
      const result = await client.callTool({
        name: 'send_messages_to_user',
        arguments: { messages: [{ path: 'clip.mp4', as_file: true }] },
      });
      assert.notEqual(result.isError, true, firstText(result));
      assert.equal(fixture.messageSendCalls.length, 1);
      assert.deepEqual(fixture.messageSendCalls[0].options.messages, [{ path: 'clip.mp4', asFile: true }]);
      assert.equal(fixture.messageSendCalls[0].options.authorizedWorkDir, undefined);
    } finally {
      await client.close();
    }
  });

  linuxIt('directory-scoped send_messages_to_user composes with secure file delivery and rejects traversal', async () => {
    fs.writeFileSync(path.join(fixture.fileWorkDir, 'inside.png'), 'image');
    fs.writeFileSync(path.join(fakeHome, 'outside.png'), 'outside');
    fixture.boundThreads.set(fixture.fileWorkDir, [threadAKey]);
    fixture.messageSendHandler.current = createSendMessagesToThread<string>({
      resolveTarget: (threadKey) => ({ ok: true, target: threadKey }),
      sendChunk: async () => 1,
      sendFiles: fixture.fileSendHandler.current,
      splitMessage,
      maxMessageLength: 4_096,
      measureRendered: (message) => message.length,
    });
    const token = buildSchedulerMcpToken(secret, { kind: 'dir', directory: fixture.fileWorkDir });
    const client = await buildClient(fixture.handle.port, token);
    try {
      const accepted = await client.callTool({
        name: 'send_messages_to_user',
        arguments: { messages: [{ path: 'inside.png', text: 'caption' }] },
      });
      assert.notEqual(accepted.isError, true, firstText(accepted));
      assert.deepEqual(fixture.fileSendGatewayCalls, [
        {
          method: 'sendPhoto',
          target: threadAKey,
          source: { filename: 'inside.png', sizeBytes: 5, contents: 'image' },
          caption: 'caption',
        },
      ]);
      assert.equal(fixture.messageSendCalls[0].options.authorizedWorkDir, fixture.fileWorkDir);

      const rejected = await client.callTool({
        name: 'send_messages_to_user',
        arguments: { messages: [{ path: '../outside.png' }] },
      });
      assert.equal(rejected.isError, true);
      assert.match(firstText(rejected), /outside the bound folder/i);
      assert.equal(fixture.fileSendGatewayCalls.length, 1, 'rejected traversal must not reach Telegram');
    } finally {
      await client.close();
    }
  });

  it('send_messages_to_user coerces a bridge-stringified mixed array (OpenCode quirk)', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    try {
      // OpenCode serialized the WHOLE messages array as one raw JSON STRING (live-verify
      // 2026-09: object + object + bare string). The preprocess must parse it, and the
      // per-item union must still validate the mixed objects/strings inside.
      const stringified = JSON.stringify([
        { text: 'digest 1/3', path: 'hero.png' },
        { text: 'digest 2/3', path: 'README.md', as_file: true },
        'digest 3/3 — plain text',
      ]);
      const result = await client.callTool({
        name: 'send_messages_to_user',
        arguments: { messages: stringified },
      });
      assert.notEqual(result.isError, true, firstText(result));
      assert.equal(fixture.messageSendCalls.length, 1);
      // Same routed items as the equivalent REAL array: attachments carry path/asFile,
      // the bare string stays a text item, order preserved.
      assert.deepEqual(fixture.messageSendCalls[0].options.messages, [
        { text: 'digest 1/3', path: 'hero.png' },
        { text: 'digest 2/3', path: 'README.md', asFile: true },
        'digest 3/3 — plain text',
      ]);
    } finally {
      await client.close();
    }
  });

  it('send_messages_to_user coerces a lone bare string into one text message', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    try {
      const result = await client.callTool({
        name: 'send_messages_to_user',
        arguments: { messages: 'just one line' },
      });
      assert.notEqual(result.isError, true, firstText(result));
      assert.equal(fixture.messageSendCalls.length, 1);
      assert.deepEqual(fixture.messageSendCalls[0].options.messages, ['just one line']);
    } finally {
      await client.close();
    }
  });

  linuxIt('send_file_to_user routes a single MP4 to sendVideo with its caption', async () => {
    fs.writeFileSync(path.join(fixture.fileWorkDir, 'clip.mp4'), 'video');
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    try {
      const result = await client.callTool({
        name: 'send_file_to_user',
        arguments: { paths: ['clip.mp4'], caption: 'clip caption' },
      });
      assert.notEqual(result.isError, true, firstText(result));
      assert.deepEqual(fixture.fileSendGatewayCalls, [
        {
          method: 'sendVideo',
          target: threadAKey,
          source: { filename: 'clip.mp4', sizeBytes: 5, contents: 'video' },
          caption: 'clip caption',
        },
      ]);
      assert.deepEqual(fixture.recordedMessageIds, [mcpSingleMessageId]);
    } finally {
      await client.close();
    }
  });

  linuxIt('send_file_to_user coerces bridge-stringified paths (JSON string and bare string)', async () => {
    fs.writeFileSync(path.join(fixture.fileWorkDir, 'clip.mp4'), 'video');
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    try {
      // Some MCP bridges serialize array arguments as a raw JSON STRING.
      const jsonStringResult = await client.callTool({
        name: 'send_file_to_user',
        arguments: { paths: '["clip.mp4"]', caption: 'stringified array' },
      });
      assert.notEqual(jsonStringResult.isError, true, firstText(jsonStringResult));
      assert.equal(fixture.fileSendGatewayCalls.length, 1);
      assert.equal(fixture.fileSendGatewayCalls[0]?.method, 'sendVideo');

      // A bare single path string wraps into a one-element array.
      const bareStringResult = await client.callTool({
        name: 'send_file_to_user',
        arguments: { paths: 'clip.mp4' },
      });
      assert.notEqual(bareStringResult.isError, true, firstText(bareStringResult));
      assert.equal(fixture.fileSendGatewayCalls.length, 2);
      assert.equal(fixture.fileSendGatewayCalls[1]?.method, 'sendVideo');
    } finally {
      await client.close();
    }
  });

  linuxIt('send_file_to_user routes a PNG+MP4 album as photo then video with one caption', async () => {
    fs.writeFileSync(path.join(fixture.fileWorkDir, 'chart.png'), 'photo');
    fs.writeFileSync(path.join(fixture.fileWorkDir, 'clip.mp4'), 'video');
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    try {
      const result = await client.callTool({
        name: 'send_file_to_user',
        arguments: { paths: ['chart.png', 'clip.mp4'], caption: 'album caption' },
      });
      assert.notEqual(result.isError, true, firstText(result));
      assert.deepEqual(fixture.fileSendGatewayCalls, [
        {
          method: 'sendMediaGroup',
          target: threadAKey,
          mediaGroup: {
            kind: 'photoVideo',
            media: [
              {
                type: 'photo',
                media: { filename: 'chart.png', sizeBytes: 5, contents: 'photo' },
                caption: 'album caption',
              },
              {
                type: 'video',
                media: { filename: 'clip.mp4', sizeBytes: 5, contents: 'video' },
              },
            ],
          },
        },
      ]);
      assert.deepEqual(fixture.recordedMessageIds, mcpAlbumMessageIds);
    } finally {
      await client.close();
    }
  });

  linuxIt('send_file_to_user routes an as_file MP4 to sendDocument', async () => {
    fs.writeFileSync(path.join(fixture.fileWorkDir, 'clip.mp4'), 'video');
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    try {
      const result = await client.callTool({
        name: 'send_file_to_user',
        arguments: { paths: ['clip.mp4'], as_file: true },
      });
      assert.notEqual(result.isError, true, firstText(result));
      assert.deepEqual(fixture.fileSendGatewayCalls, [
        {
          method: 'sendDocument',
          target: threadAKey,
          source: { filename: 'clip.mp4', sizeBytes: 5, contents: 'video' },
        },
      ]);
      assert.deepEqual(fixture.recordedMessageIds, [mcpSingleMessageId]);
    } finally {
      await client.close();
    }
  });

  linuxIt('directory-scoped send_file_to_user forwards its canonical authorized directory', async () => {
    fs.writeFileSync(path.join(fixture.fileWorkDir, 'clip.mp4'), 'video');
    fixture.boundThreads.set(fixture.fileWorkDir, [threadAKey]);
    const token = buildSchedulerMcpToken(secret, {
      kind: 'dir',
      directory: fixture.fileWorkDir,
    });
    const client = await buildClient(fixture.handle.port, token);
    try {
      const result = await client.callTool({
        name: 'send_file_to_user',
        arguments: { paths: ['clip.mp4'] },
      });

      assert.notEqual(result.isError, true, firstText(result));
      assert.equal(fixture.fileSendCalls.length, 1);
      assert.equal(fixture.fileSendCalls[0].threadKey, threadAKey);
      assert.equal(fixture.fileSendCalls[0].options.authorizedWorkDir, fixture.fileWorkDir);
      assert.ok(fixture.fileSendCalls[0].options.signal instanceof AbortSignal);
    } finally {
      await client.close();
    }
  });

  it('returns deliveryUnknown as machine-readable non-error output that forbids retry', async () => {
    fixture.fileSendHandler.current = async () => ({
      ok: false,
      kind: 'deliveryUnknown',
      error: 'Telegram may already have accepted this delivery; MUST NOT retry automatically.',
    });
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    try {
      const result = await client.callTool({
        name: 'send_file_to_user',
        arguments: { paths: ['ambiguous.bin'] },
      });
      const parsedResult = CallToolResultSchema.parse(result);

      assert.notEqual(parsedResult.isError, true, firstText(result));
      assert.deepEqual(parsedResult.structuredContent, {
        kind: 'deliveryUnknown',
        retryable: false,
      });
      assert.match(firstText(result), /must not retry automatically/i);
    } finally {
      await client.close();
    }
  });

  it('returns message deliveryUnknown as machine-readable non-error output that forbids retry', async () => {
    fixture.messageSendHandler.current = async () => ({
      ok: false,
      kind: 'deliveryUnknown',
      error: 'Telegram may already have accepted this message; MUST NOT retry automatically.',
    });
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    try {
      const result = await client.callTool({
        name: 'send_messages_to_user',
        arguments: { messages: [{ path: 'ambiguous.bin' }] },
      });
      const parsedResult = CallToolResultSchema.parse(result);

      assert.notEqual(parsedResult.isError, true, firstText(result));
      assert.deepEqual(parsedResult.structuredContent, {
        kind: 'deliveryUnknown',
        retryable: false,
      });
      assert.match(firstText(result), /must not retry automatically/i);
    } finally {
      await client.close();
    }
  });

  it('canceling a real HTTP file-send call aborts the service signal', async () => {
    let markFileSendStarted = () => {};
    let markServerSignalAborted = () => {};
    const fileSendStarted = new Promise<void>((resolve) => { markFileSendStarted = resolve; });
    const serverSignalAborted = new Promise<void>((resolve) => { markServerSignalAborted = resolve; });
    fixture.fileSendHandler.current = async (_threadKey, options) => {
      const signal = options.signal;
      assert.ok(signal, 'the MCP request signal must reach the file-send service');
      markFileSendStarted();
      return new Promise((_resolve, reject) => {
        const handleAbort = () => {
          markServerSignalAborted();
          reject(signal.reason);
        };
        signal.addEventListener('abort', handleAbort, { once: true });
        if (signal.aborted) handleAbort();
      });
    };
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    const controller = new AbortController();
    try {
      const result = client.callTool(
        {
          name: 'send_file_to_user',
          arguments: { paths: ['unused.bin'] },
        },
        CallToolResultSchema,
        { signal: controller.signal },
      );
      await fileSendStarted;
      controller.abort();

      await assert.rejects(result, /AbortError: This operation was aborted/);
      assert.equal(
        await checkPromiseResolvesWithin(serverSignalAborted, schedulerMcpStopTimeoutMs),
        true,
        'the canceled HTTP request must abort the server-side tool signal',
      );
    } finally {
      controller.abort();
      await client.close();
    }
  });

  it('suppresses an inactive late cancellation but cancels the active reused request', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const clientId = 'reused-request-client';
    fixture.fileSendHandler.current = async () => ({ ok: true, summary: 'first completed', sentKinds: ['document'] });
    const firstClient = await buildClient(fixture.handle.port, token, clientId);
    try {
      const firstResult = await firstClient.callTool({
        name: 'send_file_to_user',
        arguments: { paths: ['first.bin'] },
      });
      assert.equal(firstText(firstResult), 'first completed');
    } finally {
      await firstClient.close();
    }

    await sendCancellationNotification(
      fixture.handle.port,
      token,
      clientId,
      1,
      'stale cancellation for the inactive completed generation',
    );

    let markReusedRequestStarted = () => {};
    let markReusedRequestAborted = () => {};
    const reusedRequestStarted = new Promise<void>((resolve) => {
      markReusedRequestStarted = resolve;
    });
    const reusedRequestAborted = new Promise<void>((resolve) => {
      markReusedRequestAborted = resolve;
    });
    let reusedRequestSignal: AbortSignal | undefined;
    fixture.fileSendHandler.current = async (_threadKey, options) => {
      const signal = options.signal;
      assert.ok(signal);
      reusedRequestSignal = signal;
      markReusedRequestStarted();
      return new Promise((_resolve, reject) => {
        const handleAbort = () => {
          markReusedRequestAborted();
          reject(signal.reason);
        };
        signal.addEventListener('abort', handleAbort, { once: true });
        if (signal.aborted) handleAbort();
      });
    };

    const reusedClient = await buildClient(fixture.handle.port, token, clientId);
    try {
      const reusedResultSettled = reusedClient.callTool({
        name: 'send_file_to_user',
        arguments: { paths: ['reused.bin'] },
      }).then(() => undefined, () => undefined);
      await reusedRequestStarted;
      assert.equal(
        reusedRequestSignal?.aborted,
        false,
        'the inactive late cancellation must not poison the reused request',
      );

      await sendCancellationNotification(
        fixture.handle.port,
        token,
        clientId,
        1,
        'legitimate cancellation for the active reused generation',
      );
      assert.equal(
        await checkPromiseResolvesWithin(reusedRequestAborted, schedulerMcpStopTimeoutMs),
        true,
        'the active reused request must receive its legitimate cancellation',
      );
      assert.equal(reusedRequestSignal?.aborted, true);
      await reusedResultSettled;
    } finally {
      await reusedClient.close();
    }
  });

  it('identifies a client that still sends the pre-rename client-id header, and says so once', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const clientId = 'pre-rename-client';
    let markStarted = () => {};
    let markAborted = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      markAborted = resolve;
    });
    fixture.fileSendHandler.current = async (_threadKey, options) => {
      const signal = options.signal;
      assert.ok(signal);
      markStarted();
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          markAborted();
          reject(signal.reason);
        }, { once: true });
      });
    };
    resetLegacyNameState();
    const stderrChunks: string[] = [];
    const originalStderrWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    const client = await buildClient(fixture.handle.port, token, clientId, legacySchedulerMcpClientIdHeader);
    try {
      const settled = client.callTool({
        name: 'send_file_to_user',
        arguments: { paths: ['legacy.bin'] },
      }).then(() => undefined, () => undefined);
      await started;

      // The cancellation names the SAME client id under the NEW header: it can only reach the request
      // if the server read the old header as that client's identity.
      await sendCancellationNotification(fixture.handle.port, token, clientId, 1, 'cancel via the new header');

      assert.equal(await checkPromiseResolvesWithin(aborted, schedulerMcpStopTimeoutMs), true);
      await settled;
    } finally {
      process.stderr.write = originalStderrWrite;
      await client.close();
    }

    const deprecations = stderrChunks.filter((chunk) => chunk.includes(legacySchedulerMcpClientIdHeader));
    assert.equal(deprecations.length, 1, 'announced once, not per request');
    assert.match(deprecations[0], /x-charness-mcp-client-id/);
    assert.match(deprecations[0], /MIGRATION_RENAME_TO_CHARNESS\.md/);
  });

  it('records abnormal response closure before abort so late cancellation cannot poison ID reuse', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const clientId = 'abnormal-close-client';
    const requestId = 77;
    let markFirstRequestStarted = () => {};
    let markFirstRequestAborted = () => {};
    const firstRequestStarted = new Promise<void>((resolve) => {
      markFirstRequestStarted = resolve;
    });
    const firstRequestAborted = new Promise<void>((resolve) => {
      markFirstRequestAborted = resolve;
    });
    let firstRequestSignal: AbortSignal | undefined;
    let wasReusedRequestAbortedOnEntry: boolean | undefined;
    let serviceCallCount = 0;
    fixture.fileSendHandler.current = async (_threadKey, options) => {
      const signal = options.signal;
      assert.ok(signal);
      serviceCallCount += 1;
      if (serviceCallCount === 1) {
        firstRequestSignal = signal;
        markFirstRequestStarted();
        return new Promise((_resolve, reject) => {
          const handleAbort = () => {
            markFirstRequestAborted();
            reject(signal.reason);
          };
          signal.addEventListener('abort', handleAbort, { once: true });
          if (signal.aborted) handleAbort();
        });
      }

      wasReusedRequestAbortedOnEntry = signal.aborted;
      assert.equal(signal.aborted, false, 'the late cancellation must not pre-cancel the reused request');
      return { ok: true, summary: 'reused request entered un-aborted', sentKinds: ['document'] };
    };

    const abnormalCall = startRawFileSendCall(
      fixture.handle.port,
      token,
      clientId,
      requestId,
      'abnormal.bin',
    );
    void abnormalCall.response.catch(() => undefined);
    await firstRequestStarted;
    abnormalCall.request.destroy();

    assert.equal(
      await checkPromiseResolvesWithin(firstRequestAborted, schedulerMcpStopTimeoutMs),
      true,
      'abnormal client closure must abort the active server signal',
    );
    assert.equal(firstRequestSignal?.aborted, true);

    await sendCancellationNotification(
      fixture.handle.port,
      token,
      clientId,
      requestId,
      'late cancellation after abnormal closure',
    );
    const reusedCall = startRawFileSendCall(
      fixture.handle.port,
      token,
      clientId,
      requestId,
      'reused-after-abnormal.bin',
    );
    const reusedResponse = await reusedCall.response;

    assert.equal(reusedResponse.statusCode, 200, reusedResponse.body);
    assert.equal(serviceCallCount, 2, 'the reused call must enter the service');
    assert.equal(wasReusedRequestAbortedOnEntry, false);
  });

  it('isolates equal request IDs from two clients that share one bearer token', async () => {
    const serverSignals: AbortSignal[] = [];
    const startedResolvers: Array<() => void> = [];
    const abortedResolvers: Array<() => void> = [];
    const started = [0, 1].map(() => new Promise<void>((resolve) => {
      startedResolvers.push(resolve);
    }));
    const aborted = [0, 1].map(() => new Promise<void>((resolve) => {
      abortedResolvers.push(resolve);
    }));
    let releaseSecond = () => {};
    fixture.fileSendHandler.current = async (_threadKey, options) => {
      const signal = options.signal;
      assert.ok(signal);
      const callIndex = serverSignals.length;
      serverSignals.push(signal);
      startedResolvers[callIndex]();
      return new Promise((resolve, reject) => {
        const handleAbort = () => {
          abortedResolvers[callIndex]();
          reject(signal.reason);
        };
        signal.addEventListener('abort', handleAbort, { once: true });
        if (signal.aborted) handleAbort();
        if (callIndex === 1) {
          releaseSecond = () => resolve({ ok: true, summary: 'second delivered', sentKinds: ['document'] });
        }
      });
    };
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const firstClient = await buildClient(fixture.handle.port, token, 'client-a');
    const secondClient = await buildClient(fixture.handle.port, token, 'client-b');
    const firstController = new AbortController();
    try {
      const firstResult = firstClient.callTool(
        { name: 'send_file_to_user', arguments: { paths: ['first.bin'] } },
        CallToolResultSchema,
        { signal: firstController.signal },
      );
      await started[0];
      const secondResult = secondClient.callTool({
        name: 'send_file_to_user',
        arguments: { paths: ['second.bin'] },
      });
      await started[1];

      firstController.abort();
      await assert.rejects(firstResult, /AbortError: This operation was aborted/);
      assert.equal(
        await checkPromiseResolvesWithin(aborted[0], schedulerMcpStopTimeoutMs),
        true,
        'the canceled client must abort its server request',
      );
      assert.equal(serverSignals[0].aborted, true);
      assert.equal(serverSignals[1].aborted, false, 'one client must not cancel another client\'s equal request ID');

      releaseSecond();
      const secondToolResult = await secondResult;
      assert.notEqual(secondToolResult.isError, true, firstText(secondToolResult));
      assert.equal(firstText(secondToolResult), 'second delivered');
    } finally {
      firstController.abort();
      releaseSecond();
      await firstClient.close();
      await secondClient.close();
    }
  });

  it('applies a cancellation notification that arrives before request registration', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const clientId = 'pre-cancel-client';
    await sendCancellationNotification(fixture.handle.port, token, clientId, 1);
    const client = await buildClient(fixture.handle.port, token, clientId);
    try {
      const result = await client.callTool({
        name: 'send_file_to_user',
        arguments: { paths: ['must-not-send.bin'] },
      });

      assert.equal(result.isError, true);
      assert.match(firstText(result), /abort|cancel/i);
      assert.equal(fixture.fileSendCalls.length, 0, 'a pre-cancelled request must not enter the service');
    } finally {
      await client.close();
    }
  });

  it('thread-scope: create (cron + once + N-times) → list → cancel → list empty', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);

    const futureIso = new Date(Date.now() + 5 * 60_000).toISOString();
    const cronResult = await client.callTool({
      name: 'schedule_create',
      arguments: { name: 'Daily', cron: '0 9 * * *', prompt: 'standup' },
    });
    assert.notEqual(cronResult.isError, true, firstText(cronResult));
    const dailyRecord = fixture.armed.find((r) => r.name === 'Daily');
    assert.ok(dailyRecord);
    assert.equal(
      firstText(cronResult),
      `Scheduled "Daily": daily at 09:00; next: ${getExpectedNextStamp(dailyRecord)}\nid: ${dailyRecord.id}`,
      'one human line — what and when — then the id the agent cancels by',
    );

    const onceResult = await client.callTool({
      name: 'schedule_create',
      arguments: { name: 'OneShot', onceAt: futureIso, prompt: 'fire once' },
    });
    assert.notEqual(onceResult.isError, true, firstText(onceResult));

    const ntimesResult = await client.callTool({
      name: 'schedule_create',
      arguments: { name: 'Thrice', cron: '0 */6 * * *', repeatCount: 3, prompt: 'thrice' },
    });
    assert.notEqual(ntimesResult.isError, true, firstText(ntimesResult));

    // All three armed and persisted to the right thread.
    assert.equal(fixture.armed.length, 3);
    assert.equal(fixture.store.getThreadSchedules(makeTelegramKey(-1001234567890, 11)).length, 3);

    const listResult = await client.callTool({ name: 'schedule_list', arguments: {} });
    const listText = firstText(listResult);
    assert.match(listText, /Daily/);
    assert.match(listText, /OneShot/);
    assert.match(listText, /Thrice/);
    assert.match(listText, /3 runs left/);

    // Cancel the cron one by its real id.
    const dailyId = fixture.armed.find((r) => r.name === 'Daily')?.id;
    assert.ok(dailyId);
    const cancelResult = await client.callTool({ name: 'schedule_cancel', arguments: { id: dailyId } });
    assert.notEqual(cancelResult.isError, true, firstText(cancelResult));
    assert.match(firstText(cancelResult), /Cancelled "Daily"/);
    assert.ok(fixture.disarmed.includes(dailyId));

    // Cancel the remaining two.
    for (const name of ['OneShot', 'Thrice']) {
      const id = fixture.armed.find((r) => r.name === name)?.id;
      assert.ok(id);
      await client.callTool({ name: 'schedule_cancel', arguments: { id } });
    }
    const emptyList = await client.callTool({ name: 'schedule_list', arguments: {} });
    assert.match(firstText(emptyList), /No schedules/);

    await client.close();
  });

  it('thread-scope: checkCommand creates a watchdog check that list shows with its state', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    const result = await client.callTool({
      name: 'schedule_create',
      arguments: {
        name: 'API health',
        cron: '*/5 * * * *',
        prompt: 'Restart the API.',
        checkCommand: '  curl -fsS http://127.0.0.1:8080/health  ',
        checkTimeoutSeconds: 15,
      },
    });
    assert.notEqual(result.isError, true, firstText(result));
    const record = fixture.armed.find((r) => r.name === 'API health');
    assert.ok(record);
    assert.equal(record.deliveryKind, 'check');
    assert.equal(record.checkCommand, 'curl -fsS http://127.0.0.1:8080/health');
    assert.equal(record.checkTimeoutSec, 15);
    assert.equal(
      firstText(result),
      `Scheduled "API health": checks every 5m; next: ${getExpectedNextStamp(record)}\nid: ${record.id}`,
      'no command in the confirmation the topic shows',
    );
    assert.doesNotMatch(firstText(result), /curl/);

    // A check counts against the agent's cap and is listed like any agent job — with its command, for the agent.
    const listText = firstText(await client.callTool({ name: 'schedule_list', arguments: {} }));
    assert.match(listText, /API health/);
    assert.match(listText, /check: `curl -fsS http:\/\/127\.0\.0\.1:8080\/health` \(passing\)/);
    await client.close();
  });

  it('thread-scope: checkTimeoutSeconds without checkCommand is ignored with a note', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    const result = await client.callTool({
      name: 'schedule_create',
      arguments: { name: 'Plain', cron: '0 9 * * *', prompt: 'p', checkTimeoutSeconds: 15 },
    });
    assert.notEqual(result.isError, true, firstText(result));
    assert.match(firstText(result), /checkTimeoutSeconds was ignored/);
    const record = fixture.armed.find((r) => r.name === 'Plain');
    assert.ok(record);
    assert.equal(record.deliveryKind, undefined);
    assert.equal(record.checkTimeoutSec, undefined);
    await client.close();
  });

  it('thread-scope: a worker watch with statusWorkerRunDir keeps its status source and its interval, and list shows it', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    const result = await client.callTool({
      name: 'schedule_create',
      arguments: {
        name: 'watch builder S2',
        cron: '*/5 * * * *',
        prompt: 'Read the worker result.',
        checkCommand: 'kill -0 4242',
        statusWorkerRunDir: '  /runs/builder-s2  ',
        statusEveryMinutes: 30,
      },
    });
    assert.notEqual(result.isError, true, firstText(result));
    const record = fixture.armed.find((r) => r.name === 'watch builder S2');
    assert.ok(record);
    assert.equal(record.deliveryKind, 'check');
    assert.equal(record.statusWorkerRunDir, '/runs/builder-s2');
    assert.equal(record.statusEveryMinutes, 30);
    assert.equal(record.statusCommand, undefined);
    assert.equal(firstText(result), `Scheduled "watch builder S2": checks every 5m; next: ${getExpectedNextStamp(record)}\nid: ${record.id}`);
    assert.match(firstText(await client.callTool({ name: 'schedule_list', arguments: {} })), /status every 30 min/);
    await client.close();
  });

  it('thread-scope: a status source without statusEveryMinutes defaults to 15 minutes (the record leaves it unset)', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    const result = await client.callTool({
      name: 'schedule_create',
      arguments: { name: 'Build progress', cron: '*/5 * * * *', prompt: 'p', checkCommand: 'true', statusCommand: 'tail -n 1 build.log' },
    });
    assert.notEqual(result.isError, true, firstText(result));
    const record = fixture.armed.find((r) => r.name === 'Build progress');
    assert.ok(record);
    assert.equal(record.statusCommand, 'tail -n 1 build.log');
    assert.equal(record.statusEveryMinutes, undefined);
    assert.match(firstText(await client.callTool({ name: 'schedule_list', arguments: {} })), /status every 15 min/);
    await client.close();
  });

  it('thread-scope: both status sources is a tool error and nothing is scheduled', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    const armedBefore = fixture.armed.length;
    const result = await client.callTool({
      name: 'schedule_create',
      arguments: { name: 'Both', cron: '*/5 * * * *', prompt: 'p', checkCommand: 'true', statusWorkerRunDir: '/runs/a', statusCommand: 'echo x' },
    });
    assert.equal(result.isError, true);
    assert.match(firstText(result), /ONE status source/);
    assert.equal(fixture.armed.length, armedBefore, 'nothing was armed');
    await client.close();
  });

  it('thread-scope: status fields without checkCommand, or an interval without a source, are ignored with a note', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);

    const withoutCheck = await client.callTool({
      name: 'schedule_create',
      arguments: { name: 'Plain status', cron: '0 9 * * *', prompt: 'p', statusWorkerRunDir: '/runs/a', statusEveryMinutes: 20 },
    });
    assert.notEqual(withoutCheck.isError, true, firstText(withoutCheck));
    assert.match(firstText(withoutCheck), /statusWorkerRunDir \/ statusCommand was ignored/);
    assert.match(firstText(withoutCheck), /statusEveryMinutes was ignored/);
    const plain = fixture.armed.find((r) => r.name === 'Plain status');
    assert.ok(plain);
    assert.equal(plain.statusWorkerRunDir, undefined);
    assert.equal(plain.statusEveryMinutes, undefined);
    assert.doesNotMatch(firstText(withoutCheck), /status every/);

    const withoutSource = await client.callTool({
      name: 'schedule_create',
      arguments: { name: 'Plain check', cron: '*/5 * * * *', prompt: 'p', checkCommand: 'true', statusEveryMinutes: 20 },
    });
    assert.notEqual(withoutSource.isError, true, firstText(withoutSource));
    assert.match(firstText(withoutSource), /statusEveryMinutes was ignored/);
    assert.equal(fixture.armed.find((r) => r.name === 'Plain check')?.statusEveryMinutes, undefined);
    await client.close();
  });

  it('thread-scope: statusEveryMinutes is a whole number of 5 to 240 minutes', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    for (const statusEveryMinutes of [4, 241, 7.5]) {
      const result = await client.callTool({
        name: 'schedule_create',
        arguments: { name: `Interval ${statusEveryMinutes}`, cron: '*/5 * * * *', prompt: 'p', checkCommand: 'true', statusWorkerRunDir: '/runs/a', statusEveryMinutes },
      });
      assert.equal(result.isError, true, `${statusEveryMinutes} is refused`);
    }
    for (const statusEveryMinutes of [5, 240]) {
      const result = await client.callTool({
        name: 'schedule_create',
        arguments: { name: `Interval ${statusEveryMinutes}`, cron: '*/5 * * * *', prompt: 'p', checkCommand: 'true', statusWorkerRunDir: '/runs/a', statusEveryMinutes },
      });
      assert.notEqual(result.isError, true, `${statusEveryMinutes} is accepted: ${firstText(result)}`);
    }
    await client.close();
  });

  it('thread-scope: create with a mismatching threadKey arg errors', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    const result = await client.callTool({
      name: 'schedule_create',
      arguments: { name: 'Wrong', cron: '0 9 * * *', prompt: 'p', threadKey: threadBKey },
    });
    assert.equal(result.isError, true);
    assert.match(firstText(result), /does not match/);
    assert.equal(fixture.armed.length, 0);
    await client.close();
  });

  it('thread-scope: cannot cancel a job owned by another thread', async () => {
    // Seed a job on thread B directly in the store.
    const created = await (await import('../scheduler/store')).createScheduleForThread(fixture.store, {
      threadKey: makeTelegramKey(-1001234567890, 22),
      name: 'BJob',
      spec: { kind: 'cron', cronExpr: '0 9 * * *' },
      prompt: 'p',
      createdBy: 'agent',
      nowMs: Date.now(),
    });
    assert.ok(created.ok);

    // A thread-A-scoped client must not be able to cancel B's job.
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    const result = await client.callTool({ name: 'schedule_cancel', arguments: { id: created.record.id } });
    assert.equal(result.isError, true);
    assert.match(firstText(result), /no schedule with id/);
    // Still present (not deleted by the cross-thread attempt).
    assert.ok(fixture.store.getSchedules()[created.record.id]);
    await client.close();
  });

  it('dir-scope: 2 bound threads → create needs threadKey, then works', async () => {
    const directory = '/work/shared';
    fixture.boundThreads.set(directory, [threadAKey, threadBKey]);
    const token = buildSchedulerMcpToken(secret, { kind: 'dir', directory });
    const client = await buildClient(fixture.handle.port, token);

    // No threadKey → ambiguous → error, nothing armed.
    const ambiguous = await client.callTool({
      name: 'schedule_create',
      arguments: { name: 'Amb', cron: '0 9 * * *', prompt: 'p' },
    });
    assert.equal(ambiguous.isError, true);
    assert.match(firstText(ambiguous), /2 bound threads/);
    assert.equal(fixture.armed.length, 0);

    // With a valid threadKey → works.
    const ok = await client.callTool({
      name: 'schedule_create',
      arguments: { name: 'Picked', cron: '0 9 * * *', prompt: 'p', threadKey: threadBKey },
    });
    assert.notEqual(ok.isError, true, firstText(ok));
    assert.equal(fixture.armed.length, 1);
    assert.equal(fixture.armed[0].threadKey, threadBKey);
    await client.close();
  });

  it('dir-scope: exactly 1 bound thread is implicit', async () => {
    const directory = '/work/solo';
    fixture.boundThreads.set(directory, [threadAKey]);
    const token = buildSchedulerMcpToken(secret, { kind: 'dir', directory });
    const client = await buildClient(fixture.handle.port, token);
    const result = await client.callTool({
      name: 'schedule_create',
      arguments: { name: 'Solo', cron: '0 9 * * *', prompt: 'p' },
    });
    assert.notEqual(result.isError, true, firstText(result));
    assert.equal(fixture.armed.length, 1);
    assert.equal(fixture.armed[0].threadKey, threadAKey);
    await client.close();
  });

  it('one-shot with a redundant repeatCount succeeds first-try (live transcript regression)', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    const futureIso = new Date(Date.now() + 60 * 60_000).toISOString();
    const result = await client.callTool({
      name: 'schedule_create',
      arguments: { name: 'OnceTask', onceAt: futureIso, repeatCount: 1, prompt: 'do it once' },
    });
    assert.notEqual(result.isError, true, firstText(result));
    assert.match(firstText(result), /ignored/i);
    const record = fixture.armed.find((r) => r.name === 'OnceTask');
    assert.ok(record);
    assert.equal(record.spec.kind, 'once');
    // No N-times remainingRuns leaked onto the one-shot.
    assert.equal((record.spec as { remainingRuns?: number }).remainingRuns, undefined);
    await client.close();
  });

  // ── reminders are invisible to the agent (bot-local delivery kind) ──
  //
  // The whole point of `/reminders` is "no agent involvement": a reminder is
  // posted + pinned by the bot and never reaches a session. So the agent must not
  // see one described as a "scheduled prompt" it could act on, and must not be
  // able to delete something the operator created with buttons. Both are asserted
  // over the REAL HTTP tool surface, and each check is paired with a prompt job in
  // the SAME thread so a blanket filter (which would also hide the agent's own
  // jobs) cannot pass.

  async function seedThreadSchedule(
    name: string,
    deliveryKind?: 'reminder',
  ): Promise<ScheduleRecord> {
    const created = await (await import('../scheduler/store')).createScheduleForThread(fixture.store, {
      threadKey: makeTelegramKey(-1001234567890, 11),
      name,
      spec: { kind: 'cron', cronExpr: '0 9 * * *' },
      prompt: `${name} body`,
      createdBy: deliveryKind === 'reminder' ? 'user' : 'agent',
      nowMs: Date.now(),
      ...(deliveryKind !== undefined ? { deliveryKind } : {}),
    });
    assert.ok(created.ok);
    return created.record;
  }

  it('schedule_list hides reminders but still lists the agent-prompt jobs', async () => {
    const reminder = await seedThreadSchedule('Take the pills', 'reminder');
    const promptJob = await seedThreadSchedule('Check the deploy');

    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    const listed = firstText(await client.callTool({ name: 'schedule_list', arguments: {} }));

    assert.ok(listed.includes(promptJob.id), `the prompt job must still be listed: "${listed}"`);
    assert.ok(!listed.includes(reminder.id), `the reminder id leaked into the list: "${listed}"`);
    assert.ok(!listed.includes('Take the pills'), `the reminder name leaked into the list: "${listed}"`);
    await client.close();
  });

  it('schedule_list reports an empty topic when its ONLY schedules are reminders', async () => {
    await seedThreadSchedule('Take the pills', 'reminder');

    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    const result = await client.callTool({ name: 'schedule_list', arguments: {} });
    assert.notEqual(result.isError, true, firstText(result));
    assert.match(firstText(result), /No schedules for this topic/);
    await client.close();
  });

  it('schedule_cancel treats a reminder id as not found and leaves it armed', async () => {
    const reminder = await seedThreadSchedule('Take the pills', 'reminder');

    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    const result = await client.callTool({ name: 'schedule_cancel', arguments: { id: reminder.id } });

    // The SAME not-found wording a missing id gets — from the agent's side the
    // reminder genuinely does not exist, and a distinct refusal would only tell it
    // there is an id here worth retrying.
    assert.equal(result.isError, true);
    assert.match(firstText(result), /no schedule with id/);
    // Untouched: still persisted, and never disarmed.
    assert.ok(fixture.store.getSchedules()[reminder.id], 'the reminder must survive the cancel attempt');
    assert.ok(!fixture.disarmed.includes(reminder.id), 'the reminder must not be disarmed');
    await client.close();
  });

  it('schedule_cancel still cancels a real prompt job in a thread that also holds reminders', async () => {
    const reminder = await seedThreadSchedule('Take the pills', 'reminder');
    const promptJob = await seedThreadSchedule('Check the deploy');

    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    const result = await client.callTool({ name: 'schedule_cancel', arguments: { id: promptJob.id } });

    assert.notEqual(result.isError, true, firstText(result));
    assert.equal(fixture.store.getSchedules()[promptJob.id], undefined, 'the prompt job is gone');
    assert.ok(fixture.disarmed.includes(promptJob.id));
    assert.ok(fixture.store.getSchedules()[reminder.id], 'the reminder is untouched');
    await client.close();
  });

  it('schedule_cancel of a check unpins the alerts an earlier version pinned for it; a job without any unpins nothing', async () => {
    const watch = await seedThreadSchedule('watch builder S1');
    await fixture.store.upsertSchedule({ ...watch, deliveryKind: 'check', checkCommand: 'kill -0 1', alertPinMessageIds: [501, 502] });
    const plain = await seedThreadSchedule('Check the deploy');

    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    const cancelled = await client.callTool({ name: 'schedule_cancel', arguments: { id: watch.id } });
    assert.notEqual(cancelled.isError, true, firstText(cancelled));
    assert.match(firstText(cancelled), /2 pinned alert\(s\) unpinned/);
    assert.deepEqual(fixture.unpinCalls, [{ threadKey: watch.threadKey, messageIds: [501, 502] }]);

    await client.callTool({ name: 'schedule_cancel', arguments: { id: plain.id } });
    assert.equal(fixture.unpinCalls.length, 1, 'nothing to unpin');
    await client.close();
  });

  it('schedule_cancel counts only the alerts that WERE unpinned, and says which could not be (Telegram did not answer)', async () => {
    const watch = await seedThreadSchedule('watch builder S5');
    await fixture.store.upsertSchedule({ ...watch, deliveryKind: 'check', checkCommand: 'kill -0 1', alertPinMessageIds: [701, 702, 703] });
    fixture.stillPinnedMessageIds.push(702);

    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    const cancelled = await client.callTool({ name: 'schedule_cancel', arguments: { id: watch.id } });
    assert.notEqual(cancelled.isError, true, firstText(cancelled));
    assert.equal(
      firstText(cancelled),
      `Cancelled "watch builder S5" (id: ${watch.id}); its 2 pinned alert(s) unpinned; 1 pinned alert(s) could not be unpinned (Telegram did not answer — unpin by hand).`,
    );
    assert.equal(fixture.store.getSchedules()[watch.id], undefined, 'the job is cancelled all the same');

    const allFailed = await seedThreadSchedule('watch builder S6');
    await fixture.store.upsertSchedule({ ...allFailed, deliveryKind: 'check', checkCommand: 'kill -0 1', alertPinMessageIds: [801] });
    fixture.stillPinnedMessageIds.push(801);
    const second = await client.callTool({ name: 'schedule_cancel', arguments: { id: allFailed.id } });
    assert.doesNotMatch(firstText(second), /unpinned;|its \d+ pinned alert\(s\) unpinned/, 'nothing was unpinned, so nothing is claimed');
    assert.match(firstText(second), /1 pinned alert\(s\) could not be unpinned/);
    await client.close();
  });

  it('schedule_cancel of a check deletes its status line; with alert pins too, it says both; a job without a line deletes nothing', async () => {
    const watch = await seedThreadSchedule('watch builder S3');
    await fixture.store.upsertSchedule({
      ...watch,
      deliveryKind: 'check',
      checkCommand: 'kill -0 1',
      statusWorkerRunDir: '/runs/a',
      statusMessageId: 733,
    });
    const alerted = await seedThreadSchedule('watch builder S4');
    await fixture.store.upsertSchedule({
      ...alerted,
      deliveryKind: 'check',
      checkCommand: 'kill -0 2',
      statusWorkerRunDir: '/runs/b',
      statusMessageId: 734,
      alertPinMessageIds: [601],
    });
    const plain = await seedThreadSchedule('Check the deploy');

    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);

    const first = await client.callTool({ name: 'schedule_cancel', arguments: { id: watch.id } });
    assert.notEqual(first.isError, true, firstText(first));
    assert.equal(firstText(first), `Cancelled "watch builder S3" (id: ${watch.id}); its status line deleted.`);
    assert.deepEqual(fixture.deleteCalls, [{ threadKey: watch.threadKey, messageId: 733 }]);
    assert.deepEqual(fixture.unpinCalls, []);

    const second = await client.callTool({ name: 'schedule_cancel', arguments: { id: alerted.id } });
    assert.equal(firstText(second), `Cancelled "watch builder S4" (id: ${alerted.id}); its 1 pinned alert(s) unpinned; its status line deleted.`);
    assert.deepEqual(fixture.unpinCalls, [{ threadKey: alerted.threadKey, messageIds: [601] }]);
    assert.deepEqual(fixture.deleteCalls.map((call) => call.messageId), [733, 734]);

    const third = await client.callTool({ name: 'schedule_cancel', arguments: { id: plain.id } });
    assert.equal(firstText(third), `Cancelled "Check the deploy" (id: ${plain.id}).`);
    assert.equal(fixture.deleteCalls.length, 2, 'a job without a status line deletes nothing');
    await client.close();
  });

  it('isPinSilent is still accepted from an older caller and changes nothing: it is not stored and the answer does not mention it', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    const result = await client.callTool({
      name: 'schedule_create',
      arguments: { name: 'Silent', cron: '0 9 * * *', prompt: 'p', isPinSilent: true },
    });
    assert.notEqual(result.isError, true, firstText(result));
    const record = fixture.armed.find((r) => r.name === 'Silent');
    assert.ok(record);
    assert.ok(!('isPinSilent' in fixture.store.getSchedules()[record.id]), 'the deprecated flag is not persisted');
    assert.equal(firstText(result), `Scheduled "Silent": daily at 09:00; next: ${getExpectedNextStamp(record)}\nid: ${record.id}`);

    const scheduleCreate = (await client.listTools()).tools.find((tool) => tool.name === 'schedule_create');
    const pinSilentProperty = (scheduleCreate?.inputSchema.properties ?? {}).isPinSilent;
    assert.ok(pinSilentProperty && typeof pinSilentProperty === 'object' && 'description' in pinSilentProperty);
    assert.match(String(pinSilentProperty.description), /DEPRECATED, has no effect/);
    await client.close();
  });

  it('a cron nothing phrases is confirmed by its next run, never by the raw expression; a one-shot by its own time', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    const twiceADay = await client.callTool({ name: 'schedule_create', arguments: { name: 'Twice', cron: '0 9,18 * * *', prompt: 'p' } });
    const twiceRecord = fixture.armed.find((r) => r.name === 'Twice');
    assert.ok(twiceRecord);
    assert.equal(firstText(twiceADay), `Scheduled "Twice": next: ${getExpectedNextStamp(twiceRecord)}\nid: ${twiceRecord.id}`);
    assert.doesNotMatch(firstText(twiceADay), /cron|9,18/);

    const irregularCheck = await client.callTool({ name: 'schedule_create', arguments: { name: 'Odd check', cron: '*/40 * * * *', prompt: 'p', checkCommand: 'true' } });
    const checkRecord = fixture.armed.find((r) => r.name === 'Odd check');
    assert.ok(checkRecord);
    assert.equal(firstText(irregularCheck), `Scheduled "Odd check": checks; next: ${getExpectedNextStamp(checkRecord)}\nid: ${checkRecord.id}`, '*/40 does not divide the hour (it fires at :00 and :40): no «every 40m»');
    await client.close();
  });

  it('a one-shot is confirmed in the same one-line shape', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    const onceIso = new Date(Date.now() + 60 * 60_000).toISOString();
    const once = await client.callTool({ name: 'schedule_create', arguments: { name: 'Once', onceAt: onceIso, prompt: 'p' } });
    const onceRecord = fixture.armed.find((r) => r.name === 'Once');
    assert.ok(onceRecord);
    assert.match(firstText(once), new RegExp(`^Scheduled "Once": once at \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}\\nid: ${onceRecord.id}$`));
    await client.close();
  });
});
