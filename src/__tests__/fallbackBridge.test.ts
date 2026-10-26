/**
 * @description Unit tests for {@link ../utils/fallbackBridge} — the first prompt a cross-backend fallback switch
 * hands the new agent: why it takes over, the reply-language directive, the previous agent's last turns
 * verbatim (the forwarded thread-context glue stripped from user turns), the summary of an earlier compaction
 * under its own heading (context, never a turn), over-long turns cut in the middle,
 * and the turn-less shape when the old transcript could not be read.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildFallbackBridgePrompt, checkIsFallbackBridgePrompt, fallbackBridgeSummaryMaxChars, fallbackBridgeTurnMaxChars, truncateTurnText } from '../utils/fallbackBridge';
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
  assert.match(prompt, /1\. Find out the task and where it stopped; none of the previous conversation is available below\./);
  assert.ok(!prompt.includes('Read the recent turns'), 'step 1 does not point at turns that are not there');
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

const summaryHeading = /--- Summary of the earlier conversation \([^)]*not a message of the user\) ---/;

test('bridge: the earlier compaction\'s summary goes in under its own heading, before the turns, and is not a user turn', () => {
  const summary = 'This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n1. Primary Request and Intent: ship the release.';
  const prompt = buildFallbackBridgePrompt({
    ...base,
    resetsAtText: null,
    compactionSummary: summary,
    turns: [{ role: 'user', text: 'Run the tests' }, { role: 'assistant', text: 'All tests pass.' }],
  });
  assert.match(prompt, summaryHeading);
  assert.match(prompt, /1\. Read the summary of the earlier conversation and the recent turns below/);
  const headingIndex = prompt.search(summaryHeading);
  const summaryIndex = prompt.indexOf(summary);
  const endIndex = prompt.indexOf('--- End of the summary ---');
  const turnsIndex = prompt.indexOf('--- Last 2 turn(s)');
  assert.ok(headingIndex >= 0 && summaryIndex > headingIndex && endIndex > summaryIndex && turnsIndex > endIndex, 'heading, summary, its end, then the turns');
  assert.ok(!prompt.includes(`User:\n${summary}`) && !prompt.includes('User:\nThis session is being continued'), 'never told as the user\'s');
});

test('bridge: a summary with no turns is still handed over, is not called "no turns", and step 1 does not send the agent to turns that are not there', () => {
  const prompt = buildFallbackBridgePrompt({ ...base, resetsAtText: null, turns: [], compactionSummary: 'Summary: the release is half done.' });
  assert.match(prompt, summaryHeading);
  assert.match(prompt, /1\. Read the summary of the earlier conversation below to understand the task/);
  assert.ok(!prompt.includes('recent turns'), 'no turns section follows, so none is mentioned');
  assert.ok(prompt.includes('Summary: the release is half done.'));
  assert.ok(!prompt.includes('No turns of the previous agent are available'));
  assert.ok(!prompt.includes('--- Last'));
});

test('bridge: no summary (none, or an empty one) leaves the prompt as it was', () => {
  for (const compactionSummary of [undefined, null, '']) {
    const prompt = buildFallbackBridgePrompt({ ...base, resetsAtText: null, compactionSummary, turns: [{ role: 'user', text: 'Run the tests' }] });
    assert.ok(!prompt.includes('Summary of the earlier conversation'));
    assert.match(prompt, /1\. Read the recent turns below/);
  }
});

test('bridge: an over-long summary keeps its head and tail with a cut marker', () => {
  const long = `${'s'.repeat(fallbackBridgeSummaryMaxChars + 500)}END`;
  const prompt = buildFallbackBridgePrompt({ ...base, resetsAtText: null, turns: [], compactionSummary: long });
  assert.match(prompt, /characters cut/);
  assert.ok(prompt.includes('END\n--- End of the summary ---'));
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
