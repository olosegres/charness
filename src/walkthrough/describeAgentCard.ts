import type { AgentCardEvent } from './buildWalkthroughFrames';
import type { WalkthroughConfig } from './walkthroughTypes';

/** What a card of the agent column says. */
export interface AgentCardView {
  /** Who: the label of the request's key prefix. */
  label: string;
  /** What it is: the prompt the agent read, a tool's result, a hook's text. */
  kindText: string;
  /** The words of it worth reading, short. */
  words: string;
  /** The highlighted block (a note the agent was handed), or `null`. */
  note: string | null;
}

const promptWordsMaxChars = 90;
const resultWordsMaxChars = 70;

/** The tokens a fake agent's test messages carry (`[fake:answer]`, `[work-ms:1500]`): noise on a card. */
const fakeAgentTokenPattern = /\[(?:fake|work-ms|tool-after-ms)[^\]]*\]/g;

/** @description `text` from `marker` to the next blank line, or `null` when it holds none (or no marker is set). */
export function extractHighlightedBlock(text: string, marker: string | undefined): string | null {
  if (marker === undefined) return null;
  const start = text.indexOf(marker);
  return start < 0 ? null : text.slice(start).split('\n\n')[0];
}

function getLastLine(text: string): string {
  return text.split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
}

function getRequestKeyPrefix(issueKey: string): string {
  return issueKey.replace(/-\d+$/, '');
}

/** @description How one card of the agent column reads: its label, what kind of card it is, its words, and its note. */
export function describeAgentCard(event: AgentCardEvent, config: WalkthroughConfig): AgentCardView {
  const prefix = getRequestKeyPrefix(event.issueKey);
  const label = config.agentLabels?.[prefix] ?? prefix;
  if (event.kind === 'prompt') {
    const note = extractHighlightedBlock(event.text, config.highlightMarker);
    const beforeNote = note === null ? event.text : event.text.slice(0, event.text.indexOf(note));
    return { label, kindText: 'prompt the agent read', words: getLastLine(beforeNote).replace(fakeAgentTokenPattern, '').replace(/\s+/g, ' ').trim().slice(0, promptWordsMaxChars), note };
  }
  if (event.kind === 'hook') return { label, kindText: 'after its next tool call (hook)', words: '', note: event.text };
  const outcome = event.outcome;
  const kindText = event.kind === 'tool' ? `${event.tool} result` : `answer_request ${event.answerKind} result`;
  return { label, kindText, words: outcome.split('\n')[0].slice(0, resultWordsMaxChars), note: extractHighlightedBlock(outcome, config.highlightMarker) };
}
