/**
 * @description Pure collector for a thread's TRANSIENT message ids — the bot
 * messages that are created, shown for a moment and deleted again:
 *
 *   - `statusMessageId`          — the "✽ working…" liveness/spinner frame
 *   - `thinkingMessageId`        — the live "☁️ thinking …" chain-of-thought frame
 *   - `subagentStatusMessageId`  — the dedicated "🤖 sub-agent …" delegation frame
 *   - `voiceProgressNoteIds`     — the "🎙 Transcribing the voice message…" notes (one per
 *                                  voice message still waiting for its text, so a list)
 *   - `undeletedMessageIds`      — leftovers of an earlier process whose delete FAILED in a way a
 *                                  retry can fix (a network error, a 429, a 5xx): kept so the next
 *                                  sweep / boot tries again instead of forgetting them
 *
 * Returns only the ones on screen, in that fixed order, so the graceful-shutdown
 * sweep and the boot reconciliation can delete exactly the messages currently on
 * screen. These ids live ONLY in volatile in-memory `ThreadMessageState`, so a
 * restart that doesn't clean them up orphans the messages forever in the topic.
 *
 * Deliberately absent: the pinned status banner (`pinnedStatusMessageId`, a
 * persistent-by-design message) and the native typing loader (a
 * `sendChatAction('typing')` with no message of its own) — neither is a
 * transient frame.
 */
export interface TransientFrameState {
  statusMessageId: number | null;
  thinkingMessageId: number | null;
  subagentStatusMessageId: number | null;
  voiceProgressNoteIds: readonly number[];
  undeletedMessageIds: readonly number[];
}

export function getTransientFrameIds(state: TransientFrameState): number[] {
  const ids: number[] = [];
  if (state.statusMessageId !== null) ids.push(state.statusMessageId);
  if (state.thinkingMessageId !== null) ids.push(state.thinkingMessageId);
  if (state.subagentStatusMessageId !== null) ids.push(state.subagentStatusMessageId);
  ids.push(...state.voiceProgressNoteIds, ...state.undeletedMessageIds);
  return ids;
}

/**
 * The frame-generation guards a shutdown sweep must bump. Both are captured by
 * an in-flight `sendStatusFrame` / thinking-frame create BEFORE its `await` and
 * re-checked after (`getStatusFrameStoreDecision`) to decide store-vs-discard.
 */
export interface ShutdownFrameState extends TransientFrameState {
  statusFrameGeneration: number;
  thinkingFrameGeneration: number;
}

/**
 * @description Graceful-shutdown clear of a thread's transient frames: returns the
 * ids currently on screen (for the caller to delete), bumps BOTH frame
 * generations, nulls the frame fields and empties the voice notes' list — and PARKS
 * every collected id in `undeletedMessageIds`, the thread's list of messages still
 * to delete. The caller deletes them and replaces that list with the ones to try
 * again; until then ANY save of the thread's transient ids — a late frame setter, a
 * late note removal, which rewrite the persisted set from memory — still carries
 * every pending id. (Keeping the retained ids only on disk let such a save drop them.)
 *
 * The generation bump is the load-bearing part, and the reason this must run for
 * EVERY tracked thread — including one whose ids are all null right now. A
 * `sendStatusFrame` / thinking-frame create that is mid-`await` when the sweep
 * runs has NOT yet stored its id (so {@link getTransientFrameIds} is empty here),
 * but it captured the pre-bump generation and re-checks it after the await
 * (`getStatusFrameStoreDecision`). Bumping makes that racing create DISCARD
 * (delete) its just-sent message instead of storing an orphan that outlives the
 * restart — the leftover "🔧 <tool>…" / "✽ working…" frame stranded as a topic's
 * last message. Mirrors the bump `deleteStatusMessage` already does for the
 * mid-session delete; the shutdown path previously nulled the ids WITHOUT bumping,
 * so it sat outside that race protection.
 */
export function clearTransientFramesForShutdown(state: ShutdownFrameState): number[] {
  const ids = getTransientFrameIds(state);
  state.statusFrameGeneration += 1;
  state.thinkingFrameGeneration += 1;
  state.statusMessageId = null;
  state.thinkingMessageId = null;
  state.subagentStatusMessageId = null;
  state.voiceProgressNoteIds = [];
  state.undeletedMessageIds = ids;
  return ids;
}

/**
 * @description Delete transient messages and say which ones must be KEPT for a later try. A delete that fails in a way a
 * retry can fix (`checkIsRetryable`: no answer from Telegram, a 429, a 5xx) keeps its id; one that succeeded, found the message
 * already gone, or was refused for good (a message Telegram will not delete, a chat the bot left) is settled — keeping it would
 * only retry what can never work. Never rejects. The one place the shutdown sweep and the boot reconciliation share, so neither
 * can forget a message whose delete merely hit a bad moment (the stranded frame would stay in the topic with no record left).
 */
export async function deleteTransientMessages(
  messageIds: readonly number[],
  deleteMessage: (messageId: number) => Promise<void>,
  checkIsRetryable: (error: unknown) => boolean,
): Promise<number[]> {
  const keptIds = await Promise.all(messageIds.map(async (messageId): Promise<number | null> => {
    try {
      await deleteMessage(messageId);
      return null;
    } catch (error) {
      return checkIsRetryable(error) ? messageId : null;
    }
  }));
  return keptIds.filter((messageId): messageId is number => messageId !== null);
}

export interface TransientSweepThread<Key> {
  key: Key;
  state: ShutdownFrameState;
}

export interface TransientSweepPorts<Key> {
  deleteMessage: (key: Key, messageId: number) => Promise<void>;
  checkIsRetryable: (error: unknown) => boolean;
  /**
   * Replace the thread's pending-delete list (`undeletedMessageIds`, in memory) with `keptIds` — the ones whose delete must be
   * tried again at the next start (none: the list empties) — and save it with the thread's other transient ids through the one
   * save every writer of the set uses. Synchronous: it replaces the list in memory and schedules the disk write, which the
   * shutdown's `state.flush()` lands — the sweep does not wait for the disk. Must not throw. Called once the deletes have
   * settled; until then the list holds every collected id (see {@link clearTransientFramesForShutdown}), so a save that
   * interleaves, or a sweep cut short by its time bound, leaves a complete record for the boot reconciliation.
   */
  saveKeptIds: (key: Key, keptIds: number[]) => void;
  logProblem: (line: string) => void;
}

/**
 * @description The graceful-shutdown sweep over every tracked thread: {@link clearTransientFramesForShutdown} for EACH (the
 * generation bump must reach a thread whose ids are all null too), then the messages that were on screen are deleted in
 * parallel and the ones that could not be deleted yet stay in the thread's pending list, which is saved with its other ids.
 * Resolves when every thread's deletes have settled (the ports must not throw, so it never rejects). The caller bounds the wait.
 */
export async function sweepTransientMessages<Key>(
  threads: readonly TransientSweepThread<Key>[],
  ports: TransientSweepPorts<Key>,
): Promise<void> {
  const settlements: Promise<void>[] = [];
  for (const { key, state } of threads) {
    const messageIds = clearTransientFramesForShutdown(state);
    if (messageIds.length === 0) continue;
    settlements.push((async () => {
      const keptIds = await deleteTransientMessages(messageIds, (messageId) => ports.deleteMessage(key, messageId), ports.checkIsRetryable);
      if (keptIds.length > 0) ports.logProblem(`[shutdown] ${keptIds.length} transient message(s) could not be deleted now; they stay recorded for the next start`);
      ports.saveKeptIds(key, keptIds);
    })());
  }
  await Promise.all(settlements);
}
