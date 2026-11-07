/**
 * @description The Anthropic bonus API credit of an account billed to API credits (`billing: 'api'`): what the bot can
 * honestly tell about it, and the figure the operator may add.
 *
 * No credential the bot has can read that credit's balance, so the bot tells what it SAW: the account's spend through the
 * bot (`ClaudeApiSpend`, the turn costs of `claudeApiSpend.ts`), counted from the start of the current PERIOD — the
 * operator's last figure, or the bot's last detected renewal, or, with neither, the first counted turn. A refusal for a used-up
 * balance (`creditExhaustedAt`) says «probably used up» (the bot cannot be sure); the daily recheck
 * (`claudeApiCreditRecheck.ts`) or a billed turn that goes through ends it as a RENEWAL: the counter starts over from that
 * moment. When the operator acts on the account first (picks it again, signs it in again) the refusal is not forgotten:
 * the exclusion ends but the refusal stays as `creditUnconfirmedSince`, so the first billed turn that goes through is still
 * the renewal — the line says the refusal is unconfirmed, and claims neither «used up» nor a stale remainder.
 *
 * The operator's figure is an ANCHOR — what was left at an instant, how big the grant was, the day it expires — and adds
 * `left ≈ anchored amount − spend since` to the line. A renewal re-anchors on the LAST GIVEN grant (never one derived from
 * the plan: team grants are pooled and vary), expiry unknown; without a grant ever given there is no remainder to show.
 * It is all an estimate: spend by another key or machine is invisible to the bot.
 *
 * WHY the anchors are a file of their own (`DATA_DIR/claudeApiCredit.json`) and not part of the profile record: the
 * operator sets one from the `charness claude-profiles credit` command line, a separate process, while the live bot
 * rewrites the whole `state.json` from its memory on every save — a figure a second process wrote there would be lost
 * at the bot's next save. The command is the file's only writer, the bot only reads it (stamp-cached, so an edit shows
 * at once, no restart); what the bot counts and detects goes to its own record.
 *
 * Pure except the file store at the bottom.
 */

import * as path from 'path';
import { z } from 'zod';
import { createConfigFileLoader, writeJsonFileAtomically, type ConfigFileLoad, type ConfigValidation } from '../configDirFile';
import type { ClaudeApiSpend } from './claudeApiSpend';

/** The anchors file inside `DATA_DIR`. */
export const claudeApiCreditFileName = 'claudeApiCredit.json';

/** Not secret, but the operator's own: owner-only like `state.json`. */
const creditFileMode = 0o600;

const millisecondsPerDay = 24 * 3_600_000;

const centsPerUsd = 100;

/** A balance in whole cents: sums of turn costs carry float noise (`67.71 − 6.51`) the report must not show. */
function roundToCents(usd: number): number {
  return Math.round(usd * centsPerUsd) / centsPerUsd;
}

/** A calendar day: `2026-11-15`. */
const calendarDayPattern = /^\d{4}-\d{2}-\d{2}$/;

/** What the operator read on the Console at `anchoredAt` (`DATA_DIR/claudeApiCredit.json`, one per profile name). */
export interface ClaudeApiCreditAnchor {
  /** What was left at `anchoredAt`. */
  remainingUsd: number;
  /** The size of the grant the balance comes from, when the operator gave it. */
  grantUsd?: number;
  /** ISO instant the figure was given: the bot counts spend from here on. */
  anchoredAt: string;
  /** The last day (`YYYY-MM-DD`, UTC) the credit is usable; absent = no expiry given. */
  expiresOn?: string;
}

/** What an account spent through the bot since `since`, the start of its current anchor or renewal (`ClaudeProfileRecord.creditSpend`). */
export interface ClaudeApiCreditSpend {
  /** The start of the period this was counted from (the anchor's `anchoredAt`, or the renewal instant): another period starts the count over. */
  since: string;
  usd: number;
}

/**
 * @name ClaudeApiCreditBasis
 * @description What the counted spend starts at: the operator's `anchor`, the bot's detected `renewal` (the newer of the
 * two wins), else the account's `firstTurn` counted; `none` while nothing was counted.
 */
export type ClaudeApiCreditBasis = 'anchor' | 'renewal' | 'firstTurn' | 'none';

/** The current period of a profile's credit: what it starts at, and when. */
export interface ClaudeApiCreditPeriod {
  basis: ClaudeApiCreditBasis;
  /** ISO instant; `null` for `none`. */
  since: string | null;
}

/** What the period and the estimate read of a profile. */
export interface ClaudeApiCreditInput {
  anchor: ClaudeApiCreditAnchor | undefined;
  /** When the bot last detected a renewal (`ClaudeProfileRecord.creditRenewedAt`). */
  renewedAt: string | null | undefined;
  /** The spend counted since the period began (not the lifetime `apiSpend`). */
  spend: ClaudeApiCreditSpend | undefined;
  /** The account's whole spend through the bot: the spend of the `firstTurn` period. */
  apiSpend: Pick<ClaudeApiSpend, 'since' | 'totalUsd'> | undefined;
  creditExhaustedAt: string | null | undefined;
  /** The refusal the operator acted on (picked the account again, signed it in again): the exclusion is lifted, the renewal still awaited. */
  creditUnconfirmedSince?: string | null;
  nowMs: number;
}

/** The figures every estimate carries. */
interface ClaudeApiCreditEstimateFigures {
  basis: ClaudeApiCreditBasis;
  /** The start of the period `spentUsd` is counted from; `null` while nothing was counted. */
  since: string | null;
  /** What the account spent through the bot in the period. */
  spentUsd: number;
  /** `anchored amount (or the last grant, after a renewal) − spent`, never below 0; `null` when no figure is known. */
  leftUsd: number | null;
  grantUsd: number | null;
  /** When the bot detected the renewal the period starts at (`basis: 'renewal'`), else `null`. */
  renewedAt: string | null;
  /**
   * A refusal for a used-up balance came after the period began and the operator has not acted on it — whatever else the
   * estimate says (an expired credit with a pending refusal is still refused): what an agent reads as `probablyUsedUp`.
   */
  isProbablyUsedUp: boolean;
  /** The refusal the operator acted on, while it still awaits the answer that confirms the renewal; `null` otherwise. */
  unconfirmedSince: string | null;
}

/**
 * @name ClaudeApiCreditEstimate
 * @description What the bot can tell of a profile's credit at an instant. `probablyUsedUp`: a refusal for a used-up balance
 * came after the period began (the bot cannot be sure: spend elsewhere, a renewal it has not seen yet); `unconfirmed`: such a
 * refusal the operator has since acted on — no claim of «used up», no stale remainder; `expired`: the operator's expiry day
 * is over (so it always has one). `expiresOn` is the operator's, never guessed: unknown after a renewal.
 */
export type ClaudeApiCreditEstimate =
  | (ClaudeApiCreditEstimateFigures & { status: 'available' | 'probablyUsedUp' | 'unconfirmed'; expiresOn: string | null })
  | (ClaudeApiCreditEstimateFigures & { status: 'expired'; expiresOn: string });

/**
 * @description Has the credit's expiry day passed? The credit counts as usable through the WHOLE of `expiresOn` (UTC):
 * the Console shows a bare date, and calling a credit expired while it still works is the mistake nothing corrects —
 * the opposite one ends in the refusal the bot already detects.
 */
export function checkIsClaudeApiCreditExpired(expiresOn: string, nowMs: number): boolean {
  const dayStartMs = Date.parse(`${expiresOn}T00:00:00Z`);
  return !Number.isNaN(dayStartMs) && nowMs >= dayStartMs + millisecondsPerDay;
}

/**
 * @description Is the used-up-balance mark (`creditExhaustedAt`) still news next to the instant a period began (the operator's
 * figure)? Only when the refusal came AFTER it: a figure given later is the operator saying there is money, the same signal as
 * a billed turn going through, and an older refusal is the balance the figure replaced.
 */
export function checkIsClaudeApiCreditMarkCurrent(creditExhaustedAt: string | null | undefined, anchoredAt: string): boolean {
  if (!creditExhaustedAt) return false;
  return Date.parse(creditExhaustedAt) > Date.parse(anchoredAt);
}

/**
 * @description The profiles whose used-up evidence (the mark, or the refusal the operator acted on) an anchor has
 * superseded (the anchor is the same instant or newer): the bot clears it when it reads the anchors, so the figure and the
 * mark never tell opposite stories on one screen.
 */
export function listProfilesWithSupersededCreditEvidence(
  records: Readonly<Record<string, { creditExhaustedAt?: string; creditUnconfirmedSince?: string }>>,
  anchors: ClaudeApiCreditAnchors,
): string[] {
  return Object.entries(records)
    .filter(([name, record]) => {
      const anchor = anchors[name];
      if (anchor === undefined) return false;
      return [record.creditExhaustedAt, record.creditUnconfirmedSince].some((instant) => instant !== undefined && !checkIsClaudeApiCreditMarkCurrent(instant, anchor.anchoredAt));
    })
    .map(([name]) => name);
}

/**
 * @description The period the profile's credit is in: the operator's figure and the bot's detected renewal compete by time
 * (the newer wins), with neither the account's first counted turn starts it.
 */
export function getClaudeApiCreditPeriod(input: Pick<ClaudeApiCreditInput, 'anchor' | 'renewedAt' | 'apiSpend'>): ClaudeApiCreditPeriod {
  const { anchor, renewedAt } = input;
  if (anchor && (!renewedAt || Date.parse(anchor.anchoredAt) >= Date.parse(renewedAt))) return { basis: 'anchor', since: anchor.anchoredAt };
  if (renewedAt) return { basis: 'renewal', since: renewedAt };
  if (input.apiSpend) return { basis: 'firstTurn', since: input.apiSpend.since };
  return { basis: 'none', since: null };
}

/**
 * @description What the bot can tell of a profile's credit now, `null` when it knows nothing worth a line (no figure, no
 * renewal, nothing spent, no refusal). Expired (the operator's expiry day is over) wins over probably used up (a refusal
 * after the period began) which wins over available.
 */
export function getClaudeApiCreditEstimate(input: ClaudeApiCreditInput): ClaudeApiCreditEstimate | null {
  const period = getClaudeApiCreditPeriod(input);
  const isCounted = period.basis === 'anchor' || period.basis === 'renewal';
  const spentUsd = isCounted
    ? (input.spend?.since === period.since ? input.spend.usd : 0)
    : (period.basis === 'firstTurn' ? input.apiSpend?.totalUsd ?? 0 : 0);
  // After a renewal the credit is re-anchored on the LAST GIVEN grant: with none ever given, no remainder is known.
  const grantUsd = input.anchor?.grantUsd ?? null;
  const remainingUsd = period.basis === 'anchor' ? input.anchor?.remainingUsd ?? null : period.basis === 'renewal' ? grantUsd : null;
  const figures: Omit<ClaudeApiCreditEstimateFigures, 'isProbablyUsedUp' | 'unconfirmedSince'> = {
    basis: period.basis,
    since: period.since,
    spentUsd,
    leftUsd: remainingUsd === null ? null : Math.max(0, roundToCents(remainingUsd - spentUsd)),
    grantUsd,
    renewedAt: period.basis === 'renewal' ? period.since : null,
  };
  const expiresOn = period.basis === 'anchor' ? input.anchor?.expiresOn ?? null : null;
  const checkIsCurrent = (instant: string | null | undefined): boolean => !!instant && (period.since === null || checkIsClaudeApiCreditMarkCurrent(instant, period.since));
  const isProbablyUsedUp = checkIsCurrent(input.creditExhaustedAt);
  const unconfirmedSince = !isProbablyUsedUp && checkIsCurrent(input.creditUnconfirmedSince) ? input.creditUnconfirmedSince ?? null : null;
  const withEvidence = { ...figures, isProbablyUsedUp, unconfirmedSince };
  if (expiresOn !== null && checkIsClaudeApiCreditExpired(expiresOn, input.nowMs)) return { ...withEvidence, leftUsd: 0, status: 'expired', expiresOn };
  if (isProbablyUsedUp) return { ...withEvidence, leftUsd: figures.leftUsd === null ? null : 0, status: 'probablyUsedUp', expiresOn };
  // The refusal was acted on: the remainder the figures would give is the one the refusal just contradicted.
  if (unconfirmedSince !== null) return { ...withEvidence, leftUsd: null, status: 'unconfirmed', expiresOn };
  if (period.basis === 'none') return null;
  return { ...withEvidence, status: 'available', expiresOn };
}

/**
 * @description The spend counted after a turn that cost `turnCostUsd` in `period`; `null` when the period keeps no count of its
 * own (`firstTurn` reads the account's whole spend, `none` has none). A count of another period starts over.
 */
export function addClaudeApiCreditSpend(previous: ClaudeApiCreditSpend | undefined, period: ClaudeApiCreditPeriod, turnCostUsd: number): ClaudeApiCreditSpend | null {
  if ((period.basis !== 'anchor' && period.basis !== 'renewal') || period.since === null) return null;
  const countedUsd = previous?.since === period.since ? previous.usd : 0;
  return { since: period.since, usd: countedUsd + turnCostUsd };
}

/**
 * @description `YYYY-MM-DD` as a real calendar day (`2026-02-30` is not one); `null` when it is not. The command line
 * and the file share it.
 */
export function parseClaudeApiCreditDay(text: string): string | null {
  if (!calendarDayPattern.test(text)) return null;
  const parsedMs = Date.parse(`${text}T00:00:00Z`);
  return !Number.isNaN(parsedMs) && new Date(parsedMs).toISOString().startsWith(text) ? text : null;
}

// ── the anchors file ──

const anchorSchema = z.strictObject({
  remainingUsd: z.number().min(0),
  grantUsd: z.number().positive().optional(),
  anchoredAt: z.iso.datetime(),
  expiresOn: z.string().refine((day) => parseClaudeApiCreditDay(day) !== null, 'must be a calendar day, YYYY-MM-DD').optional(),
}).refine((anchor) => anchor.grantUsd === undefined || anchor.remainingUsd <= anchor.grantUsd, {
  path: ['remainingUsd'],
  message: 'must not be more than grantUsd',
});

const anchorsSchema = z.record(z.string().min(1), anchorSchema);

/** The anchors by profile name. */
export type ClaudeApiCreditAnchors = Readonly<Record<string, ClaudeApiCreditAnchor>>;

function validateClaudeApiCreditAnchors(parsedJson: object): ConfigValidation<ClaudeApiCreditAnchors> {
  const parsed = anchorsSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((issue) => `${claudeApiCreditFileName} ${issue.path.join('.') || '(root)'}: ${issue.message}`) };
  }
  return { ok: true, config: parsed.data };
}

const anchorsLoader = createConfigFileLoader<ClaudeApiCreditAnchors>({
  fileName: claudeApiCreditFileName,
  createEmpty: () => ({}),
  validate: validateClaudeApiCreditAnchors,
});

/** The broken states of the file already logged: one line per broken state for the whole process, not one per read. */
const reportedInvalidLoads = new WeakSet<ConfigFileLoad<ClaudeApiCreditAnchors>>();

/** @description Where the anchors live. */
export function getClaudeApiCreditFilePath(dataDir: string): string {
  return path.join(dataDir, claudeApiCreditFileName);
}

/**
 * @description The anchors of `dataDir`, re-read when the file changes (a repeated call costs one `stat`). A missing
 * file is no anchors. A broken file serves its last good copy (none at first) and ONE line says why — an anchor lost to
 * a typo would silently hide the line, so the log names the field.
 */
export function readClaudeApiCreditAnchors(dataDir: string): ClaudeApiCreditAnchors {
  const load = anchorsLoader.load(getClaudeApiCreditFilePath(dataDir));
  if (load.status !== 'invalid') return load.config;
  if (!reportedInvalidLoads.has(load)) {
    reportedInvalidLoads.add(load);
    console.warn(`[credit] ${load.errors.join('; ')} — ${load.config === null ? 'no API credit anchor is shown' : 'the last good anchors are kept'} until the file is fixed`);
  }
  return load.config ?? {};
}

/**
 * @description Give `profile` an anchor (`null` removes it) and write the file atomically; `false` when there was nothing
 * to remove (nothing written). Throws on an unwritable folder or a broken existing file — a broken file is never
 * overwritten (it holds other profiles' figures) and never read as «no figure».
 */
export function writeClaudeApiCreditAnchor(dataDir: string, profile: string, anchor: ClaudeApiCreditAnchor | null): boolean {
  const filePath = getClaudeApiCreditFilePath(dataDir);
  const load = anchorsLoader.load(filePath);
  if (load.status === 'invalid') throw new Error(`${load.errors.join('; ')} — fix or delete ${filePath} first`);
  const { [profile]: previousAnchor, ...others } = load.config;
  if (anchor === null && previousAnchor === undefined) return false;
  const next = anchor === null ? others : { ...others, [profile]: anchor };
  const validation = validateClaudeApiCreditAnchors(next);
  if (!validation.ok) throw new Error(`refusing to write an invalid ${claudeApiCreditFileName}: ${validation.errors.join('; ')}`);
  writeJsonFileAtomically(filePath, next, creditFileMode);
  return true;
}

/** @description Forget every cached load — for tests, which swap files under one path. */
export const resetClaudeApiCreditCache = anchorsLoader.resetCache;
