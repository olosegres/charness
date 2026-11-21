/**
 * The pure part of the walkthrough video: what is on screen after each change a recording holds. A frame is the operator's chat (every
 * message of every topic, with its keyboard), the cards of what the fake agent read, and the flow's steps with the one that runs.
 * Bursts of changes a few hundred milliseconds apart are one picture (the last state of the burst), and how long a picture stays follows
 * the real time to the next one, clamped so a long wait never freezes the video and a flurry stays readable.
 */
import type { RecordedMessage, WalkthroughEvent, WalkthroughRecording } from './walkthroughTypes';

/** A burst of changes within this long of its first change is one frame. */
export const frameBurstWindowMs = 450;

/** How long a tapped button stays marked. */
export const tapHighlightMs = 1500;

const minFrameSeconds = 0.7;
const maxFrameSeconds = 3.2;
const msPerSecond = 1000;

/** A gap past this long before the next frame is said on screen («N s pass here»). */
export const idleCaptionAfterMs = 4000;

/** How long the last frame stays. */
export const lastFrameHoldSeconds = 4;

/** What an agent column card is made of. */
export type AgentCardEvent = Extract<WalkthroughEvent, { kind: 'prompt' | 'hook' | 'tool' | 'answer' }>;

export type StepStatus = 'pending' | 'run' | 'pass' | 'fail';

export interface StepState {
  index: number;
  name: string;
  status: StepStatus;
}

export interface TappedButton {
  messageId: number;
  data: string;
}

/** One picture of the walkthrough. */
export interface WalkthroughFrame {
  atMs: number;
  messages: RecordedMessage[];
  agentCards: AgentCardEvent[];
  steps: StepState[];
  tapped: TappedButton | null;
}

/** A frame with how long it stays and what to say about the wait that follows it. */
export interface TimedFrame {
  frame: WalkthroughFrame;
  seconds: number;
  /** The real wait to the next frame when it is long enough to be said; else `null`. */
  waitSeconds: number | null;
}

export interface FrameBuildOptions {
  /** A block starting with this text marks a note the agent was handed; an answer's result is shown only when it holds one. */
  highlightMarker?: string;
}

/** @description Every step the recording holds, in order of start, as pending. */
function listPlannedSteps(events: readonly WalkthroughEvent[]): StepState[] {
  const steps: StepState[] = [];
  for (const event of events) {
    if (event.kind === 'step' && event.phase === 'start' && !steps.some((step) => step.index === event.index)) {
      steps.push({ index: event.index, name: event.name, status: 'pending' });
    }
  }
  return steps;
}

function checkIsAgentCardEvent(event: WalkthroughEvent): event is AgentCardEvent {
  return event.kind === 'prompt' || event.kind === 'hook' || event.kind === 'tool' || event.kind === 'answer';
}

/**
 * @description The frames of a recording, oldest first, from the first step on (what happens while the flow boots is no picture).
 * `agentCards` holds every card so far: the page keeps the newest few.
 */
export function buildWalkthroughFrames(recording: WalkthroughRecording, options: FrameBuildOptions = {}): WalkthroughFrame[] {
  const frames: WalkthroughFrame[] = [];
  let messages: RecordedMessage[] = [];
  const agentCards: AgentCardEvent[] = [];
  const steps = listPlannedSteps(recording.events);
  let tapped: TappedButton | null = null;
  let tappedUntilMs = -1;
  let hasStarted = false;
  let burstStartMs = Number.NEGATIVE_INFINITY;

  for (const event of recording.events) {
    let isChanged = false;
    if (event.kind === 'step') {
      hasStarted = true;
      const step = steps.find((candidate) => candidate.index === event.index);
      if (step) step.status = event.phase === 'start' ? 'run' : event.phase;
      isChanged = true;
    } else if (event.kind === 'chat') {
      messages = event.messages;
      isChanged = true;
    } else if (event.kind === 'tap') {
      tapped = { messageId: event.messageId, data: event.data };
      tappedUntilMs = event.atMs + tapHighlightMs;
      isChanged = true;
    } else if (checkIsAgentCardEvent(event)) {
      const isUnnotedAnswer = event.kind === 'answer' && !(options.highlightMarker !== undefined && event.outcome.includes(options.highlightMarker));
      if (!isUnnotedAnswer) {
        agentCards.push(event);
        isChanged = true;
      }
    }
    if (tapped !== null && event.atMs > tappedUntilMs && event.kind !== 'tap') {
      tapped = null;
      isChanged = true;
    }
    if (!isChanged || !hasStarted) continue;
    const frame: WalkthroughFrame = { atMs: event.atMs, messages: structuredClone(messages), agentCards: [...agentCards], steps: structuredClone(steps), tapped };
    if (event.atMs - burstStartMs < frameBurstWindowMs && frames.length > 0) {
      frames[frames.length - 1] = { ...frame, atMs: burstStartMs };
    } else {
      burstStartMs = event.atMs;
      frames.push(frame);
    }
  }
  return frames;
}

/** @description How long each frame stays: the real time to the next one, clamped; the last one holds {@link lastFrameHoldSeconds}. */
export function planFrameTimings(frames: readonly WalkthroughFrame[]): TimedFrame[] {
  return frames.map((frame, index) => {
    const next = frames[index + 1];
    if (next === undefined) return { frame, seconds: lastFrameHoldSeconds, waitSeconds: null };
    const gapMs = next.atMs - frame.atMs;
    const seconds = Math.min(Math.max(gapMs / msPerSecond, minFrameSeconds), maxFrameSeconds);
    return { frame, seconds, waitSeconds: gapMs > idleCaptionAfterMs ? Math.round(gapMs / msPerSecond) : null };
  });
}
