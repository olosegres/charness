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
 * account of the CLI's queue can be exact for ever — it holds a turn-less process only for a bounded time.
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

/** @description The messages after a turn ended: each one's wait for the turn that takes it in starts over (see {@link UnconsumedInput.since}). */
export function getInputsAfterTurnEnd(inputs: readonly UnconsumedInput[], now: number): UnconsumedInput[] {
  return inputs.map((input) => ({ ...input, since: now }));
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
