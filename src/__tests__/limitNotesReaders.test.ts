/**
 * The readers that show a stored user prompt back — the resume context, the cross-backend hand-over, the two session-title builders —
 * cut the accounts note off a user turn like the thread-context preamble: it is service glue, and its figures are of the moment it was
 * written, so a new agent must not read them as today's. An assistant turn is never touched.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderTurns } from '../resumeContext';
import { buildFallbackBridgePrompt } from '../utils/fallbackBridge';
import { getSessionTitleLine } from '../utils/claudeSessionTitle';
import { buildSessionTitleSnippet } from '../openCodeSessionTitle';
import { buildThreadContextPreamble, getUserPromptWithoutGlue, prependThreadContextPreamble } from '../threadContextPreamble';
import { appendLimitNote, limitNoteReminderInstructionLine } from '../limitNotes/noteText';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

const note = [
  '[Accounts · 14:05] Next new Claude worker → work (soonest weekly reset): week 62 % used, resets in 1 d 19 h; 5 h 30 %.',
  limitNoteReminderInstructionLine,
].join('\n');
const preamble = buildThreadContextPreamble({ key: makeTelegramKey(-1001111111111, 111), subdir: 'example' });
const todoLine = '[Todo] Your published todo list was last updated 70 min ago and you have worked since.';
/** What the forward writes for a carrier prompt: the preamble first, the person's words, the todo line, the note last. */
const storedUserPrompt = appendLimitNote(prependThreadContextPreamble(preamble, `Run the review\n\n${todoLine}`), note);

/** What the CLI stores when it merges a second message queued behind a carrier prompt into ONE user turn (texts joined by a newline). */
const mergedUserTurn = `${storedUserPrompt}\nand also fix the README`;
/** The same, when the second message is a request's (its header ends in a blank line). */
const mergedUserTurnWithHeader = `${storedUserPrompt}\n[Request req_7 · from: Anna]\n\nand also fix the README`;

describe('getUserPromptWithoutGlue: the ONE rule for a stored user prompt', () => {
  it('cuts the leading preamble and every note, wherever the notes sit; the person\'s words all stay', () => {
    assert.equal(getUserPromptWithoutGlue(storedUserPrompt), `Run the review\n\n${todoLine}`);
    assert.equal(getUserPromptWithoutGlue(mergedUserTurn), `Run the review\n\n${todoLine}\nand also fix the README`);
    assert.equal(getUserPromptWithoutGlue(mergedUserTurnWithHeader), `Run the review\n\n${todoLine}\n[Request req_7 · from: Anna]\n\nand also fix the README`);
    assert.equal(getUserPromptWithoutGlue('plain words'), 'plain words');
  });
});

describe('a merged user turn — the CLI drains messages queued behind a carrier prompt into ONE turn — keeps the person\'s next message', () => {
  it('the resume context shows both asks and no stale figure, with or without a blank line in the second message', () => {
    for (const merged of [mergedUserTurn, mergedUserTurnWithHeader]) {
      const [user] = renderTurns([{ role: 'user', text: merged }]);
      assert.ok(user.includes('Run the review'), user);
      assert.ok(user.includes('and also fix the README'), 'the person\'s second ask is not lost');
      assert.equal(user.includes('[Accounts'), false);
      assert.equal(user.includes('claude_profiles'), false);
    }
  });

  it('the hand-over prompt carries the person\'s LAST ask to the new agent, and no stale figure', () => {
    for (const merged of [mergedUserTurn, mergedUserTurnWithHeader]) {
      const prompt = buildFallbackBridgePrompt({ fromLabel: 'Claude · work', toLabel: 'OpenCode · openai/gpt-5', reason: 'limit', replyLanguage: 'English', resetsAtText: null, turns: [{ role: 'user', text: merged }] });
      assert.ok(prompt.includes('and also fix the README'), 'the new agent sees what the person asked last');
      assert.equal(prompt.includes('[Accounts'), false);
      assert.equal(prompt.includes('claude_profiles'), false);
    }
  });

  it('the session titles read both messages as the person wrote them', () => {
    const shortMerged = `${appendLimitNote('Run the review', note)}\nand also fix the README`;
    assert.equal(getSessionTitleLine(shortMerged), 'Run the review and also fix the README');
    assert.equal(buildSessionTitleSnippet(shortMerged), 'Run the review and also fix the README');
  });
});

describe('a stored user prompt shows back without the accounts note', () => {
  it('the resume context: the preamble and the note go, the person\'s words and the todo line stay; an assistant turn is untouched', () => {
    const [user, assistant] = renderTurns([
      { role: 'user', text: storedUserPrompt },
      { role: 'assistant', text: `I quoted it: ${note}` },
    ]);
    assert.ok(user.endsWith(`Run the review\n\n${todoLine}`), user);
    assert.equal(user.includes('[Accounts'), false);
    assert.equal(user.includes('Telegram thread context'), false);
    assert.ok(assistant.includes(note), 'the assistant\'s own text is shown as it is');
  });

  it('the hand-over prompt to a new agent: the stale figures never reach it', () => {
    const prompt = buildFallbackBridgePrompt({
      fromLabel: 'Claude · work',
      toLabel: 'OpenCode · openai/gpt-5',
      reason: 'limit',
      replyLanguage: 'English',
      resetsAtText: null,
      turns: [{ role: 'user', text: storedUserPrompt }, { role: 'assistant', text: 'Started.' }],
    });
    assert.ok(prompt.includes('User:\nRun the review'));
    assert.equal(prompt.includes('[Accounts'), false);
    assert.equal(prompt.includes('claude_profiles'), false);
  });

  it('the session titles: a short prompt with a note after it titles as the prompt, in both backends\' builders', () => {
    const shortPrompt = appendLimitNote(prependThreadContextPreamble(preamble, 'review it'), note);
    assert.equal(getSessionTitleLine(shortPrompt), 'review it');
    assert.equal(buildSessionTitleSnippet(shortPrompt), 'review it');
  });

  it('a prompt that carries no note reads exactly as before', () => {
    const plain = prependThreadContextPreamble(preamble, 'plain words');
    assert.equal(getSessionTitleLine(plain), 'plain words');
    assert.equal(buildSessionTitleSnippet(plain), 'plain words');
    assert.ok(renderTurns([{ role: 'user', text: plain }])[0].endsWith('plain words'));
  });
});
