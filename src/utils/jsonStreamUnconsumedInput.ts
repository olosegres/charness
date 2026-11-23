/**
 * @description The json-stream adapter's account of the user messages it wrote that the CLI has not taken in yet ("unconsumed
 * input"): the part of "working" that keeps a process from being stopped, compacted or switched while a message to the agent
 * would be lost. Pure: every function takes the list and the clock and returns the next list.
 *
 * Measured on the real CLI 2.1.329 (`-p`, stream-json, `--replay-user-messages`): a message written while a turn runs is taken in
 * either at a point of that turn (a tool boundary), each with an echo of its own, or — when the turn ends first — together with
 * every other message queued by then, as ONE turn whose single echo carries their texts joined by a newline: four writes, two
 * echoes. A bare write-versus-echo count therefore never returns to zero after such a drain, which is how a topic's process was
 * once held "working" for hours. So a message is kept WITH ITS TEXT and taken off by the echo that carries it, and — since no
 * account of the CLI's queue can be exact for ever — it holds a turn-less process only for a bounded time, and a message the CLI
 * took in in a shape nothing here can match (a "phantom") is dropped at the end of the turn that echoed it (see
 * {@link getInputsAfterTurnEnd}).
 */

import { unconsumedInputGraceMs } from './jsonStreamPendingWork';

/** A user message written to the CLI's stdin and not yet echoed back. */
export interface UnconsumedInput {
  text: string;
  /**
   * The moment the CLI's chance to take it in last began: its write, then every turn end — a queued message is taken in right
   * after the turn that ran ahead of it, so the wait for that starts at the turn's end, not at the write.
   */
  since: number;
  /**
   * An echo of ours that matched nothing arrived in the running turn, and this is the entry it is counted against (the oldest
   * unmarked one at that moment): the message the turn took in, in a shape nothing here matches. The turn's end drops marked
   * entries ({@link getInputsAfterTurnEnd}); a turn that really opens (`init`, a job's firing, a `running` with none running), an
   * interrupt or the busy watchdog forgets the marks (see {@link getInputsWithoutEchoMarks}).
   */
  hasUnmatchedEcho: boolean;
  /**
   * Written before a turn that ended in an error result, and not taken in since: the CLI still runs it as its own next turn
   * (measured on 2.1.330, see {@link getInputsAfterTurnEnd}), so it counts as on its way like any other — only a deferred account
   * switch looks past it, so a limit's switch is never held off by a message the limited account cannot run anyway.
   */
  isQueuedBehindFailedTurn?: boolean;
}

/** What the CLI joins the texts of messages it takes in together with (measured). */
const mergedInputSeparator = '\n';

/** The first run of messages whose texts, joined as the CLI joins them, are exactly `echoText`: `[start, end)`; `null` for none. */
function findEchoedRange(inputs: readonly UnconsumedInput[], echoText: string): { start: number; end: number } | null {
  for (let start = 0; start < inputs.length; start += 1) {
    let joinedText = '';
    // A longer join can never shrink back to the echo: stop growing it past the echo's length.
    for (let end = start; end < inputs.length && joinedText.length <= echoText.length; end += 1) {
      joinedText = end === start ? inputs[end].text : `${joinedText}${mergedInputSeparator}${inputs[end].text}`;
      if (joinedText === echoText) return { start, end: end + 1 };
    }
  }
  return null;
}

/**
 * @description The messages still unconsumed after a user line of the CLI with `echoText`: the run that text carries is taken in.
 * A line that is no echo of anything written (`null` text, or the CLI's own `[Request interrupted…]` marker) takes nothing in —
 * counting it as an echo would drop a message that is still queued.
 */
export function getInputsAfterEcho(inputs: readonly UnconsumedInput[], echoText: string | null): UnconsumedInput[] {
  const echoedRange = echoText === null ? null : findEchoedRange(inputs, echoText);
  if (echoedRange === null) return [...inputs];
  return [...inputs.slice(0, echoedRange.start), ...inputs.slice(echoedRange.end)];
}

/**
 * @description The messages after an echo of ours that matched NONE of them: the oldest one not yet marked is marked as the one the
 * echo carried (the CLI takes its queue in order) — a message the turn took in, in a shape nothing matches. Tied to the entry, not
 * counted: a message written after the echo, or one a later echo takes off, is never the one that goes.
 */
export function getInputsWithOldestEchoMarked(inputs: readonly UnconsumedInput[]): UnconsumedInput[] {
  const unmarkedIndex = inputs.findIndex((input) => !input.hasUnmatchedEcho);
  return inputs.map((input, index) => (index === unmarkedIndex ? { ...input, hasUnmatchedEcho: true } : input));
}

/**
 * @description The messages after a turn ended. Every one's wait for the turn that takes it in starts from now (the CLI starts it a
 * moment after this end — measured on 2.1.329, its echo follows within a second). The marked ones are DROPPED: the turn took them
 * in, in a shape nothing matches (the CLI changed their text), so nothing can match them any more and an entry kept would hold the
 * readers that decide at a turn end — the claude-per-turn stop, a deferred account switch — at every turn end for good. A turn that
 * carried no echo of ours (a finished task's notification, a scheduled job, the bot's own `/compact`) marked nothing and drops
 * nothing: a real message the CLI queued behind it stays counted until its own echo, or its grace is out — dropping it here would
 * let the stop or the account switch kill the process a moment before the turn that takes that message in. (Measured on 2.1.329:
 * such a turn writes no `user` line of its own at all, and a message written behind it is echoed in its own turn after it.)
 * A turn that ended in an ERROR result (`isFailedTurn`) keeps its queue too, each message marked `isQueuedBehindFailedTurn`. Measured on
 * 2.1.330 with `claude -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages --permission-mode default`
 * (no `CLAUDE_CONFIG_DIR`, the default sign-in, a throwaway folder; a second user message written 0.3 s after the first, stdin held open),
 * the first turn failing on `--model claude-nonexistent-model-x`, and on an HTTP 400 and an HTTP 429 (after the CLI's ten retries) from a
 * loopback API through `ANTHROPIC_BASE_URL`: the CLI wrote a new `system/init` 0.02–0.2 s after the error `result` and ran the queued
 * message as its own turn (in a turn that fails, the echo comes at its end, right before its `result`). Emptied here as it once was, the
 * list read the message as taken in before its turn began: the per-turn stop killed the process ahead of that turn, and the bot decided
 * the request's turn ended.
 */
export function getInputsAfterTurnEnd(inputs: readonly UnconsumedInput[], now: number, options: { isFailedTurn?: boolean } = {}): UnconsumedInput[] {
  return inputs
    .filter((input) => !input.hasUnmatchedEcho)
    .map((input) => ({ ...input, since: now, ...(options.isFailedTurn === true ? { isQueuedBehindFailedTurn: true } : {}) }));
}

/**
 * @description The messages as a turn OPENS (its `init`, a job's firing, a `running` after none), or the running one is interrupted or
 * cleared by the busy watchdog: the marks of the turn before are forgotten. A turn that never reported a `result` (an aborted one,
 * one the watchdog cleared) must not leave its marks to drop a real message at some later turn's end. The marker the CLI writes for
 * an interrupt arrives AFTER the interrupt request and may still mark an entry: the next turn's `init` forgets that mark.
 */
export function getInputsWithoutEchoMarks(inputs: readonly UnconsumedInput[]): UnconsumedInput[] {
  return inputs.map((input) => (input.hasUnmatchedEcho ? { ...input, hasUnmatchedEcho: false } : input));
}

/**
 * @description The messages that may still be on their way to the CLI's turn: all of them while a turn runs (it takes them in or
 * ends, and a turn end starts their wait over), and with no turn only those written or left behind by a turn end less than
 * {@link unconsumedInputGraceMs} ago. A message the CLI never echoes — dropped, transformed past recognition — stops holding the
 * process there instead of for good.
 */
export function getInputsOnTheirWay(input: { inputs: readonly UnconsumedInput[]; isBusy: boolean; now: number }): UnconsumedInput[] {
  if (input.isBusy) return [...input.inputs];
  return input.inputs.filter((pending) => input.now - pending.since < unconsumedInputGraceMs);
}
