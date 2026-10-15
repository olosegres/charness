/**
 * @description The usage lines of an account (`utils/claudeProfileUsageLines.ts`) — the ONE renderer behind the
 * rows of `/accounts` and the usage block of `/limits`. Pinned, in two locales:
 *
 *   • the line: `⏱ 5h 5% 🔄 in 4h · week 20% 🔄 in 5d 8h · Fable 4% 🔄 in 5d 8h` — a space between a percentage
 *     and its reset, no arrow;
 *   • Fable is written only when the snapshot has that window; 5h and weekly always (`—` when missing);
 *   • an unknown reset is the bare percent (the weekly reset stands in for an unknown 5h one);
 *   • the stale mark, the limit mark, nothing for an account never polled.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runWithLocale } from '../i18n';
import { formatClaudeProfileUsageLines } from '../utils/claudeProfileUsageLines';
import type { ClaudeUsageBucket, ClaudeUsageSnapshot } from '../utils/claudeUsage';

const nowMs = Date.parse('2026-10-12T10:00:00Z');
const inHours = (hours: number): string => new Date(nowMs + hours * 3_600_000 + 30_000).toISOString();

function buildSnapshot(buckets: ClaudeUsageBucket[], isStale = false): ClaudeUsageSnapshot {
  return { fetchedAt: new Date(nowMs).toISOString(), source: 'api', buckets, isStale };
}

const session = (percent: number, resetsAt: string | null): ClaudeUsageBucket => ({ kind: 'session', percent, resetsAt, scopeModel: null });
const weekly = (percent: number, resetsAt: string | null): ClaudeUsageBucket => ({ kind: 'weekly_all', percent, resetsAt, scopeModel: null });
const fable = (percent: number, resetsAt: string | null): ClaudeUsageBucket => ({ kind: 'weekly_scoped', percent, resetsAt, scopeModel: 'Fable' });

describe('formatClaudeProfileUsageLines', () => {
  it('writes each window as the percentage, a space and the relative reset — no arrow', () => {
    const lines = formatClaudeProfileUsageLines(
      { usage: buildSnapshot([session(5, inHours(4)), weekly(20, inHours(5 * 24 + 8)), fable(4, inHours(5 * 24 + 8))]) },
      'UTC',
      nowMs,
    );
    assert.deepEqual(lines, ['    ⏱ 5h 5% 🔄 in 4h · week 20% 🔄 in 5d 8h · Fable 4% 🔄 in 5d 8h']);
  });

  it('says nothing about Fable when the account has no such window; 5h and weekly stay, with a dash when missing', () => {
    assert.deepEqual(
      formatClaudeProfileUsageLines({ usage: buildSnapshot([session(5, inHours(4)), weekly(20, inHours(30))]) }, 'UTC', nowMs),
      ['    ⏱ 5h 5% 🔄 in 4h · week 20% 🔄 in 1d 6h'],
    );
    assert.deepEqual(
      formatClaudeProfileUsageLines({ usage: buildSnapshot([weekly(20, inHours(30))]) }, 'UTC', nowMs),
      ['    ⏱ 5h — · week 20% 🔄 in 1d 6h'],
      'a window the snapshot lacks (a stream frame carried only the weekly one) is a dash',
    );
  });

  it('an unknown reset is the bare percent; the weekly reset stands in for an unknown 5h one', () => {
    assert.deepEqual(
      formatClaudeProfileUsageLines({ usage: buildSnapshot([session(5, null), weekly(20, null), fable(4, null)]) }, 'UTC', nowMs),
      ['    ⏱ 5h 5% · week 20% · Fable 4%'],
    );
    assert.deepEqual(
      formatClaudeProfileUsageLines({ usage: buildSnapshot([session(5, null), weekly(20, inHours(30))]) }, 'UTC', nowMs),
      ['    ⏱ 5h 5% 🔄 in 1d 6h · week 20% 🔄 in 1d 6h'],
    );
  });

  it('marks a stale snapshot and a held limit; an account never polled and not limited has no lines', () => {
    const limitedUntil = new Date(nowMs + 3_600_000).toISOString();
    const lines = formatClaudeProfileUsageLines(
      { usage: buildSnapshot([session(100, limitedUntil)], true), limitedUntil },
      'UTC',
      nowMs,
    );
    assert.deepEqual(lines, ['    ⏱ 5h 100% 🔄 in 1h · week — (stale)', '    ⛔ at its limit until 11:00']);
    assert.deepEqual(formatClaudeProfileUsageLines({ limitedUntil: new Date(nowMs - 60_000).toISOString() }, 'UTC', nowMs), [], 'a past limit mark is no limit');
    assert.deepEqual(formatClaudeProfileUsageLines(undefined, 'UTC', nowMs), []);
  });

  it('is localised: the words and the relative reset follow the locale, the shape stays', async () => {
    const lines = await runWithLocale('ru', async () => formatClaudeProfileUsageLines(
      { usage: buildSnapshot([session(5, inHours(4)), weekly(20, inHours(5 * 24 + 8))]) },
      'UTC',
      nowMs,
    ));
    assert.deepEqual(lines, ['    ⏱ 5ч 5% 🔄 через 4ч · неделя 20% 🔄 через 5д 8ч']);
  });
});
