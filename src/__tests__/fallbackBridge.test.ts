/**
 * @description Unit tests for {@link ../utils/fallbackBridge} — the first prompt a cross-backend fallback switch
 * hands the new agent: why it takes over, the reply-language directive, the previous agent's last turns
 * verbatim (the forwarded thread-context glue stripped from user turns), over-long turns cut in the middle,
 * and the turn-less shape when the old transcript could not be read.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildFallbackBridgePrompt, checkIsFallbackBridgePrompt, fallbackBridgeTurnMaxChars, truncateTurnText } from '../utils/fallbackBridge';
import { buildThreadContextPreamble } from '../threadContextPreamble';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

const base = { fromLabel: 'Claude · work · fable', toLabel: 'OpenCode · openai/gpt-5', reason: 'limit' as const, replyLanguage: 'Deutsch' };

test('bridge: names both agents, the reset, the reply language and the recent turns in order, user glue stripped', () => {
  const preamble = buildThreadContextPreamble({ key: makeTelegramKey(-1001111111111, 111), subdir: 'example', groupTitle: 'ExampleGroup' });
  const userTurn = `${preamble}\n\nAdd the retry test`;
  const prompt = buildFallbackBridgePrompt({
    ...base,
    resetsAtText: '16:00',
    turns: [
      { role: 'user', text: userTurn },
      { role: 'assistant', text: 'Added src/retry.test.ts; one case still fails.' },
    ],
  });
  assert.ok(checkIsFallbackBridgePrompt(prompt));
  assert.match(prompt, /You \(OpenCode · openai\/gpt-5\) are taking this conversation over from Claude · work · fable, which hit a usage limit \(it resets at 16:00\)/);
  assert.match(prompt, /Reply IN Deutsch with ONE short message/);
  assert.match(prompt, /--- Last 2 turn\(s\) of Claude · work · fable \(oldest first\) ---/);
  const userIndex = prompt.indexOf('User:\nAdd the retry test');
  const assistantIndex = prompt.indexOf('Assistant:\nAdded src/retry.test.ts');
  assert.ok(userIndex > 0 && assistantIndex > userIndex, 'turns in chronological order');
  assert.ok(!prompt.includes('[Telegram thread context]'), 'the forwarded glue is service noise');
  assert.match(prompt, /git status, git diff, git log/);
});

test('bridge: without a reset the clause is omitted; without turns the agent is told to start from the project', () => {
  const prompt = buildFallbackBridgePrompt({ ...base, resetsAtText: null, turns: [] });
  assert.ok(!prompt.includes('it resets at'));
  assert.match(prompt, /No turns of the previous agent are available/);
  assert.ok(!prompt.includes('--- Last'));
});

test('bridge: an over-long turn keeps its head and tail with a cut marker', () => {
  const long = `${'a'.repeat(3000)}END`;
  const cut = truncateTurnText(long);
  assert.ok(cut.length < fallbackBridgeTurnMaxChars + 60);
  assert.ok(cut.startsWith('aaaa'));
  assert.ok(cut.endsWith('END'));
  assert.match(cut, /\[… \d+ characters cut …\]/);
  assert.equal(truncateTurnText('short'), 'short');
  const prompt = buildFallbackBridgePrompt({ ...base, resetsAtText: null, turns: [{ role: 'assistant', text: long }] });
  assert.match(prompt, /characters cut/);
});

test('bridge marker: only a bridge starts with it', () => {
  assert.ok(!checkIsFallbackBridgePrompt('Continue from where you left off.'));
});

test('bridge: a switch by hand says the operator switched the agent, not that a limit was hit, and carries the typed message', () => {
  const prompt = buildFallbackBridgePrompt({
    ...base,
    reason: 'manual',
    resetsAtText: null,
    userMessage: 'start with the failing test',
    turns: [{ role: 'user', text: 'Add the retry test' }],
  });
  assert.ok(checkIsFallbackBridgePrompt(prompt));
  assert.match(prompt, /You \(OpenCode · openai\/gpt-5\) are taking this conversation over from Claude · work · fable, because the operator switched this topic's agent\./);
  assert.ok(!prompt.includes('usage limit'), 'no limit is claimed');
  assert.match(prompt, /The operator also wrote, together with the switch:\nstart with the failing test/);
  assert.match(prompt, /User:\nAdd the retry test/, 'the previous agent\'s turns still follow');
  assert.ok(!buildFallbackBridgePrompt({ ...base, reason: 'manual', resetsAtText: null, turns: [] }).includes('also wrote'), 'no message, no line');
});
