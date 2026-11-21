/**
 * How an accounts note is attached to a text and taken off it again (`limitNotes/noteText.ts`): the one rule behind the prompt's last
 * block, a bot send tool's result, the renderer that hides it from the topic, and the resume readers that must not show a new agent
 * stale figures.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendLimitNote, limitNoteMarker, stripLimitNote } from '../limitNotes/noteText';
import { checkIsBotMcpToolName } from '../scheduler/injection';

const reminder = [
  '[Accounts · 14:05] Next new Claude worker → work (soonest weekly reset): week 62 % used, resets in 1 d 19 h; 5 h 30 %.',
  'Then default (week 20 %, resets in 5 d).',
  'Call claude_profiles right before your next launch or resume — the pick moves as limits fill and reset. No reply is needed.',
].join('\n');
const summary = '[Accounts · 16:40 · changed] work 71 % (resets in 1 d 16 h) → next new worker; default 20 % (5 d).';

describe('appendLimitNote / stripLimitNote', () => {
  it('the note is the LAST block, after a blank line; strip is the exact inverse, for both shapes', () => {
    for (const note of [reminder, summary]) {
      const withNote = appendLimitNote('Delivered 2 messages.', note);
      assert.equal(withNote, `Delivered 2 messages.\n\n${note}`);
      assert.equal(stripLimitNote(withNote), 'Delivered 2 messages.');
    }
    assert.ok(reminder.startsWith(limitNoteMarker));
  });

  it('a text with no note is returned as it is — including one that mentions the marker without being a note', () => {
    for (const text of ['Delivered.', '', 'no blank line before [Accounts · 14:05] here', 'a\n\n[Accounts · soon] not a header', 'a\n\n[Accounts of the month] are in']) {
      assert.equal(stripLimitNote(text), text, JSON.stringify(text));
    }
  });

  it('a note-looking block that is followed by more text (a blank line after it) is not the last block: nothing is cut', () => {
    const text = `Body.\n\n${summary}\n\nAnd then the person went on.`;
    assert.equal(stripLimitNote(text), text);
  });

  it('only the LAST block goes: the todo lines and everything before it stay', () => {
    const prompt = 'The person wrote this.\n\n[Todo] Your published todo list was last updated 70 min ago.';
    assert.equal(stripLimitNote(appendLimitNote(prompt, reminder)), prompt);
    assert.equal(stripLimitNote(appendLimitNote(appendLimitNote(prompt, summary), reminder)), appendLimitNote(prompt, summary), 'a second note on top is taken off alone');
  });
});

describe('checkIsBotMcpToolName: which tool results the renderer hides a note from', () => {
  it('the bot\'s own tools in Claude Code and OpenCode naming — under the current and the pre-rename server name', () => {
    for (const name of ['mcp__charness__send_messages_to_user', 'charness_send_file_to_user', 'mcp__charness__answer_request', 'mcp__telegramBot__send_messages_to_user', 'telegramBot_answer_request']) {
      assert.equal(checkIsBotMcpToolName(name), true, name);
    }
  });

  it('every other tool — a shell, a file read, another MCP server — is not', () => {
    for (const name of ['Bash', 'bash', 'read', 'mcp__playwright__browser_click', 'mcp__charnessother__x', 'charnessy_tool', 'tool']) {
      assert.equal(checkIsBotMcpToolName(name), false, name);
    }
  });
});
