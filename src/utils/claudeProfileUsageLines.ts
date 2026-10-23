/**
 * The usage lines of one Claude account profile — what `/accounts` prints under a profile row and `/limits`
 * prints at the top of its screen. ONE renderer for both, so the two screens can never word a window differently.
 */
import { t } from '../i18n';
import type { ClaudeProfileBilling } from './claudeProfiles';
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
}

/** The localised words of a relative reset («🔄 in 2h»). */
function getRelativeResetWords(): ClaudeRelativeResetWords {
  return { pattern: t('usage.resetIn'), day: t('usage.unitDay'), hour: t('usage.unitHour'), minute: t('usage.unitMinute') };
}

/**
 * @description The profile's usage as display lines: the windows as `used% 🔄 reset` — 5h and weekly always (`—`
 * for one the snapshot lacks), Fable only when the account HAS that window (a corporate seat has none: nothing
 * is written about it) — `(stale)` when the last poll could not refresh, and the limit mark while it holds, the
 * reset instant in `timezone`. An account billed to API credits has no windows (its row already says it pays per
 * use): only the used-up mark while it holds. The lines carry the locale's own indentation (they hang under a row);
 * empty for an account with nothing to show.
 */
export function formatClaudeProfileUsageLines(source: ClaudeProfileUsageSource | undefined, timezone: string, nowMs: number): string[] {
  if (source?.billing === 'api') return formatApiBillingLines(source);
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
  return lines;
}

/** The lines of an account billed to API credits: the used-up mark while it holds. */
function formatApiBillingLines(source: ClaudeProfileUsageSource): string[] {
  return source.creditExhaustedAt ? [t('account.row.creditExhausted')] : [];
}
