/**
 * The accounts note's MID-TURN delivery (`limitNotes/engine.ts` over `utils/midTurnInbox.ts`): which sessions it offers a due reminder to,
 * when a note counts as delivered, when it is withdrawn and stays due — and the lifecycle rule behind all of it (README § Lifecycle
 * safety): a note is a passenger, never a cause. The engine is also run over the REAL json-stream adapter, a real `StateStore` and the
 * real hook, and what the lifecycle readers see — busy, working, unconsumed input, the watchdog's clock, the idle marks, the open
 * requests, stdin — is compared before and after.
 *
 *   L2  the poll over an idle, an asleep and a busy session stamps no activity (a spy over the whole state the notes' ports reach)
 *   L4  a mid-turn delivery writes no stdin and opens no request; an OpenCode session is never offered one
 *   L6  it leaves busy / working / the unconsumed input / the busy watchdog's clock as they were (the inputs of the self-update idle
 *       verdict, L11, among them; its wiring is `limitNotesWiring.test.ts`'s)
 *   L7  every cause that holds a turn open skips the engine and withdraws a waiting section
 *   L13 a turn the bot started for its own bookkeeping (a retry's nudge, a wake-up, the todo reminder, …) is given no reminder: the mark
 *       a forward sets, a turn end clears, and the engine reads
 *   L10 a deferred account switch fires at the turn end after a turn that got a mid-turn note and a send-result note
 *   L12 boot clears every inbox file; the note record survives a restart, so no reminder comes before the interval
 *
 * The whole thing at process level (a fake agent, the idle fire at the same instant) is `limitNotesMidTurnE2e.test.ts`.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeJsonStreamAdapter, type StreamSession } from '../adapters/claudeJsonStreamAdapter';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { LimitNotesEngine, limitNoteEnginePollMs, type LimitNotesEngineDeps } from '../limitNotes/engine';
import { defaultLimitNoteWindows, type LimitNoteRecord } from '../limitNotes/plan';
import { createLimitNotes, type LimitNotes, type LimitNotesPorts } from '../limitNotes/service';
import { claudeJsonStreamAdapterName, openCodeAdapterName } from '../adapters/adapterNames';
import { createSessionTurnProbe, type SessionTurnProbeDeps } from '../requests/sessionTurnProbe';
import type { SessionTurnProbe } from '../requests/wakeUpRules';
import { keyToString, type SessionKey } from '../sessionKey';
import { StateStore } from '../state';
import { buildMidTurnInboxHookCommand, createMidTurnInbox, getMidTurnInboxDir, type MidTurnInbox } from '../utils/midTurnInbox';
import { createStreamSessionFixture } from './claudeJsonStreamSessionFixture';
import { buildReport, hourMs, minuteMs, nowMs } from './limitNotesFixtures';

const key: SessionKey = makeTelegramKey(-1001111111111, 401);
const secondKey: SessionKey = makeTelegramKey(-1001111111111, 402);
const sessionId = '5a836301-382a-444f-8076-26b744c36d01';
const secondSessionId = '9b1c2d3e-0000-4444-8888-aaaaaaaaaaaa';

const busyProbe: SessionTurnProbe = { isActive: true, isBusy: true, hasUnconsumedInput: false, isTurnEndBlocked: false };
const orchestrating = (patch: LimitNoteRecord = {}): LimitNoteRecord => ({ lastOrchestratedAt: nowMs - hourMs, lastNoteAt: nowMs - 70 * minuteMs, fingerprint: 'rec=old', ...patch });

/** What an agent's tool call does with the inbox: the hook, as a launch runs it. */
function runHook(inboxDir: string, id: string = sessionId): string {
  return spawnSync('sh', ['-c', buildMidTurnInboxHookCommand(inboxDir)], { input: JSON.stringify({ session_id: id, hook_event_name: 'PostToolUse', tool_name: 'Bash' }), encoding: 'utf8' }).stdout;
}

/** The text a hook run printed, as the agent reads it. */
const readAdditionalContext = (hookOutput: string): string => JSON.parse(hookOutput).hookSpecificOutput.additionalContext;

describe('the engine over fakes: which session is offered a due reminder, and when it counts as delivered', () => {
  let dataDir: string;
  let inbox: MidTurnInbox;
  let records: Map<string, LimitNoteRecord>;
  let notes: LimitNotes;
  let probes: Map<string, SessionTurnProbe>;
  let sessionIds: Map<string, string | null>;
  let takeCalls: string[];
  let clockMs: number;
  let workWeeklyPercent: number;
  let engine: LimitNotesEngine;
  let ports: LimitNotesPorts;

  const inboxDir = (): string => getMidTurnInboxDir(dataDir);
  const inboxFile = (id: string = sessionId): string => path.join(inboxDir(), `${id}.json`);

  function createEngine(overrides: Partial<LimitNotesEngineDeps> = {}): LimitNotesEngine {
    return new LimitNotesEngine({
      listConversations: () => [key, secondKey],
      getClaudeSessionId: (target) => sessionIds.get(keyToString(target)) ?? null,
      probeTurn: (target) => probes.get(keyToString(target)) ?? { isActive: false, isBusy: false, hasUnconsumedInput: null, isTurnEndBlocked: false },
      notes: {
        takeMidTurnNote: (target) => { takeCalls.push(keyToString(target)); return notes.takeMidTurnNote(target); },
        checkIsBookkeepingTurn: (target) => notes.checkIsBookkeepingTurn(target),
      },
      inbox,
      pollIntervalMs: 10,
      ...overrides,
    });
  }

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-limit-engine-'));
    inbox = createMidTurnInbox({ inboxDir: inboxDir() });
    records = new Map([[keyToString(key), orchestrating()], [keyToString(secondKey), orchestrating()]]);
    probes = new Map([[keyToString(key), busyProbe], [keyToString(secondKey), busyProbe]]);
    sessionIds = new Map([[keyToString(key), sessionId], [keyToString(secondKey), secondSessionId]]);
    takeCalls = [];
    clockMs = nowMs;
    workWeeklyPercent = 62;
    ports = {
      getRecord: (target) => records.get(keyToString(target)),
      setRecord: (target, record) => { if (record === null) records.delete(keyToString(target)); else records.set(keyToString(target), record); },
      getIntervalMs: () => hourMs,
      getWindows: () => defaultLimitNoteWindows,
      getReport: () => buildReport(workWeeklyPercent),
      getOpenCodeUsage: () => ({}),
      getTimezone: () => 'UTC',
      getBackendName: () => claudeJsonStreamAdapterName,
      getNowMs: () => clockMs,
      log: () => {},
    };
    notes = createLimitNotes(ports);
    engine = createEngine();
  });
  afterEach(() => {
    engine.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('a busy Claude session whose reminder is due gets it into its inbox — and it counts as delivered only once the hook took it', async () => {
    await engine.poll();
    assert.match(readAdditionalContext(fs.readFileSync(inboxFile(), 'utf8')), /^\[Accounts · 14:05\] Next new Claude worker → work/);
    assert.deepEqual(records.get(keyToString(key)), orchestrating(), 'written is not delivered: the record is as it was');
    const read = readAdditionalContext(runHook(inboxDir()));
    assert.match(read, /^\[Accounts · 14:05\]/);
    await engine.poll();
    assert.equal(records.get(keyToString(key))?.lastNoteAt, nowMs, 'the next poll finds the file taken and records the note');
    assert.match(records.get(keyToString(key))?.fingerprint ?? '', /^rec=work\|/);
    assert.equal(fs.existsSync(inboxFile()), false, 'and offers nothing: not due any more');
  });

  it('the agent\'s claude_profiles call withdraws a waiting reminder before the hook can hand it over — and the look it records is the record that stands', async () => {
    await engine.poll();
    workWeeklyPercent = 75;
    clockMs = nowMs + minuteMs;
    // What the bot's port for the tool does, in its order: the stale reminder goes, then the look is recorded.
    inbox.withdraw(key, 'accounts');
    notes.noteProfilesCall(key);
    const afterLook = records.get(keyToString(key));
    assert.equal(runHook(inboxDir()), '', 'the tool\'s own PostToolUse hook finds nothing: the agent is not told to call the tool right after it did');
    clockMs = nowMs + 2 * minuteMs;
    await engine.poll();
    assert.deepEqual(records.get(keyToString(key)), afterLook, 'and nothing was recorded over the look');
    assert.equal(fs.existsSync(inboxFile()), false, 'the clock restarted with the look: nothing is due, so nothing is offered again');
  });

  it('a reminder the hook took AFTER the agent looked (no withdrawal in between) is recorded without rolling the look back', async () => {
    await engine.poll();
    workWeeklyPercent = 75;
    clockMs = nowMs + minuteMs;
    notes.noteProfilesCall(key);
    const afterLook = records.get(keyToString(key));
    assert.ok(readAdditionalContext(runHook(inboxDir())).startsWith('[Accounts'), 'the file was still there for the hook');
    clockMs = nowMs + 2 * minuteMs;
    await engine.poll();
    assert.deepEqual(records.get(keyToString(key)), afterLook, 'the older picture the note carried does not replace the one the agent looked at');
  });

  it('a note that waits is not rewritten by the next poll, and another conversation has its own file', async () => {
    await engine.poll();
    const writtenAt = fs.statSync(inboxFile()).mtimeMs;
    const writtenSecondAt = fs.statSync(inboxFile(secondSessionId)).mtimeMs;
    await engine.poll();
    assert.equal(fs.statSync(inboxFile()).mtimeMs, writtenAt);
    assert.equal(fs.statSync(inboxFile(secondSessionId)).mtimeMs, writtenSecondAt);
    assert.deepEqual(takeCalls, [keyToString(key), keyToString(secondKey)], 'asked once each: a waiting note is no reason to work another out');
  });

  it('the turn ends before a tool call took it: the note is withdrawn unseen, the record untouched, and it comes at the next turn that works', async () => {
    await engine.poll();
    probes.set(keyToString(key), { ...busyProbe, isBusy: false });
    await engine.poll();
    assert.equal(fs.existsSync(inboxFile()), false, 'the dir is empty between turns');
    assert.deepEqual(records.get(keyToString(key)), orchestrating());
    probes.set(keyToString(key), busyProbe);
    await engine.poll();
    assert.match(readAdditionalContext(fs.readFileSync(inboxFile(), 'utf8')), /^\[Accounts · 14:05\]/, 'still due');
  });

  it('a session that is gone or asleep, and one that is idle, is offered nothing and asked for no note', async () => {
    probes.set(keyToString(key), { isActive: false, isBusy: false, hasUnconsumedInput: null, isTurnEndBlocked: false });
    probes.set(keyToString(secondKey), { ...busyProbe, isBusy: false });
    await engine.poll();
    assert.deepEqual(takeCalls, []);
    assert.equal(fs.existsSync(inboxDir()), false, 'nothing written, no dir even');
  });

  it('a conversation whose agent is not a Claude json-stream session (OpenCode, the terminal, none) gets no mid-turn path at all', async () => {
    sessionIds.set(keyToString(key), null);
    sessionIds.set(keyToString(secondKey), null);
    await engine.poll();
    assert.deepEqual(takeCalls, [], 'no note is even worked out for it');
    assert.equal(fs.existsSync(inboxDir()), false);
  });

  it('a section that waits for a session whose agent changed backend is withdrawn', async () => {
    await engine.poll();
    sessionIds.set(keyToString(key), null);
    await engine.poll();
    assert.equal(fs.existsSync(inboxFile()), false);
    assert.deepEqual(records.get(keyToString(key)), orchestrating(), 'unseen: still due');
  });

  it('the project board\'s section of the same inbox is neither written nor withdrawn by the engine', async () => {
    inbox.offer(key, sessionId, 'todoBoard', { text: 'BOARD', onTaken: () => {} });
    await engine.poll();
    assert.match(readAdditionalContext(fs.readFileSync(inboxFile(), 'utf8')), /^\[Accounts · 14:05\][^]*\n\nBOARD$/);
    probes.set(keyToString(key), { ...busyProbe, isBusy: false });
    await engine.poll();
    assert.equal(readAdditionalContext(fs.readFileSync(inboxFile(), 'utf8')), 'BOARD', 'only its own section goes');
  });

  it('a conversation whose poll throws does not stop the others; the one that failed is tried again', async () => {
    const warnings: string[] = [];
    mock.method(console, 'warn', (...parts: unknown[]) => { warnings.push(parts.map(String).join(' ')); });
    try {
      let isFirstConversationFailing = true;
      engine = createEngine({
        probeTurn: (target) => {
          if (isFirstConversationFailing && keyToString(target) === keyToString(key)) throw new Error('adapter went away');
          return busyProbe;
        },
      });
      await engine.poll();
      assert.equal(fs.existsSync(inboxFile()), false);
      assert.equal(fs.existsSync(inboxFile(secondSessionId)), true, 'the next conversation was polled');
      assert.match(warnings.join('\n'), /mid-turn poll of .* failed: adapter went away/);
      isFirstConversationFailing = false;
      await engine.poll();
      assert.equal(fs.existsSync(inboxFile()), true);
    } finally {
      mock.restoreAll();
    }
  });

  it('a file that cannot be written gives the note back at once: nothing stays in flight, and a later poll offers it again', async () => {
    mock.method(console, 'warn', () => {});
    try {
      fs.mkdirSync(inboxDir(), { recursive: true });
      fs.mkdirSync(inboxFile());
      fs.writeFileSync(path.join(inboxFile(), 'blocks-the-rename'), 'x');
      await engine.poll();
      assert.deepEqual(records.get(keyToString(key)), orchestrating());
      fs.rmSync(inboxFile(), { recursive: true });
      await engine.poll();
      assert.equal(fs.existsSync(inboxFile()), true, 'not stuck in flight: offered again');
    } finally {
      mock.restoreAll();
    }
  });

  it('L13: a turn the bot started for its own bookkeeping is given no reminder — none is worked out, a waiting one is withdrawn — and the next turn, a person\'s, is', async () => {
    await engine.poll();
    assert.equal(fs.existsSync(inboxFile()), true, 'a turn nobody marked is offered the reminder that is due');
    takeCalls.length = 0;
    notes.noteTurnStart(key, { isBookkeeping: true, isSessionIdle: true });
    await engine.poll();
    assert.equal(fs.existsSync(inboxFile()), false, 'the bookkeeping turn takes the waiting section out');
    assert.equal(fs.existsSync(inboxFile(secondSessionId)), true, 'another conversation is its own');
    assert.deepEqual(takeCalls, [], 'and no note is even worked out for the marked one (the other conversation\'s section still waits: asked for nothing)');
    assert.deepEqual(records.get(keyToString(key)), orchestrating(), 'unseen: the reminder stays due');
    notes.noteTurnEnd(key);
    await engine.poll();
    assert.match(readAdditionalContext(fs.readFileSync(inboxFile(), 'utf8')), /^\[Accounts · 14:05\]/, 'the turn ended: the next one gets the reminder that was due');
  });

  it('L13: a prompt that opens a turn of its own decides its mark — a bookkeeping prompt sets it, a person\'s clears it — and one queued behind a running turn leaves that turn as it was', () => {
    notes.noteTurnStart(key, { isBookkeeping: true, isSessionIdle: true });
    assert.equal(notes.checkIsBookkeepingTurn(key), true);
    assert.equal(notes.checkIsBookkeepingTurn(secondKey), false, 'per conversation');
    notes.noteTurnStart(key, { isBookkeeping: false, isSessionIdle: false });
    assert.equal(notes.checkIsBookkeepingTurn(key), true, 'a person\'s message queued behind the running bookkeeping turn does not change what that turn is');
    notes.noteTurnStart(key, { isBookkeeping: false, isSessionIdle: true });
    assert.equal(notes.checkIsBookkeepingTurn(key), false, 'a person\'s message that opens its own turn');
    notes.noteTurnStart(key, { isBookkeeping: true, isSessionIdle: false });
    assert.equal(notes.checkIsBookkeepingTurn(key), false, 'a bookkeeping prompt queued behind a person\'s turn does not turn it into one');
    notes.noteTurnStart(key, { isBookkeeping: true, isSessionIdle: true });
    notes.noteTurnEnd(key);
    assert.equal(notes.checkIsBookkeepingTurn(key), false, 'a turn end clears it');
  });

  it('L13: the mark is kept only for a Claude json-stream conversation: no other backend\'s forward leaves one behind', () => {
    for (const backendName of [openCodeAdapterName, undefined]) {
      const otherNotes = createLimitNotes({ ...ports, getBackendName: () => backendName });
      otherNotes.noteTurnStart(key, { isBookkeeping: true, isSessionIdle: true });
      assert.equal(otherNotes.checkIsBookkeepingTurn(key), false, String(backendName));
    }
  });

  it('the timer polls on its interval until it is stopped, is started once, and is the production minute by default', async () => {
    assert.equal(limitNoteEnginePollMs, 60_000);
    engine.start();
    engine.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(fs.existsSync(inboxFile()), true, 'it polled by itself');
    engine.stop();
    fs.rmSync(inboxDir(), { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(fs.existsSync(inboxDir()), false, 'stopped: no more polls');
  });
});

describe('L7: every cause that holds a turn open skips the engine and withdraws a waiting section', () => {
  type Cause = 'pendingQuestion' | 'questionPin' | 'adapterQuestion' | 'loginPaste' | 'compacting' | 'armedRetry' | 'wedgeRecovery' | 'retryKick' | 'sessionStarting';
  const causes: Cause[] = ['pendingQuestion', 'questionPin', 'adapterQuestion', 'loginPaste', 'compacting', 'armedRetry', 'wedgeRecovery', 'retryKick', 'sessionStarting'];
  let dataDir: string;
  let activeCauses: Set<Cause>;
  let armedTimer: NodeJS.Timeout;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-limit-engine-causes-'));
    activeCauses = new Set();
    armedTimer = setTimeout(() => {}, 60_000);
    armedTimer.unref();
  });
  afterEach(() => {
    clearTimeout(armedTimer);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function createRig() {
    const inbox = createMidTurnInbox({ inboxDir: getMidTurnInboxDir(dataDir) });
    const takeCalls: string[] = [];
    const probeDeps: SessionTurnProbeDeps = {
      getAdapter: () => ({
        checkIsActive: () => true,
        checkIsBusy: () => true,
        isQuestionPending: () => activeCauses.has('adapterQuestion'),
        isLoginPastePending: () => activeCauses.has('loginPaste'),
      }),
      checkHasPendingQuestion: () => activeCauses.has('pendingQuestion'),
      checkHasQuestionPin: () => activeCauses.has('questionPin'),
      checkIsCompacting: () => activeCauses.has('compacting'),
      getApiRetryTimer: () => (activeCauses.has('armedRetry') ? armedTimer : undefined),
      checkIsWedgeRecoveryInFlight: () => activeCauses.has('wedgeRecovery'),
      checkIsRetryKickInFlight: () => activeCauses.has('retryKick'),
      checkIsSessionStarting: () => activeCauses.has('sessionStarting'),
      checkIsReplayingBufferedPrompts: () => false,
      serializeKey: keyToString,
    };
    const engine = new LimitNotesEngine({
      listConversations: () => [key],
      getClaudeSessionId: () => sessionId,
      probeTurn: createSessionTurnProbe(probeDeps),
      notes: {
        takeMidTurnNote: () => { takeCalls.push('take'); return { text: '[Accounts · 14:05] note', markDelivered: () => {}, release: () => {} }; },
        checkIsBookkeepingTurn: () => false,
      },
      inbox,
    });
    return { engine, inbox, takeCalls };
  }

  for (const cause of causes) {
    it(`${cause}: no note is worked out for a turn held open by it, and one already waiting is withdrawn when it begins`, async () => {
      const { engine, inbox, takeCalls } = createRig();
      activeCauses.add(cause);
      await engine.poll();
      assert.deepEqual(takeCalls, [], 'nothing is even worked out');
      assert.equal(inbox.checkIsWaiting(key, 'accounts'), false);
      activeCauses.delete(cause);
      await engine.poll();
      assert.equal(inbox.checkIsWaiting(key, 'accounts'), true, 'the same session, no cause: it is offered');
      activeCauses.add(cause);
      await engine.poll();
      assert.equal(inbox.checkIsWaiting(key, 'accounts'), false, 'the cause began while it waited: withdrawn');
      assert.equal(fs.existsSync(path.join(getMidTurnInboxDir(dataDir), `${sessionId}.json`)), false);
    });
  }
});

describe('on the real json-stream adapter, a real StateStore and the real hook', () => {
  let dataDir: string;
  let state: StateStore;
  let adapter: ClaudeJsonStreamAdapter;
  let session: StreamSession;
  let inbox: MidTurnInbox;
  let notes: LimitNotes;
  let engine: LimitNotesEngine;
  let stdinWrites: string[];
  let stateCalls: string[];
  let backendName: string;
  const stores: StateStore[] = [];

  /** Every method of the state the notes' ports reach, recorded by name — the bot hands the notes exactly this object's two record methods. */
  function spyOnState(target: StateStore): StateStore {
    return new Proxy(target, {
      get(store, property, receiver) {
        const member = Reflect.get(store, property, receiver);
        if (typeof member !== 'function') return member;
        return (...args: unknown[]) => {
          stateCalls.push(String(property));
          return member.apply(store, args);
        };
      },
    });
  }

  function createNotes(source: StateStore): LimitNotes {
    return createLimitNotes({
      getRecord: (target) => source.getLimitNoteRecord(target),
      setRecord: (target, record) => source.setLimitNoteRecord(target, record),
      getIntervalMs: () => hourMs,
      getWindows: () => defaultLimitNoteWindows,
      getReport: () => buildReport(),
      getOpenCodeUsage: () => ({}),
      getTimezone: () => 'UTC',
      getBackendName: () => backendName,
      getNowMs: () => nowMs,
      log: () => {},
    });
  }

  function buildEngine(): LimitNotesEngine {
    const probeDeps: SessionTurnProbeDeps = {
      getAdapter: () => adapter,
      checkHasPendingQuestion: () => false,
      checkHasQuestionPin: () => false,
      checkIsCompacting: () => false,
      getApiRetryTimer: () => undefined,
      checkIsWedgeRecoveryInFlight: () => false,
      checkIsRetryKickInFlight: () => false,
      checkIsSessionStarting: () => false,
      checkIsReplayingBufferedPrompts: () => false,
      serializeKey: keyToString,
    };
    return new LimitNotesEngine({
      listConversations: () => [key],
      getClaudeSessionId: () => (backendName === claudeJsonStreamAdapterName ? sessionId : null),
      probeTurn: createSessionTurnProbe(probeDeps),
      notes,
      inbox,
    });
  }

  /** Everything a lifecycle reader looks at, copied: two of these are equal when nothing moved. */
  function takeLifecycleSnapshot() {
    return {
      isBusy: adapter.checkIsBusy(key),
      isWorking: adapter.checkIsWorking(key),
      hasUnconsumedInput: adapter.checkHasUnconsumedInput(key),
      workingSignals: adapter.getBackgroundWorkSignals(key),
      unconsumedInputs: structuredClone(session.unconsumedInputs),
      lastStdoutActivityAt: session.lastStdoutActivityAt,
      lastTurnEndedAt: session.lastTurnEndedAt,
      outstandingToolUseIds: [...session.outstandingToolUseIds],
      stdinWrites: [...stdinWrites],
      idleTracking: state.getCompactIdleTracking(key),
      openRequests: state.getOpenRequests(),
    };
  }

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-limit-lifecycle-'));
    state = new StateStore(dataDir, { saveDebounceMs: 10 });
    stores.push(state);
    await state.init();
    await state.setAgent(key, { name: claudeJsonStreamAdapterName, claudeSessionId: sessionId });
    state.noteCompactIdleActivity(key, nowMs - 30 * minuteMs);
    state.noteCompactIdleTurnEnd(key, nowMs - 30 * minuteMs);
    state.setLimitNoteRecord(key, orchestrating());
    stdinWrites = [];
    stateCalls = [];
    backendName = claudeJsonStreamAdapterName;
    adapter = new ClaudeJsonStreamAdapter({ lifecycle: 'idle', writeFifo: async (_fifoFd, text) => { stdinWrites.push(text); } });
    session = createStreamSessionFixture({ key, pid: process.pid, sessionId, isBusy: true, lastStdoutActivityAt: nowMs - 5_000, lastTurnEndedAt: nowMs - 30 * minuteMs });
    session.outstandingToolUseIds.add('toolu_running');
    adapter['sessions'].set(keyToString(key), session);
    inbox = createMidTurnInbox({ inboxDir: getMidTurnInboxDir(dataDir) });
    notes = createNotes(spyOnState(state));
    engine = buildEngine();
    stateCalls.length = 0;
  });

  afterEach(async () => {
    engine.stop();
    adapter['clearTimers'](session);
    for (const store of stores.splice(0)) await store.flush();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('L6 + L4 + L2: a mid-turn note read by the running turn moves nothing a lifecycle reader looks at — no stdin, no request, no stamp, no busy flag — and stamps only its own record', async () => {
    const before = takeLifecycleSnapshot();
    await engine.poll();
    assert.equal(fs.existsSync(path.join(getMidTurnInboxDir(dataDir), `${sessionId}.json`)), true, 'the note waits for the next tool call');
    assert.deepEqual(takeLifecycleSnapshot(), before, 'offered');
    assert.match(readAdditionalContext(runHook(getMidTurnInboxDir(dataDir))), /^\[Accounts · 14:05\]/, 'the tool call read it');
    assert.deepEqual(takeLifecycleSnapshot(), before, 'read');
    await engine.poll();
    assert.deepEqual(takeLifecycleSnapshot(), before, 'delivered');
    assert.equal(state.getLimitNoteRecord(key)?.lastNoteAt, nowMs, 'its own record is all that moved');
    assert.deepEqual(stdinWrites, [], 'never a write to the agent');
    assert.deepEqual([...new Set(stateCalls)].sort(), ['getLimitNoteRecord', 'setLimitNoteRecord'], 'the only state the notes and the engine ever reach');
  });

  it('a fresh context after the hook took the note: the withdrawal comes first and records it, then the reset clears the fingerprint — the reset is the last write', async () => {
    await engine.poll();
    runHook(getMidTurnInboxDir(dataDir));
    // The order of `clearThreadContextMarker` / `noteConversationContextReset` in the bot (`limitNotesWiring.test.ts` pins it).
    inbox.withdraw(key, 'accounts');
    state.clearLimitNoteFingerprint(key);
    assert.equal(state.getLimitNoteRecord(key)?.fingerprint, undefined, 'the agent holds no picture of the limits any more');
    assert.equal(state.getLimitNoteRecord(key)?.lastNoteAt, nowMs, 'the note it read is on the clock');
  });

  it('the reverse order — what the order guards against — leaves the cleared picture back on record', async () => {
    await engine.poll();
    runHook(getMidTurnInboxDir(dataDir));
    state.clearLimitNoteFingerprint(key);
    inbox.withdraw(key, 'accounts');
    assert.notEqual(state.getLimitNoteRecord(key)?.fingerprint, undefined);
  });

  it('L2: the poll over an idle, an asleep and a busy session stamps no activity, turn end, compaction or held mark — nor a request', async () => {
    const before = state.getCompactIdleTracking(key);
    session.isBusy = false;
    await engine.poll();
    session.isActive = false;
    await engine.poll();
    session.isActive = true;
    session.isBusy = true;
    await engine.poll();
    assert.deepEqual(state.getCompactIdleTracking(key), before);
    assert.equal(before.lastActivityAt > 0 && before.lastHeldMarkAt === 0, true, 'a real tracking entry was read, with no held mark');
    assert.deepEqual(state.getOpenRequests(), {});
    assert.deepEqual([...new Set(stateCalls)], ['getLimitNoteRecord'], 'it only read its record: nothing was delivered, nothing was written');
  });

  it('L4: an OpenCode conversation is never offered a mid-turn note: no note is worked out and nothing is written to any inbox or agent', async () => {
    backendName = openCodeAdapterName;
    await engine.poll();
    assert.equal(fs.existsSync(getMidTurnInboxDir(dataDir)), false);
    assert.deepEqual(stdinWrites, []);
    assert.deepEqual(state.getLimitNoteRecord(key), orchestrating(), 'its record is as it was');
  });

  it('L10: a deferred account switch fires at the turn end after a turn that got a mid-turn note and a send-result note', async () => {
    const respawns: Array<string | null | undefined> = [];
    adapter.setClaudeConfigDirReader(() => '/profiles/perf');
    adapter['respawnWithChange'] = async (_target, change) => { respawns.push(change.configDir); };
    assert.equal(await adapter.applyClaudeConfigDir(key), 'deferred', 'the turn runs: the switch waits for its end');
    await engine.poll();
    runHook(getMidTurnInboxDir(dataDir));
    await engine.poll();
    assert.equal(state.getLimitNoteRecord(key)?.lastNoteAt, nowMs, 'the mid-turn note was delivered');
    // A changed picture a later send result carries (the floor's 30 min are past: the last note was long ago in the record's clock).
    state.setLimitNoteRecord(key, orchestrating({ lastNoteAt: nowMs - 40 * minuteMs, fingerprint: 'rec=other' }));
    assert.ok(notes.takeSendResultNote(key) !== null, 'and a send-result note rode a tool result');
    assert.deepEqual(respawns, [], 'neither note ended the turn');
    adapter['onStdout'](session, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }) + '\n');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(respawns, ['/profiles/perf'], 'the switch fires at the turn end, as without any note');
  });
});

describe('L12: a restart', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-limit-restart-')); });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  it('clears every inbox file at boot, and the note record survives it: no reminder before the interval, the first one when it has passed', async () => {
    const first = new StateStore(dataDir, { saveDebounceMs: 10 });
    await first.init();
    first.setLimitNoteRecord(key, orchestrating({ lastNoteAt: nowMs - 10 * minuteMs }));
    const inboxDir = getMidTurnInboxDir(dataDir);
    const beforeRestart = createMidTurnInbox({ inboxDir });
    beforeRestart.offer(key, sessionId, 'accounts', { text: 'a note the old process wrote', onTaken: () => {} });
    fs.writeFileSync(path.join(inboxDir, 'left-by-an-ended-session.json'), '{}');
    await first.flush();

    // The new process: its inbox knows nothing, the dir still holds the old files, the state is read from disk.
    const second = new StateStore(dataDir, { saveDebounceMs: 10 });
    await second.init();
    try {
      createMidTurnInbox({ inboxDir }).clearAll();
      assert.equal(fs.existsSync(inboxDir), false, 'no inbox file is left for a session that is gone');
      let clockMs = nowMs;
      const notes = createLimitNotes({
        getRecord: (target) => second.getLimitNoteRecord(target),
        setRecord: (target, record) => second.setLimitNoteRecord(target, record),
        getIntervalMs: () => hourMs,
        getWindows: () => defaultLimitNoteWindows,
        getReport: () => buildReport(),
        getOpenCodeUsage: () => ({}),
        getTimezone: () => 'UTC',
        getBackendName: () => claudeJsonStreamAdapterName,
        getNowMs: () => clockMs,
        log: () => {},
      });
      assert.equal(notes.takeMidTurnNote(key), null, 'the last note was 10 min ago: a restart is no reason to remind');
      clockMs = nowMs + 51 * minuteMs;
      assert.ok(notes.takeMidTurnNote(key) !== null, 'the interval counts from the note on record');
    } finally {
      await second.flush();
    }
  });
});
