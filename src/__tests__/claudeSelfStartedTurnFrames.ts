/**
 * @description What the real Claude Code CLI writes to stdout (stream-json, `--replay-user-messages`) for a turn it starts BY ITSELF —
 * a one-shot `CronCreate` job firing, a `ScheduleWakeup` wakeup firing, a finished background task's notification — with a user
 * message written while that turn runs. Recorded by a live probe on Claude Code 2.1.329 (haiku, one process per scenario); the
 * values are placeholders (session and message ids, timestamps, no paths), the SHAPES are as written. The `system` frames are
 * trimmed to the fields the adapter reads.
 *
 * What the probe showed, and the unmatched-echo accounting of the json-stream adapter (`utils/jsonStreamUnconsumedInput.ts`) rests on:
 *   - NO `user` line is written for the prompt of such a turn: a cron or wakeup turn announces itself by a `command_lifecycle`
 *     frame (`state: "started"`, `wakeup_source`), a notification turn by `task_notification` + `session_state_changed running`.
 *     So nothing of the turn passes `checkIsOwnInputEcho` — it carries no echo of ours, matched or not;
 *   - a message written while the turn runs is echoed normally (`isReplay: true`, string content): inside that turn at a tool
 *     boundary (cron, wakeup), or — behind a turn that has no tool boundary to take it in — in a turn of its OWN after the
 *     notification turn's `result`, never in the notification turn itself.
 *
 * Matches neither runner glob; imported by `claudeJsonStreamSelfStartedTurns.test.ts`.
 */

const sessionId = 'session-recorded';
const stamp = '2026-01-01T00:00:00.000Z';

/** One step of a recorded scenario: a stdout line the CLI wrote, or the moment the bot wrote a user message. */
export type RecordedStep = { line: Record<string, unknown> } | { write: string };

const lifecycleUuid = '00000000-0000-4000-8000-0000000000c1';
const frameUuid = (index: number): string => `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`;

const stateFrame = (state: 'running' | 'idle'): Record<string, unknown> => ({ type: 'system', subtype: 'session_state_changed', state, uuid: frameUuid(1), session_id: sessionId });
const initFrame: Record<string, unknown> = { type: 'system', subtype: 'init', session_id: sessionId, model: 'recorded-model', claude_code_version: '2.1.329' };
const resultFrame = (text: string): Record<string, unknown> => ({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sessionId });
const assistantText = (text: string): Record<string, unknown> => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: sessionId });
const bashToolUse: Record<string, unknown> = {
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_recorded_1', name: 'Bash', input: { command: 'sleep 15', description: 'Sleep for 15 seconds' } }] },
  parent_tool_use_id: null,
  session_id: sessionId,
};
/** The tool result of the turn's `Bash` call: a `user` line, but a tool result, never an echo. */
const bashToolResult: Record<string, unknown> = {
  type: 'user',
  message: { role: 'user', content: [{ tool_use_id: 'toolu_recorded_1', type: 'tool_result', content: '(Bash completed with no output)', is_error: false }] },
  parent_tool_use_id: null,
  session_id: sessionId,
  uuid: frameUuid(2),
  timestamp: stamp,
  tool_use_result: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
};
/** The echo of a message the bot wrote: a plain-string `user` line with `isReplay: true`. */
const echoOf = (text: string): Record<string, unknown> => ({
  type: 'user', message: { role: 'user', content: text }, session_id: sessionId, parent_tool_use_id: null, uuid: frameUuid(3), timestamp: stamp, isReplay: true,
});

/** The text the bot writes while the self-started turn runs. */
export const queuedMessageText = 'QUEUED-BEHIND-THE-TURN: reply with exactly QUEUED-DONE';

/**
 * A one-shot `CronCreate` job fires while the process is idle; its turn calls `Bash` (`sleep 15`), the message is written during
 * that call and echoed at the tool boundary — one turn, answered together. No `user` line for the cron prompt.
 */
export const recordedCronTurn: readonly RecordedStep[] = [
  { line: stateFrame('running') },
  { line: { type: 'command_lifecycle', command_uuid: lifecycleUuid, state: 'started', wakeup_source: 'schedule_wakeup', uuid: frameUuid(4), session_id: sessionId } },
  { line: initFrame },
  { line: bashToolUse },
  { write: queuedMessageText },
  { line: bashToolResult },
  { line: echoOf(queuedMessageText) },
  { line: assistantText('CRON-DONE\nQUEUED-DONE') },
  { line: resultFrame('CRON-DONE\nQUEUED-DONE') },
  { line: { type: 'command_lifecycle', command_uuid: lifecycleUuid, state: 'completed', uuid: frameUuid(5), session_id: sessionId } },
  { line: stateFrame('idle') },
];

/** The same for a `ScheduleWakeup` wakeup (`wakeup_source: "loop_wakeup"`, with the time it was scheduled for). */
export const recordedWakeupTurn: readonly RecordedStep[] = [
  { line: stateFrame('running') },
  { line: { type: 'command_lifecycle', command_uuid: lifecycleUuid, state: 'started', wakeup_source: 'loop_wakeup', scheduled_for: 1_790_000_000_000, uuid: frameUuid(4), session_id: sessionId } },
  { line: initFrame },
  { line: bashToolUse },
  { write: queuedMessageText },
  { line: bashToolResult },
  { line: echoOf(queuedMessageText) },
  { line: assistantText('WAKE-DONE\nQUEUED-DONE') },
  { line: resultFrame('WAKE-DONE\nQUEUED-DONE') },
  { line: { type: 'command_lifecycle', command_uuid: lifecycleUuid, state: 'completed', uuid: frameUuid(5), session_id: sessionId } },
  { line: stateFrame('idle') },
];

/**
 * A background task finishes while the process is idle: its notification starts a turn of the CLI's own (no tool boundary in it).
 * The message written as that turn starts is NOT echoed in it — the notification turn ends first, and the message gets a turn and
 * an echo of its own. No `user` line for the notification.
 */
export const recordedNotificationTurn: readonly RecordedStep[] = [
  { line: { type: 'system', subtype: 'task_notification', task_id: 'task-recorded', status: 'completed', session_id: sessionId } },
  { line: { type: 'system', subtype: 'background_tasks_changed', tasks: [], session_id: sessionId } },
  { line: stateFrame('running') },
  { write: queuedMessageText },
  { line: assistantText('The background command finished with exit code 0.') },
  { line: resultFrame('The background command finished with exit code 0.') },
  { line: echoOf(queuedMessageText) },
  { line: assistantText('QUEUED-DONE') },
  { line: resultFrame('QUEUED-DONE') },
  { line: stateFrame('idle') },
];
