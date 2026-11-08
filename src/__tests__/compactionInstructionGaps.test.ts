/**
 * @description The agent-mistakes section of a compaction summary, through the REAL compaction module
 * (`connectors/telegram/commands/compaction.ts`) wired to ports (`commandModuleHarness.ts`: a real telegraf instance against
 * the fake Bot API, the real state store, recording topic sends) and a stub adapter whose summary the test chooses. The
 * section is shown even when `/compact_summary` hides the full summary — each way a compaction can reach the topic:
 *
 *   • `/compact` (the same seam the agent's `compact_conversation` runs): hide mode posts the section ALONE, show mode only
 *     the full summary (the section is inside it, never twice), an empty or «none» section posts nothing, a backend that
 *     streams its own summary is not read at all;
 *   • the idle compaction: notice → section → the re-asked question, LAST, in hide mode;
 *   • the CLI's own overflow compaction (`postOwnCompactionInstructionGaps`): posted in both modes, a compaction the bot is
 *     running itself is left to its caller;
 *   • a backend that streams its own summary (OpenCode) with the summary hidden: the section is taken out of the tails the
 *     topic does not get, once per summary, and posted when the end marker has arrived.
 *
 * What the end-to-end flow covers instead: the same through a real bot and a fake `claude` (`compactionInstructionGapsE2e.test.ts`).
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { EventEmitter } from 'node:events';
import { after, before, beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCompaction } from '../connectors/telegram/commands/compaction';
import { MAX_MESSAGE_LEN } from '../connectors/telegram/messageSplit';
import type { AgentAdapter, AgentSession, CompactionResult, OpenCodeQuestion, PendingQuestionState } from '../types';
import type { OutboundHints } from '../platform/outbound';
import type { SessionKey } from '../sessionKey';
import { keyToString } from '../sessionKey';
import { enDict } from '../i18n/en';
import {
  compactionClosingEndMarker,
  compactionClosingStartMarker,
  compactionGapsEndMarker,
  compactionGapsStartMarker,
  compactionNoGapsLine,
  formatTokenCount,
} from '../utils/compactOnIdle';
import { createCommandHarness, type CommandHarness } from './commandModuleHarness';

const waitStepMs = 10;
const waitTimeoutMs = 10_000;
/** The idle window of the module under test: the fire comes this long after the last activity. */
const idleWindowMs = 20;

const instructionGapsText = '1. Mistake (repeated): pushed without asking. Change: add a never-push-without-permission rule to CLAUDE.md.\n2. Mistake: skipped the lint step. Change: a lint line in the commit skill.';
const question: OpenCodeQuestion = { question: 'Which way?', header: 'Way', options: [{ label: 'Short' }, { label: 'Long' }] };

/** A summary as a model writes it with the instruction followed: the body, the section in its markers, the closing section. */
function buildSummary(sectionBody: string): string {
  return [
    '## Goals',
    '- finish the refactor',
    compactionGapsStartMarker,
    sectionBody,
    compactionGapsEndMarker,
    compactionClosingStartMarker,
    'Next: run the suite.',
    compactionClosingEndMarker,
  ].join('\n');
}

async function waitUntil(description: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + waitTimeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, waitStepMs));
  }
}

/** A conversation that compacts and hands back the summary the test set; counts the reads of that summary. */
class StubAdapter extends EventEmitter implements AgentAdapter {
  readonly name = 'stub-json-stream';
  readonly label = 'Stub';
  isActive = true;
  streamsCompactionSummary = false;
  summary: string | null = null;
  summaryReads = 0;

  async startSession(): Promise<void> {}
  async resumeSession(): Promise<void> {}
  stopSession(): void {}
  async suspendSession(): Promise<void> {}
  checkIsActive(): boolean { return this.isActive; }
  sendInput(): void {}
  sendSignal(): void {}
  async getSessions(): Promise<AgentSession[]> { return []; }
  rejectQuestion(): void {}
  async compactContext(): Promise<CompactionResult> {
    return { ok: true, preTokens: 25_600, postTokens: 2_800 };
  }
  async getLatestCompactionSummary(): Promise<string | null> {
    this.summaryReads += 1;
    return this.summary;
  }
}

let harness: CommandHarness;
let compaction: ReturnType<typeof createCompaction>;
const adapter = new StubAdapter();
const pendingQuestions = new Map<string, PendingQuestionState>();
let idleFireFinished = createDeferredFlag();

function createDeferredFlag(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((resolveFn) => { resolve = resolveFn; });
  return { promise, resolve };
}

const key: SessionKey = { platform: 'telegram', space: '-1001111111111', thread: '111' };
const keyString = keyToString(key);
const trackerKey: SessionKey = { platform: 'jira', space: 'PROJ', thread: 'PROJ-1' };

function getReplyTexts(): string[] {
  return harness.replies.map((reply) => reply.text);
}

/** The topic's messages that carry the section's text (the section alone, or the full summary it is inside). */
function countRepliesWith(text: string): number {
  return getReplyTexts().filter((reply) => reply.includes(text)).length;
}

async function setSummaryVisible(isVisible: boolean): Promise<void> {
  await harness.runCommand('compact_summary', isVisible ? 'on' : 'off');
  harness.replies.length = 0;
}

describe('the agent-mistakes section of a compaction summary, through the compaction module', () => {
  before(async () => {
    harness = await createCommandHarness();
    compaction = createCompaction({
      ...harness.core,
      startTypingLoader: () => {},
      forwardPromptToAgent: async () => {},
      pendingQuestions,
      clearPendingQuestion: (clearedKey) => { pendingQuestions.delete(keyToString(clearedKey)); },
      closeQuestionMessage: async () => true,
      idleWindowMs,
      checkIsLimitWaitArmed: () => false,
      // The last step of the idle fire (after the compaction and the posts): the stop of the conversation.
      suspendThreadSession: async () => { idleFireFinished.resolve(); },
      resumeSleepingSessionForCompaction: async () => false,
      getThreadAdapter: () => adapter,
      deliverLabel: async () => 'forwarded',
      resumeSleepingSessionForPrompt: async () => false,
      checkIsStarting: () => false,
      closeOrphanQuestionMessage: async () => true,
      notePersonActivity: (activeKey) => { compaction.noteThreadUserActivity(activeKey); },
    });
    compaction.registerCompactionCommands();
    compaction.registerCompactionCallbacks();
  });

  after(async () => {
    await harness.stop();
  });

  beforeEach(async () => {
    adapter.isActive = true;
    adapter.streamsCompactionSummary = false;
    adapter.summary = null;
    adapter.summaryReads = 0;
    idleFireFinished = createDeferredFlag();
    pendingQuestions.clear();
    harness.replies.length = 0;
    await harness.state.setCompactSummaryOverride(key, false);
    await harness.state.clearCompactIdleTracking(key);
    await harness.state.setCompactIdleLatched(key, false);
    await harness.state.setAgent(key, { name: adapter.name, claudeSessionId: 'session-gaps' });
  });

  afterEach(async () => {
    compaction.clearThreadCompaction(key);
    await harness.state.clearReAskedQuestion(key);
  });

  describe('a compaction the bot runs: /compact and the agent\'s own compact_conversation (one seam)', () => {
    it('summary HIDDEN: the completion line, then the section ALONE under its own header — the full summary stays out', async () => {
      adapter.summary = buildSummary(instructionGapsText);

      await harness.runCommand('compact');

      const texts = getReplyTexts();
      assert.equal(texts.length, 3, `started, done, the section: ${JSON.stringify(texts)}`);
      assert.equal(texts[0], enDict['compact.started']);
      assert.equal(texts[1], enDict['compact.done_tokens'].replace('{pre}', formatTokenCount(25_600)).replace('{post}', formatTokenCount(2_800)), 'the completion line, with the token counts');
      assert.equal(texts[2], `${enDict['compact.instructionGapsHeader']}\n\n${instructionGapsText}`);
      assert.ok(!texts.some((text) => text.includes(enDict['compact.summaryHeader'])), 'the full summary is not posted');
      assert.ok(!texts.some((text) => text.includes('finish the refactor')), 'nothing of the summary body is posted');
      assert.ok(!texts[2].includes('<<<'), 'no marker reaches the topic');
    });

    it('summary SHOWN: the full summary carries the section — one message, markers stripped, the section not posted a second time', async () => {
      await setSummaryVisible(true);
      adapter.summary = buildSummary(instructionGapsText);

      await harness.runCommand('compact');

      const texts = getReplyTexts();
      assert.equal(texts.length, 3, `started, done, the full summary: ${JSON.stringify(texts)}`);
      assert.ok(texts[2].startsWith(enDict['compact.summaryHeader']));
      assert.equal(countRepliesWith(instructionGapsText), 1, 'the section is in exactly one message');
      assert.ok(!texts.some((text) => text.startsWith(enDict['compact.instructionGapsHeader'])), 'no separate section message');
      assert.ok(texts[2].includes('finish the refactor') && texts[2].includes('Next: run the suite.'), 'the summary body and the closing section are there');
      assert.ok(!texts[2].includes('<<<'), 'the markers of both sections are stripped');
      // The proposals are labelled, so they do not blur into the numbered next steps right after them.
      assert.ok(texts[2].includes(`${enDict['compact.instructionGapsHeader']}\n${instructionGapsText}\n`), `the section sits under its header: ${texts[2]}`);
      assert.equal(texts[2].split(enDict['compact.instructionGapsHeader']).length - 1, 1, 'one header');
    });

    it('a section that says there were no mistakes (the none line, or nothing) posts nothing, in either mode', async () => {
      for (const body of [compactionNoGapsLine, '']) {
        for (const isVisible of [false, true]) {
          await setSummaryVisible(isVisible);
          adapter.summary = buildSummary(body);
          await harness.runCommand('compact');
          assert.ok(!getReplyTexts().some((text) => text.includes(enDict['compact.instructionGapsHeader'])), `no section message and no header over an empty section (visible: ${isVisible}, body "${body}")`);
          // Neither as a section of its own nor inside the full summary: it is scaffolding, like the markers.
          assert.ok(!getReplyTexts().some((text) => text.includes(compactionNoGapsLine)), `the none line never reaches the topic (visible: ${isVisible})`);
          harness.replies.length = 0;
        }
      }
    });

    it('a summary with no section at all, or none that could be read, posts nothing with the summary hidden', async () => {
      adapter.summary = '## Goals\n- finish the refactor';
      await harness.runCommand('compact');
      assert.deepEqual(getReplyTexts().map((text) => Array.from(text)[0]), ['🧹', '✅'], 'only the notices');

      harness.replies.length = 0;
      adapter.summary = null;
      await harness.runCommand('compact');
      assert.deepEqual(getReplyTexts().map((text) => Array.from(text)[0]), ['🧹', '✅'], 'only the notices');
    });

    it('a backend that streams its own summary, the summary HIDDEN: its stream is dropped, so the bot reads the section itself and posts it AFTER its notices', async () => {
      adapter.streamsCompactionSummary = true;
      adapter.summary = buildSummary(instructionGapsText);

      await harness.runCommand('compact');

      const texts = getReplyTexts();
      assert.equal(adapter.summaryReads, 1, 'the summary is read once');
      assert.equal(texts.length, 3, `started, done, the section: ${JSON.stringify(texts)}`);
      assert.equal(texts[0], enDict['compact.started']);
      assert.ok(texts[1].startsWith('✅'));
      assert.equal(texts[2], `${enDict['compact.instructionGapsHeader']}\n\n${instructionGapsText}`);
    });

    it('a backend that streams its own summary, the summary SHOWN: the stream carries it, so the bot reads and posts nothing', async () => {
      adapter.streamsCompactionSummary = true;
      adapter.summary = buildSummary(instructionGapsText);
      await setSummaryVisible(true);

      await harness.runCommand('compact');

      assert.equal(adapter.summaryReads, 0, 'the summary is not read');
      assert.deepEqual(getReplyTexts().map((text) => Array.from(text)[0]), ['🧹', '✅'], 'only the notices: the summary comes by the stream');
    });

    it('a long section is SPLIT to Telegram\'s limit, never truncated, the header on the first part', async () => {
      const longSection = Array.from({ length: 400 }, (_, index) => `${index + 1}. Mistake ${index + 1}: a long line that repeats. Change: edit rule ${index + 1}.`).join('\n');
      adapter.summary = buildSummary(longSection);

      await harness.runCommand('compact');

      const parts = getReplyTexts().slice(2);
      assert.ok(parts.length >= 2, `split into several messages, got ${parts.length}`);
      assert.ok(parts.every((part) => part.length <= MAX_MESSAGE_LEN), 'every part fits one Telegram message');
      assert.ok(parts[0].startsWith(enDict['compact.instructionGapsHeader']));
      const posted = parts.join('\n');
      assert.ok(posted.includes('400. Mistake 400:') && posted.includes('1. Mistake 1:'), 'nothing is cut off');
    });
  });

  describe('the idle compaction', () => {
    /** The topic goes quiet after a turn: the idle fire compacts and stops the conversation; resolves when it is done. */
    async function runIdleCompaction(): Promise<void> {
      compaction.markThreadTurnProducedOutput(key);
      compaction.noteThreadActivity(key);
      await idleFireFinished.promise;
    }

    it('summary HIDDEN: the short notice, then the section alone', async () => {
      adapter.summary = buildSummary(instructionGapsText);

      await runIdleCompaction();

      const texts = getReplyTexts();
      assert.equal(texts.length, 2, JSON.stringify(texts));
      assert.equal(texts[0], enDict['compactOnIdle.notice']);
      assert.equal(texts[1], `${enDict['compact.instructionGapsHeader']}\n\n${instructionGapsText}`);
    });

    it('summary SHOWN: the notice, then the full summary only — the section is not repeated', async () => {
      await setSummaryVisible(true);
      adapter.summary = buildSummary(instructionGapsText);

      await runIdleCompaction();

      const texts = getReplyTexts();
      assert.equal(texts.length, 2, JSON.stringify(texts));
      assert.equal(texts[0], enDict['compactOnIdle.notice']);
      assert.ok(texts[1].startsWith(enDict['compact.summaryHeader']));
      assert.equal(countRepliesWith(instructionGapsText), 1);
    });

    it('with a question to ask again: notice → section → the re-asked question, which stays LAST with its buttons', async () => {
      adapter.summary = buildSummary(instructionGapsText);
      pendingQuestions.set(keyString, { data: { requestId: 'que_1', questions: [question] }, messageId: 77, answers: [null], currentIndex: 0 });

      await runIdleCompaction();

      const texts = getReplyTexts();
      assert.equal(texts.length, 3, JSON.stringify(texts));
      assert.equal(texts[0], enDict['compactOnIdle.notice']);
      assert.ok(texts[1].startsWith(enDict['compact.instructionGapsHeader']));
      assert.ok(harness.getKeyboardData(harness.replies[2]).flat().some((data) => data.startsWith('reask_')), 'the re-asked question is the last message and carries its buttons');
    });
  });

  describe('the idle compaction of a backend that streams its own summary (OpenCode), the summary hidden', () => {
    it('notice → section → the re-asked question, which stays LAST — the section is read after the compaction, not taken from a stream that may still be arriving', async () => {
      adapter.streamsCompactionSummary = true;
      adapter.summary = buildSummary(instructionGapsText);
      pendingQuestions.set(keyString, { data: { requestId: 'que_1', questions: [question] }, messageId: 77, answers: [null], currentIndex: 0 });
      compaction.markThreadTurnProducedOutput(key);
      compaction.noteThreadActivity(key);
      await idleFireFinished.promise;

      const texts = getReplyTexts();
      assert.equal(texts.length, 3, JSON.stringify(texts));
      assert.equal(texts[0], enDict['compactOnIdle.notice']);
      assert.ok(texts[1].startsWith(enDict['compact.instructionGapsHeader']));
      assert.ok(harness.getKeyboardData(harness.replies[2]).flat().some((data) => data.startsWith('reask_')), 'the re-asked question is the last message and carries its buttons');
    });
  });

  describe('the CLI\'s own compaction at a context overflow (nobody posts its summary)', () => {
    it('posts the section whatever /compact_summary says', async () => {
      adapter.summary = buildSummary(instructionGapsText);
      for (const isVisible of [false, true]) {
        await setSummaryVisible(isVisible);
        await compaction.postOwnCompactionInstructionGaps(key);
        assert.deepEqual(getReplyTexts(), [`${enDict['compact.instructionGapsHeader']}\n\n${instructionGapsText}`], `visible: ${isVisible}`);
        harness.replies.length = 0;
      }
    });

    it('a compaction the bot is running itself is left to its caller — no second post from the event that announces it', async () => {
      adapter.summary = buildSummary(instructionGapsText);
      compaction.threadsCompacting.add(keyString);
      try {
        await compaction.postOwnCompactionInstructionGaps(key);
      } finally {
        compaction.threadsCompacting.delete(keyString);
      }
      assert.deepEqual(getReplyTexts(), []);
      assert.equal(adapter.summaryReads, 0, 'the summary is not even read');
    });

    it('posts nothing when there is no section, no readable summary, a streaming backend or a tracker issue', async () => {
      adapter.summary = buildSummary(compactionNoGapsLine);
      await compaction.postOwnCompactionInstructionGaps(key);
      adapter.summary = null;
      await compaction.postOwnCompactionInstructionGaps(key);
      adapter.summary = buildSummary(instructionGapsText);
      adapter.streamsCompactionSummary = true;
      await compaction.postOwnCompactionInstructionGaps(key);
      adapter.streamsCompactionSummary = false;
      await compaction.postOwnCompactionInstructionGaps(trackerKey);
      assert.deepEqual(getReplyTexts(), []);
    });
  });

  describe('a backend that streams its own summary (OpenCode): the tails of a summary the bot did not issue', () => {
    const streamedSummary = buildSummary(instructionGapsText);
    const firstId = 'msg_summary_1';
    const secondId = 'msg_summary_2';

    function tailHints(overrides: OutboundHints = {}): OutboundHints {
      return { isCompactionSummary: true, compactionSummaryMessageId: firstId, isContinuation: false, ...overrides };
    }

    async function settle(): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, waitStepMs * 3));
    }

    describe('with the summary HIDDEN', () => {
      it('posts the section once its end marker has arrived — however the tails cut the markers — and once per summary', async () => {
        // Cut the summary in the middle of the start marker and of the end marker: no tail holds a whole marker line.
        const cutAt = [streamedSummary.indexOf(compactionGapsStartMarker) + 6, streamedSummary.indexOf(compactionGapsEndMarker) + 9];
        const tails = [streamedSummary.slice(0, cutAt[0]), streamedSummary.slice(cutAt[0], cutAt[1]), streamedSummary.slice(cutAt[1])];

        assert.equal(compaction.routeStreamedCompactionSummaryTail(key, tails[0], tailHints()), null, 'a hidden summary shows nothing');
        assert.equal(compaction.routeStreamedCompactionSummaryTail(key, tails[1], tailHints({ isContinuation: true })), null);
        await settle();
        assert.deepEqual(getReplyTexts(), [], 'the section is not complete yet: nothing is posted');
        assert.equal(compaction.routeStreamedCompactionSummaryTail(key, tails[2], tailHints({ isContinuation: true })), null);
        await waitUntil('the section to be posted', () => harness.replies.length === 1);
        assert.equal(harness.replies[0].text, `${enDict['compact.instructionGapsHeader']}\n\n${instructionGapsText}`);

        compaction.routeStreamedCompactionSummaryTail(key, '\n1. load these skills: commit', tailHints({ isContinuation: true }));
        await settle();
        assert.equal(harness.replies.length, 1, 'more tails of the same summary post nothing more');
      });

      it('a second section in the SAME summary (the model restates it) is not posted again', async () => {
        compaction.routeStreamedCompactionSummaryTail(key, streamedSummary, tailHints());
        await waitUntil('the section', () => harness.replies.length === 1);
        compaction.routeStreamedCompactionSummaryTail(key, `\n${compactionGapsStartMarker}\n1. Mistake: restated. Change: restated.\n${compactionGapsEndMarker}`, tailHints({ isContinuation: true }));
        await settle();
        assert.equal(harness.replies.length, 1, 'one summary, one section message');
      });

      it('a LATER summary of the session is a new one — its section is posted even when every one of its tails is a continuation', async () => {
        // The server compacts again mid-turn, after the agent already streamed text: the adapter marks every tail of that
        // summary a continuation, so only the summary message's id tells it from the first one.
        compaction.routeStreamedCompactionSummaryTail(key, streamedSummary, tailHints());
        await waitUntil('the first section', () => harness.replies.length === 1);
        compaction.routeStreamedCompactionSummaryTail(key, buildSummary('1. Mistake: another one. Change: another rule.'), tailHints({ compactionSummaryMessageId: secondId, isContinuation: true }));
        await waitUntil('the second section', () => harness.replies.length === 2);
        assert.ok(harness.replies[1].text.endsWith('1. Mistake: another one. Change: another rule.'));
      });

      it('a summary whose section says there were no mistakes posts nothing', async () => {
        compaction.routeStreamedCompactionSummaryTail(key, buildSummary(compactionNoGapsLine), tailHints());
        await settle();
        assert.deepEqual(getReplyTexts(), []);
      });

      it('a summary of a compaction the BOT issued posts nothing from the stream — the bot reads its section itself, in order', async () => {
        compaction.routeStreamedCompactionSummaryTail(key, streamedSummary, tailHints({ isBotIssuedCompaction: true }));
        await settle();
        assert.deepEqual(getReplyTexts(), []);
      });

      it('a continuation with no first tail before it (the bot started mid-summary) never posts a half section', async () => {
        compaction.routeStreamedCompactionSummaryTail(key, `${instructionGapsText}\n${compactionGapsEndMarker}`, tailHints({ isContinuation: true }));
        await settle();
        assert.deepEqual(getReplyTexts(), []);
      });

      it('a tracker issue has no topic to post into', async () => {
        compaction.routeStreamedCompactionSummaryTail(trackerKey, streamedSummary, tailHints());
        await settle();
        assert.deepEqual(getReplyTexts(), []);
      });

      it('a thread that ends mid-summary forgets it: the next summary starts clean', async () => {
        compaction.routeStreamedCompactionSummaryTail(key, `${compactionGapsStartMarker}\n${instructionGapsText}`, tailHints());
        compaction.clearThreadCompaction(key);
        compaction.routeStreamedCompactionSummaryTail(key, `\n${compactionGapsEndMarker}`, tailHints({ isContinuation: true }));
        await settle();
        assert.deepEqual(getReplyTexts(), [], 'the end marker alone completes nothing');
      });
    });

    describe('with the summary SHOWN', () => {
      beforeEach(async () => {
        await setSummaryVisible(true);
      });

      it('what goes on to the topic has no marker line and no none line, the section sits under its header, and nothing is posted on the side', async () => {
        const shown = [] as string[];
        for (const [index, slice] of [streamedSummary.slice(0, 40), streamedSummary.slice(40, 130), streamedSummary.slice(130)].entries()) {
          const routed = compaction.routeStreamedCompactionSummaryTail(key, slice, tailHints({ isContinuation: index > 0 }));
          if (routed !== null) shown.push(routed.text);
        }
        const text = shown.join('');
        assert.ok(!text.includes('<<<'), `no marker reaches the topic: ${text}`);
        assert.ok(text.includes(`${enDict['compact.instructionGapsHeader']}\n${instructionGapsText}\n`), `the section sits under its header: ${text}`);
        assert.ok(text.includes('finish the refactor'), 'the rest of the summary is shown');
        await settle();
        assert.deepEqual(getReplyTexts(), [], 'the bot posts nothing of its own: the stream is the summary');
      });

      it('a section that says «none» leaves no trace in what is shown', () => {
        const routed = compaction.routeStreamedCompactionSummaryTail(key, buildSummary(compactionNoGapsLine), tailHints());
        assert.ok(routed);
        assert.ok(!routed.text.includes(compactionNoGapsLine) && !routed.text.includes(enDict['compact.instructionGapsHeader']) && !routed.text.includes('<<<'), routed.text);
      });

      it('a tail whose whole text is scaffolding is not shown, and the next one that is shown does not continue a message that was never started', () => {
        assert.equal(compaction.routeStreamedCompactionSummaryTail(key, `${compactionGapsStartMarker}\n`, tailHints()), null);
        const next = compaction.routeStreamedCompactionSummaryTail(key, '1. Mistake: a.\n', tailHints({ isContinuation: true }));
        assert.ok(next);
        assert.equal(next.isContinuation, false);
      });

      it('a tracker issue\'s summary passes through as it is', () => {
        assert.deepEqual(
          compaction.routeStreamedCompactionSummaryTail(trackerKey, streamedSummary, tailHints({ isContinuation: true })),
          { text: streamedSummary, isContinuation: true },
        );
      });
    });
  });
});
