/**
 * `utils/limitsBoardPlan.ts` — the rows of the `/limits` board and their one label: order (signed-in Claude accounts, then
 * connected OpenCode providers), the ✓ on the active row, the model on the active row only, the status precedence
 * (⛔ until, else the usage, else nothing), the ⚠️ on stale usage, a provider limited by the earliest mark of its models,
 * a signed-out account left out, the General board (the default account carries the ✓).
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runWithLocale } from '../i18n';
import { buildLimitsBoardRows, type LimitsBoardInput } from '../utils/limitsBoardPlan';
import type { ClaudeProfileUsageView, ClaudeUsageBucket, ClaudeUsageSnapshot } from '../utils/claudeUsage';
import type { FallbackChainEntry } from '../utils/fallbackChain';

const nowMs = Date.parse('2026-10-17T10:00:00Z');
const words = { claude: 'Claude', openCode: 'OpenCode' };
const inHours = (hours: number): string => new Date(nowMs + hours * 3_600_000).toISOString();

const bucket = (kind: ClaudeUsageBucket['kind'], percent: number): ClaudeUsageBucket => ({ kind, percent, resetsAt: inHours(3), scopeModel: null });
const snapshot = (buckets: ClaudeUsageBucket[], isStale = false): ClaudeUsageSnapshot => ({ fetchedAt: new Date(nowMs).toISOString(), source: 'api', buckets, ...(isStale ? { isStale: true, error: 'token expired' } : {}) });

function profile(name: string, overrides: Partial<ClaudeProfileUsageView> = {}): ClaudeProfileUsageView {
  return { name, configDir: null, loggedIn: true, email: `${name}@example.com`, subscriptionType: 'max', usage: undefined, limitedUntil: null, ...overrides };
}

function build(overrides: Partial<LimitsBoardInput> = {}): ReturnType<typeof buildLimitsBoardRows> {
  return buildLimitsBoardRows({
    detection: { claudeProfiles: [], openCodeModels: [], recentOpenCodeModels: [], openCodeLimits: {} },
    openCodeProviderUsage: {},
    current: null,
    nowMs,
    timezone: 'UTC',
    words,
    ...overrides,
  });
}

const claudeHere = (profileName: string, model: string | null = null): FallbackChainEntry => ({ backend: 'claude', profile: profileName, model });

describe('buildLimitsBoardRows', () => {
  it('lists the signed-in Claude accounts in the order given, then the OpenCode providers in catalog order; a signed-out account is left out', () => {
    const rows = build({
      detection: {
        claudeProfiles: [profile('default'), profile('out', { loggedIn: false }), profile('work')],
        openCodeModels: ['openrouter/gpt-5-mini', 'openai/gpt-5', 'openrouter/deepseek-chat'],
        recentOpenCodeModels: [],
        openCodeLimits: {},
      },
    });
    assert.deepEqual(rows.map((row) => [row.kind, row.id, row.label]), [
      ['claude', 'default', 'Claude · default'],
      ['claude', 'work', 'Claude · work'],
      ['opencode', 'openrouter', 'OpenCode · openrouter'],
      ['opencode', 'openai', 'OpenCode · openai'],
    ]);
  });

  it('an account that was never probed counts as signed in', () => {
    assert.deepEqual(build({ detection: { claudeProfiles: [profile('default', { loggedIn: undefined })], openCodeModels: [], recentOpenCodeModels: [], openCodeLimits: {} } }).map((row) => row.id), ['default']);
  });

  it('the usage is the status when known: 5h and week as plain percents; a missing window is a dash; Fable is not on the label', () => {
    const rows = build({
      detection: {
        claudeProfiles: [
          profile('perf', { usage: snapshot([bucket('session', 5), bucket('weekly_all', 78), bucket('weekly_scoped', 90)]) }),
          profile('weekonly', { usage: snapshot([bucket('weekly_all', 20)]) }),
          profile('fableonly', { usage: snapshot([bucket('weekly_scoped', 90)]) }),
          profile('unpolled'),
        ],
        openCodeModels: [],
        recentOpenCodeModels: [],
        openCodeLimits: {},
      },
    });
    assert.deepEqual(rows.map((row) => row.label), [
      'Claude · perf — 5h 5% · week 78%',
      'Claude · weekonly — 5h — · week 20%',
      'Claude · fableonly',
      'Claude · unpolled',
    ]);
  });

  it('the ✓ opens the active row and the topic\'s model follows its name — on that row only', () => {
    const rows = build({
      current: claudeHere('perf', 'opus'),
      detection: { claudeProfiles: [profile('perf', { usage: snapshot([bucket('session', 5), bucket('weekly_all', 78)]) }), profile('default')], openCodeModels: ['openai/gpt-5'], recentOpenCodeModels: [], openCodeLimits: {} },
    });
    assert.deepEqual(rows.map((row) => [row.label, row.isActive]), [
      ['✓ Claude · perf · opus — 5h 5% · week 78%', true],
      ['Claude · default', false],
      ['OpenCode · openai', false],
    ]);
  });

  it('an OpenCode topic: the ✓ is on its provider with the model named; an OpenCode on the server\'s default model carries no ✓', () => {
    const detection = { claudeProfiles: [profile('default')], openCodeModels: ['openai/gpt-5', 'openrouter/gpt-5-mini'], recentOpenCodeModels: [], openCodeLimits: {} };
    const here = build({ detection, current: { backend: 'opencode', providerId: 'openai', modelId: 'gpt-5' } });
    assert.deepEqual(here.map((row) => row.label), ['Claude · default', '✓ OpenCode · openai · gpt-5', 'OpenCode · openrouter']);
    const unknown = build({ detection, current: null });
    assert.equal(unknown.some((row) => row.isActive), false);
  });

  it('a limited account shows ⛔ until its reset instead of the usage; the date comes with a reset that is not today', () => {
    const rows = build({
      detection: {
        claudeProfiles: [
          profile('today', { limitedUntil: inHours(2), usage: snapshot([bucket('session', 100), bucket('weekly_all', 40)]) }),
          profile('later', { limitedUntil: inHours(30) }),
          profile('over', { usage: snapshot([{ kind: 'session', percent: 100, resetsAt: inHours(1), scopeModel: null }, bucket('weekly_all', 40)]) }),
        ],
        openCodeModels: [],
        recentOpenCodeModels: [],
        openCodeLimits: {},
      },
    });
    assert.equal(rows[0].label, 'Claude · today — ⛔ until 12:00');
    assert.match(rows[1].label, /^Claude · later — ⛔ until [A-Z][a-z]{2} 16:00$/, 'the weekday joins the time when it is not today');
    assert.equal(rows[2].label, 'Claude · over — ⛔ until 11:00', 'a window at 100 % with a reset ahead is a limit too');
  });

  it('a limit mark in the past, or one on a window with no reset known, does not show ⛔', () => {
    const rows = build({
      detection: {
        claudeProfiles: [
          profile('past', { limitedUntil: inHours(-1), usage: snapshot([bucket('session', 30), bucket('weekly_all', 40)]) }),
          profile('noreset', { usage: snapshot([{ kind: 'session', percent: 100, resetsAt: null, scopeModel: null }]) }),
        ],
        openCodeModels: [],
        recentOpenCodeModels: [],
        openCodeLimits: {},
      },
    });
    assert.equal(rows[0].label, 'Claude · past — 5h 30% · week 40%');
    assert.equal(rows[1].label, 'Claude · noreset — 5h 100% · week —');
  });

  it('out-of-date usage keeps its numbers with a trailing ⚠️ and marks the row stale; a limited row shows no ⚠️', () => {
    const rows = build({
      detection: {
        claudeProfiles: [
          profile('old', { usage: snapshot([bucket('session', 61), bucket('weekly_all', 20)], true) }),
          profile('limitedold', { limitedUntil: inHours(2), usage: snapshot([bucket('session', 61)], true) }),
          profile('fresh', { usage: snapshot([bucket('session', 1), bucket('weekly_all', 2)]) }),
        ],
        openCodeModels: [],
        recentOpenCodeModels: [],
        openCodeLimits: {},
      },
    });
    assert.deepEqual(rows.map((row) => [row.label, row.isStale]), [
      ['Claude · old — 5h 61% · week 20% ⚠️', true],
      ['Claude · limitedold — ⛔ until 12:00', false],
      ['Claude · fresh — 5h 1% · week 2%', false],
    ]);
  });

  it('a provider is ⛔ until the EARLIEST limit mark of its models; a past mark and another provider\'s mark do not count', () => {
    const rows = build({
      detection: {
        claudeProfiles: [],
        openCodeModels: ['openai/gpt-5', 'openai/gpt-5-mini', 'openai/o3', 'openrouter/deepseek-chat'],
        recentOpenCodeModels: [],
        openCodeLimits: {
          'openai/gpt-5': inHours(5),
          'openai/gpt-5-mini': inHours(2),
          'openai/o3': inHours(-3),
          'openrouter/other': inHours(1),
        },
      },
    });
    assert.deepEqual(rows.map((row) => row.label), ['OpenCode · openai — ⛔ until 12:00', 'OpenCode · openrouter']);
  });

  it('a ChatGPT subscription provider shows its polled windows; an API-key provider (kind only) shows nothing; stale ones carry ⚠️', () => {
    const rows = build({
      detection: { claudeProfiles: [], openCodeModels: ['openai/gpt-5', 'openrouter/gpt-5-mini', 'google/gemini-2.5-pro'], recentOpenCodeModels: [], openCodeLimits: {} },
      openCodeProviderUsage: {
        openai: { authKind: 'subscription', usage: snapshot([bucket('session', 12), bucket('weekly_all', 40)]) },
        openrouter: { authKind: 'apiKey' },
        google: { authKind: 'subscription', usage: snapshot([bucket('session', 3)], true) },
      },
    });
    assert.deepEqual(rows.map((row) => row.label), [
      'OpenCode · openai — 5h 12% · week 40%',
      'OpenCode · openrouter',
      'OpenCode · google — 5h 3% · week — ⚠️',
    ]);
    assert.deepEqual(rows.map((row) => row.isStale), [false, false, true]);
  });

  it('General: the default account carries the ✓ with no model', () => {
    const rows = build({
      current: claudeHere('perf'),
      detection: { claudeProfiles: [profile('default'), profile('perf')], openCodeModels: ['openai/gpt-5'], recentOpenCodeModels: [], openCodeLimits: {} },
    });
    assert.deepEqual(rows.map((row) => row.label), ['Claude · default', '✓ Claude · perf', 'OpenCode · openai']);
  });

  it('the program names and the words come from the active locale', () => {
    const rows = runWithLocale('ru', () => build({
      detection: { claudeProfiles: [profile('perf', { usage: snapshot([bucket('session', 5), bucket('weekly_all', 78)]), limitedUntil: null }), profile('work', { limitedUntil: inHours(2) })], openCodeModels: [], recentOpenCodeModels: [], openCodeLimits: {} },
    }));
    assert.deepEqual(rows.map((row) => row.label), ['Claude · perf — 5ч 5% · неделя 78%', 'Claude · work — ⛔ до 12:00']);
  });
});
