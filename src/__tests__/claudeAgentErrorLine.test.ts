/**
 * @description Unit tests for {@link ../adapters/claudeCliAdapter#getClaudeAgentErrorLine}
 * (plan S2) — the pure detector that finds a terminal provider / logged-out error
 * row in a scraped Claude pane WITHOUT false-firing on the agent's own answer
 * prose. A live 401 / logout is not inducible on demand (documented in
 * CLAUDE.md), so these REAL scraped line samples are the load-bearing proof.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ClaudeCliAdapter, getClaudeAgentErrorLine } from '../adapters/claudeCliAdapter';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { keyToString, type SessionKey } from '../sessionKey';
import type { AgentApiErrorClass } from '../types';
import { classifyAgentApiError } from '../apiErrorRetry';
import { getNewPaneContent } from '../utils/paneDiff';

const fixedNow = Date.parse('2026-07-01T10:00:00.000Z');

test('detect (a): `API Error:` at line start → the line', () => {
  const line = 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited';
  assert.equal(getClaudeAgentErrorLine(line), line);
});

test('detect (a): leading whitespace before `API Error:` still matches', () => {
  assert.equal(getClaudeAgentErrorLine('   API Error: 500 upstream'), '   API Error: 500 upstream');
});

test('detect (b): `⎿ … · API Error: 429` → the line (the old start-anchored gate missed this)', () => {
  const line = '⎿  overloaded · API Error: 429';
  assert.equal(getClaudeAgentErrorLine(line), line);
});

test('detect (c): `⎿  Not logged in · Please run /login` → the line', () => {
  const line = '⎿  Not logged in · Please run /login';
  assert.equal(getClaudeAgentErrorLine(line), line);
});

test('detect (c): mixed `⎿  Please run /login · API Error: 401 …` → the line', () => {
  const line = '⎿  Please run /login · API Error: 401 Invalid authentication credentials';
  assert.equal(getClaudeAgentErrorLine(line), line);
});

test('detect: finds the error row inside a full multi-line pane', () => {
  const pane = [
    '● Here is what I found in the code:',
    'The auth module reads a token from disk.',
    '⎿  Not logged in · Please run /login',
    '❯ ',
  ].join('\n');
  assert.equal(getClaudeAgentErrorLine(pane), '⎿  Not logged in · Please run /login');
});

test('NEGATIVE: agent prose quoting "not logged in" mid-sentence (no ⎿) → null', () => {
  const pane = [
    '● To reproduce: the user said they were not logged in yesterday,',
    'so the request failed. Run /login to fix it.',
    '❯ ',
  ].join('\n');
  assert.equal(getClaudeAgentErrorLine(pane), null);
});

test('NEGATIVE: prose with "API Error:" quoted mid-line (not at start, no ⎿) → null', () => {
  assert.equal(
    getClaudeAgentErrorLine('I saw an API Error: earlier but it recovered on its own'),
    null,
  );
});

// A TOOL result (Bash/Read/Grep) is rendered by the TUI UNDER a `⎿` marker, so a
// row starting with `⎿` that merely QUOTES an auth phrase deeper in the line must
// NOT fire — case (c) anchors the phrase to the row start. These are the exact
// live samples the agent tripped while grepping the bot's own logs/source in
// a live topic (2026-07-03).
test('NEGATIVE: a `⎿` tool-result row QUOTING the auth phrase deeper in the line → null', () => {
  // grep of the console log printing an old detection line under a Bash `⎿`.
  const grepEcho =
    '⎿  bot-console-2026070322.log:224:[Claude] API error detected: Not logged in · Please run /login';
  assert.equal(getClaudeAgentErrorLine(grepEcho), null);
  // a Read of apiErrorRetry.ts source whose comment lists the phrases.
  const sourceEcho = '⎿  67: * @description The auth phrases (please run /login, not logged in).';
  assert.equal(getClaudeAgentErrorLine(sourceEcho), null);
  // a real third-party CLI ("not logged in") under a `⎿` tool result.
  const ghEcho = '⎿  gh: not logged in to github.com. Run: gh auth login';
  assert.equal(getClaudeAgentErrorLine(ghEcho), null);
});

test('POSITIVE still holds: a real auth row LEADS with the phrase → detected', () => {
  assert.equal(
    getClaudeAgentErrorLine('⎿  Not logged in · Please run /login'),
    '⎿  Not logged in · Please run /login',
  );
  assert.equal(
    getClaudeAgentErrorLine('⎿  Please run /login · API Error: 401 Invalid authentication credentials'),
    '⎿  Please run /login · API Error: 401 Invalid authentication credentials',
  );
});

test('end-to-end: a detected auth row classifies to auth (the whole Claude logged-out path)', () => {
  const line = getClaudeAgentErrorLine('⎿  Not logged in · Please run /login');
  assert.ok(line !== null);
  assert.deepEqual(classifyAgentApiError(line, fixedNow), { kind: 'auth' });
});

test('end-to-end: a detected `⎿ … 429` row classifies to transient', () => {
  const line = getClaudeAgentErrorLine('⎿  overloaded · API Error: 429');
  assert.ok(line !== null);
  assert.deepEqual(classifyAgentApiError(line, fixedNow), { kind: 'transient' });
});

// Regression for the re-pin loop (live 2026-07-03): the logged-out
// `⎿ … /login` row lingers in the pane scrollback long after the user re-logs
// in. `handleAutoLifecycle` must detect it on the NEW pane delta, so the row
// fires `apiError('auth')` ONCE (first render) — not on every later redraw,
// which re-pinned "logged out, run /login" after a successful login. This walks
// the real set-diff (getNewPaneContent) that feeds the detector.
test('fire-once: a persistent logged-out row is NEW only on first appearance', () => {
  const paneBefore = ['● Working on it…', '❯ '].join('\n');
  const paneWithError = [
    '● Working on it…',
    '⎿  Not logged in · Please run /login',
    '❯ ',
  ].join('\n');

  // Poll 1 — the row first renders: it IS in the delta → detected + classified.
  const firstDelta = getNewPaneContent(paneBefore, paneWithError).text;
  const firstLine = getClaudeAgentErrorLine(firstDelta);
  assert.ok(firstLine !== null, 'first appearance must be detected');
  assert.deepEqual(classifyAgentApiError(firstLine, fixedNow), { kind: 'auth' });

  // Poll 2 — the login menu redraws while the SAME stale row still sits on the
  // pane. The set-diff yields only the new menu lines; the row is NOT new, so
  // the detector returns null and `apiError('auth')` does NOT re-fire.
  const paneLoginMenu = [
    '● Working on it…',
    '⎿  Not logged in · Please run /login',
    'Login',
    'Claude Code can be used with your Claude subscription…',
    '1. Subscription',
    '❯ ',
  ].join('\n');
  const secondDelta = getNewPaneContent(paneWithError, paneLoginMenu).text;
  assert.equal(
    getClaudeAgentErrorLine(secondDelta),
    null,
    'a stale logout row must not re-fire on a later redraw',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
//  Case (d): a usage/session-limit row (no `API Error:` marker at all)
// ─────────────────────────────────────────────────────────────────────────────

test('detect (d): the verbatim live session-limit row → the line', () => {
  const line = "You've hit your session limit · resets 10:50pm (UTC)";
  assert.equal(getClaudeAgentErrorLine(line), line);
});

test('detect (d): the limit row behind a `⎿` / `⏺` / `●` marker → the line', () => {
  for (const line of [
    '⎿  5-hour limit reached ∙ resets 3am',
    "⏺ You've hit your weekly limit · resets Monday",
    '●  Usage limit reached — resets at 9pm',
  ]) {
    assert.equal(getClaudeAgentErrorLine(line), line, line);
  }
});

test('detect (d): finds the limit row inside a full multi-line pane', () => {
  const pane = [
    '● Let me check the remaining work.',
    "You've hit your session limit · resets 10:50pm (UTC)",
    '❯ ',
  ].join('\n');
  assert.equal(getClaudeAgentErrorLine(pane), "You've hit your session limit · resets 10:50pm (UTC)");
});

// Same false-positive reasoning as the auth shape: a TOOL result is rendered under
// `⎿`, so a row that merely QUOTES a limit phrase deeper in the line (the agent
// grepping this very source, or a log echo) must NOT fire. The row lead-in allows
// only a few punctuation-free words, which a path / log prefix never is.
test('NEGATIVE: a `⎿` tool-result row QUOTING the limit phrase deeper in the line → null', () => {
  for (const line of [
    "⎿  bot-console-2026092400.log:88:[Claude] API error detected: You've hit your session limit",
    '⎿  src/apiErrorRetry.ts:120: * qualified limits: session limit, weekly limit, 5-hour limit',
    '⎿  README.md:12: the bot waits out a usage limit and resumes on its own',
  ]) {
    assert.equal(getClaudeAgentErrorLine(line), null, line);
  }
});

// Case (d) has no `⎿` / `API Error:` anchor, so a limit phrase at the START of a
// line is not enough on its own: the agent's OWN answer prose about limits would
// otherwise arm a 60-min wait and push a "continue" nudge into a healthy topic.
// The row must ALSO read like an error (`reached` / `resets` / `·` / …) — prose
// uses the bare verb ("limits reset weekly"), which is not in that list.
test('NEGATIVE: the agent\'s own prose leading with a limit phrase does NOT fire', () => {
  for (const line of [
    'Session limits reset weekly for every plan.',
    '  Usage limits apply per 5-hour window and reset automatically.',
    'Quota is the word for a per-account allowance.',
    "  Session limit handling is documented in CLAUDE.md, so I'll follow it.",
  ]) {
    assert.equal(getClaudeAgentErrorLine(line), null, line);
  }
});

test('end-to-end: a detected limit row classifies to usageLimit with a reset time', () => {
  const line = getClaudeAgentErrorLine("You've hit your session limit · resets 10:50pm (UTC)");
  assert.ok(line !== null);
  const cls = classifyAgentApiError(line, fixedNow);
  assert.equal(cls?.kind, 'usageLimit');
  assert.equal(cls?.resetAt, Date.parse('2026-07-01T22:50:00.000Z'));
});

// ─────────────────────────────────────────────────────────────────────────────
//  A usage WARNING is not a limit. Claude Code (2.1.304) words the non-blocking
//  `allowed_warning` status `Approaching <window> · resets <time>` or
//  `You've used N% of your <window> · resets <time>`, and the overage one
//  `You're close to your usage limit`; only `rejected` reads
//  `You've hit your <window> · resets <time>`. The warning row carries the window
//  name and the reset time, so it was detected and classified as an exhausted
//  limit: the topic got "Usage limit reached — will auto-resume after reset" while
//  the account still had room, and the work stopped until the reset.
// ─────────────────────────────────────────────────────────────────────────────

/** The warning rows the CLI renders, verbatim shapes from its message builder. */
const usageWarningRows = [
  'Approaching session limit · resets 11:29pm',
  'Approaching weekly limit · resets Oct 25, 3pm',
  'Approaching Opus limit · resets Oct 25, 3pm',
  '⎿  Approaching session limit · resets 11:29pm',
  "You've used 90% of your session limit · resets 11:29pm",
  "You've used 75% of your weekly limit · resets Oct 25, 3pm · Run /usage-credits to turn on extra usage",
  "You're close to your usage credit limit",
];

test('NEGATIVE: a usage WARNING row (allowed_warning) is not detected as a limit error', () => {
  for (const line of usageWarningRows) {
    assert.equal(getClaudeAgentErrorLine(line), null, line);
  }
});

test('NEGATIVE: a usage WARNING text never classifies as an exhausted usage limit', () => {
  for (const text of [
    ...usageWarningRows,
    // claude.ai / credits wordings (support article "Understanding Claude error messages"): work continues.
    '5-hour limit resets 11:29pm - continuing with usage credits',
    'Now using credits. Your plan limit resets Thu at 11:29pm',
    "You're now using extra usage · Your session limit resets 11:29pm",
    'Now using usage credits for Opus · Your Opus limit resets 11:29pm',
  ]) {
    assert.equal(classifyAgentApiError(text, fixedNow), null, text);
  }
});

test('a warning row followed by the real block in the same delta → the block row is the one detected', () => {
  const pane = [
    'Approaching session limit · resets 11:29pm',
    '● Working on the next step.',
    "You've hit your session limit · resets 11:29pm",
    '❯ ',
  ].join('\n');
  assert.equal(getClaudeAgentErrorLine(pane), "You've hit your session limit · resets 11:29pm");
});

test('adapter: a warning row on the pane arms NO limit wait; the block row that follows does', () => {
  const key: SessionKey = makeTelegramKey(-1001111111111, 42);
  const adapter = new ClaudeCliAdapter();
  const session = adapter['createSession']({
    key,
    workDir: '/tmp/work',
    sessionName: `claude-${keyToString(key)}`,
    claudeSessionId: '00000000-0000-4000-8000-000000000000',
    configDir: null,
    isActive: true,
    handledAutoEnter: false,
    handledAutoAccept: false,
  });
  const apiErrors: AgentApiErrorClass[] = [];
  adapter.on('apiError', (_key: SessionKey, apiError: AgentApiErrorClass) => {
    apiErrors.push(apiError);
  });
  const warningPane = ['● Refactoring the parser now.', 'Approaching session limit · resets 11:29pm', '❯ '].join('\n');
  adapter['handleAutoLifecycle'](session, warningPane, getNewPaneContent('● Refactoring the parser now.\n❯ ', warningPane).text);
  assert.equal(apiErrors.length, 0, 'a warning must not reach the bot as a usage-limit error');

  const blockedPane = `${warningPane}\nYou've hit your session limit · resets 11:29pm`;
  adapter['handleAutoLifecycle'](session, blockedPane, getNewPaneContent(warningPane, blockedPane).text);
  assert.deepEqual(apiErrors.map((apiError) => apiError.kind), ['usageLimit'], 'the real block still arms the wait');
});
