/**
 * The usage lines of one Claude account profile — what `/accounts` prints under a profile row and `/limits`
 * prints at the top of its screen. ONE renderer for both, so the two screens can never word a window differently.
 */
import { t } from '../i18n';
import {
  formatClaudeUsageBucket,
  formatClaudeUsageResetAt,
  getClaudeUsageBucket,
  type ClaudeRelativeResetWords,
  type ClaudeUsageBucketKind,
  type ClaudeUsageSnapshot,
} from './claudeUsage';

/** What the lines read of a profile: its usage snapshot and limit mark (a state record and a usage view both fit). */
export interface ClaudeProfileUsageSource {
  usage?: ClaudeUsageSnapshot;
  limitedUntil?: string | null;
}

/** The localised words of a relative reset («🔄 in 2h»). */
function getRelativeResetWords(): ClaudeRelativeResetWords {
  return { pattern: t('usage.resetIn'), day: t('usage.unitDay'), hour: t('usage.unitHour'), minute: t('usage.unitMinute') };
}

/**
 * @description The profile's usage as display lines: the three windows as `used% → reset` (`—` for a window the
 * account has no figure for — a corporate seat has no Fable window), `(stale)` when the last poll could not
 * refresh, and the limit mark while it holds, the reset instant in `timezone`. The lines carry the locale's own
 * indentation (they hang under a row); empty for a profile never polled and not limited.
 */
export function formatClaudeProfileUsageLines(source: ClaudeProfileUsageSource | undefined, timezone: string, nowMs: number): string[] {
  const lines: string[] = [];
  const usage = source?.usage;
  if (usage && usage.buckets.length > 0) {
    const words = getRelativeResetWords();
    // An unknown 5h reset shows the weekly window's instead of «?».
    const weeklyReset = getClaudeUsageBucket(usage, 'weekly_all')?.resetsAt ?? null;
    const read = (kind: ClaudeUsageBucketKind) => formatClaudeUsageBucket(getClaudeUsageBucket(usage, kind), nowMs, {
      words,
      fallbackResetsAt: kind === 'session' ? weeklyReset : null,
    });
    const stale = usage.isStale ? t('account.row.usageStale') : '';
    lines.push(t('account.row.usage', { session: read('session'), weekly: read('weekly_all'), fable: read('weekly_scoped') }) + stale);
  }
  if (source?.limitedUntil && Date.parse(source.limitedUntil) > nowMs) {
    lines.push(t('account.row.limited', { until: formatClaudeUsageResetAt(source.limitedUntil, timezone, nowMs) }));
  }
  return lines;
}
