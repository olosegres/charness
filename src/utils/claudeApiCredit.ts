/**
 * @description The Anthropic bonus API credit of an account billed to API credits (`billing: 'api'`): the figure the
 * operator reads on the Console's Billing page, and the estimate the bot keeps from it.
 *
 * No credential the bot has can read that balance, so the operator gives it once: an ANCHOR — what was left at an
 * instant, how big the grant was, the day it expires. The bot then counts what the account spends through it
 * (`ClaudeApiCreditSpend`, fed by the same turn costs as `claudeApiSpend.ts`, from the anchor on) and shows
 * `left ≈ anchored amount − spend since`. It is an estimate: spend by another key or machine is invisible to the bot.
 * A refusal for a used-up balance (`creditExhaustedAt`) newer than the anchor overrides it, and a credit past its
 * expiry day is shown as expired until a new figure is given.
 *
 * WHY the anchors are a file of their own (`DATA_DIR/claudeApiCredit.json`) and not part of the profile record: the
 * operator sets one from the `charness claude-profiles credit` command line, a separate process, while the live bot
 * rewrites the whole `state.json` from its memory on every save — a figure a second process wrote there would be lost
 * at the bot's next save. The command is the file's only writer, the bot only reads it (stamp-cached, so an edit shows
 * at once, no restart); what the bot counts goes to its own record.
 *
 * Pure except the file store at the bottom.
 */

import * as path from 'path';
import { z } from 'zod';
import { createConfigFileLoader, writeJsonFileAtomically, type ConfigFileLoad, type ConfigValidation } from '../configDirFile';

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

/** What an account spent through the bot since the anchor `anchoredAt` was given (`ClaudeProfileRecord.creditSpend`). */
export interface ClaudeApiCreditSpend {
  /** The `anchoredAt` of the anchor this was counted from: another anchor starts the count over. */
  anchoredAt: string;
  usd: number;
}

/** The figures every estimate carries. */
interface ClaudeApiCreditEstimateFigures {
  /** `anchored amount − spent via the bot`, never below 0; 0 when used up or expired. */
  leftUsd: number;
  grantUsd: number | null;
  /** What the account spent through the bot since `anchoredAt`. */
  spentUsd: number;
  anchoredAt: string;
}

/**
 * @name ClaudeApiCreditEstimate
 * @description The estimate a profile's anchor and counted spend give at an instant. `usedUp`: a refusal for a used-up
 * balance came after the anchor; `expired`: the expiry day is over (so it always has one).
 */
export type ClaudeApiCreditEstimate =
  | (ClaudeApiCreditEstimateFigures & { status: 'available' | 'usedUp'; expiresOn: string | null })
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

/** Did the used-up-balance refusal come AFTER the figure was given (an older one is the balance the figure replaced)? */
function checkIsExhaustedSince(creditExhaustedAt: string | null | undefined, anchoredAt: string): boolean {
  if (!creditExhaustedAt) return false;
  return Date.parse(creditExhaustedAt) > Date.parse(anchoredAt);
}

/**
 * @description The estimate for a profile, `null` without an anchor. Expired wins over used up (a past credit is gone
 * whatever was spent); spend counted from another anchor is ignored.
 */
export function getClaudeApiCreditEstimate(input: {
  anchor: ClaudeApiCreditAnchor | undefined;
  spend: ClaudeApiCreditSpend | undefined;
  creditExhaustedAt: string | null | undefined;
  nowMs: number;
}): ClaudeApiCreditEstimate | null {
  const { anchor } = input;
  if (!anchor) return null;
  const spentUsd = input.spend?.anchoredAt === anchor.anchoredAt ? input.spend.usd : 0;
  const figures = { grantUsd: anchor.grantUsd ?? null, spentUsd, anchoredAt: anchor.anchoredAt };
  if (anchor.expiresOn !== undefined && checkIsClaudeApiCreditExpired(anchor.expiresOn, input.nowMs)) {
    return { ...figures, leftUsd: 0, status: 'expired', expiresOn: anchor.expiresOn };
  }
  const expiresOn = anchor.expiresOn ?? null;
  if (checkIsExhaustedSince(input.creditExhaustedAt, anchor.anchoredAt)) return { ...figures, leftUsd: 0, status: 'usedUp', expiresOn };
  return { ...figures, leftUsd: Math.max(0, roundToCents(anchor.remainingUsd - spentUsd)), status: 'available', expiresOn };
}

/** The spend after a turn that cost `turnCostUsd` on an account holding `anchor` (a count of another anchor starts over). */
export function addClaudeApiCreditSpend(previous: ClaudeApiCreditSpend | undefined, anchor: ClaudeApiCreditAnchor, turnCostUsd: number): ClaudeApiCreditSpend {
  const countedUsd = previous?.anchoredAt === anchor.anchoredAt ? previous.usd : 0;
  return { anchoredAt: anchor.anchoredAt, usd: countedUsd + turnCostUsd };
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
 * @description Give `profile` an anchor (`null` removes it) and write the file atomically. Throws on an unwritable folder
 * or a broken existing file — a broken file is never overwritten, it holds other profiles' figures.
 */
export function writeClaudeApiCreditAnchor(dataDir: string, profile: string, anchor: ClaudeApiCreditAnchor | null): void {
  const filePath = getClaudeApiCreditFilePath(dataDir);
  const load = anchorsLoader.load(filePath);
  if (load.status === 'invalid') throw new Error(`${load.errors.join('; ')} — fix or delete ${filePath} first`);
  const { [profile]: previousAnchor, ...others } = load.config;
  if (anchor === null && previousAnchor === undefined) return;
  const next = anchor === null ? others : { ...others, [profile]: anchor };
  const validation = validateClaudeApiCreditAnchors(next);
  if (!validation.ok) throw new Error(`refusing to write an invalid ${claudeApiCreditFileName}: ${validation.errors.join('; ')}`);
  writeJsonFileAtomically(filePath, next, creditFileMode);
}

/** @description Forget every cached load — for tests, which swap files under one path. */
export const resetClaudeApiCreditCache = anchorsLoader.resetCache;
