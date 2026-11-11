/**
 * @description The usage lines of an account (`utils/claudeProfileUsageLines.ts`) — the ONE renderer behind the
 * rows of `/accounts` and the usage block of `/limits`. Pinned, in two locales:
 *
 *   • the line: `⏱ 5h 5% 🔄 in 4h · week 20% 🔄 in 5d 8h · Fable 4% 🔄 in 5d 8h` — a space between a percentage
 *     and its reset, no arrow;
 *   • Fable is written only when the snapshot has that window; 5h and weekly always (`—` when missing);
 *   • an unknown reset is the bare percent (the weekly reset stands in for an unknown 5h one);
 *   • the stale mark, the limit mark, nothing for an account never polled;
 *   • an account billed to API credits: its spend, and — when the operator gave a Console figure — the bonus credit line
 *     (`🎁 API credit ≈ $61.20 of $200.00 · $6.51 spent via the bot since 07.11 · expires 15.11`), used up, or expired.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runWithLocale } from '../i18n';
import { formatClaudeProfileUsageLines } from '../utils/claudeProfileUsageLines';
import type { ClaudeUsageBucket, ClaudeUsageSnapshot } from '../utils/claudeUsage';
import type { ClaudeApiCreditAnchor } from '../utils/claudeApiCredit';

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

  it('an account frozen by an expired token — figures read at 100 % before their resets passed — shows a bare 0 % with the stale mark, never «100% 🔄 in 1m»', () => {
    const minutesAgo = (minutes: number): string => new Date(nowMs - minutes * 60_000).toISOString();
    const frozen = buildSnapshot([session(100, minutesAgo(1)), weekly(100, minutesAgo(30)), fable(100, minutesAgo(30))], true);
    const [line] = formatClaudeProfileUsageLines({ usage: { ...frozen, error: 'token expired' } }, 'UTC', nowMs);
    assert.equal(line, '    ⏱ 5h 0% · week 0% · Fable 0% (stale)');
    assert.doesNotMatch(line, /100%|in 1m/);
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

describe('formatClaudeProfileUsageLines: the bonus API credit of an account billed to API credits', () => {
  const creditNowMs = Date.parse('2026-11-07T10:00:00Z');
  const anchor: ClaudeApiCreditAnchor = { remainingUsd: 67.71, grantUsd: 200, anchoredAt: '2026-11-07T08:00:00.000Z', expiresOn: '2026-11-15' };
  const spend = { since: anchor.anchoredAt, usd: 6.51 };
  const apiSpend = { totalUsd: 12.34, since: '2026-11-06T17:21:00.000Z', lastTurnUsd: 0.25, lastTurnAt: '2026-11-07T09:30:00.000Z' };
  const spendLine = '    💳 $12.34 spent since 06.11 · last turn $0.25';
  const lines = (source: Parameters<typeof formatClaudeProfileUsageLines>[0], atMs = creditNowMs) => formatClaudeProfileUsageLines({ billing: 'api', ...source }, 'UTC', atMs);

  it('with the operator\'s figure: left, of the grant, spent via the bot since the figure, the expiry — under the spend line', () => {
    assert.deepEqual(lines({ apiSpend, creditAnchor: anchor, creditSpend: spend }), [
      spendLine,
      '    🎁 API credit ≈ $61.20 of $200.00 · $6.51 spent via the bot since 07.11 · expires 15.11',
    ]);
  });

  it('leaves out the grant and the expiry when none was given, and counts nothing spent before the first turn after the figure', () => {
    assert.deepEqual(
      lines({ creditAnchor: { remainingUsd: 12.5, anchoredAt: anchor.anchoredAt } }),
      ['    🎁 API credit ≈ $12.50 · $0.00 spent via the bot since 07.11'],
    );
  });

  it('shows the figure\'s day in the instance zone and the expiry as a plain day, with the year when it is not this one', () => {
    assert.deepEqual(
      formatClaudeProfileUsageLines({ billing: 'api', creditAnchor: { ...anchor, anchoredAt: '2026-11-07T22:30:00.000Z', expiresOn: '2027-01-15' } }, 'Asia/Tbilisi', creditNowMs),
      ['    🎁 API credit ≈ $67.71 of $200.00 · $0.00 spent via the bot since 08.11 · expires 15.01.2027'],
    );
  });

  it('with no figure and no renewal the «💳» line already says the spend since the first turn: no second line saying it again', () => {
    assert.deepEqual(lines({ apiSpend }), [spendLine]);
    assert.deepEqual(lines({}), [], 'nothing counted, nothing to say');
  });

  it('probably used up after a refusal — with the spend since when a figure or a renewal gives its own period, just «probably used up» when the «💳» line carries the spend; no second used-up line', () => {
    assert.deepEqual(lines({ apiSpend, creditExhaustedAt: '2026-11-07T09:00:00.000Z' }), [spendLine, '    🎁 API credit probably used up — top it up, then pick the account again'], 'the spend is in the line above, and the way back is told');
    assert.deepEqual(
      lines({ apiSpend, creditAnchor: anchor, creditSpend: spend, creditExhaustedAt: '2026-11-07T09:00:00.000Z' }),
      [spendLine, '    🎁 API credit probably used up · $6.51 spent since 07.11 — top it up, then pick the account again'],
    );
    const renewedAt = '2026-11-07T07:00:00.000Z';
    assert.deepEqual(
      lines({ apiSpend, creditRenewedAt: renewedAt, creditSpend: { since: renewedAt, usd: 1 }, creditExhaustedAt: '2026-11-07T09:00:00.000Z' }),
      [spendLine, '    🎁 API credit probably used up · $1.00 spent since 07.11 — top it up, then pick the account again'],
      'a renewal is a period of its own too',
    );
    assert.deepEqual(lines({ creditExhaustedAt: '2026-11-07T09:00:00.000Z' }), ['    🎁 API credit probably used up — top it up, then pick the account again']);
  });

  it('after a refusal the operator acted on (picked the account again): says it was refused and awaits the answer — neither «used up» nor the stale remainder', () => {
    const unconfirmed = lines({ apiSpend, creditAnchor: anchor, creditSpend: spend, creditUnconfirmedSince: '2026-11-07T09:00:00.000Z' });
    assert.deepEqual(unconfirmed, [spendLine, '    🎁 API credit: refused 07.11 — the next turn that goes through shows it is back']);
    assert.ok(!unconfirmed.some((line) => line.includes('≈') || line.includes('used up')));
    assert.deepEqual(lines({ creditUnconfirmedSince: '2026-11-07T09:00:00.000Z' }), ['    🎁 API credit: refused 07.11 — the next turn that goes through shows it is back']);
  });

  it('a refusal older than the figure is no news: the estimate stands', () => {
    const [line] = lines({ creditAnchor: anchor, creditExhaustedAt: '2026-11-06T09:00:00.000Z' });
    assert.match(line, /^ {4}🎁 API credit ≈ \$67\.71 /);
  });

  it('after a renewal the bot detected: the last given grant, the counter from the renewal, the expiry to be checked on the Console', () => {
    const renewedAt = '2026-11-07T09:00:00.000Z';
    assert.deepEqual(
      lines({ creditAnchor: anchor, creditSpend: { since: renewedAt, usd: 0.25 }, creditRenewedAt: renewedAt }),
      ['    🎁 API credit renewed ≈ 07.11 · ≈ $199.75 of $200.00 · $0.25 spent via the bot · check expiry in Console › Billing'],
    );
  });

  it('after a renewal with no grant ever given: only the renewal day and the spend since — no remainder', () => {
    const renewedAt = '2026-11-07T09:00:00.000Z';
    assert.deepEqual(lines({ creditSpend: { since: renewedAt, usd: 0.25 }, creditRenewedAt: renewedAt }), ['    🎁 API credit renewed ≈ 07.11 · $0.25 spent since']);
    assert.deepEqual(
      lines({ creditAnchor: { remainingUsd: 3, anchoredAt: '2026-11-01T00:00:00.000Z' }, creditRenewedAt: renewedAt }),
      ['    🎁 API credit renewed ≈ 07.11 · $0.00 spent since'],
      'a figure without a grant gives nothing to re-anchor on',
    );
  });

  it('a figure given AFTER the renewal is the newer news and takes over again', () => {
    const [line] = lines({ creditAnchor: anchor, creditRenewedAt: '2026-11-06T09:00:00.000Z' });
    assert.match(line, /^ {4}🎁 API credit ≈ \$67\.71 of \$200\.00 · /);
  });

  it('says expired past the expiry day and names the command that sets the new figure for THIS profile', () => {
    assert.deepEqual(
      lines({ name: 'console', creditAnchor: anchor, creditSpend: spend }, Date.parse('2026-11-16T00:00:00Z')),
      ['    🎁 API credit expired 15.11 — give the new figure: charness claude-profiles credit console <left>'],
    );
    assert.match(lines({ creditAnchor: anchor }, Date.parse('2026-11-16T00:00:00Z'))[0], /credit <profile> <left>$/, 'a source without a name leaves a placeholder');
  });

  it('writes no credit line for an account that is not billed to API credits', () => {
    assert.deepEqual(formatClaudeProfileUsageLines({ billing: 'subscription', creditAnchor: anchor, creditSpend: spend }, 'UTC', creditNowMs), []);
    assert.deepEqual(formatClaudeProfileUsageLines({ creditAnchor: anchor }, 'UTC', creditNowMs), []);
  });

  it('keeps the plain used-up line for a subscription account a refusal landed on', () => {
    assert.deepEqual(
      formatClaudeProfileUsageLines({ billing: 'subscription', creditExhaustedAt: '2026-11-07T09:00:00.000Z' }, 'UTC', creditNowMs),
      ['    💸 API credits used up — top them up, then pick it again'],
    );
  });

  it('is localised', async () => {
    const russian = await runWithLocale('ru', async () => lines({ creditAnchor: anchor, creditSpend: spend }));
    assert.deepEqual(russian, ['    🎁 API-кредит ≈ $61.20 из $200.00 · через бота потрачено $6.51 с 07.11 · истекает 15.11']);
    const probably = await runWithLocale('ru', async () => lines({ apiSpend, creditAnchor: anchor, creditSpend: spend, creditExhaustedAt: '2026-11-07T09:00:00.000Z' }));
    assert.equal(probably[1], '    🎁 API-кредит, вероятно, израсходован · $6.51 потрачено с 07.11 — пополни и выбери аккаунт снова');
    const unconfirmed = await runWithLocale('ru', async () => lines({ creditUnconfirmedSince: '2026-11-07T09:00:00.000Z' }));
    assert.equal(unconfirmed[0], '    🎁 API-кредит: отказ 07.11 — следующий ход, который пройдёт, покажет, что он вернулся');
  });
});
