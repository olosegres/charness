/**
 * @description The CONTEXT BRIDGE a cross-backend fallback switch hands the new agent (`utils/fallbackChain.ts`):
 * when a topic moves between Claude Code and OpenCode the adapter changes, the new session cannot read the
 * old transcript, and the only thing it knows is what its first prompt tells it. That prompt is built here:
 * why it takes over, the folder it shares with its predecessor, the predecessor's last turns verbatim
 * (user and assistant), and the instruction to establish the state of the work from the project itself
 * before carrying on — then to say in one short message what the task is, what is done and what remains.
 *
 * English on purpose (an agent-facing template, like the thread-context preamble) with a baked reply-language
 * directive. Pure: the turns and labels come from the caller, so the shape is unit-tested.
 */

import { stripThreadContextPreamble } from '../threadContextPreamble';
import type { RecentTurn } from '../types';

/** How many of the previous agent's last turns the bridge carries (user and assistant turns alike). */
export const fallbackBridgeTurnLimit = 6;

/** A single turn longer than this is cut in the middle — the bridge is a hand-over, not a transcript copy. */
export const fallbackBridgeTurnMaxChars = 2500;

const bridgeMarker = '[Backend switch]';

/**
 * @description The bridge prompt. `turns` are chronological (oldest first), already capped by the caller.
 * `reason` is why the agent changes: `limit` (the previous one hit a usage limit; `resetsAtText` names when it
 * comes back, omitted when unknown) or `manual` (the operator switched the topic's backend by hand).
 * `userMessage` is text the operator sent together with a manual switch (`/opencode do X`), passed on as it is.
 */
export function buildFallbackBridgePrompt(input: {
  fromLabel: string;
  toLabel: string;
  turns: readonly RecentTurn[];
  reason: 'limit' | 'manual';
  resetsAtText: string | null;
  userMessage?: string;
  replyLanguage: string;
}): string {
  const why = input.reason === 'limit'
    ? `which hit a usage limit${input.resetsAtText ? ` (it resets at ${input.resetsAtText})` : ''}`
    : "because the operator switched this topic's agent";
  const lines: string[] = [
    `${bridgeMarker} You (${input.toLabel}) are taking this conversation over from ${input.fromLabel}, ${why}. You work in the same project folder, but you cannot see its transcript.`,
    '',
    'Do this now:',
    '1. Read the recent turns below to understand the task and where it stopped.',
    '2. Establish the real state of the work from the project itself (git status, git diff, git log, the files mentioned) — trust the folder over the transcript when they disagree.',
    `3. Reply IN ${input.replyLanguage} with ONE short message: the task as you understand it, what is already done, what remains.`,
    '4. Then continue the work from where it stopped, without redoing what is done.',
  ];
  if (input.userMessage) lines.push('', 'The operator also wrote, together with the switch:', input.userMessage);
  if (input.turns.length === 0) {
    lines.push('', 'No turns of the previous agent are available: start from the project state and ask the user what the task is if it is not evident.');
    return lines.join('\n');
  }
  lines.push('', `--- Last ${input.turns.length} turn(s) of ${input.fromLabel} (oldest first) ---`);
  for (const turn of input.turns) {
    const label = turn.role === 'user' ? 'User' : 'Assistant';
    const text = turn.role === 'user' ? stripThreadContextPreamble(turn.text) : turn.text;
    lines.push('', `${label}:`, truncateTurnText(text.trim()));
  }
  lines.push('', '--- End of the previous agent\'s turns ---');
  return lines.join('\n');
}

/** Cut the middle of an over-long turn, keeping its head and tail (the ask and the outcome are at the ends). */
export function truncateTurnText(text: string, maxChars: number = fallbackBridgeTurnMaxChars): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor((maxChars - 20) / 2);
  return `${text.slice(0, half)}\n[… ${text.length - 2 * half} characters cut …]\n${text.slice(-half)}`;
}

/** Whether a prompt is a bridge (the request ledger and the trace must not read it as the user's own text). */
export function checkIsFallbackBridgePrompt(text: string): boolean {
  return text.startsWith(bridgeMarker);
}
