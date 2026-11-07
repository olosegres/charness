/**
 * @description The daily recheck of an API account the bot believes has used up its credit (`creditExhaustedAt`, shown as
 * «probably used up», `claudeApiCredit.ts`): one tiny request on that account's OWN key, to learn whether the balance is
 * back (the monthly bonus renews by itself, with no sign the bot can read).
 *
 *   • refused for the balance («credit balance is too low») → still used up, nothing changes;
 *   • any other answer or failure (a 401, a 5xx, a timeout, no network) → no conclusion, ONE log line, no retry;
 *   • answered → the credit is back: the bot records a RENEWAL (`onRenewed`) and its spend counter starts over.
 *
 * Never on a subscription account (only `billing: 'api'`), never more than once per interval (a day) per account — the
 * attempt is recorded BEFORE the request, in the account's persisted record, so a restart, a hang or a failure does not
 * bring it round again sooner. A real turn that goes through on the account is a recheck too (the bot's turn-cost path),
 * and a refused one moves the mark, so the day starts from it.
 *
 * The request is `POST {ANTHROPIC_BASE_URL or the API}/v1/messages` with `max_tokens: 1` on the cheapest model, a bounded
 * timeout and no retries; the key travels only in the `x-api-key` header and is never logged or part of a result.
 */

import { creditBalanceExhaustedRe } from '../apiErrorRetry';
import type { ClaudeProfileBilling } from './claudeProfiles';

/** One recheck a day per account. */
export const claudeApiCreditRecheckIntervalMs = 24 * 3_600_000;

/** How often the bot looks for an account whose day is up (the granularity of «a day», not a rate of requests). */
export const claudeApiCreditRecheckPollMs = 30 * 60_000;

/** The API root the request goes to when `ANTHROPIC_BASE_URL` (the variable Claude Code itself honours) is not set. */
const anthropicApiRoot = 'https://api.anthropic.com';

/** The cheapest model: the request only has to be answered or refused for the balance. */
export const claudeApiCreditProbeModel = 'claude-haiku-5-5';

const anthropicApiVersion = '2023-06-01';

/** The probe is bounded: a hung request ends the attempt (the day is spent) instead of holding the timer. */
export const claudeApiCreditProbeTimeoutMs = 15_000;

/** How much of an error body is read to look for the balance wording. */
const probeBodyMaxChars = 2_000;

/** What the request answered, as the recheck reads it. `inconclusive` names no key and no body: a status or an error kind. */
export type ClaudeApiCreditProbeOutcome =
  | { kind: 'renewed' }
  | { kind: 'stillUsedUp' }
  | { kind: 'inconclusive'; reason: string };

/** The part of `fetch` the probe uses, injectable so a test never reaches the network. */
export type ClaudeApiCreditProbeFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

/** Where the request goes: `ANTHROPIC_BASE_URL` when it is a plain http(s) URL (what the account's sessions use), else the API. */
export function getClaudeApiCreditProbeUrl(env: Readonly<Record<string, string | undefined>>): string {
  const configured = env.ANTHROPIC_BASE_URL?.trim();
  let root = anthropicApiRoot;
  if (configured) {
    try {
      const parsed = new URL(configured);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') root = configured.replace(/\/+$/, '');
    } catch {
      // Not a URL: the sessions' own client would fail on it too; the recheck uses the API.
    }
  }
  return `${root}/v1/messages`;
}

/**
 * @description Ask the API with `apiKey` whether it still refuses for the balance (see the module). One request, no retry;
 * never throws; the key is in the header only.
 */
export async function probeClaudeApiCredit(
  apiKey: string,
  options: { url?: string; fetchImpl?: ClaudeApiCreditProbeFetch; timeoutMs?: number } = {},
): Promise<ClaudeApiCreditProbeOutcome> {
  const fetchImpl: ClaudeApiCreditProbeFetch = options.fetchImpl ?? (globalThis.fetch as unknown as ClaudeApiCreditProbeFetch);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? claudeApiCreditProbeTimeoutMs);
  try {
    const response = await fetchImpl(options.url ?? getClaudeApiCreditProbeUrl(process.env), {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': anthropicApiVersion, 'content-type': 'application/json' },
      body: JSON.stringify({ model: claudeApiCreditProbeModel, max_tokens: 1, messages: [{ role: 'user', content: '.' }] }),
      signal: controller.signal,
    });
    if (response.status >= 200 && response.status < 300) return { kind: 'renewed' };
    const body = (await response.text()).slice(0, probeBodyMaxChars);
    if (creditBalanceExhaustedRe.test(body)) return { kind: 'stillUsedUp' };
    return { kind: 'inconclusive', reason: `http ${response.status}` };
  } catch (e) {
    return { kind: 'inconclusive', reason: e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'network error' };
  } finally {
    clearTimeout(timer);
  }
}

/** The milliseconds of an ISO instant; 0 for none or an unreadable one (a mark nobody can date is as old as can be). */
function parseInstantMs(iso: string | null): number {
  const parsedMs = iso === null ? Number.NaN : Date.parse(iso);
  return Number.isNaN(parsedMs) ? 0 : parsedMs;
}

/**
 * @description Is an account's recheck due? Only while it is marked used up, and a full interval after the LATER of the mark
 * (the refusal that set it — fresh news in itself) and the last recheck.
 */
export function checkIsClaudeApiCreditRecheckDue(input: {
  creditExhaustedAt: string | null;
  creditRecheckedAt: string | null;
  nowMs: number;
  intervalMs: number;
}): boolean {
  if (input.creditExhaustedAt === null) return false;
  const lastNewsMs = Math.max(parseInstantMs(input.creditExhaustedAt), parseInstantMs(input.creditRecheckedAt));
  return input.nowMs - lastNewsMs >= input.intervalMs;
}

/** What the recheck reads of a profile. */
export interface ClaudeApiCreditRecheckProfile {
  name: string;
  billing: ClaudeProfileBilling | null;
  /** The profile's directory (`null` = the default profile, which is never an API account of the bot's own). */
  configDir: string | null;
  creditExhaustedAt: string | null;
  creditRecheckedAt: string | null;
}

/** What the recheck needs from the bot. */
export interface ClaudeApiCreditRecheckPorts {
  nowMs: () => number;
  intervalMs: number;
  listProfiles: () => ClaudeApiCreditRecheckProfile[];
  /** The key the profile's own sessions use (`readClaudeProfileApiKey`). */
  readApiKey: (configDir: string) => string | null;
  probe: (apiKey: string) => Promise<ClaudeApiCreditProbeOutcome>;
  /** Persist that a recheck of `name` was ATTEMPTED at `atIso` (before the request goes out). */
  markRechecked: (name: string, atIso: string) => void;
  /** The balance is back: record the renewal at `atIso`. */
  onRenewed: (name: string, atIso: string) => void;
  log: (line: string) => void;
}

/** What one pass did to each account whose day was up. */
export interface ClaudeApiCreditRecheckResult {
  name: string;
  outcome: ClaudeApiCreditProbeOutcome | { kind: 'noKey' };
}

/**
 * @description One pass: every API account marked used up whose day is up gets ONE probe, in turn. Subscription accounts and
 * accounts not marked are not touched. An account the bot holds no key for says so in one line (the day is spent too).
 */
export async function runDueClaudeApiCreditRechecks(ports: ClaudeApiCreditRecheckPorts): Promise<ClaudeApiCreditRecheckResult[]> {
  const results: ClaudeApiCreditRecheckResult[] = [];
  for (const profile of ports.listProfiles()) {
    const nowMs = ports.nowMs();
    if (profile.billing !== 'api' || profile.configDir === null) continue;
    if (!checkIsClaudeApiCreditRecheckDue({ creditExhaustedAt: profile.creditExhaustedAt, creditRecheckedAt: profile.creditRecheckedAt, nowMs, intervalMs: ports.intervalMs })) continue;
    const atIso = new Date(nowMs).toISOString();
    ports.markRechecked(profile.name, atIso);
    const apiKey = ports.readApiKey(profile.configDir);
    if (apiKey === null) {
      ports.log(`[credit] ${profile.name}: no API key the bot can read in the account's directory, so its used-up credit cannot be rechecked`);
      results.push({ name: profile.name, outcome: { kind: 'noKey' } });
      continue;
    }
    const outcome = await ports.probe(apiKey);
    results.push({ name: profile.name, outcome });
    if (outcome.kind === 'renewed') {
      ports.log(`[credit] ${profile.name}: the daily recheck was answered — the credit is back`);
      ports.onRenewed(profile.name, atIso);
    } else if (outcome.kind === 'inconclusive') {
      ports.log(`[credit] ${profile.name}: the daily recheck gave no answer about the balance (${outcome.reason}); asked again in a day`);
    }
  }
  return results;
}

/**
 * @description Run {@link runDueClaudeApiCreditRechecks} now and then every `pollMs`; the timer does not hold the process
 * open, a pass that is still running is not started twice. Returns the stop function.
 */
export function startClaudeApiCreditRechecks(ports: ClaudeApiCreditRecheckPorts, pollMs: number): () => void {
  let isRunning = false;
  const runPass = (): void => {
    if (isRunning) return;
    isRunning = true;
    runDueClaudeApiCreditRechecks(ports)
      .catch((e) => ports.log(`[credit] the daily recheck failed: ${e instanceof Error ? e.message : 'unknown error'}`))
      .finally(() => { isRunning = false; });
  };
  runPass();
  const timer = setInterval(runPass, pollMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
