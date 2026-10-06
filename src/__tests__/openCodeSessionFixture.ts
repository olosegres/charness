/**
 * @description A complete, idle `OpenCodeSession` for adapter tests, so a test names only the fields it cares
 * about and the compiler checks the rest: when the product adds a required field, this one file stops compiling
 * instead of every test silently running against a half-built session. The defaults are the idle state a
 * session has right after `startSession` / `resumeSession` (the product builds it inline in both).
 *
 * Matches neither runner glob; imported by the OpenCode adapter tests.
 */

import assert from 'node:assert/strict';

import { type OpenCodeAdapter, type OpenCodeSession } from '../adapters/openCodeAdapter';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

/** @description Build an `OpenCodeSession`; `overrides` win over the idle defaults. */
export function createOpenCodeSessionFixture(overrides: Partial<OpenCodeSession> = {}): OpenCodeSession {
  return {
    key: makeTelegramKey(-100999555, 1),
    sessionId: 'ses_fixture',
    workDir: '/tmp/opencode-fixture-work',
    isActive: true,
    currentResponseText: '',
    lastEmittedLength: 0,
    outputTimer: null,
    childResponseText: '',
    childLastEmittedLength: 0,
    childOutputTimer: null,
    activeSubagentTitle: null,
    isModelInfoShown: false,
    modelOverride: null,
    currentModelLabel: null,
    latestParentRuntimeContext: null,
    parentAssistantObservationVersion: 0,
    partTypes: new Map(),
    statusDebounceTimer: null,
    pendingStatus: null,
    reasoningText: '',
    reasoningStartedAt: null,
    reasoningTimer: null,
    emittedToolResultPartIds: new Set(),
    pendingQuestion: null,
    effortLevel: null,
    isBusy: false,
    awaitingTurnResponse: false,
    sawTurnActivity: false,
    unconsumedInputCount: 0,
    seenUserMessageIds: new Set(),
    providerRetrySignature: null,
    isAwaitingModelAfterProviderRetryAbort: false,
    isAwaitingProviderRetryAbortIdle: false,
    isAwaitingProviderRetryReplacementStart: false,
    providerRetryReplacementStartTimer: null,
    providerRetryAbortPromise: null,
    isCompacting: false,
    busyChildSessionIds: new Set(),
    lastMessageId: undefined,
    isAutoNamePending: false,
    ...overrides,
  };
}

/** @description The session the adapter holds under `sessionKey` (a serialised `SessionKey`); fails the test when there is none. */
export function getOpenCodeSession(adapter: OpenCodeAdapter, sessionKey: string): OpenCodeSession {
  const session = adapter['sessions'].get(sessionKey);
  assert.ok(session, `the adapter holds no session for ${sessionKey}`);
  return session;
}
