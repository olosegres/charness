/**
 * @description The session probe the wake-up engine polls
 * (`requests/sessionTurnProbe.ts`, request/answer core S4): every "not a turn
 * end" input it reads off the bot's state and the adapter.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { createSessionTurnProbe, type SessionTurnProbeDeps } from '../requests/sessionTurnProbe';
import { unnumberedProcessGeneration } from '../types';
import type { BackgroundWorkSignal } from '../utils/workingSignals';

const topicKey: SessionKey = makeTelegramKey(-1001234567890, 42);
const topicKeyString = keyToString(topicKey);

interface ProbeScenario {
  isActive: boolean;
  isBusy: boolean;
  isTuiQuestionPending: boolean;
  isLoginPastePending: boolean;
  isRespawnPending: boolean;
  isTurnOnItsWay: boolean;
  isCliOwnTurn: boolean;
  pendingQuestionKeys: Set<string>;
  questionPinKeys: Set<string>;
  compactingKeys: Set<string>;
  apiRetryTimers: Map<string, NodeJS.Timeout | null>;
  wedgeRecoveryKeys: Set<string>;
  retryKickKeys: Set<string>;
  apiErrorKeys: Set<string>;
  startingKeys: Set<string>;
  replayingKeys: Set<string>;
  hasUnconsumedInput: boolean | undefined;
  /** What the adapter's `getProcessGeneration` answers; `undefined`: an adapter without it. */
  processGeneration: number | undefined;
  /** What the adapter names beside its running turn; `undefined`: an adapter without the signal. */
  backgroundSignals: BackgroundWorkSignal[] | undefined;
}

let scenario: ProbeScenario;

function createProbe(): ReturnType<typeof createSessionTurnProbe> {
  const deps: SessionTurnProbeDeps = {
    getAdapter: () => ({
      checkIsActive: () => scenario.isActive,
      checkIsBusy: () => scenario.isBusy,
      isQuestionPending: () => scenario.isTuiQuestionPending,
      isLoginPastePending: () => scenario.isLoginPastePending,
      checkIsRespawnPending: () => scenario.isRespawnPending,
      checkIsTurnOnItsWay: () => scenario.isTurnOnItsWay,
      checkIsCliOwnTurn: () => scenario.isCliOwnTurn,
      ...(scenario.hasUnconsumedInput === undefined ? {} : { checkHasUnconsumedInput: () => scenario.hasUnconsumedInput === true }),
      ...(scenario.processGeneration === undefined ? {} : { getProcessGeneration: () => scenario.processGeneration }),
      ...(scenario.backgroundSignals === undefined ? {} : { getBackgroundWorkSignals: () => scenario.backgroundSignals ?? [] }),
    }),
    checkHasPendingQuestion: (keyString) => scenario.pendingQuestionKeys.has(keyString),
    checkHasQuestionPin: (keyString) => scenario.questionPinKeys.has(keyString),
    checkIsCompacting: (keyString) => scenario.compactingKeys.has(keyString),
    getApiRetryTimer: (keyString) => scenario.apiRetryTimers.get(keyString),
    checkIsWedgeRecoveryInFlight: (keyString) => scenario.wedgeRecoveryKeys.has(keyString),
    checkIsRetryKickInFlight: (keyString) => scenario.retryKickKeys.has(keyString),
    checkIsApiErrorInHandling: (keyString) => scenario.apiErrorKeys.has(keyString),
    checkIsSessionStarting: (keyString) => scenario.startingKeys.has(keyString),
    checkIsReplayingBufferedPrompts: (keyString) => scenario.replayingKeys.has(keyString),
    serializeKey: keyToString,
  };
  return createSessionTurnProbe(deps);
}

beforeEach(() => {
  scenario = {
    isActive: true,
    isBusy: false,
    isTuiQuestionPending: false,
    isLoginPastePending: false,
    isRespawnPending: false,
    isTurnOnItsWay: false,
    isCliOwnTurn: false,
    pendingQuestionKeys: new Set(),
    questionPinKeys: new Set(),
    compactingKeys: new Set(),
    apiRetryTimers: new Map(),
    wedgeRecoveryKeys: new Set(),
    retryKickKeys: new Set(),
    apiErrorKeys: new Set(),
    startingKeys: new Set(),
    replayingKeys: new Set(),
    hasUnconsumedInput: undefined,
    processGeneration: undefined,
    backgroundSignals: undefined,
  };
});

describe('createSessionTurnProbe', () => {
  it('an idle session with nothing pending is a possible turn end', () => {
    assert.deepEqual(createProbe()(topicKey), {
      isActive: true,
      isBusy: false,
      processGeneration: unnumberedProcessGeneration,
      hasUnconsumedInput: null,
      isTurnEndBlocked: false,
    });
  });

  it('only a retry or limit wait that is still ARMED holds the turn', () => {
    const armedTimer = setTimeout(() => {}, 60_000);
    try {
      scenario.apiRetryTimers.set(topicKeyString, null); // fired: kept only for its grace window
      assert.equal(createProbe()(topicKey).isTurnEndBlocked, false, 'a fired retry is history');

      scenario.apiRetryTimers.set(topicKeyString, armedTimer);
      assert.equal(createProbe()(topicKey).isTurnEndBlocked, true);
    } finally {
      clearTimeout(armedTimer);
    }
  });

  it('a TUI question or login code prompt the adapter reads off the pane holds the turn without a pin', () => {
    scenario.isTuiQuestionPending = true;
    assert.equal(createProbe()(topicKey).isTurnEndBlocked, true, 'TUI selector, pin failed');

    scenario.isTuiQuestionPending = false;
    scenario.isLoginPastePending = true;
    assert.equal(createProbe()(topicKey).isTurnEndBlocked, true, 'login code prompt');
  });

  it('a pending question, a question pin or a compaction hold the turn', () => {
    for (const keys of ['pendingQuestionKeys', 'questionPinKeys', 'compactingKeys'] as const) {
      scenario[keys].add(topicKeyString);
      assert.equal(createProbe()(topicKey).isTurnEndBlocked, true, keys);
      scenario[keys].delete(topicKeyString);
    }
  });

  it('a wedge recovery under way holds the turn: its replay is the recovery, not a reminder', () => {
    scenario.wedgeRecoveryKeys.add(topicKeyString);
    assert.equal(createProbe()(topicKey).isTurnEndBlocked, true);
  });

  it('a retry whose timer fired but whose nudge is not forwarded yet still holds the turn', () => {
    scenario.apiRetryTimers.set(topicKeyString, null);
    scenario.retryKickKeys.add(topicKeyString);
    assert.equal(createProbe()(topicKey).isTurnEndBlocked, true);
  });

  it('a session still starting has not taken in what was forwarded — its prompt waits in the startup buffer (R21)', () => {
    // An active backend with nothing unread: without the startup check this read as "taken in".
    scenario.hasUnconsumedInput = false;
    scenario.startingKeys.add(topicKeyString);
    assert.equal(createProbe()(topicKey).hasUnconsumedInput, true, 'json-stream: active right after spawn, prompt still buffered');
    scenario.hasUnconsumedInput = undefined;
    assert.equal(createProbe()(topicKey).hasUnconsumedInput, true, 'a backend without the signal');

    scenario.startingKeys.delete(topicKeyString);
    assert.equal(createProbe()(topicKey).hasUnconsumedInput, null, 'started: the backend\'s own signal again');
    scenario.hasUnconsumedInput = false;
    assert.equal(createProbe()(topicKey).hasUnconsumedInput, false);
  });

  it('a session START under way holds the turn: the request whose first post is starting it is not one nobody works on', () => {
    scenario.isActive = false; // the session is not up yet — its start is the work being done
    scenario.startingKeys.add(topicKeyString);
    assert.equal(createProbe()(topicKey).isTurnEndBlocked, true);

    scenario.startingKeys.delete(topicKeyString);
    assert.equal(createProbe()(topicKey).isTurnEndBlocked, false, 'started or failed: nothing holds it any more');
  });

  it('the replay of the prompts buffered during the start is still the start: the turn end is held and the input reads unconsumed, whatever the adapter says (review 15 #1)', () => {
    // The window is closed before the first replayed write, and a fresh session reports nothing unread: without this every watch made
    // while the session started read `ended` at the replay's first write, and was decided as a silent turn the agent never had.
    scenario.hasUnconsumedInput = false;
    scenario.replayingKeys.add(topicKeyString);
    const probe = createProbe()(topicKey);
    assert.equal(probe.isTurnEndBlocked, true);
    assert.equal(probe.hasUnconsumedInput, true);
    scenario.replayingKeys.delete(topicKeyString);
    assert.equal(createProbe()(topicKey).isTurnEndBlocked, false, 'the replay over: the adapter decides again');
    assert.equal(createProbe()(topicKey).hasUnconsumedInput, false);
  });

  it('an API error the bot still handles with nothing armed holds the turn — «wait for reset» off, a used-up balance, an account refusal: the turn that ended on it is no silent one until the stop, move or wait has landed (review 16 #1)', () => {
    // The error result also empties the adapter's queue of inputs: without the hold the turn reads ended with everything taken in.
    scenario.hasUnconsumedInput = false;
    scenario.apiErrorKeys.add(topicKeyString);
    assert.equal(createProbe()(topicKey).isTurnEndBlocked, true);
    scenario.apiErrorKeys.add(keyToString(makeTelegramKey(-1001234567890, 43)));
    scenario.apiErrorKeys.delete(topicKeyString);
    assert.equal(createProbe()(topicKey).isTurnEndBlocked, false, 'handled — and another thread\'s error holds nothing here');
  });

  it('a re-spawn under way or about to start (a deferred account switch at the turn\'s end) holds the turn — also while the process is down for it, which is not a gone session: no reminder may start a second launch beside it (report 6, not fixed 2)', () => {
    scenario.isRespawnPending = true;
    assert.equal(createProbe()(topicKey).isTurnEndBlocked, true);
    scenario.isActive = false;
    const respawning = createProbe()(topicKey);
    assert.equal(respawning.isActive, false);
    assert.equal(respawning.isTurnEndBlocked, true, 'held, so the watch reads `running`, not `sessionGone`');
    scenario.isActive = true;
    scenario.isRespawnPending = false;
    assert.equal(createProbe()(topicKey).isTurnEndBlocked, false, 're-spawned: the new process decides');
  });

  it('a finished task\'s own turn on its way reads BUSY — a watched turn runs on into it — and only for a live session (review 17 #2)', () => {
    scenario.isTurnOnItsWay = true;
    assert.equal(createProbe()(topicKey).isBusy, true);
    assert.equal(createProbe()(topicKey).isTurnEndBlocked, false, 'busy, not held: the sweep still sees a busy session');
    scenario.isActive = false;
    assert.equal(createProbe()(topicKey).isBusy, false);
  });

  it('a turn the CLI started by itself is named only while the session is busy — its busy time is no request\'s activity (review 17 #4)', () => {
    scenario.isCliOwnTurn = true;
    assert.equal(createProbe()(topicKey).isCliOwnTurn, undefined, 'not busy: nothing runs');
    scenario.isBusy = true;
    assert.equal(createProbe()(topicKey).isCliOwnTurn, true);
    scenario.isCliOwnTurn = false;
    assert.equal(createProbe()(topicKey).isCliOwnTurn, undefined, 'the bot\'s turn');
  });

  it('names the live process a prompt written now goes to — during the replay of a start\'s buffer too — and none while a start\'s or a stop\'s window is open or with no live process (review 18 #2); a backend that cannot number its processes is named `unnumberedProcessGeneration`, never nothing (review 21 #1 b)', () => {
    assert.equal(createProbe()(topicKey).processGeneration, unnumberedProcessGeneration, 'a backend without process numbers: a prompt written there is named');
    scenario.processGeneration = 7;
    assert.equal(createProbe()(topicKey).processGeneration, 7);
    scenario.startingKeys.add(topicKeyString);
    assert.equal(createProbe()(topicKey).processGeneration, undefined, 'a window is open: a prompt forwarded now waits in the buffer');
    scenario.startingKeys.delete(topicKeyString);
    scenario.replayingKeys.add(topicKeyString);
    assert.equal(createProbe()(topicKey).processGeneration, 7, 'the replay writes into the process the start brought up');
    scenario.replayingKeys.delete(topicKeyString);
    scenario.isActive = false;
    assert.equal(createProbe()(topicKey).processGeneration, undefined, 'no live process');
    scenario.processGeneration = undefined;
    assert.equal(createProbe()(topicKey).processGeneration, undefined, 'no live process on a backend without numbers either');
    scenario.isActive = true;
    scenario.startingKeys.add(topicKeyString);
    assert.equal(createProbe()(topicKey).processGeneration, undefined, 'its window open: none');
    assert.equal(createProbe()(topicKey).isWindowOpen, true, 'and it says a window holds what is forwarded now (review 22 nit 2)');
    scenario.startingKeys.delete(topicKeyString);
    assert.equal(createProbe()(topicKey).isWindowOpen, undefined, 'no window: absent');
  });

  it('another thread\'s start never holds this one', () => {
    scenario.startingKeys.add(keyToString(makeTelegramKey(-1001234567890, 43)));
    assert.equal(createProbe()(topicKey).isTurnEndBlocked, false);
  });

  it('busy is reported only for an active session', () => {
    scenario.isBusy = true;
    assert.equal(createProbe()(topicKey).isBusy, true);
    scenario.isActive = false;
    assert.equal(createProbe()(topicKey).isBusy, false);
  });

  it('another thread\'s state never blocks this one', () => {
    const otherKeyString = keyToString(makeTelegramKey(-1001234567890, 43));
    scenario.pendingQuestionKeys.add(otherKeyString);
    scenario.wedgeRecoveryKeys.add(otherKeyString);
    assert.equal(createProbe()(topicKey).isTurnEndBlocked, false);
  });

  it('the agent\'s own pending work is a background command or sub-agent, a session job or a finished task\'s turn on its way — never unread input or a compaction, and only of a live session', () => {
    // What a tracker's rules do with it: src/__tests__/wakeUpRules.test.ts › "a tracker\'s rules"; at process level jiraRequestWakeE2e.
    for (const signal of [{ kind: 'backgroundTasks', count: 1 }, { kind: 'scheduledJobs', count: 1 }, { kind: 'taskTurnOnItsWay' }] as const) {
      scenario.backgroundSignals = [signal];
      assert.equal(createProbe()(topicKey).hasOwnPendingWork, true, signal.kind);
    }
    scenario.backgroundSignals = [{ kind: 'unconsumedInput', count: 1 }, { kind: 'compaction' }];
    assert.equal(createProbe()(topicKey).hasOwnPendingWork, undefined, 'what the turn fields already cover');
    scenario.backgroundSignals = [{ kind: 'backgroundTasks', count: 1 }];
    scenario.isActive = false;
    assert.equal(createProbe()(topicKey).hasOwnPendingWork, undefined, 'a gone session waits on nothing');
  });
});
