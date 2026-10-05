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

const topicKey: SessionKey = makeTelegramKey(-1001234567890, 42);
const topicKeyString = keyToString(topicKey);

interface ProbeScenario {
  isActive: boolean;
  isBusy: boolean;
  isTuiQuestionPending: boolean;
  isLoginPastePending: boolean;
  pendingQuestionKeys: Set<string>;
  questionPinKeys: Set<string>;
  compactingKeys: Set<string>;
  apiRetryTimers: Map<string, NodeJS.Timeout | null>;
  wedgeRecoveryKeys: Set<string>;
  retryKickKeys: Set<string>;
  startingKeys: Set<string>;
  hasUnconsumedInput: boolean | undefined;
}

let scenario: ProbeScenario;

function createProbe(): ReturnType<typeof createSessionTurnProbe> {
  const deps: SessionTurnProbeDeps = {
    getAdapter: () => ({
      checkIsActive: () => scenario.isActive,
      checkIsBusy: () => scenario.isBusy,
      isQuestionPending: () => scenario.isTuiQuestionPending,
      isLoginPastePending: () => scenario.isLoginPastePending,
      ...(scenario.hasUnconsumedInput === undefined ? {} : { checkHasUnconsumedInput: () => scenario.hasUnconsumedInput === true }),
    }),
    checkHasPendingQuestion: (keyString) => scenario.pendingQuestionKeys.has(keyString),
    checkHasQuestionPin: (keyString) => scenario.questionPinKeys.has(keyString),
    checkIsCompacting: (keyString) => scenario.compactingKeys.has(keyString),
    getApiRetryTimer: (keyString) => scenario.apiRetryTimers.get(keyString),
    checkIsWedgeRecoveryInFlight: (keyString) => scenario.wedgeRecoveryKeys.has(keyString),
    checkIsRetryKickInFlight: (keyString) => scenario.retryKickKeys.has(keyString),
    checkIsSessionStarting: (keyString) => scenario.startingKeys.has(keyString),
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
    pendingQuestionKeys: new Set(),
    questionPinKeys: new Set(),
    compactingKeys: new Set(),
    apiRetryTimers: new Map(),
    wedgeRecoveryKeys: new Set(),
    retryKickKeys: new Set(),
    startingKeys: new Set(),
    hasUnconsumedInput: undefined,
  };
});

describe('createSessionTurnProbe', () => {
  it('an idle session with nothing pending is a possible turn end', () => {
    assert.deepEqual(createProbe()(topicKey), {
      isActive: true,
      isBusy: false,
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
});

