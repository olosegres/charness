/**
 * @description The session probe the wake-up engine polls
 * (`requests/sessionTurnProbe.ts`, request/answer core S4): every "not a turn
 * end" input it reads off the bot's state and the adapter.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

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
}

let scenario: ProbeScenario;

function createProbe(): ReturnType<typeof createSessionTurnProbe> {
  const deps: SessionTurnProbeDeps = {
    getAdapter: () => ({
      checkIsActive: () => scenario.isActive,
      checkIsBusy: () => scenario.isBusy,
      isQuestionPending: () => scenario.isTuiQuestionPending,
      isLoginPastePending: () => scenario.isLoginPastePending,
    }),
    checkHasPendingQuestion: (keyString) => scenario.pendingQuestionKeys.has(keyString),
    checkHasQuestionPin: (keyString) => scenario.questionPinKeys.has(keyString),
    checkIsCompacting: (keyString) => scenario.compactingKeys.has(keyString),
    getApiRetryTimer: (keyString) => scenario.apiRetryTimers.get(keyString),
    checkIsWedgeRecoveryInFlight: (keyString) => scenario.wedgeRecoveryKeys.has(keyString),
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

