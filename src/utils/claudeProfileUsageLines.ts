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
  usage?: ClaudeUsageSnapshot;
  limitedUntil?: string | null;
  billing?: ClaudeProfileBilling | null;
  creditExhaustedAt?: string | null;
  apiSpend?: ClaudeApiSpend;
  /** The operator's Console figure (`utils/claudeApiCredit.ts`): an account billed to API credits shows its estimate. */
  creditAnchor?: ClaudeApiCreditAnchor;
  creditSpend?: ClaudeApiCreditSpend;
}

/** The localised words of a relative reset («🔄 in 2h»). */
function getRelativeResetWords(): ClaudeRelativeResetWords {
  return { pattern: t('usage.resetIn'), day: t('usage.unitDay'), hour: t('usage.unitHour'), minute: t('usage.unitMinute') };
}

/**
 * @description The profile's usage as display lines: the windows as `used% 🔄 reset` — 5h and weekly always (`—`
 * for one the snapshot lacks), Fable only when the account HAS that window (a corporate seat has none: nothing
 * is written about it) — `(stale)` when the last poll could not refresh, and the limit mark while it holds, the
 * reset instant in `timezone`, and the used-up-credits mark while it holds. An account billed to API credits has no
 * windows (its row already says it pays per use): what it spent through the bot, its bonus credit estimate when the
 * operator gave a Console figure (`utils/claudeApiCredit.ts`), and that mark. The lines carry the
 * locale's own indentation (they hang under a row); empty for an account with nothing to show.
 */
export function formatClaudeProfileUsageLines(source: ClaudeProfileUsageSource | undefined, timezone: string, nowMs: number): string[] {
  if (source?.billing === 'api') return formatApiBillingLines(source, timezone, nowMs);
  const lines: string[] = [];
  const usage = source?.usage;
  if (usage && usage.buckets.length > 0) {
    const words = getRelativeResetWords();
    // An unknown 5h reset shows the weekly window's instead (with neither, the bare percent).
    const weeklyReset = getClaudeUsageBucket(usage, 'weekly_all')?.resetsAt ?? null;
    const read = (kind: ClaudeUsageBucketKind) => formatClaudeUsageBucket(getClaudeUsageBucket(usage, kind), nowMs, {
      words,
      fallbackResetsAt: kind === 'session' ? weeklyReset : null,
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
 * The lines of an account billed to API credits: its spend through the bot, the estimate of its bonus credit when the
 * operator gave a figure, and the used-up mark while it holds.
 */
function formatApiBillingLines(source: ClaudeProfileUsageSource, timezone: string, nowMs: number): string[] {
  const lines: string[] = [];
  if (source.apiSpend) lines.push(t('account.row.apiSpend', formatClaudeApiSpendWords(source.apiSpend, timezone, nowMs)));
  const credit = getClaudeApiCreditEstimate({ anchor: source.creditAnchor, spend: source.creditSpend, creditExhaustedAt: source.creditExhaustedAt, nowMs });
  if (credit) lines.push(formatClaudeApiCreditLine(credit, timezone, nowMs));
  if (source.creditExhaustedAt) lines.push(t('account.row.creditExhausted'));
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
 * @description The one line of the bonus API credit (`utils/claudeApiCredit.ts`): `🎁 API credit ≈ $61.20 of $200.00 ·
 * $6.51 spent via the bot since 07.11 · expires 15.11` — the size of the grant and the expiry only when the operator gave
 * them; or `used up` after a refusal; or `expired` with the way to set the new figure. The «≈» and «via the bot» say what
 * the figure is: the Console's balance minus what the bot saw spent, not the balance itself.
 */
function formatClaudeApiCreditLine(credit: ClaudeApiCreditEstimate, timezone: string, nowMs: number): string {
  if (credit.status === 'expired') return t('account.row.apiCreditExpired', { day: formatCreditExpiryDay(credit.expiresOn, nowMs) });
  const expires = credit.expiresOn === null ? '' : t('account.row.apiCreditExpires', { day: formatCreditExpiryDay(credit.expiresOn, nowMs) });
  if (credit.status === 'usedUp') return t('account.row.apiCreditUsedUp', { expires });
  return t('account.row.apiCredit', {
    left: formatUsd(credit.leftUsd),
    grant: credit.grantUsd === null ? '' : t('account.row.apiCreditGrant', { grant: formatUsd(credit.grantUsd) }),
    spent: formatUsd(credit.spentUsd),
    since: formatSpendSinceDay(credit.anchoredAt, timezone, nowMs),
    expires,
  });
}

/** The placeholders every spend text fills: `total`, `since` (the day, in `timezone`), `last` (the last turn's). */
export function formatClaudeApiSpendWords(spend: ClaudeApiSpend, timezone: string, nowMs: number): { total: string; since: string; last: string } {
  return { total: formatUsd(spend.totalUsd), since: formatSpendSinceDay(spend.since, timezone, nowMs), last: formatUsd(spend.lastTurnUsd) };
}
