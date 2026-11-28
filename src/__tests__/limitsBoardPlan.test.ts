/**
 * `utils/limitsBoardPlan.ts` — the two pure pieces of the `/limits` switch board.
 *
 *   - the ROWS: order (the Claude accounts, then connected OpenCode providers), a label of `[✓ ]<program> · <name>`
 *     and nothing more — no figure, no reset, no ⛔, no model, even on the active row — the ✓ on the active row only, an
 *     account that cannot work kept as a `🔑` row that is no switch target (it stays on the board, never vanishes) where a
 *     sign-in mends it — signed out, expired, refused by the API — and with NO row where it does not (its organization turned
 *     Claude subscription use off), the General board (the default account carries the ✓);
 *   - the USAGE BLOCK of the message: the heading and a line per signed-in account / connected provider that has a figure
 *     or a limit, in exactly the wording `/accounts` prints under a row (the one renderer both screens share), and for an
 *     account that cannot work a line worded by WHY (`🔑 not signed in`, `🔑 sign-in expired`, `🔑 refused by the API (401/403)`,
 *     `🚫 its organization turned it off`), none (and no heading) when there is nothing to show.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runWithLocale } from '../i18n';
import { buildLimitsBoardRows, formatLimitsUsageBlock, type LimitsBoardInput, type LimitsUsageBlockInput } from '../utils/limitsBoardPlan';
import { formatClaudeProfileUsageLines } from '../utils/claudeProfileUsageLines';
import type { ClaudeProfileUsageView, ClaudeUsageBucket, ClaudeUsageSnapshot } from '../utils/claudeUsage';
import type { AgentAuthErrorReason } from '../types';
import type { FallbackChainEntry, FallbackDetection } from '../utils/fallbackChain';

const nowMs = Date.parse('2026-10-17T10:00:00Z');
const words = { claude: 'Claude', openCode: 'OpenCode' };
const inHours = (hours: number): string => new Date(nowMs + hours * 3_600_000).toISOString();

const bucket = (kind: ClaudeUsageBucket['kind'], percent: number, resetsInHours = 3): ClaudeUsageBucket => ({ kind, percent, resetsAt: inHours(resetsInHours), scopeModel: null });
const snapshot = (buckets: ClaudeUsageBucket[], isStale = false): ClaudeUsageSnapshot => ({ fetchedAt: new Date(nowMs).toISOString(), source: 'api', buckets, ...(isStale ? { isStale: true, error: 'token expired' } : {}) });
/** The two shared windows as `/accounts` shows them: the 5-hour one resets in 3 h, the weekly one in 6 days. */
const usageOf = (session: number, weekly: number): ClaudeUsageSnapshot => snapshot([bucket('session', session, 3), bucket('weekly_all', weekly, 6 * 24)]);

function profile(name: string, overrides: Partial<ClaudeProfileUsageView> = {}): ClaudeProfileUsageView {
  return { name, configDir: null, loggedIn: true, email: `${name}@example.com`, subscriptionType: 'max', usage: undefined, limitedUntil: null, billing: null, creditExhaustedAt: null, ...overrides };
}

/** An account the CLI refused on a turn for `reason`: `loggedIn` is `false` while that stands, as the usage views build it. */
function refused(reason: AgentAuthErrorReason, overrides: Partial<ClaudeProfileUsageView> = {}): Partial<ClaudeProfileUsageView> {
  return { loggedIn: false, authRefusal: { at: new Date(nowMs).toISOString(), reason }, ...overrides };
}

function detectionOf(claudeProfiles: ClaudeProfileUsageView[], openCodeModels: string[] = [], openCodeLimits: Record<string, string> = {}): FallbackDetection {
  return { claudeProfiles, openCodeModels, recentOpenCodeModels: [], openCodeLimits };
}

function buildRows(overrides: Partial<LimitsBoardInput> = {}): ReturnType<typeof buildLimitsBoardRows> {
  return buildLimitsBoardRows({ detection: detectionOf([]), current: null, words, ...overrides });
}

function buildBlock(overrides: Partial<LimitsUsageBlockInput> = {}): string {
  return formatLimitsUsageBlock({ detection: detectionOf([]), openCodeProviderUsage: {}, nowMs, timezone: 'UTC', ...overrides });
}

const claudeHere = (profileName: string, model: string | null = null): FallbackChainEntry => ({ backend: 'claude', profile: profileName, model });

describe('buildLimitsBoardRows', () => {
  it('lists the Claude accounts in the order given, then the OpenCode providers in catalog order; a signed-out account stays, as a 🔑 sign-in row that is never active', () => {
    const rows = buildRows({
      current: claudeHere('out'),
      detection: detectionOf(
        [profile('default'), profile('out', { loggedIn: false }), profile('work')],
        ['openrouter/gpt-5-mini', 'openai/gpt-5', 'openrouter/deepseek-chat'],
      ),
    });
    assert.deepEqual(rows.map((row) => [row.kind, row.id, row.label, row.isActive]), [
      ['claude', 'default', 'Claude · default', false],
      ['claudeSignIn', 'out', '🔑 Claude · out', false],
      ['claude', 'work', 'Claude · work', false],
      ['opencode', 'openrouter', 'OpenCode · openrouter', false],
      ['opencode', 'openai', 'OpenCode · openai', false],
    ]);
  });

  it('a sign-in row exists where a sign-in mends the account — never signed in, signed out, expired, refused by the API — and not where it does not (its organization turned the use off)', () => {
    const rows = buildRows({
      detection: detectionOf([
        profile('fresh', { loggedIn: false }),
        profile('signed', refused('signedOut')),
        profile('bare', refused('rejected')),
        profile('org', refused('orgDisabled')),
        profile('work'),
      ]),
    });
    assert.deepEqual(rows.map((row) => [row.kind, row.label]), [
      ['claudeSignIn', '🔑 Claude · fresh'],
      ['claudeSignIn', '🔑 Claude · signed'],
      ['claudeSignIn', '🔑 Claude · bare'],
      ['claude', 'Claude · work'],
    ]);
  });

  it('a signed-out account billed to API credits is a plain 🔑 row too: its tap signs in, it never spends', () => {
    const [row] = buildRows({ detection: detectionOf([profile('console', { loggedIn: false, billing: 'api' })]) });
    assert.deepEqual([row.kind, row.label], ['claudeSignIn', '🔑 Claude · console']);
  });

  it('an account that was never probed counts as signed in', () => {
    assert.deepEqual(buildRows({ detection: detectionOf([profile('default', { loggedIn: undefined })]) }).map((row) => row.id), ['default']);
  });

  it('a label is the name only: no usage, no reset, no ⛔, no model — whatever the account or the provider has', () => {
    const rows = buildRows({
      current: claudeHere('perf', 'opus'),
      detection: detectionOf(
        [
          profile('perf', { usage: snapshot([bucket('session', 5), bucket('weekly_all', 78), bucket('weekly_scoped', 90)]) }),
          profile('limited', { limitedUntil: inHours(2), usage: usageOf(100, 40) }),
          profile('stale', { usage: snapshot([bucket('session', 61)], true) }),
        ],
        ['openai/gpt-5', 'openai/gpt-5-mini'],
        { 'openai/gpt-5': inHours(5), 'openai/gpt-5-mini': inHours(2) },
      ),
    });
    assert.deepEqual(rows.map((row) => row.label), ['✓ Claude · perf', 'Claude · limited', 'Claude · stale', 'OpenCode · openai']);
  });

  it('the ✓ opens the active row only', () => {
    const rows = buildRows({
      current: claudeHere('perf', 'opus'),
      detection: detectionOf([profile('perf'), profile('default')], ['openai/gpt-5']),
    });
    assert.deepEqual(rows.map((row) => [row.label, row.isActive]), [
      ['✓ Claude · perf', true],
      ['Claude · default', false],
      ['OpenCode · openai', false],
    ]);
  });

  it('an OpenCode topic: the ✓ is on its provider, the model not named; an OpenCode on the server\'s default model carries no ✓', () => {
    const detection = detectionOf([profile('default')], ['openai/gpt-5', 'openrouter/gpt-5-mini']);
    const here = buildRows({ detection, current: { backend: 'opencode', providerId: 'openai', modelId: 'gpt-5' } });
    assert.deepEqual(here.map((row) => row.label), ['Claude · default', '✓ OpenCode · openai', 'OpenCode · openrouter']);
    assert.equal(buildRows({ detection, current: null }).some((row) => row.isActive), false);
  });

  it('General: the default account carries the ✓ with no model', () => {
    const rows = buildRows({ current: claudeHere('perf'), detection: detectionOf([profile('default'), profile('perf')], ['openai/gpt-5']) });
    assert.deepEqual(rows.map((row) => row.label), ['Claude · default', '✓ Claude · perf', 'OpenCode · openai']);
  });

  it('the program names come from the caller (the active locale)', () => {
    const rows = buildRows({ detection: detectionOf([profile('work')], ['openai/gpt-5']), words: { claude: 'Клод', openCode: 'ОпенКод' } });
    assert.deepEqual(rows.map((row) => row.label), ['Клод · work', 'ОпенКод · openai']);
  });

  it('an account is named by its display name (its view\'s label), cut with … when a phone would not fit it; the tap still carries the id', () => {
    const long = 'Sergei Solomatkin — corporate seat';
    const rows = buildRows({
      current: claudeHere('work'),
      detection: detectionOf([profile('default', { label: 'Main' }), profile('work', { label: 'Sergei.Solo@work' }), profile('seat', { label: long }), profile('out', { label: 'Old one', loggedIn: false })]),
    });
    assert.deepEqual(rows.map((row) => [row.kind, row.id, row.name, row.label]), [
      ['claude', 'default', 'Main', 'Claude · Main'],
      ['claude', 'work', 'Sergei.Solo@work', '✓ Claude · Sergei.Solo@work'],
      ['claude', 'seat', long, 'Claude · Sergei Solomatkin — cor…'],
      ['claudeSignIn', 'out', 'Old one', '🔑 Claude · Old one'],
    ]);
  });
});

describe('formatLimitsUsageBlock', () => {
  it('a signed-in account with a figure: the heading and `<name> — <the /accounts usage line>`', () => {
    assert.equal(
      buildBlock({ detection: detectionOf([profile('default', { usage: usageOf(14, 3) })]) }),
      'Usage (% used)\ndefault — ⏱ 5h 14% 🔄 in 3h · week 3% 🔄 in 6d',
    );
  });

  it('names an account by its display name, whole — a long one too — and one that cannot work as well', () => {
    const long = 'Sergei Solomatkin — corporate seat';
    assert.equal(
      buildBlock({ detection: detectionOf([profile('work', { label: long, usage: usageOf(14, 3) }), profile('out', { label: 'Old one', ...refused('signedOut') })]) }),
      `Usage (% used)\n${long} — ⏱ 5h 14% 🔄 in 3h · week 3% 🔄 in 6d\nOld one — 🔑 sign-in expired`,
    );
  });

  it('is the very line `/accounts` prints under the row (one renderer): the block adds the name and drops the row indent', () => {
    const source = profile('perf', { limitedUntil: inHours(2), usage: snapshot([bucket('session', 5), bucket('weekly_all', 78), { ...bucket('weekly_scoped', 90), scopeModel: 'fable' }], true) });
    const [first, ...rest] = formatClaudeProfileUsageLines(source, 'UTC', nowMs);
    assert.deepEqual(buildBlock({ detection: detectionOf([source]) }).split('\n').slice(1), [`perf — ${first.trimStart()}`, ...rest]);
  });

  it('Fable is shown when the account has that window; the stale marker and the limit mark are the /accounts ones', () => {
    const block = buildBlock({
      detection: detectionOf([
        profile('perf', { usage: snapshot([bucket('session', 5), bucket('weekly_all', 78), { ...bucket('weekly_scoped', 90), scopeModel: 'fable' }]) }),
        profile('old', { usage: snapshot([bucket('session', 61), bucket('weekly_all', 20)], true) }),
        profile('limited', { limitedUntil: inHours(2), usage: usageOf(100, 40) }),
      ]),
    });
    assert.deepEqual(block.split('\n'), [
      'Usage (% used)',
      'perf — ⏱ 5h 5% 🔄 in 3h · week 78% 🔄 in 3h · Fable 90% 🔄 in 3h',
      'old — ⏱ 5h 61% 🔄 in 3h · week 20% 🔄 in 3h (stale)',
      'limited — ⏱ 5h 100% 🔄 in 3h · week 40% 🔄 in 6d',
      '    ⛔ at its limit until 12:00',
    ]);
  });

  it('a limited account with no figure has its limit as the line; the date comes with a reset that is not today', () => {
    const block = buildBlock({ detection: detectionOf([profile('today', { limitedUntil: inHours(2) }), profile('later', { limitedUntil: inHours(30) })]) });
    const [heading, today, later] = block.split('\n');
    assert.equal(heading, 'Usage (% used)');
    assert.equal(today, 'today — ⛔ at its limit until 12:00');
    assert.match(later, /^later — ⛔ at its limit until [A-Z][a-z]{2} 16:00$/);
  });

  it('an account never polled and not limited and a past limit mark have no line; with no line at all there is no block and no heading', () => {
    assert.equal(buildBlock({ detection: detectionOf([profile('fresh'), profile('past', { limitedUntil: inHours(-1) })]) }), '');
    assert.equal(buildBlock(), '');
  });

  it('an account the CLI refused as signed out has the line `<name> — 🔑 sign-in expired` in its place among the accounts, whatever it was last polled at — the board never silently drops it', () => {
    const block = buildBlock({ detection: detectionOf([profile('default', { usage: usageOf(14, 3) }), profile('out', refused('signedOut', { usage: usageOf(1, 2), limitedUntil: inHours(2) })), profile('work', { usage: usageOf(5, 9) })]) });
    assert.deepEqual(block.split('\n'), [
      'Usage (% used)',
      'default — ⏱ 5h 14% 🔄 in 3h · week 3% 🔄 in 6d',
      'out — 🔑 sign-in expired',
      'work — ⏱ 5h 5% 🔄 in 3h · week 9% 🔄 in 6d',
    ]);
  });

  it('every reason an account cannot work has its own words: not signed in (the /accounts words), sign-in expired, refused by the API, its organization turned it off — each with the mark of what the operator can do', () => {
    const block = buildBlock({
      detection: detectionOf([
        profile('fresh', { loggedIn: false }),
        profile('signed', refused('signedOut')),
        profile('bare', refused('rejected')),
        profile('org', refused('orgDisabled')),
      ]),
    });
    assert.deepEqual(block.split('\n'), [
      'Usage (% used)',
      'fresh — 🔑 not signed in',
      'signed — 🔑 sign-in expired',
      'bare — 🔑 refused by the API (401/403)',
      'org — 🚫 its organization turned it off',
    ]);
  });

  it('a lone account that cannot work is the whole block: the heading and its line', () => {
    assert.deepEqual(buildBlock({ detection: detectionOf([profile('out', refused('signedOut'))]) }).split('\n'), ['Usage (% used)', 'out — 🔑 sign-in expired']);
  });

  it('an account billed to API credits shows its spend and, with the operator\'s Console figure, the bonus credit estimate — the very lines `/accounts` prints', () => {
    const creditAnchor = { remainingUsd: 67.71, grantUsd: 200, anchoredAt: inHours(-2), expiresOn: '2026-10-25' };
    const source = profile('console', {
      billing: 'api',
      apiSpend: { totalUsd: 6.51, since: inHours(-30), lastTurnUsd: 0.25, lastTurnAt: inHours(-1) },
      creditAnchor,
      creditSpend: { since: creditAnchor.anchoredAt, usd: 6.51 },
    });
    assert.deepEqual(buildBlock({ detection: detectionOf([source]) }).split('\n'), [
      'Usage (% used)',
      'console — 💳 API · pay per use',
      '    💳 $6.51 spent since 16.10 · last turn $0.25',
      '    🎁 API credit ≈ $61.20 of $200.00 · $6.51 spent via the bot since 17.10 · expires 25.10',
    ]);
  });

  it('a connected OpenCode provider that reports usage (the ChatGPT subscription) follows the accounts: `openai (ChatGPT) — …`', () => {
    const block = buildBlock({
      detection: detectionOf([profile('default', { usage: usageOf(14, 3) })], ['openai/gpt-5', 'openrouter/gpt-5-mini']),
      openCodeProviderUsage: { openai: { authKind: 'subscription', usage: usageOf(12, 40) } },
    });
    assert.deepEqual(block.split('\n'), [
      'Usage (% used)',
      'default — ⏱ 5h 14% 🔄 in 3h · week 3% 🔄 in 6d',
      'openai (ChatGPT) — ⏱ 5h 12% 🔄 in 3h · week 40% 🔄 in 6d',
    ]);
  });

  it('a provider without usage (an API key), one that is no longer connected, and a stale one that kept no windows have no line; another provider with usage is named by its id', () => {
    const block = buildBlock({
      detection: detectionOf([], ['openai/gpt-5', 'openrouter/gpt-5-mini', 'google/gemini-2.5-pro']),
      openCodeProviderUsage: {
        openai: { authKind: 'subscription', usage: snapshot([], true) },
        openrouter: { authKind: 'apiKey' },
        gone: { authKind: 'subscription', usage: usageOf(1, 2) },
        google: { authKind: 'subscription', usage: snapshot([bucket('session', 3)], true) },
      },
    });
    assert.deepEqual(block.split('\n'), ['Usage (% used)', 'google — ⏱ 5h 3% 🔄 in 3h · week — (stale)']);
  });

  it('the providers follow the catalog order', () => {
    const block = buildBlock({
      detection: detectionOf([], ['google/gemini-2.5-pro', 'openai/gpt-5']),
      openCodeProviderUsage: { openai: { authKind: 'subscription', usage: usageOf(12, 40) }, google: { authKind: 'subscription', usage: usageOf(3, 4) } },
    });
    assert.deepEqual(block.split('\n').slice(1).map((line) => line.split(' — ')[0]), ['google', 'openai (ChatGPT)']);
  });

  it('the words of an account that cannot work come from the active locale too', () => {
    const block = runWithLocale('ru', () => buildBlock({ detection: detectionOf([profile('fresh', { loggedIn: false }), profile('signed', refused('signedOut')), profile('bare', refused('rejected')), profile('org', refused('orgDisabled'))]) }));
    assert.deepEqual(block.split('\n').slice(1), [
      'fresh — 🔑 не выполнен вход',
      'signed — 🔑 вход истёк',
      'bare — 🔑 отклонён API (401/403)',
      'org — 🚫 организация его отключила',
    ]);
  });

  it('the heading and the words come from the active locale', () => {
    const block = runWithLocale('ru', () => buildBlock({ detection: detectionOf([profile('perf', { usage: usageOf(5, 78) }), profile('work', { limitedUntil: inHours(2) })]) }));
    assert.equal(block.split('\n')[0], 'Лимиты (% израсходовано)');
    assert.match(block.split('\n')[1], /^perf — ⏱ 5ч 5% 🔄 через 3ч · неделя 78% 🔄 через 6д$/);
    assert.match(block.split('\n')[2], /^work — ⛔ /);
  });
});
