/**
 * @description A complete, idle json-stream `StreamSession` for adapter tests, so a test names only the fields it
 * cares about and the compiler checks the rest: when the product adds a required field, this one file stops
 * compiling instead of every test silently running against a half-built session.
 *
 * The defaults are the state a session has right after spawn, with the process-facing fields made inert:
 * `pid` is a reaped child's (certainly dead, so no code path can signal a live process) and `fifoFd` is `-1`
 * (`closeFifo` tolerates it). A test that needs a live host passes `paths` / `pid` / `fifoFd` itself.
 *
 * Matches neither runner glob; imported by the json-stream adapter tests.
 */

import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

import { type StreamSession } from '../adapters/claudeJsonStreamAdapter';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { ClaudeStreamLineReader } from '../utils/claudeStreamJson';
import { createStdoutTailState, getJsonStreamSessionPaths } from '../utils/jsonStreamHost';

/** A pid that is certainly dead: a reaped short-lived child of ours. */
export function getDeadPid(): number {
  const child = spawnSync('true');
  return child.pid ?? 1;
}

/** @description Build a `StreamSession`; `overrides` win over the post-spawn defaults. */
export function createStreamSessionFixture(overrides: Partial<StreamSession> = {}): StreamSession {
  return {
    key: makeTelegramKey(-100999777, 55),
    workDir: '/tmp/jsonstream-fixture-work',
    sessionId: 'sess-fixture',
    pid: getDeadPid(),
    paths: getJsonStreamSessionPaths(path.join(os.tmpdir(), 'jsonstream-fixture-nonexistent')),
    fifoFd: -1,
    stdinWriteChain: Promise.resolve(),
    tail: createStdoutTailState(0),
    pollTimer: null,
    pollDelayMs: 300,
    unchangedStreak: 0,
    isOversizeWarned: false,
    lastPersistedTailOffset: 0,
    reader: new ClaudeStreamLineReader(),
    isActive: true,
    isStopping: false,
    isSuspending: false,
    isRespawning: false,
    isBusy: false,
    lastStdoutActivityAt: Date.now(),
    outstandingToolUseIds: new Set(),
    model: null,
    reportedModel: null,
    effort: null,
    currentResponseText: '',
    emittedLength: 0,
    outputTimer: null,
    reasoningText: '',
    reasoningStartedAt: null,
    reasoningTimer: null,
    reasoningActive: false,
    toolNamesById: new Map(),
    questionToolUseIds: new Set(),
    subagentActive: false,
    childResponseText: '',
    childEmittedLength: 0,
    childOutputTimer: null,
    pendingInitResolve: null,
    initRequestId: null,
    pendingControlRequests: new Map(),
    compactionInProgress: false,
    pendingCompaction: null,
    pendingQuestion: null,
    apiErrorFired: false,
    swallowNextAbortError: false,
    lastWatermarkOffset: -1,
    unconsumedInputCount: 0,
    backgroundTaskIds: new Set(),
    claudeCodeVersion: null,
    applyingChunk: null,
    adoptCatchUpOffset: null,
    adoptCatchUpResolvers: [],
    ...overrides,
  };
}
