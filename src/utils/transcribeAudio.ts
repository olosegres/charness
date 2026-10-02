/**
 * @description Voice-note transcription against a Whisper-compatible HTTP API
 * (Groq when its key is set, else OpenAI), with automatic retries on transient
 * failures.
 *
 * Extracted from `bot.ts` so it is side-effect-free and testable against a
 * local HTTP server (importing `bot.ts` would construct a Telegraf instance and
 * read ENV at module load) — the same reasoning as `./download`.
 *
 * Why retries: Groq normally answers in well under a second, yet a request
 * occasionally stalls past the timeout. Without a retry that voice note was
 * simply lost and the user had to re-record it. A timeout, a network error, an
 * HTTP 408 / 409 and a 5xx are retried after a pause (5 s, then 15 s); a 429
 * waits at least as long as the provider's `Retry-After`; any other 4xx fails
 * at once, since resending the same request would fail the same way.
 */

import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import FormData from 'form-data';
import { getRetryAfterHeaderMs } from './retryAfterHeader';

/** Pauses before the automatic retries: the 1st after 5 s, the 2nd after 15 s. */
export const transcribeRetryDelaysMs: readonly number[] = [5_000, 15_000];

const groqTranscriptionUrl = 'https://api.groq.com/openai/v1/audio/transcriptions';
const openAiTranscriptionUrl = 'https://api.openai.com/v1/audio/transcriptions';
const groqTranscriptionModel = 'whisper-large-v3';
const openAiTranscriptionModel = 'whisper-1';
const tooManyRequestsStatus = 429;
const firstServerErrorStatus = 500;
/**
 * 408 Request Timeout and 409 Conflict pass on a resend — the same set the
 * official OpenAI / Groq SDKs retry besides 429 and 5xx.
 */
const retryableClientErrorStatuses: ReadonlySet<number> = new Set([408, 409]);
const errorBodyPreviewLength = 500;

/**
 * @description Where and how a voice note is transcribed.
 */
export interface TranscriptionEndpoint {
  url: string;
  apiKey: string;
  model: string;
}

/**
 * @description Whether a failed attempt is worth repeating: `transient`
 * (timeout / network error / 408 / 409 / 5xx), `rateLimited` (429 — honour
 * `Retry-After`), or `permanent` (any other failure — a retry would fail the
 * same way).
 */
export type TranscribeFailureKind = 'transient' | 'rateLimited' | 'permanent';

export type TranscribeResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

type TranscribeAttemptResult =
  | { ok: true; text: string }
  | { ok: false; error: string; failureKind: TranscribeFailureKind; retryAfterSec?: number };

/**
 * @description Details of a failed attempt that is about to be retried.
 */
export interface TranscribeRetryInfo {
  /** 1-based number of the attempt that just failed. */
  attemptNumber: number;
  error: string;
  /** Pause before the next attempt. */
  delayMs: number;
}

export interface TranscribeAudioOptions {
  /** Per-attempt socket inactivity timeout. */
  timeoutMs: number;
  /** Pause before each retry; its length is the retry count. Defaults to {@link transcribeRetryDelaysMs}. */
  retryDelaysMs?: readonly number[];
  /** Fired before each retry, e.g. to tell the user a retry is coming. */
  onRetry?: (info: TranscribeRetryInfo) => void;
}

/**
 * @description Pick the transcription provider from the configured API keys:
 * Groq wins when both are set; `null` when neither is.
 */
export function getTranscriptionEndpoint(apiKeys: {
  groqApiKey?: string;
  openaiApiKey?: string;
}): TranscriptionEndpoint | null {
  if (apiKeys.groqApiKey) {
    return { url: groqTranscriptionUrl, apiKey: apiKeys.groqApiKey, model: groqTranscriptionModel };
  }
  if (apiKeys.openaiApiKey) {
    return { url: openAiTranscriptionUrl, apiKey: apiKeys.openaiApiKey, model: openAiTranscriptionModel };
  }
  return null;
}

/**
 * @description Classify a non-2xx HTTP status of the transcription API.
 */
export function getTranscribeFailureKind(status: number): TranscribeFailureKind {
  if (status === tooManyRequestsStatus) return 'rateLimited';
  if (status >= firstServerErrorStatus || retryableClientErrorStatuses.has(status)) return 'transient';
  return 'permanent';
}

/**
 * @description Pause before retry number `retryIndex` (0-based), or `null`
 * when the failure must not be retried (permanent, or the schedule is used
 * up). A 429 never retries sooner than the schedule NOR sooner than the
 * provider's `Retry-After` asks.
 */
export function getTranscribeRetryDelayMs(input: {
  failureKind: TranscribeFailureKind;
  retryIndex: number;
  retryAfterSec?: number;
  retryDelaysMs?: readonly number[];
}): number | null {
  if (input.failureKind === 'permanent') return null;
  const scheduledDelayMs = (input.retryDelaysMs ?? transcribeRetryDelaysMs)[input.retryIndex];
  if (scheduledDelayMs === undefined) return null;
  if (input.failureKind === 'rateLimited' && input.retryAfterSec !== undefined) {
    return Math.max(input.retryAfterSec * 1000, scheduledDelayMs);
  }
  return scheduledDelayMs;
}

function parseRetryAfterSec(header: string | string[] | undefined): number | undefined {
  const waitMs = getRetryAfterHeaderMs(Array.isArray(header) ? header[0] : header, Date.now());
  return waitMs ? Math.ceil(waitMs / 1000) : undefined;
}

function getApiErrorMessage(body: string): string {
  const bodyPreview = body.slice(0, errorBodyPreviewLength);
  try {
    const errorJson = JSON.parse(body);
    const apiMessage = errorJson?.error?.message ?? errorJson?.error;
    return typeof apiMessage === 'string' ? apiMessage : bodyPreview;
  } catch {
    return bodyPreview;
  }
}

/**
 * @description One transcription request. Never rejects: every failure comes
 * back classified so {@link transcribeAudio} can decide whether to retry.
 */
async function transcribeAudioOnce(
  filePath: string,
  endpoint: TranscriptionEndpoint,
  timeoutMs: number,
): Promise<TranscribeAttemptResult> {
  // Detect a 0-byte download up-front: previously this would still be sent
  // to Whisper, which replies 400 with a generic "file is empty" body that
  // the old error path swallowed silently. Failing here gives the operator
  // a concrete cause (download produced no bytes) without the round-trip.
  let fileSize = 0;
  try {
    fileSize = (await fsp.stat(filePath)).size;
  } catch (e) {
    return { ok: false, error: `stat failed: ${e instanceof Error ? e.message : e}`, failureKind: 'permanent' };
  }
  if (fileSize === 0) return { ok: false, error: 'downloaded audio is empty', failureKind: 'permanent' };

  const form = new FormData();
  // Explicit filename + content-type: form-data's auto-detection from the
  // ReadStream's path usually works, but some intermediaries strip
  // path-based hints. Setting both makes the multipart upload deterministic.
  form.append('file', fs.createReadStream(filePath), {
    filename: path.basename(filePath),
    contentType: 'audio/ogg',
  });
  form.append('model', endpoint.model);

  const url = new URL(endpoint.url);
  const client = url.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    // Audit S14 / #33: install the error handler before piping the form
    // so a socket error during the initial handshake can't escape. Also
    // add a hard timeout so a hung Groq/OpenAI response can't block the
    // voice-message path indefinitely.
    const req = client.request(url, {
      method: 'POST',
      headers: { ...form.getHeaders(), Authorization: `Bearer ${endpoint.apiKey}` },
    }, (res) => {
      // Decode across chunk boundaries: per-chunk `toString()` garbled a
      // multi-byte character (e.g. Cyrillic) split between two chunks.
      res.setEncoding('utf8');
      let body = '';
      res.on('data', (chunk: string) => { body += chunk; });
      // A connection reset mid-body destroys only the RESPONSE: `end` never
      // fires and the request emits no `error`, so without this the attempt
      // would hang forever and stall the thread's voice queue.
      res.on('error', (e) => {
        resolve({ ok: false, error: e.message, failureKind: 'transient' });
      });
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          resolve({
            ok: false,
            error: `HTTP ${status}: ${getApiErrorMessage(body)}`,
            failureKind: getTranscribeFailureKind(status),
            retryAfterSec: parseRetryAfterSec(res.headers['retry-after']),
          });
          return;
        }
        try {
          const json = JSON.parse(body);
          if (typeof json.text === 'string' && json.text.length > 0) {
            resolve({ ok: true, text: json.text });
            return;
          }
          resolve({ ok: false, error: 'transcription returned empty text', failureKind: 'permanent' });
        } catch {
          resolve({
            ok: false,
            error: `malformed response from Whisper API: ${body.slice(0, errorBodyPreviewLength)}`,
            failureKind: 'permanent',
          });
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('transcription timed out'));
    });
    req.on('error', (e) => {
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e), failureKind: 'transient' });
    });
    form.pipe(req);
  });
}

/**
 * @description Transcribe a voice note, retrying transient failures on the
 * {@link transcribeRetryDelaysMs} schedule. Resolves with the text, or with
 * the LAST error (annotated with the attempt count once a retry happened).
 */
export async function transcribeAudio(
  filePath: string,
  endpoint: TranscriptionEndpoint,
  options: TranscribeAudioOptions,
): Promise<TranscribeResult> {
  for (let retryIndex = 0; ; retryIndex++) {
    const attempt = await transcribeAudioOnce(filePath, endpoint, options.timeoutMs);
    if (attempt.ok) return attempt;

    const delayMs = getTranscribeRetryDelayMs({
      failureKind: attempt.failureKind,
      retryIndex,
      retryAfterSec: attempt.retryAfterSec,
      retryDelaysMs: options.retryDelaysMs,
    });
    const attemptCount = retryIndex + 1;
    if (delayMs === null) {
      return {
        ok: false,
        error: attemptCount > 1 ? `${attempt.error} (after ${attemptCount} attempts)` : attempt.error,
      };
    }
    options.onRetry?.({ attemptNumber: attemptCount, error: attempt.error, delayMs });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
