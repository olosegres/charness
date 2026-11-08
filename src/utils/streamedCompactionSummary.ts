/**
 * @description The compaction summary a backend STREAMS to the bot (OpenCode) tail by tail, before it reaches the topic —
 * pure, no I/O. The bot never reads such a summary whole, so the two things it does with a summary it reads (post it
 * without the scaffolding, post its agent-mistakes section alone) are done here on the tails:
 *
 *  - summary SHOWN (`/compact_summary` on): {@link createStreamedSummaryDisplay} takes the scaffolding out of what goes on
 *    to the topic — the marker lines, the «none» line — and puts the section's header where its first line is, however the
 *    tails cut the lines. A fragment that could still turn out to be a marker is held back, any other is shown at once;
 *  - summary HIDDEN: the tracker collects the tails of a summary the bot did NOT issue (the server's own, at a context
 *    overflow) and hands back its section once, the moment the section is complete. A compaction the bot issued is
 *    left to the bot, which reads the section after the compaction and posts it in order (`compaction.ts`).
 *
 * A summary is told from the next by its message id (`OutboundHints.compactionSummaryMessageId`): the adapter marks a tail a
 * continuation whenever its buffer already holds text, so «the first tail of a summary» is no marker of a new summary.
 */

import {
  checkCouldBecomeCompactionScaffoldingLine,
  createCompactionSummaryLineFilter,
  parseCompactionInstructionGaps,
} from './compactOnIdle';

/** Shows a streamed summary: tails in, the text to show now out. */
export interface StreamedSummaryDisplay {
  /** The text of `tail` the topic shows (and what a held-back fragment before it adds); `''` when there is nothing to show yet. */
  push(tail: string): string;
}

/**
 * @description The display of a SHOWN streamed summary. Complete lines go through the summary line filter; the last,
 * unfinished line is shown at once unless it could still become a marker (then it waits for its newline, or for the next
 * tail to settle it) — so a line that is not scaffolding is never kept back, and the last line of a summary that ends without
 * a newline is not lost. Once part of a line is out, the rest of that line is passed on as it comes: a fragment that starts
 * mid-line is never read as a marker.
 */
export function createStreamedSummaryDisplay(gapsHeader: string): StreamedSummaryDisplay {
  const filter = createCompactionSummaryLineFilter(gapsHeader);
  /** The unfinished line held back because it could still become a marker line. */
  let heldFragment = '';
  /** Part of the current line is already shown: the rest of it is passed on as it is. */
  let isMidLine = false;
  return {
    push(tail: string): string {
      let pending = `${heldFragment}${tail}`;
      heldFragment = '';
      let shown = '';
      if (isMidLine) {
        const newlineAt = pending.indexOf('\n');
        if (newlineAt < 0) return pending;
        shown += pending.slice(0, newlineAt + 1);
        pending = pending.slice(newlineAt + 1);
        isMidLine = false;
      }
      const lines = pending.split('\n');
      const unfinishedLine = lines.pop() ?? '';
      for (const line of lines) shown += filter.pushLine(line).map((shownLine) => `${shownLine}\n`).join('');
      if (unfinishedLine === '') return shown;
      if (checkCouldBecomeCompactionScaffoldingLine(unfinishedLine)) {
        heldFragment = unfinishedLine;
        return shown;
      }
      // Prose (or the line that opens the section, which brings its header): all of it goes out except the newline to come.
      shown += filter.pushLine(unfinishedLine).join('\n');
      isMidLine = true;
      return shown;
    },
  };
}

/** One tail of a streamed summary and what the backend said about it. */
export interface StreamedSummaryTail {
  text: string;
  /** The backend's own flag: this tail goes on from one already sent (the adapter sets it whenever its buffer held text). */
  isContinuation: boolean;
  /** The id of the summary message the tail belongs to, `null` when the backend gives none. */
  summaryId: string | null;
  /** The bot itself issued the compaction this summary belongs to. */
  isBotIssued: boolean;
}

/** How the topic shows summaries now, which the tracker needs for every tail. */
export interface StreamedSummaryView {
  /** `/compact_summary` is on for the topic. */
  isSummaryShown: boolean;
  /** What goes where the agent-mistakes section starts in a summary that is shown. */
  gapsHeader: string;
}

/** What a tail leads to. */
export interface StreamedSummaryOutcome {
  /** The text to send on to the topic and whether it goes on from the message before; `null`: nothing to send now. */
  shown: { text: string; isContinuation: boolean } | null;
  /** The agent-mistakes section to post on its own, once per summary; `null` when there is none to post now. */
  instructionGaps: string | null;
}

/** Per-thread tracker of the streamed summary being written. */
export interface StreamedSummaryTracker {
  push(threadKey: string, tail: StreamedSummaryTail, view: StreamedSummaryView): StreamedSummaryOutcome;
  /** Forget the thread's summary (its session ended). */
  clear(threadKey: string): void;
}

interface StreamedSummary {
  summaryId: string | null;
  /** The display of a shown summary; made with the first tail that needs it. */
  display: StreamedSummaryDisplay | null;
  /** Some text of this summary was sent on to the topic: a later tail may go on from it. */
  hasShown: boolean;
  /** The text collected for the section while the summary is hidden; dropped once the section is complete. */
  collectedText: string;
  /** The section is over (posted, or empty): later tails of this summary are not collected. */
  isSectionClosed: boolean;
}

const noOutcome: StreamedSummaryOutcome = { shown: null, instructionGaps: null };

export function createStreamedSummaryTracker(): StreamedSummaryTracker {
  const summaries = new Map<string, StreamedSummary>();
  return {
    push(threadKey: string, tail: StreamedSummaryTail, view: StreamedSummaryView): StreamedSummaryOutcome {
      const known = summaries.get(threadKey);
      const isSameSummary = known !== undefined && (tail.summaryId !== null ? known.summaryId === tail.summaryId : tail.isContinuation);
      const summary: StreamedSummary = isSameSummary
        ? known
        : { summaryId: tail.summaryId, display: null, hasShown: false, collectedText: '', isSectionClosed: false };
      summaries.set(threadKey, summary);

      if (view.isSummaryShown) {
        summary.display ??= createStreamedSummaryDisplay(view.gapsHeader);
        const text = summary.display.push(tail.text);
        // Blank space alone is nothing to send (the bot's output path drops it as well) and starts no message.
        if (text.trim() === '') return noOutcome;
        // A tail that goes on from a message nothing of which was sent (its start was all scaffolding, or held back) starts one.
        const isContinuation = tail.isContinuation && summary.hasShown;
        summary.hasShown = true;
        return { shown: { text, isContinuation }, instructionGaps: null };
      }

      if (tail.isBotIssued || summary.isSectionClosed) return noOutcome;
      summary.collectedText += tail.text;
      const section = parseCompactionInstructionGaps(summary.collectedText);
      if (!section.isComplete) return noOutcome;
      summary.isSectionClosed = true;
      summary.collectedText = '';
      return { shown: null, instructionGaps: section.text };
    },
    clear(threadKey: string): void {
      summaries.delete(threadKey);
    },
  };
}
