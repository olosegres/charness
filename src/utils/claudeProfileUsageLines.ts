/**
 * The usage lines of one Claude account profile — what `/accounts` prints under a profile row and `/limits`
 * prints at the top of its screen. ONE renderer for both, so the two screens can never word a window differently.
 */
import { t } from '../i18n';
import type { ClaudeProfileBilling } from './claudeProfiles';
import { formatSpendSinceDay, formatUsd, type ClaudeApiSpend } from './claudeApiSpend';
import { getClaudeApiCreditEstimate, type ClaudeApiCreditAnchor, type ClaudeApiCreditEstimate, type ClaudeApiCreditSpend } from './claudeApiCredit';
import {
  formatClaudeUsageBucket,
  formatClaudeUsageResetAt,
  getClaudeUsageBucket,
  type ClaudeRelativeResetWords,
  type ClaudeUsageBucketKind,
  type ClaudeUsageSnapshot,
} from './claudeUsage';

/**
 * What the lines read of a profile: its usage snapshot, limit mark, billing and used-up-credits mark (a state record and
 * a usage view both fit).
 */
export interface ClaudeProfileUsageSource {
  /** The profile's name: the expired-credit line names the command that sets the new figure for it. */
  name?: string;
  usage?: ClaudeUsageSnapshot;
  limitedUntil?: string | null;
  billing?: ClaudeProfileBilling | null;
  creditExhaustedAt?: string | null;
  apiSpend?: ClaudeApiSpend;
  /** The operator's Console figure (`utils/claudeApiCredit.ts`): an account billed to API credits shows its estimate. */
  creditAnchor?: ClaudeApiCreditAnchor;
  creditSpend?: ClaudeApiCreditSpend;
  /** When the bot detected that the used-up credit was back (the credit period starts there). */
  creditRenewedAt?: string;
  /** The refusal the operator acted on: the account is usable again, the renewal still awaited. */
  creditUnconfirmedSince?: string;
}

/** What the expired-credit line names when the source carries no profile name (a placeholder the operator replaces). */
const unknownProfileName = '<profile>';

/** The localised words of a relative reset («🔄 in 2h»). */
function getRelativeResetWords(): ClaudeRelativeResetWords {
  return { pattern: t('usage.resetIn'), day: t('usage.unitDay'), hour: t('usage.unitHour'), minute: t('usage.unitMinute') };
}

/**
 * @description The profile's usage as display lines: the windows as `used% 🔄 reset` — 5h and weekly always (`—`
 * for one the snapshot lacks), Fable only when the account HAS that window (a corporate seat has none: nothing
 * is written about it; a window whose reset has passed since it was read shows `0%`) — `(stale)` when the last poll could not refresh, and the limit mark while it holds, the
 * reset instant in `timezone`, and the used-up-credits mark while it holds. An account billed to API credits has no
 * windows (its row already says it pays per use): what it spent through the bot and the one credit line
 * (`utils/claudeApiCredit.ts`: the spend of the credit period, the operator's figure when there is one, and the «probably
 * used up» sign in place of the plain used-up mark). The lines carry the
 * locale's own indentation (they hang under a row); empty for an account with nothing to show.
 */
export function formatClaudeProfileUsageLines(source: ClaudeProfileUsageSource | undefined, timezone: string, nowMs: number): string[] {
  if (source?.billing === 'api') return formatApiBillingLines(source, timezone, nowMs);
  const lines: string[] = [];
  const usage = source?.usage;
  if (usage && usage.buckets.length > 0) {
    const words = getRelativeResetWords();
    // An unknown 5h reset shows the weekly window's instead (with neither, the bare percent).
    const weeklyBucket = getClaudeUsageBucket(usage, 'weekly_all');
    const read = (kind: ClaudeUsageBucketKind) => formatClaudeUsageBucket(getClaudeUsageBucket(usage, kind), nowMs, {
      words,
      fallbackBucket: kind === 'session' ? weeklyBucket : null,
    });
    const stale = usage.isStale ? t('account.row.usageStale') : '';
    const hasFable = getClaudeUsageBucket(usage, 'weekly_scoped') !== null;
    const fable = hasFable ? t('account.row.usageFable', { fable: read('weekly_scoped') }) : '';
    lines.push(t('account.row.usage', { session: read('session'), weekly: read('weekly_all'), fable }) + stale);
  }
  if (source?.limitedUntil && Date.parse(source.limitedUntil) > nowMs) {
    lines.push(t('account.row.limited', { until: formatClaudeUsageResetAt(source.limitedUntil, timezone, nowMs) }));
  }
  // The refusal can come from any account (its billing unrecorded, extra usage): the mark keeps it out of the chain.
  if (source?.creditExhaustedAt) lines.push(t('account.row.creditExhausted'));
  return lines;
}

/**
 * The lines of an account billed to API credits: its spend through the bot, and the one credit line
 * (`formatClaudeApiCreditLine`) that tells how the credit stands when the spend line does not already — it also carries the
 * «probably used up» sign, so this account has no separate used-up line.
 */
function formatApiBillingLines(source: ClaudeProfileUsageSource, timezone: string, nowMs: number): string[] {
  const lines: string[] = [];
  if (source.apiSpend) lines.push(t('account.row.apiSpend', formatClaudeApiSpendWords(source.apiSpend, timezone, nowMs)));
  const credit = getClaudeApiCreditEstimate({
    anchor: source.creditAnchor,
    renewedAt: source.creditRenewedAt,
    spend: source.creditSpend,
    apiSpend: source.apiSpend,
    creditExhaustedAt: source.creditExhaustedAt,
    creditUnconfirmedSince: source.creditUnconfirmedSince,
    nowMs,
  });
  const creditLine = credit ? formatClaudeApiCreditLine(credit, source.name ?? unknownProfileName, timezone, nowMs) : null;
  if (creditLine !== null) lines.push(creditLine);
  return lines;
}

/**
 * The expiry day as a date: `15.11` (the year when it is not this one), like every other date of these lines. The day is
 * a plain calendar day, so it is read in UTC — no zone shifts it.
 */
function formatCreditExpiryDay(expiresOn: string, nowMs: number): string {
  return formatSpendSinceDay(`${expiresOn}T00:00:00Z`, 'UTC', nowMs);
}

/**
 * @description The one line of the bonus API credit (`utils/claudeApiCredit.ts`), `null` when the «💳» spend line above it
 * already says everything (no figure, no renewal, nothing refused: both would show the same total from the same day):
 *   • a figure from the operator: `🎁 API credit ≈ $61.20 of $200.00 · $6.51 spent via the bot since 07.11 · expires 15.11`
 *     (the grant and the expiry only when they were given) — the period differs from the «💳» lifetime total, so both show;
 *   • after a renewal the bot detected: `🎁 API credit renewed ≈ 08.11 · ≈ $199.75 of $200.00 · $0.25 spent via the bot ·
 *     check expiry in Console › Billing` on the last given grant, or only `renewed ≈ 08.11 · $0.25 spent since` without one;
 *   • after a refusal for the balance: `🎁 API credit probably used up · $6.51 spent since 07.11 — top it up, then pick the account
 *     again` — «probably»: the bot cannot be sure, and the daily recheck ends it by itself — or just `probably used up` when the
 *     «💳» line carries the spend; the tail is what the old used-up line told, so a topped-up balance is picked again at once;
 *   • after a refusal the operator acted on (picked the account again): `refused 07.11 — the next turn that goes through shows
 *     it is back` — no claim of «used up» and no stale remainder;
 *   • past the expiry day the operator gave: `expired`, with the command that sets the new figure.
 * The «≈» and «via the bot» say what the figures are: the bot's own count, not the Console's balance.
 */
function formatClaudeApiCreditLine(credit: ClaudeApiCreditEstimate, profileName: string, timezone: string, nowMs: number): string | null {
  if (credit.status === 'expired') return t('account.row.apiCreditExpired', { day: formatCreditExpiryDay(credit.expiresOn, nowMs), name: profileName });
  const spent = formatUsd(credit.spentUsd);
  const since = credit.since === null ? '' : formatSpendSinceDay(credit.since, timezone, nowMs);
  const isPeriodOfItsOwn = credit.basis === 'anchor' || credit.basis === 'renewal';
  if (credit.status === 'probablyUsedUp') {
    // The old used-up line told what to do; this one still does (the refusal notice in the topic says it once and scrolls away).
    const pickAgain = t('account.row.apiCreditPickAgain');
    return (isPeriodOfItsOwn ? t('account.row.apiCreditProbablyUsedUp', { spent, since }) : t('account.row.apiCreditProbablyUsedUpBare')) + pickAgain;
  }
  if (credit.status === 'unconfirmed') {
    return t('account.row.apiCreditUnconfirmed', { day: credit.unconfirmedSince === null ? '' : formatSpendSinceDay(credit.unconfirmedSince, timezone, nowMs) });
  }
  if (credit.basis === 'anchor' && credit.leftUsd !== null) {
    return t('account.row.apiCredit', {
      left: formatUsd(credit.leftUsd),
      grant: credit.grantUsd === null ? '' : t('account.row.apiCreditGrant', { grant: formatUsd(credit.grantUsd) }),
      spent,
      since,
      expires: credit.expiresOn === null ? '' : t('account.row.apiCreditExpires', { day: formatCreditExpiryDay(credit.expiresOn, nowMs) }),
    });
  }
  if (credit.basis === 'renewal') {
    return credit.leftUsd !== null && credit.grantUsd !== null
      ? t('account.row.apiCreditRenewedEstimate', { since, left: formatUsd(credit.leftUsd), grant: formatUsd(credit.grantUsd), spent })
      : t('account.row.apiCreditRenewed', { since, spent });
  }
  return null;
}

/** The placeholders every spend text fills: `total`, `since` (the day, in `timezone`), `last` (the last turn's). */
export function formatClaudeApiSpendWords(spend: ClaudeApiSpend, timezone: string, nowMs: number): { total: string; since: string; last: string } {
  return { total: formatUsd(spend.totalUsd), since: formatSpendSinceDay(spend.since, timezone, nowMs), last: formatUsd(spend.lastTurnUsd) };
}
