/**
 * How an accounts note is attached to a text and taken off it again (`limitNotes/noteText.ts`): the one rule behind the prompt's last
 * block, a bot send tool's result, the renderer that hides it from the topic, and the readers that must not show a new agent stale
 * figures. The strip follows the note's SHAPE — a summary is its header line, a reminder its header, at most one `Then … / ChatGPT: …`
 * line and the fixed instruction line — wherever it sits, because the CLI merges messages queued behind a prompt into ONE user turn
 * (their texts joined by a newline): the person's next message follows the note there, and must survive the strip.
 *
 * The notes cut here are the ones the planner BUILDS (`plan.ts`), so the shape the strip recognises and the shape that is written
 * cannot drift apart unseen.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendLimitNote, formatLimitNoteHeader, limitNoteMarker, limitNoteReminderInstructionLine, stripLimitNote } from '../limitNotes/noteText';
import { buildLimitNoteText, type LimitNoteShape } from '../limitNotes/plan';
import { buildClaudeProfilesCreditReport } from '../utils/claudeProfileUsageViews';
import type { ClaudeProfileUsageView, ClaudeUsageSnapshot } from '../utils/claudeUsage';
import type { OpenCodeProviderUsages } from '../limitNotes/plan';
import { checkIsBotMcpToolName } from '../scheduler/injection';

const hourMs = 60 * 60 * 1000;
const nowMs = Date.parse('2026-11-21T14:05:00Z');

function buildUsage(weekly: number, weeklyResetHours: number): ClaudeUsageSnapshot {
  return {
    fetchedAt: new Date(nowMs).toISOString(),
    source: 'api',
    buckets: [
      { kind: 'session', percent: 30, resetsAt: new Date(nowMs + 3 * hourMs).toISOString(), scopeModel: null },
      { kind: 'weekly_all', percent: weekly, resetsAt: new Date(nowMs + weeklyResetHours * hourMs).toISOString(), scopeModel: null },
    ],
  };
}

function buildView(name: string, usage: ClaudeProfileUsageView['usage'], patch: Partial<ClaudeProfileUsageView> = {}): ClaudeProfileUsageView {
  return { name, configDir: null, loggedIn: true, email: `${name}@example.com`, subscriptionType: 'max', usage, limitedUntil: null, billing: 'subscription', creditExhaustedAt: null, ...patch };
}

const chatGpt: OpenCodeProviderUsages = { openai: { authKind: 'subscription', usage: { ...buildUsage(40, 72), buckets: [{ kind: 'weekly_all', percent: 40, resetsAt: new Date(nowMs + 72 * hourMs).toISOString(), scopeModel: null }] } } };
const twoAccounts = [buildView('default', buildUsage(20, 120)), buildView('work', buildUsage(62, 43))];
const oneAccount = [buildView('work', buildUsage(62, 43))];
const nobodyUsable = [buildView('work', buildUsage(62, 43), { limitedUntil: new Date(nowMs + 3 * hourMs).toISOString() })];

/** Every shape the planner writes: a reminder with the accounts and ChatGPT lines, with each alone, with neither, with no account usable, and the summary. */
const writtenNotes: Array<{ label: string; shape: LimitNoteShape; note: string; lineCount: number }> = [
  { label: 'a reminder with the next accounts and the ChatGPT window', shape: 'reminder', note: buildLimitNoteText('reminder', buildClaudeProfilesCreditReport(twoAccounts, null, nowMs, { chainScope: null }), chatGpt, 'UTC', nowMs), lineCount: 3 },
  { label: 'a reminder with the next accounts only', shape: 'reminder', note: buildLimitNoteText('reminder', buildClaudeProfilesCreditReport(twoAccounts, null, nowMs, { chainScope: null }), {}, 'UTC', nowMs), lineCount: 3 },
  { label: 'a reminder with the ChatGPT window only', shape: 'reminder', note: buildLimitNoteText('reminder', buildClaudeProfilesCreditReport(oneAccount, null, nowMs, { chainScope: null }), chatGpt, 'UTC', nowMs), lineCount: 3 },
  { label: 'a reminder with neither', shape: 'reminder', note: buildLimitNoteText('reminder', buildClaudeProfilesCreditReport(oneAccount, null, nowMs, { chainScope: null }), {}, 'UTC', nowMs), lineCount: 2 },
  { label: 'a reminder when no account can take a worker', shape: 'reminder', note: buildLimitNoteText('reminder', buildClaudeProfilesCreditReport(nobodyUsable, null, nowMs, { chainScope: null }), {}, 'UTC', nowMs), lineCount: 2 },
  { label: 'the change summary', shape: 'summary', note: buildLimitNoteText('summary', buildClaudeProfilesCreditReport(twoAccounts, null, nowMs, { chainScope: null }), chatGpt, 'UTC', nowMs), lineCount: 1 },
];

describe('the notes the planner writes have the shape the strip follows', () => {
  for (const { label, shape, note, lineCount } of writtenNotes) {
    it(`${label}: ${lineCount} line(s), a header the marker opens, and for a reminder the fixed instruction last`, () => {
      assert.ok(note.startsWith(limitNoteMarker));
      assert.equal(note.split('\n').length, lineCount, note);
      assert.equal(note.startsWith(formatLimitNoteHeader('14:05', shape === 'summary')), true, note);
      assert.equal(note.endsWith(limitNoteReminderInstructionLine), shape === 'reminder');
    });
  }
});

describe('appendLimitNote / stripLimitNote', () => {
  for (const { label, note } of writtenNotes) {
    describe(label, () => {
      it('as the last block of a prompt or a tool result: strip is the exact inverse', () => {
        const withNote = appendLimitNote('Delivered 2 messages.', note);
        assert.equal(withNote, `Delivered 2 messages.\n\n${note}`);
        assert.equal(stripLimitNote(withNote), 'Delivered 2 messages.');
      });

      it('in a merged user turn the person\'s next message survives — whether or not it holds a blank line', () => {
        const plainNext = `Run the review${'\n\n'}${note}\nand also fix the README`;
        assert.equal(stripLimitNote(plainNext), 'Run the review\nand also fix the README', 'no blank line in the second message: nothing of it is cut');
        const headerNext = `Run the review\n\n${note}\n[Request req_7 · from: Anna]\n\nand also fix the README`;
        assert.equal(stripLimitNote(headerNext), 'Run the review\n[Request req_7 · from: Anna]\n\nand also fix the README', 'a request header ends in a blank line: the stale figures still go, nothing else');
      });

      it('two notes in one merged turn (two carriers drained together) both go', () => {
        assert.equal(stripLimitNote(`first\n\n${note}\nsecond\n\n${note}`), 'first\nsecond');
      });
    });
  }

  it('a reminder with no accounts line and no ChatGPT line cuts nothing of a next message that happens to start with «Then »', () => {
    const bare = writtenNotes[3].note;
    assert.equal(stripLimitNote(`Run it\n\n${bare}\nThen we ship it.\nChatGPT: is mentioned too`), 'Run it\nThen we ship it.\nChatGPT: is mentioned too');
  });

  it('only the shape is cut: text that merely mentions or resembles a note is returned as it is', () => {
    const summary = writtenNotes[5].note;
    const reminder = writtenNotes[0].note;
    const lookalikes = [
      '',
      'Delivered.',
      `no blank line before ${summary}`,
      `a\n${summary}`,
      'a\n\n[Accounts · soon] not a header',
      'a\n\n[Accounts of the month] are in',
      `a\n\n${reminder.split('\n').slice(0, -1).join('\n')}`,
      `a\n\n${reminder.replace(limitNoteReminderInstructionLine, 'Call it whenever.')}`,
      `a\n\n${reminder.split('\n')[0]}\nsomething else entirely\n${limitNoteReminderInstructionLine}`,
    ];
    for (const text of lookalikes) assert.equal(stripLimitNote(text), text, JSON.stringify(text));
  });

  it('only the note goes: the todo lines and everything before it stay, and a second note on top comes off alone', () => {
    const prompt = 'The person wrote this.\n\n[Todo] Your published todo list was last updated 70 min ago.';
    const [reminder, summary] = [writtenNotes[0].note, writtenNotes[5].note];
    assert.equal(stripLimitNote(appendLimitNote(prompt, reminder)), prompt);
    assert.equal(stripLimitNote(appendLimitNote(appendLimitNote(prompt, summary), reminder)), prompt, 'both are notes: both go');
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
