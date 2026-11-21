/**
 * @description What the accounts notes' tests share: a fixed «now» and a usage cache of two signed-in subscriptions (`work`
 * soonest weekly reset, `default` far behind), as the `claude_profiles` credit report the notes read.
 *
 * Matches neither runner glob; imported by the limit-notes tests.
 */

import { buildClaudeProfilesCreditReport } from '../utils/claudeProfileUsageViews';
import type { ClaudeProfilesReport, ClaudeProfileUsageView, ClaudeUsageSnapshot } from '../utils/claudeUsage';

export const minuteMs = 60 * 1000;
export const hourMs = 60 * minuteMs;
export const nowMs = Date.parse('2026-11-21T14:05:00Z');

export function buildUsage(input: { session: number; weekly: number; weeklyResetHours: number; isStale?: boolean }): ClaudeUsageSnapshot {
  return {
    fetchedAt: new Date(nowMs).toISOString(),
    source: 'api',
    ...(input.isStale === true ? { isStale: true } : {}),
    buckets: [
      { kind: 'session', percent: input.session, resetsAt: new Date(nowMs + 3 * hourMs).toISOString(), scopeModel: null },
      { kind: 'weekly_all', percent: input.weekly, resetsAt: new Date(nowMs + input.weeklyResetHours * hourMs).toISOString(), scopeModel: null },
    ],
  };
}

export function buildView(name: string, usage: ClaudeUsageSnapshot): ClaudeProfileUsageView {
  return { name, configDir: name === 'default' ? null : `/home/user/.charness/claude-profiles/${name}`, loggedIn: true, email: `${name}@example.com`, subscriptionType: 'max', usage, limitedUntil: null, billing: 'subscription', creditExhaustedAt: null };
}

export function buildViews(workWeekly = 62, isStale = false): ClaudeProfileUsageView[] {
  return [
    buildView('default', buildUsage({ session: 10, weekly: 20, weeklyResetHours: 120, isStale })),
    buildView('work', buildUsage({ session: 30, weekly: workWeekly, weeklyResetHours: 43, isStale })),
  ];
}

export function buildReport(workWeekly = 62, isStale = false): ClaudeProfilesReport {
  return buildClaudeProfilesCreditReport(buildViews(workWeekly, isStale), null, nowMs, { chainScope: null });
}
