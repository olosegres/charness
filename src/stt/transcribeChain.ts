import {
  transcribeAudio,
  type TranscribeResult,
  type TranscribeRetryInfo,
  type TranscriptionEndpoint,
} from '../utils/transcribeAudio';
import { getEngineTimeoutMs, type ResolvedSttEngine } from './sttSettings';

/**
 * @description Walk the engine chain for one voice note. An engine that is not
 * the last is tried ONCE: any failure (a refused connection, a timeout, a 5xx,
 * a spawn that did not come up) moves straight on to the next engine, with no
 * retry pause. Only the LAST engine keeps the retry schedule and its notices,
 * since nothing is left to fall back to.
 *
 * An empty transcript (or an empty file) is DEFINITIVE and ends the walk: Groq
 * hallucinates on silence, so another engine's text would not be more true.
 */

/** @description A non-last engine failed and the next one is about to be tried. */
export interface TranscribeFallbackInfo {
  /** Name of the engine that failed. */
  from: string;
  /** Name of the engine tried next. */
  to: string;
  error: string;
}

export interface TranscribeWithEnginesOptions {
  /** The voice's length in seconds (Telegram's `voice.duration`) — scales every engine's timeout. */
  durationSeconds?: number;
  /** ISO-639-1 hint sent to every engine; `null` → auto-detect. */
  language: string | null;
  /** Pause before each retry of the LAST engine; defaults to the schedule of `transcribeAudio`. */
  retryDelaysMs?: readonly number[];
  onRetry?: (info: TranscribeRetryInfo) => void;
  onFallback?: (info: TranscribeFallbackInfo) => void;
  /** The first engine's endpoint asked for when the voice arrived; used once, and only for that engine. */
  warmedEndpoint?: WarmedEndpoint | null;
  /** How long a non-last engine may take to produce its endpoint; defaults to {@link nonLastEngineStartBudgetMs}. */
  nonLastEngineStartBudgetMs?: number;
}

/** @description The outcome, plus the name of the engine that produced it (the last one tried on failure). */
export type TranscribeChainResult = TranscribeResult & { engine?: string };

/**
 * @description The endpoint of the first engine, asked for when the voice note ARRIVED: that voice's job hands it to
 * {@link transcribeWithEngines}, which uses it instead of asking the engine again.
 */
export interface WarmedEndpoint {
  engineId: string;
  endpoint: Promise<TranscriptionEndpoint>;
}

/**
 * @description Start the local engine now when a voice would reach it FIRST: its load (seconds on an idle box, tens of
 * seconds on a busy one) then overlaps the download and the other work of the voice job instead of following them. The
 * outcome belongs to THAT voice ({@link WarmedEndpoint}): its job reuses it — also a failure, so one voice never starts
 * the engine twice and never counts as two failed starts. A failure is logged here as one line, because the voice job
 * may end (a failed download) without ever asking. Any other first engine (a hosted one answers at once) starts nothing:
 * an engine a voice may never reach is not worth its memory.
 */
export function warmUpFirstEngine(
  engines: readonly ResolvedSttEngine[],
  logWarning: (line: string) => void,
): WarmedEndpoint | null {
  const firstEngine = engines[0];
  if (firstEngine?.kind !== 'gigaam') return null;
  const endpoint = firstEngine.getEndpoint({ isWarmUp: true });
  endpoint.catch((error) => logWarning(`[STT] warm-up start of ${firstEngine.name} failed: ${error instanceof Error ? error.message : 'unknown error'}`));
  return { engineId: firstEngine.id, endpoint };
}

/**
 * How long a voice waits for a NON-last engine to produce its endpoint before the next engine takes it: the local engine's
 * start can take tens of seconds on a busy box, and a hosted engine behind it answers in a few. The start is NOT cancelled —
 * it goes on, shared, so the next voice finds the engine warm. The LAST engine is waited for as long as its start lives.
 */
const nonLastEngineStartBudgetMs = 15_000;
const millisecondsPerSecond = 1000;

const startTooSlow = Symbol('startTooSlow');

/** `pending`'s value, or {@link startTooSlow} once `budgetMs` has passed; `pending` itself runs on either way. */
async function waitAtMost<Value>(pending: Promise<Value>, budgetMs: number): Promise<Value | typeof startTooSlow> {
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<typeof startTooSlow>((resolve) => { timer = setTimeout(() => resolve(startTooSlow), budgetMs); });
  try {
    return await Promise.race([pending, budget]);
  } finally {
    clearTimeout(timer);
  }
}

/** No retries: a non-last engine is tried once. */
const noRetryDelaysMs: readonly number[] = [];

export async function transcribeWithEngines(
  filePath: string,
  engines: readonly ResolvedSttEngine[],
  options: TranscribeWithEnginesOptions,
): Promise<TranscribeChainResult> {
  let lastFailure: TranscribeChainResult = { ok: false, error: 'no speech engine available' };
  for (const [index, engine] of engines.entries()) {
    const nextEngine = engines[index + 1];
    const warmedEndpoint = index === 0 && options.warmedEndpoint?.engineId === engine.id ? options.warmedEndpoint.endpoint : null;
    const result = await transcribeWithEngine(filePath, engine, nextEngine === undefined, options, warmedEndpoint);
    if (result.ok) return { ...result, engine: engine.name };
    lastFailure = { ...result, engine: engine.name };
    if (result.isDefinitive || nextEngine === undefined) break;
    options.onFallback?.({ from: engine.name, to: nextEngine.name, error: result.error });
  }
  return lastFailure;
}

async function transcribeWithEngine(
  filePath: string,
  engine: ResolvedSttEngine,
  isLast: boolean,
  options: TranscribeWithEnginesOptions,
  warmedEndpoint: Promise<TranscriptionEndpoint> | null,
): Promise<TranscribeResult> {
  /** The warm-up answers the FIRST ask only: a retry asks the engine again (it may have come back on another port). */
  let unusedWarmedEndpoint = warmedEndpoint;
  const askEngine = (): Promise<TranscriptionEndpoint> => {
    const pending = unusedWarmedEndpoint ?? engine.getEndpoint();
    unusedWarmedEndpoint = null;
    return pending;
  };
  const getEndpoint = async (): Promise<TranscriptionEndpoint> => {
    const endpoint = await askEngine();
    return options.language ? { ...endpoint, language: options.language } : endpoint;
  };
  const startBudgetMs = options.nonLastEngineStartBudgetMs ?? nonLastEngineStartBudgetMs;
  let endpoint: TranscriptionEndpoint;
  try {
    const asked = isLast ? await getEndpoint() : await waitAtMost(getEndpoint(), startBudgetMs);
    if (asked === startTooSlow) {
      return { ok: false, error: `${engine.name} was still starting after ${Math.round(startBudgetMs / millisecondsPerSecond)} s; it keeps starting for the next voice` };
    }
    endpoint = asked;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'speech engine could not be started' };
  }
  return transcribeAudio(filePath, endpoint, {
    timeoutMs: getEngineTimeoutMs(engine.timeout, options.durationSeconds),
    // The local engine names the audio in line before this voice: it is recognised first, so it is budgeted too.
    getTimeoutMsForQueuedAudio: (queuedAudioSeconds) => getEngineTimeoutMs(engine.timeout, options.durationSeconds, queuedAudioSeconds),
    retryDelaysMs: isLast ? options.retryDelaysMs : noRetryDelaysMs,
    onRetry: options.onRetry,
    // A retry asks the engine again: the local one may have crashed or idled out and come back on another port.
    refreshEndpoint: getEndpoint,
  });
}
