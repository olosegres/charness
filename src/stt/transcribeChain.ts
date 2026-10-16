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
}

/** @description The outcome, plus the name of the engine that produced it (the last one tried on failure). */
export type TranscribeChainResult = TranscribeResult & { engine?: string };

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
    const result = await transcribeWithEngine(filePath, engine, nextEngine === undefined, options);
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
): Promise<TranscribeResult> {
  let endpoint: TranscriptionEndpoint;
  try {
    endpoint = await engine.getEndpoint();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'speech engine could not be started' };
  }
  return transcribeAudio(
    filePath,
    options.language ? { ...endpoint, language: options.language } : endpoint,
    {
      timeoutMs: getEngineTimeoutMs(engine.timeout, options.durationSeconds),
      retryDelaysMs: isLast ? options.retryDelaysMs : noRetryDelaysMs,
      onRetry: options.onRetry,
    },
  );
}
