/**
 * @description A turn the CLI starts BY ITSELF (a `CronCreate` job, a `ScheduleWakeup` wakeup, a finished background task's
 * notification) must not count as taking in a message of ours — nor as an echo that matched nothing — or the unconsumed-input
 * accounting would drop a real message queued behind it (`utils/jsonStreamUnconsumedInput.ts`: the review that asked for a live
 * probe of exactly this). The frames are the ones the real CLI 2.1.329 wrote in that probe
 * (`claudeSelfStartedTurnFrames.ts`): such a turn writes no `user` line for its prompt at all, so nothing of it passes
 * `checkIsOwnInputEcho`. Proven here against the recorded shapes:
 *
 *   - the only `userEcho` of a whole recorded scenario is the echo of the bot's own message;
 *   - replayed through the adapter, the message is taken in exactly once, no entry is ever marked as the target of an unmatched
 *     echo, and a notification turn's end leaves the message behind it counted until its own echo — a reader that decides at that
 *     turn end (the claude-per-turn stop, a deferred account switch) still sees it.
 *
 * The matching and marking rules themselves are `claudeJsonStreamMergedInput.test.ts`'s and `jsonStreamUnconsumedInput.test.ts`'s.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeJsonStreamAdapter, type StreamSession } from '../adapters/claudeJsonStreamAdapter';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { classifyClaudeStreamMessage } from '../utils/claudeStreamJson';
import { createStreamSessionFixture } from './claudeJsonStreamSessionFixture';
import { queuedMessageText, recordedCronTurn, recordedNotificationTurn, recordedWakeupTurn, type RecordedStep } from './claudeSelfStartedTurnFrames';

const key: SessionKey = makeTelegramKey(-100999444, 80);

const scenarios: ReadonlyArray<{ name: string; steps: readonly RecordedStep[] }> = [
  { name: 'a one-shot CronCreate job fires', steps: recordedCronTurn },
  { name: 'a ScheduleWakeup wakeup fires', steps: recordedWakeupTurn },
  { name: 'a finished background task\'s notification starts a turn', steps: recordedNotificationTurn },
];

const created: Array<{ adapter: ClaudeJsonStreamAdapter; session: StreamSession }> = [];

afterEach(() => {
  for (const { adapter, session } of created.splice(0)) adapter['clearTimers'](session);
});

/** What a reader that decides at a turn end sees, per turn end: `checkIsWorking`, and the messages still listed. */
interface TurnEndView {
  isWorking: boolean;
  listed: string[];
}

/** Replay a recorded scenario through a fresh adapter; resolves what the turn-end readers saw and the marks ever set. */
async function replay(steps: readonly RecordedStep[]): Promise<{ turnEnds: TurnEndView[]; wasEverMarked: boolean; session: StreamSession; adapter: ClaudeJsonStreamAdapter }> {
  const adapter = new ClaudeJsonStreamAdapter({ lifecycle: 'idle', writeFifo: async () => {} });
  const session = createStreamSessionFixture({ key, pid: process.pid, sessionId: 'session-recorded' });
  adapter['sessions'].set(keyToString(key), session);
  created.push({ adapter, session });
  const turnEnds: TurnEndView[] = [];
  adapter.on('turnEnded', () => { turnEnds.push({ isWorking: adapter.checkIsWorking(key), listed: session.unconsumedInputs.map((pending) => pending.text) }); });
  let wasEverMarked = false;
  for (const step of steps) {
    if ('write' in step) await adapter.sendInputAndWait(key, step.write);
    else adapter['onStdout'](session, JSON.stringify(step.line) + '\n');
    if (session.unconsumedInputs.some((pending) => pending.hasUnmatchedEcho)) wasEverMarked = true;
  }
  return { turnEnds, wasEverMarked, session, adapter };
}

describe('turns the CLI starts by itself — recorded on the real CLI 2.1.329', () => {
  for (const { name, steps } of scenarios) {
    it(`${name}: the turn writes no user line of its own — the only echo in the whole sequence is the bot's message`, () => {
      const echoes = steps.flatMap((step) => ('line' in step ? classifyClaudeStreamMessage(step.line) : [])).filter((action) => action.kind === 'userEcho');
      assert.deepEqual(echoes, [{ kind: 'userEcho', text: queuedMessageText }]);
    });
  }

  for (const { name, steps } of scenarios) {
    it(`${name}: replayed through the adapter, the message is taken in once, nothing is marked as an unmatched echo, and nothing is left counted`, async () => {
      const { wasEverMarked, session, adapter } = await replay(steps);
      assert.equal(wasEverMarked, false, 'no line of the self-started turn is an echo of ours that matched nothing');
      assert.deepEqual(session.unconsumedInputs, []);
      assert.equal(adapter.checkIsWorking(key), false);
    });
  }

  it('a message queued behind a notification turn is still counted at that turn\'s end — the readers that decide there are held off until its own turn takes it in', async () => {
    const { turnEnds } = await replay(recordedNotificationTurn);
    assert.deepEqual(turnEnds, [
      { isWorking: true, listed: [queuedMessageText] },
      { isWorking: false, listed: [] },
    ]);
  });

  it('a cron or wakeup turn that takes the message in at its tool boundary leaves nothing counted at its end', async () => {
    for (const steps of [recordedCronTurn, recordedWakeupTurn]) {
      const { turnEnds } = await replay(steps);
      assert.deepEqual(turnEnds, [{ isWorking: false, listed: [] }]);
    }
  });
});
