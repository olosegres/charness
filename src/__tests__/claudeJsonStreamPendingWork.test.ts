/**
 * @description The json-stream adapter's "working" judgement around the agent's OWN pending work: background tasks
 * (background Bash / Monitor / sub-agent), the turn a finished task starts, and session-only `CronCreate` jobs.
 *
 * The frame order is the one MEASURED on the real CLI (2.1.310, `sleep 10` run in the background, stdout timestamped):
 *
 *   result → … → task_updated → task_notification → background_tasks_changed [] → (+72 ms) session_state_changed running
 *   → (+125 ms) init → (+1.3 s, 3–5 s on a large context) the turn's first output
 *
 * The incident: the bot read the gap after `background_tasks_changed []` as idle and stopped the process right as the
 * task's own turn began, losing the task's result. Load-bearing intent:
 * - a task's notification holds the process until its turn shows (bounded by a grace), a foreground one does not;
 * - the turn's start (`init`, `session_state_changed running`, a `CronCreate` job firing) marks the session busy;
 * - pending work holds the process only for a bounded time after the last turn (the hold), never forever;
 * - a session-only `CronCreate` job is pending work until it is cancelled or (one-shot) fires;
 * - all of it rides the persisted tail record, so an adopt restores it;
 * - `refreshWorkingState` reads what the process wrote since the last poll, so a stop decides on current state.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ClaudeJsonStreamAdapter, type StreamSession } from '../adapters/claudeJsonStreamAdapter';
import { getJsonStreamSessionPaths, resolveAdoptedTail } from '../utils/jsonStreamHost';
import { notificationTurnGraceMs } from '../utils/jsonStreamPendingWork';
import { type JsonStreamTailOffset } from '../types';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { createStreamSessionFixture } from './claudeJsonStreamSessionFixture';

const key: SessionKey = makeTelegramKey(-100999777, 57);
const backgroundTaskId = 'b4qu6cqpx';
const backgroundTaskDescription = 'Watch the test run';
const holdMs = 60_000;

function toLine(frame: Record<string, unknown>): string {
  return JSON.stringify(frame) + '\n';
}

const resultLine = toLine({ type: 'result', subtype: 'success', is_error: false, result: 'OK' });
const backgroundStartedLines =
  toLine({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: backgroundTaskId, task_type: 'local_bash', description: backgroundTaskDescription }] })
  + toLine({ type: 'system', subtype: 'task_started', task_id: backgroundTaskId, is_backgrounded: true, task_type: 'local_bash', description: backgroundTaskDescription });
/** What the CLI writes when the background task ends — up to (not including) its own turn's start. */
const backgroundFinishedLines =
  toLine({ type: 'system', subtype: 'task_updated', task_id: backgroundTaskId, patch: { status: 'completed' } })
  + toLine({ type: 'system', subtype: 'task_notification', task_id: backgroundTaskId, status: 'completed', output_file: '/tmp/claude-1000/-home-user-project/tasks/b4qu6cqpx.output', summary: 'Background command "Watch the test run" completed (exit code 0)' })
  + toLine({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
const sessionRunningLine = toLine({ type: 'system', subtype: 'session_state_changed', state: 'running' });
const initLine = toLine({ type: 'system', subtype: 'init', session_id: 'sess-pending', claude_code_version: '2.1.310' });

describe('json-stream pending work — the agent\'s own background tasks and scheduled jobs', () => {
  let dir: string;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  function createAdapterWithSession(overrides: Partial<StreamSession> = {}): { adapter: ClaudeJsonStreamAdapter; session: StreamSession; append: (text: string) => void } {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-pending-'));
    const adapter = new ClaudeJsonStreamAdapter({ lifecycle: 'idle', backgroundHoldMs: holdMs });
    const session = createStreamSessionFixture({ key, sessionId: 'sess-pending', paths: getJsonStreamSessionPaths(dir), ...overrides });
    adapter['sessions'].set(keyToString(key), session);
    fs.writeFileSync(session.paths.stdoutFile, '');
    const append = (text: string): void => {
      fs.appendFileSync(session.paths.stdoutFile, text);
      adapter['drainStdoutTail'](session);
    };
    return { adapter, session, append };
  }

  it('the gap between a background task\'s end and its own turn is working, not idle (the incident)', () => {
    const { adapter, append } = createAdapterWithSession();
    append(resultLine + backgroundStartedLines);
    assert.equal(adapter.checkIsWorking(key), true, 'the running background task holds the process');

    append(backgroundFinishedLines);
    assert.equal(adapter.checkIsBusy(key), false, 'no output of the task\'s turn yet');
    assert.equal(adapter.checkIsWorking(key), true, 'the task\'s notification says its turn is coming: still working');
    assert.equal(adapter.checkHasBackgroundWork(key), true);

    append(sessionRunningLine);
    assert.equal(adapter.checkIsBusy(key), true, 'the CLI\'s running state marks the turn at its start');
  });

  it('init alone marks the turn (a CLI without session-state events), and the result ends both', () => {
    const { adapter, append } = createAdapterWithSession();
    append(resultLine + backgroundStartedLines + backgroundFinishedLines + initLine);
    assert.equal(adapter.checkIsBusy(key), true, 'init starts the turn');
    append(resultLine);
    assert.equal(adapter.checkIsBusy(key), false);
    assert.equal(adapter.checkIsWorking(key), false, 'the turn ended and nothing else is pending');
  });

  it('a notification whose turn never shows holds only for the grace', () => {
    const { adapter, session, append } = createAdapterWithSession();
    append(resultLine + backgroundStartedLines + backgroundFinishedLines);
    assert.equal(adapter.checkIsWorking(key), true);
    assert.ok(session.notificationTurnPendingSince !== null);
    session.notificationTurnPendingSince = Date.now() - notificationTurnGraceMs - 1;
    assert.equal(adapter.checkIsWorking(key), false, 'past the grace the pending notification no longer counts');
  });

  it('a foreground task\'s notification (never in the background list) holds nothing', () => {
    const { adapter, append } = createAdapterWithSession();
    append(toLine({ type: 'system', subtype: 'task_started', task_id: 'fg1', is_backgrounded: false, task_type: 'local_bash' })
      + toLine({ type: 'system', subtype: 'task_notification', task_id: 'fg1', status: 'completed', output_file: '' })
      + resultLine);
    assert.equal(adapter.checkIsWorking(key), false);
  });

  it('pending work holds only within the hold after the last turn; the remainder is reported', () => {
    const { adapter, session, append } = createAdapterWithSession();
    append(resultLine + backgroundStartedLines);
    const remainingMs = adapter.getPendingWorkHoldRemainingMs(key);
    assert.ok(remainingMs !== null && remainingMs > holdMs - 5_000 && remainingMs <= holdMs, `remaining ${remainingMs}`);
    session.lastTurnEndedAt = Date.now() - holdMs - 1;
    assert.equal(adapter.checkIsWorking(key), false, 'a task nobody heard from within the hold no longer pins the process');
    assert.equal(adapter.getPendingWorkHoldRemainingMs(key), 0);
    session.backgroundTasks.clear();
    assert.equal(adapter.getPendingWorkHoldRemainingMs(key), null, 'nothing pending → no hold');
  });

  it('a bot-issued compaction\'s turn does not restart the hold: only the agent\'s own turns do', () => {
    const { adapter, session, append } = createAdapterWithSession();
    append(resultLine + backgroundStartedLines);
    session.lastTurnEndedAt = Date.now() - holdMs - 1;
    // As `compactContext` leaves it: the compaction settled on its boundary frame, its result still to come.
    session.isCompactionResultPending = true;
    append(toLine({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 100, post_tokens: 10 } }) + resultLine);
    assert.ok(Date.now() - session.lastTurnEndedAt > holdMs, 'the compaction turn left the hold where it was');
    assert.equal(adapter.checkIsWorking(key), false, 'the spent hold stays spent: the idle stop can follow the compaction');
  });

  it('a session-only CronCreate job is pending work until it fires (one-shot) or is cancelled (recurring)', () => {
    const { adapter, append } = createAdapterWithSession();
    const toolUse = (id: string, name: string, input: Record<string, unknown>): string =>
      toLine({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
    const toolResult = (id: string, text: string): string =>
      toLine({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
    append(toolUse('t1', 'CronCreate', { cron: '20 11 24 10 *', recurring: false, prompt: 'check' })
      + toolResult('t1', 'Scheduled one-shot task 59151bd3 (20 11 24 10 *). Next run: Oct 24 11:20am. Session-only (not written to disk, dies when Claude exits). It will fire once then auto-delete.')
      + toolUse('t2', 'CronCreate', { cron: '17 */3 * * *', recurring: true, prompt: 'check' })
      + toolResult('t2', 'Scheduled recurring job 99a38c99 (Every 3 hours at :17). Next run: Oct 24 12:47pm. Session-only (not written to disk, dies when Claude exits). Auto-expires after 7 days. Use CronDelete to cancel sooner.')
      + resultLine);
    assert.deepEqual([...adapter['sessions'].get(keyToString(key))!.scheduledJobs.keys()], ['59151bd3', '99a38c99']);
    assert.equal(adapter.checkIsWorking(key), true, 'scheduled jobs hold the process');

    // The one-shot job fires: its turn starts with a `command_lifecycle` frame, then the job is gone.
    append(toLine({ type: 'command_lifecycle', command_uuid: 'c1', state: 'started', wakeup_source: 'schedule_wakeup' }));
    assert.equal(adapter.checkIsBusy(key), true, 'the fired job\'s turn is a turn');
    append(resultLine);
    assert.deepEqual([...adapter['sessions'].get(keyToString(key))!.scheduledJobs.keys()], ['99a38c99'], 'the fired one-shot job is gone, the recurring one stays');

    append(toolUse('t3', 'CronDelete', { id: '99a38c99' }) + toolResult('t3', 'Cancelled job 99a38c99.') + resultLine);
    assert.equal(adapter['sessions'].get(keyToString(key))!.scheduledJobs.size, 0);
    assert.equal(adapter.checkIsWorking(key), false);
  });

  it('the pending work rides the tail record and an adopt restores it', () => {
    const { adapter, append } = createAdapterWithSession();
    const tailWrites: JsonStreamTailOffset[] = [];
    adapter.setJsonStreamTailWriter((_k, tail) => tailWrites.push(tail));
    append(resultLine + backgroundStartedLines);
    const withTask = tailWrites.at(-1);
    assert.deepEqual(withTask?.backgroundTasks, [{ taskId: backgroundTaskId, description: backgroundTaskDescription }]);
    assert.deepEqual(withTask?.backgroundTaskIds, [backgroundTaskId], 'the id list stays for a reader of the older record');
    assert.equal(typeof withTask?.lastTurnEndedAtMs, 'number');

    append(toLine({ type: 'system', subtype: 'task_notification', task_id: backgroundTaskId, status: 'completed', output_file: '/tmp/x.output' }));
    const pending = tailWrites.at(-1);
    assert.equal(typeof pending?.notificationTurnPendingSinceMs, 'number', 'a reload inside the gap keeps the pending turn');

    const restored = resolveAdoptedTail(pending ?? null, 'sess-pending', 10_000_000);
    assert.deepEqual(restored.backgroundTasks, [{ taskId: backgroundTaskId, description: backgroundTaskDescription }]);
    assert.equal(restored.notificationTurnPendingSinceMs, pending?.notificationTurnPendingSinceMs);
    assert.equal(restored.lastTurnEndedAtMs, withTask?.lastTurnEndedAtMs);
    // An older record (ids only) still restores the tasks, without descriptions.
    assert.deepEqual(resolveAdoptedTail({ sessionId: 'sess-pending', offsetBytes: 0, backgroundTaskIds: ['old1'] }, 'sess-pending', 0).backgroundTasks, [{ taskId: 'old1', description: '' }]);
  });

  it('a process that ends by itself leaves its pending work for the bot, once; an explicit stop leaves nothing', () => {
    const { adapter, session, append } = createAdapterWithSession();
    const tailWrites: JsonStreamTailOffset[] = [];
    adapter.setJsonStreamTailWriter((_k, tail) => tailWrites.push(tail));
    append(resultLine + backgroundStartedLines);
    fs.writeFileSync(session.paths.exitCodeFile, '137\n');
    const closed: SessionKey[] = [];
    adapter.on('closed', (closedKey: SessionKey) => closed.push(closedKey));
    adapter['pollTailTick'](session);
    assert.deepEqual(closed, [key], 'the crash is a close');
    assert.deepEqual(adapter.takeLostWork(key), { backgroundTasks: [{ taskId: backgroundTaskId, description: backgroundTaskDescription }], scheduledJobCount: 0, hasUnreadTaskResult: false, wasTurnInFlight: false });
    assert.equal(adapter.takeLostWork(key), null, 'handed over once');
    assert.equal(tailWrites.at(-1)?.backgroundTasks, undefined, 'the ended process\'s record no longer carries the task: the next boot does not report it again');
    assert.deepEqual(tailWrites.at(-1)?.backgroundTaskIds, []);

    const second = createAdapterWithSession();
    second.append(resultLine + backgroundStartedLines);
    const releasedWrites: JsonStreamTailOffset[] = [];
    second.adapter.setJsonStreamTailWriter((_k, tail) => releasedWrites.push(tail));
    second.session.isStopping = true; // `/quit`, `/new`, a backend switch
    second.adapter['finalizeExternalExit'](second.session, null);
    assert.equal(second.adapter.takeLostWork(key), null, 'a released conversation has nothing to tell');
    assert.deepEqual(releasedWrites, [], 'and its record, released by the bot, is not written back');
  });

  it('a finished task whose turn had not shown is an unread result when the process ends', () => {
    const { adapter, session, append } = createAdapterWithSession();
    append(resultLine + backgroundStartedLines + backgroundFinishedLines);
    session.isSuspending = true;
    session.isStopping = true;
    adapter['finalizeExternalExit'](session, null);
    assert.deepEqual(adapter.takeLostWork(key), { backgroundTasks: [], scheduledJobCount: 0, hasUnreadTaskResult: true, wasTurnInFlight: false });
  });

  it('getPendingWork reads what a LIVE process would lose to a stop the bot makes itself: its tasks and the turn under way', () => {
    const { adapter, session, append } = createAdapterWithSession();
    assert.equal(adapter.getPendingWork(key), null, 'nothing pending');
    append(resultLine + backgroundStartedLines + initLine);
    assert.deepEqual(adapter.getPendingWork(key), { backgroundTasks: [{ taskId: backgroundTaskId, description: backgroundTaskDescription }], scheduledJobCount: 0, hasUnreadTaskResult: false, wasTurnInFlight: true });
    session.isActive = false;
    assert.equal(adapter.getPendingWork(key), null, 'no live process, nothing to read');
  });

  it('the ScheduleWakeup (/loop) wakeup is pending work until it fires; a loop firing never takes a cron job off', () => {
    const { adapter, append } = createAdapterWithSession();
    const toolUse = (id: string, name: string): string =>
      toLine({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] } });
    const toolResult = (id: string, text: string): string =>
      toLine({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
    append(toolUse('t1', 'ScheduleWakeup') + toolResult('t1', 'Next wakeup scheduled for 15:05:00 (in 63s). If you owe the user a status update this tick, write it now.')
      + toolUse('t2', 'CronCreate') + toolResult('t2', 'Scheduled one-shot task 59151bd3 (20 11 24 10 *). Next run: Oct 24 11:20am.')
      + resultLine);
    const jobsOf = (): string[] => [...adapter['sessions'].get(keyToString(key))!.scheduledJobs.values()].map((job) => job.kind);
    assert.deepEqual(jobsOf(), ['loopWakeup', 'oneShot']);
    assert.equal(adapter.checkIsWorking(key), true);
    append(toLine({ type: 'command_lifecycle', command_uuid: 'c1', state: 'started', wakeup_source: 'loop_wakeup', scheduled_for: 1 }) + resultLine);
    assert.deepEqual(jobsOf(), ['oneShot'], 'the wakeup fired; the cron job stays');
  });

  it('refreshWorkingState reads what the process wrote since the last poll', () => {
    const { adapter, session, append } = createAdapterWithSession();
    append(resultLine);
    assert.equal(adapter.checkIsWorking(key), false);
    // Written, not yet polled: the last poll's view still says idle.
    fs.appendFileSync(session.paths.stdoutFile, backgroundStartedLines);
    assert.equal(adapter.checkIsWorking(key), false, 'the stale view');
    adapter.refreshWorkingState(key);
    assert.equal(adapter.checkIsWorking(key), true, 'the fresh read sees the task');
  });
});
