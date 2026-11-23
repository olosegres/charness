/**
 * @description The Jira answer sink (plan J6, D20, R18) over a fake client that
 * records every call: comments in order, the hand-back only for a question or a
 * final answer to an open request and only while the issue is still the AI's,
 * a failed hand-back as a warning, the read-back of a post of unknown outcome,
 * the at-most-once resend of an unconfirmed post (R29, over a real file), the
 * alert, the park notice and the notice of an untrusted hand-over.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildJiraAlertText,
  buildJiraUpdatesPausedText,
  buildJiraMentionParkText,
  buildJiraOtherThreadsWarning,
  buildJiraParkText,
  buildJiraQueuedText,
  buildJiraReplyLeftOutWarning,
  buildJiraThreadRefusedWarning,
  buildJiraUntrustedText,
  createJiraAnswerSink,
  jiraFilesUnavailableError,
  jiraQuestionContinueText,
  jiraReadBackClockSkewMs,
  jiraReadBackDelayMs,
} from '../connectors/jira/answerSink';
import { getAdfText, getMentionedAccountIds, jiraCommentMarkdownMaxChars, type AdfDocument } from '../connectors/jira/adf';
import { createJiraTrust, type JiraTrust } from '../connectors/jira/trustedGroup';
import type { JiraSentBlocks } from '../connectors/jira/contextLedger';
import { makeJiraKey } from '../connectors/jira/sessionKeyCodec';
import { JiraAuthError, JiraHttpError, type JiraClient, type JiraComment, type JiraCommentPostResult, type JiraIssue } from '../connectors/jira/client';
import { getCommentBodyHash, JiraUnconfirmedPosts, jiraUnconfirmedPostsFileName } from '../connectors/jira/unconfirmedPosts';
import { JiraAnswerThreads, jiraAnswerThreadsFileName } from '../connectors/jira/answerThreads';
import { JiraProgressComments, jiraProgressCommentsFileName } from '../connectors/jira/progressComments';
import type { RequestAnswerKind, RequestOrigin } from '../requests/types';

const aiAccountId = 'ai-account';
const issueKey = 'PROJ-12';
const key = makeJiraKey(issueKey);
const nowMs = Date.parse('2026-10-03T12:00:00Z');
/** Two paragraphs never fit one comment; one fits by both counts (R19). */
const paragraphLength = Math.floor(jiraCommentMarkdownMaxChars * 2 / 3);
const origin: RequestOrigin = { kind: 'trackerEvent', attributes: { issueKey, triggerId: '100', requester: 'requester-account' } };
/** A request raised by an @-mention: nothing was handed over, so nothing is handed back. */
const mentionOrigin: RequestOrigin = { kind: 'trackerMention', attributes: { issueKey, triggerId: 'mention:10240', requester: 'requester-account' } };

interface FakeJira {
  calls: string[];
  postedTexts: string[];
  /** The bodies as posted, for what the plain text cannot tell (a paragraph of its own, no Markdown). */
  postedBodies: AdfDocument[];
  /** The thread of each post, in order: its top-level comment's id, `null` for a top-level post. */
  postedParentIds: Array<string | null>;
  /** `getComment` answers by comment id: a comment, or the failure Jira would give. */
  commentsById: Map<string, JiraComment | Error>;
  /** What the conversation was shown (`comment:<id>` → the block), as the context ledger holds it. */
  sentBlocks: JiraSentBlocks;
  /** The trusted group's trust, `null` without a group. */
  trust: JiraTrust | null;
  assignee: string;
  /** Per comment post, in order: what Jira answers; `created` when the list runs out. */
  postOutcomes: Array<JiraCommentPostResult | Error>;
  /** Every edit made, in order: the comment, its body and its plain text. */
  edits: Array<{ commentId: string; body: AdfDocument; text: string }>;
  /** Per edit, in order: the failure Jira gives; the edit succeeds when the list runs out. */
  editFailures: Array<Error | undefined>;
  /** What the read-back sees (newest first), or an error. */
  recentComments: JiraComment[] | Error;
  isAssignFailing: boolean;
  /** The sink's way to attach files; absent: the sink has none. */
  attachFiles?: NonNullable<Parameters<typeof createJiraAnswerSink>[0]['attachFiles']>;
}

let jira: FakeJira;
let dataDir: string;
let unconfirmedPosts: JiraUnconfirmedPosts;
/** The thread an issue update put a request's next answer in — the real store, over a file in `dataDir`. */
let answerThreads: JiraAnswerThreads;
/** The comments kept up to date (a request's progress note) — the real store, over a file in `dataDir`. */
let progressComments: JiraProgressComments;

/** The store as a restarted process finds it: read back from its file. */
async function loadProgressComments(): Promise<JiraProgressComments> {
  const store = JiraProgressComments.createForDataDir(path.join(dataDir, jiraProgressCommentsFileName), () => nowMs);
  await store.load();
  return store;
}

/** The store as a restarted process finds it: read back from its file. */
async function loadUnconfirmedPosts(): Promise<JiraUnconfirmedPosts> {
  const store = JiraUnconfirmedPosts.createForDataDir(path.join(dataDir, jiraUnconfirmedPostsFileName), () => nowMs);
  await store.load();
  return store;
}

function createClient(): Pick<JiraClient, 'addComment' | 'editComment' | 'getRecentComments' | 'getIssue' | 'assignIssue' | 'getComment'> {
  return {
    getComment: async (issue, commentId) => {
      jira.calls.push(`getComment ${issue} ${commentId}`);
      const comment = jira.commentsById.get(commentId);
      if (comment === undefined) throw new Error(`Jira GET comment ${commentId} failed with 404`);
      if (comment instanceof Error) throw comment;
      return comment;
    },
    addComment: async (issue, body: AdfDocument, parentId) => {
      jira.calls.push(parentId ? `comment ${issue} in thread ${parentId}` : `comment ${issue}`);
      jira.postedTexts.push(getAdfText(body));
      jira.postedBodies.push(body);
      jira.postedParentIds.push(parentId ?? null);
      const outcome = jira.postOutcomes.shift() ?? { outcome: 'created', id: `c${jira.postedTexts.length}` };
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    editComment: async (issue, commentId, body: AdfDocument) => {
      jira.calls.push(`edit ${issue} ${commentId}`);
      jira.edits.push({ commentId, body, text: getAdfText(body) });
      const failure = jira.editFailures.shift();
      if (failure) throw failure;
    },
    getRecentComments: async (issue) => {
      jira.calls.push(`read-back ${issue}`);
      if (jira.recentComments instanceof Error) throw jira.recentComments;
      return jira.recentComments;
    },
    getIssue: async (issue): Promise<JiraIssue> => {
      jira.calls.push(`assignee? ${issue}`);
      return { id: '1', key: issue, fields: { assignee: { accountId: jira.assignee } } };
    },
    assignIssue: async (issue, accountId) => {
      jira.calls.push(`assign ${issue} ${accountId}`);
      if (jira.isAssignFailing) throw new Error('Jira PUT failed with 400: cannot assign');
      jira.assignee = accountId;
    },
  };
}

const sink = () => createJiraAnswerSink({
  client: createClient(),
  aiAccountId,
  contextLedger: { getShownBlock: (_issueKey, blockKey) => jira.sentBlocks[blockKey] },
  getTrust: () => jira.trust,
  runBudgetPer24h: 5,
  now: () => nowMs,
  wait: async (ms) => {
    jira.calls.push(`wait ${ms}`);
  },
  unconfirmedPosts,
  answerThreads,
  progressComments,
  ...(jira.attachFiles ? { attachFiles: jira.attachFiles } : {}),
});
const deliver = (kind: RequestAnswerKind, body: string, isRequestOpen = true) =>
  sink().deliverAnswer(key, { requestId: 'req_1', kind, body, origin, isRequestOpen });

beforeEach(async () => {
  jira = { calls: [], postedTexts: [], postedBodies: [], postedParentIds: [], commentsById: new Map(), sentBlocks: {}, trust: null, assignee: aiAccountId, postOutcomes: [], edits: [], editFailures: [], recentComments: [], isAssignFailing: false };
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'jira-sink-'));
  unconfirmedPosts = await loadUnconfirmedPosts();
  answerThreads = JiraAnswerThreads.createForDataDir(path.join(dataDir, jiraAnswerThreadsFileName), () => nowMs);
  await answerThreads.load();
  progressComments = await loadProgressComments();
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('answers', () => {
  it('a final answer: the comment, then the issue handed back to the requester', async () => {
    assert.deepEqual(await deliver('final', 'Done: **built** and tested.'), { ok: true });
    assert.deepEqual(jira.calls, ['comment PROJ-12', 'assignee? PROJ-12', 'assign PROJ-12 requester-account']);
    assert.deepEqual(jira.postedTexts, ['Done: built and tested.']);
  });

  it('a question hands it back too; a progress note does not', async () => {
    await deliver('question', 'Which branch?');
    assert.ok(jira.calls.includes('assign PROJ-12 requester-account'));
    jira.calls = [];
    jira.assignee = aiAccountId;
    assert.deepEqual(await deliver('progress', 'Halfway.'), { ok: true });
    assert.deepEqual(jira.calls, ['comment PROJ-12']);
  });

  it('someone who took the issue meanwhile keeps it', async () => {
    jira.assignee = 'someone-else';
    assert.deepEqual(await deliver('final', 'Done.'), { ok: true });
    assert.ok(!jira.calls.some((call) => call.startsWith('assign ')));
    assert.equal(jira.assignee, 'someone-else');
  });

  it('an answer to a request that is no longer open never takes the issue from the newer one', async () => {
    assert.deepEqual(await deliver('final', 'Late result.', false), { ok: true });
    assert.deepEqual(jira.calls, ['comment PROJ-12']);
  });

  it('a hand-back that fails leaves the answer delivered, with a warning — never a re-post', async () => {
    jira.isAssignFailing = true;
    const result = await deliver('final', 'Done.');
    assert.equal(result.ok, true);
    assert.match(result.ok ? result.warning ?? '' : '', /could not be handed back to the requester \(Jira PUT failed with 400: cannot assign\)/);
    assert.equal(jira.calls.filter((call) => call.startsWith('comment')).length, 1);
  });

  it('no known requester: delivered, the issue stays, the agent is told', async () => {
    const result = await sink().deliverAnswer(key, { requestId: 'req_1', kind: 'final', body: 'Done.', origin: { kind: 'trackerEvent', attributes: { issueKey } }, isRequestOpen: true });
    assert.match(result.ok ? result.warning ?? '' : '', /no requester is known/);
    assert.ok(!jira.calls.some((call) => call.startsWith('assign ')));
  });

  it('a long answer is several comments, in order, then one hand-back', async () => {
    const paragraphs = Array.from({ length: 3 }, (_, index) => `${index}`.repeat(paragraphLength));
    assert.deepEqual(await deliver('final', paragraphs.join('\n\n')), { ok: true });
    assert.deepEqual(jira.calls.filter((call) => call.startsWith('comment')).length, 3);
    assert.deepEqual(jira.postedTexts.map((text) => text[0]), ['0', '1', '2']);
    assert.equal(jira.calls.filter((call) => call.startsWith('assign ')).length, 1);
  });

  it('a part that fails after the first: delivered with a warning quoting where the unposted rest starts; nothing re-posted', async () => {
    jira.postOutcomes = [{ outcome: 'created', id: 'c1' }, new Error('Jira POST failed with 400: too long')];
    const paragraphs = Array.from({ length: 3 }, (_, index) => `${index}`.repeat(paragraphLength));
    const result = await deliver('final', paragraphs.join('\n\n'));
    assert.equal(result.ok, true);
    assert.equal(
      result.ok ? result.warning : '',
      'the first 1 of the answer\'s 3 comments reached the issue, the rest did not (Jira POST failed with 400: too long). ' +
        `Send the rest again, starting at "${'1'.repeat(80)}…" — not the comments already posted`,
    );
    assert.equal(jira.calls.filter((call) => call.startsWith('comment')).length, 2);
  });

  it('a later part of unknown outcome that could not be checked: the warning says it may be on the issue and where to resend from', async () => {
    jira.postOutcomes = [{ outcome: 'created', id: 'c1' }, { outcome: 'deliveryUnknown', reason: 'Jira POST: outcome unknown — timeout' }];
    jira.recentComments = new Error('Jira GET failed: fetch failed');
    const paragraphs = Array.from({ length: 3 }, (_, index) => `${index}`.repeat(paragraphLength));
    const result = await deliver('final', paragraphs.join('\n\n'));
    assert.equal(result.ok, true);
    assert.match(
      result.ok ? result.warning ?? '' : '',
      new RegExp(`^the first 1 of the answer's 3 comments reached the issue; the next one, starting at "1{80}…", may or may not have ` +
        '\\(Jira POST: outcome unknown — timeout; the issue could not be read to check\\), and nothing after it was posted\\. ' +
        'Send the rest again, unchanged, starting at "1{80}…" — the same text is checked against the issue first, so a comment that did land is not posted twice$'),
    );
    assert.equal(jira.calls.filter((call) => call.startsWith('comment')).length, 2, 'never re-posted by the sink');
  });

  it('the first comment refused: an error, the request stays for a retry, no hand-back', async () => {
    jira.postOutcomes = [new Error('Jira POST failed with 404: Issue does not exist')];
    assert.deepEqual(await deliver('final', 'Done.'), { ok: false, error: 'Jira did not take the comment: Jira POST failed with 404: Issue does not exist' });
    assert.deepEqual(jira.calls, ['comment PROJ-12']);
  });

  it('an empty answer is refused before anything reaches Jira', async () => {
    assert.deepEqual(await deliver('final', '  \n '), { ok: false, error: 'the answer is empty' });
    assert.deepEqual(jira.calls, []);
  });
});

const unknown: JiraCommentPostResult = { outcome: 'deliveryUnknown', reason: 'Jira POST: outcome unknown — 502' };
const comment = (author: string, createdMs: number, text: string): JiraComment => ({
  id: 'x',
  author: { accountId: author },
  created: new Date(createdMs).toISOString(),
  body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
});

describe('a comment post of unknown outcome is read back, never re-posted blindly (R18)', () => {

  it('found on the issue (by the AI account, the same text, not older than the post): delivered, handed back', async () => {
    jira.postOutcomes = [unknown];
    jira.recentComments = [comment(aiAccountId, nowMs + 1_000, 'Done:   tested.')];
    assert.deepEqual(await deliver('final', 'Done: tested.'), { ok: true });
    assert.deepEqual(jira.calls, [
      'comment PROJ-12',
      `wait ${jiraReadBackDelayMs}`,
      'read-back PROJ-12',
      'assignee? PROJ-12',
      'assign PROJ-12 requester-account',
    ]);
  });

  it('not found after the wait — another author, other text, or an older comment: most likely not posted, send it again', async () => {
    jira.postOutcomes = [unknown];
    jira.recentComments = [
      comment('requester-account', nowMs, 'Done: tested.'),
      comment(aiAccountId, nowMs, 'Something else.'),
      comment(aiAccountId, nowMs - jiraReadBackClockSkewMs - 1, 'Done: tested.'),
    ];
    const result = await deliver('final', 'Done: tested.');
    assert.deepEqual(result, {
      ok: false,
      error: 'Jira did not confirm the comment (Jira POST: outcome unknown — 502; it was not on the issue 10 s later), so it was most likely not posted; send the answer again',
    });
    assert.equal(jira.calls.filter((call) => call.startsWith('comment')).length, 1, 'never re-posted by the sink');
  });

  it('the read-back fails too: unknown — the agent, which cannot look at the issue, is told to send again and what that risks', async () => {
    jira.postOutcomes = [unknown];
    jira.recentComments = new Error('Jira GET failed: fetch failed');
    const result = await deliver('final', 'Done: tested.');
    assert.equal(result.ok, false);
    assert.equal(
      result.ok ? '' : result.error,
      'Jira did not confirm the comment and the issue could not be read to check it (Jira POST: outcome unknown — 502); it may already be there. ' +
        'Send the answer again, unchanged: before the same text is posted again, the issue is read, so a comment that did land is not posted twice',
    );
  });

  it('an identical comment by the AI account two minutes before the post is an earlier one, not this post (R30)', async () => {
    jira.postOutcomes = [unknown];
    jira.recentComments = [comment(aiAccountId, nowMs - 2 * 60 * 1000, 'Done: tested.')];
    const result = await deliver('final', 'Done: tested.');
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /most likely not posted/);
  });
});

describe('a resend of an unconfirmed post reads the issue first: at most once (R29)', () => {
  /** The first attempt: Jira does not confirm, and the comment is not there 10 s later. */
  async function deliverUnconfirmed(): Promise<void> {
    jira.postOutcomes = [unknown];
    jira.recentComments = [];
    const first = await deliver('final', 'Done: tested.');
    assert.match(first.ok ? '' : first.error, /most likely not posted/);
    jira.calls = [];
    jira.postedTexts = [];
  }

  it('the comment landed late: the resend — after a restart — finds it, posts nothing and hands the issue back', async () => {
    await deliverUnconfirmed();
    unconfirmedPosts = await loadUnconfirmedPosts();
    jira.recentComments = [comment(aiAccountId, nowMs + 30_000, 'Done: tested.')];
    assert.deepEqual(await deliver('final', 'Done: tested.'), { ok: true });
    assert.deepEqual(jira.calls, ['read-back PROJ-12', 'assignee? PROJ-12', 'assign PROJ-12 requester-account']);
  });

  it('the comment did not land: the resend posts it, and a third send checks nothing any more', async () => {
    await deliverUnconfirmed();
    assert.deepEqual(await deliver('final', 'Done: tested.'), { ok: true });
    assert.deepEqual(jira.calls.slice(0, 2), ['read-back PROJ-12', 'comment PROJ-12']);
    assert.deepEqual(jira.postedTexts, ['Done: tested.']);
    jira.calls = [];
    await deliver('final', 'Done: tested.');
    assert.equal(jira.calls[0], 'comment PROJ-12', 'the entry was settled — after a restart too');
    assert.equal((await loadUnconfirmedPosts()).getPostedAt('req_1', getCommentBodyHash('Done: tested.')), null);
  });

  it('the issue cannot be read before the resend: nothing is posted, the agent is told to send again later', async () => {
    await deliverUnconfirmed();
    jira.recentComments = new Error('Jira GET failed: fetch failed');
    assert.deepEqual(await deliver('final', 'Done: tested.'), {
      ok: false,
      error: 'Nothing was posted: the issue could not be read to check whether the earlier attempt landed. Send the answer again in a few minutes',
    });
    assert.deepEqual(jira.calls, ['read-back PROJ-12']);
  });

  it('another text, or the same text for another request, is posted without a check', async () => {
    await deliverUnconfirmed();
    await deliver('final', 'Something else.');
    await sink().deliverAnswer(key, { requestId: 'req_2', kind: 'final', body: 'Done: tested.', origin, isRequestOpen: true });
    assert.ok(!jira.calls.includes('read-back PROJ-12'));
    assert.deepEqual(jira.postedTexts, ['Something else.', 'Done: tested.']);
  });

  it('an unconfirmed post a day old is forgotten', async () => {
    unconfirmedPosts.recordUnconfirmed('req_1', getCommentBodyHash('Done: tested.'), nowMs - 24 * 60 * 60 * 1000);
    await deliver('final', 'Done: tested.');
    assert.equal(jira.calls[0], 'comment PROJ-12');
  });

  it('a day-old entry is dropped from memory, at load too — nothing is left of it to settle', async () => {
    const bodyHash = getCommentBodyHash('Done: tested.');
    unconfirmedPosts.recordUnconfirmed('req_1', bodyHash, nowMs - 24 * 60 * 60 * 1000);
    (await loadUnconfirmedPosts()).settle('req_1', bodyHash);
    const lines = readFileSync(path.join(dataDir, jiraUnconfirmedPostsFileName), 'utf8').trim().split('\n');
    assert.deepEqual(lines.map((line): string => JSON.parse(line).state), ['unconfirmed'], 'no settle line: the entry was already gone');
  });
});

describe('alert and park notice', () => {
  it('the alert is an English comment saying in plain words what happened and what it means — no request id — then the hand-back; nothing to release', async () => {
    assert.deepEqual(await sink().deliverAlert(key, { requestId: 'req_9', reason: 'wakeFailed', origin }), { ok: true });
    assert.deepEqual(jira.postedTexts, [buildJiraAlertText('wakeFailed')]);
    assert.equal(
      jira.postedTexts[0],
      "⚠️ The AI's session could not be reached to remind it, so there is no answer here. It will not go on by itself: a person needs to look at this issue. To try again, hand it to the AI again or mention it in a comment.",
    );
    assert.ok(!jira.postedTexts[0].includes('req_'), 'the request id stays in the log');
    assert.match(buildJiraAlertText('silentTurns'), /^⚠️ The AI stopped working on this without giving an answer, even after it was reminded\. It will not go on by itself/);
    assert.ok(jira.calls.includes('assign PROJ-12 requester-account'));
    await sink().releaseAlert(key, 'anything');
  });

  it('an alert comment Jira refused is an error (the core logs it)', async () => {
    jira.postOutcomes = [new Error('Jira POST failed with 403')];
    const result = await sink().deliverAlert(key, { requestId: 'req_9', reason: 'silentTurns', origin });
    assert.equal(result.ok, false);
  });

  it('the park notice names the limit, then the issue goes back to the requester', async () => {
    await sink().parkIssue(issueKey, { accountId: 'requester-account' });
    assert.deepEqual(jira.postedTexts, [buildJiraParkText(5)]);
    // T5: hand-overs and mentions fill the same budget, and the notice says so.
    assert.equal(
      jira.postedTexts[0],
      '⏸ The AI was asked to work on this issue 5 times in the last 24 hours (hand-overs and mentions together), its limit, ' +
        'so no new request was opened. Assign it to the AI again later, or ask the operator to raise the limit.',
    );
    assert.ok(jira.calls.includes('assign PROJ-12 requester-account'));
  });

  describe('the queued notice (D10)', () => {
    it('says every slot is busy and the issue starts by itself — one comment, and NO hand-back: the issue stays the AI\'s', async () => {
      await sink().postQueuedNotice(issueKey, { kind: 'queued', isNewlyQueued: true, aheadCount: 2, maxConcurrent: 5 });
      assert.deepEqual(jira.postedTexts, [buildJiraQueuedText(5, 2)]);
      assert.equal(
        jira.postedTexts[0],
        '⏳ The AI is working on 5 tasks at once, its limit, so this issue is queued (2 issues are ahead of it). ' +
          'It starts by itself when a slot frees up; nothing is needed from you.',
      );
      assert.deepEqual(jira.calls, ['comment PROJ-12'], 'nothing is handed back');
    });

    it('the wording follows the numbers: the next in line, one issue ahead, a cap of one', () => {
      assert.match(buildJiraQueuedText(5, 0), /\(it is next in line\)/);
      assert.match(buildJiraQueuedText(5, 1), /\(1 issue is ahead of it\)/);
      assert.match(buildJiraQueuedText(1, 3), /working on 1 task at once/);
    });

    it('a notice Jira refused is a warning, never a throw — the poll goes on', async () => {
      jira.postOutcomes = [new Error('Jira POST failed with 403')];
      const warnings = mock.method(console, 'warn', () => {});
      try {
        await sink().postQueuedNotice(issueKey, { kind: 'queued', isNewlyQueued: true, aheadCount: 0, maxConcurrent: 5 });
        assert.equal(warnings.mock.calls.length, 1);
        assert.match(String(warnings.mock.calls[0].arguments[0]), /^\[jira\] PROJ-12: queued notice not posted: Jira did not take the comment/);
      } finally {
        warnings.mock.restore();
      }
    });
  });

  describe('the notice of a hand-over the trusted group does not back (T1)', () => {
    it('the fixed text names the configured group, then the issue goes back to the requester', async () => {
      await sink().refuseUntrusted(issueKey, { accountId: 'outsider-account' }, 'ai-trusted');
      assert.deepEqual(jira.postedTexts, [
        'Only members of the AI\'s trusted group (ai-trusted) can hand it work, so nothing was started. Ask a member to hand it over.',
      ]);
      assert.deepEqual(jira.calls, ['comment PROJ-12', 'assignee? PROJ-12', 'assign PROJ-12 outsider-account']);
    });

    it('a group name is data: Markdown in it reaches the comment as written, not converted', async () => {
      const groupName = 'team_*dev*_ [ops] `x`';
      await sink().refuseUntrusted(issueKey, { accountId: 'outsider-account' }, groupName);
      assert.deepEqual(jira.postedTexts, [buildJiraUntrustedText(groupName)]);
      assert.ok(jira.postedTexts[0].includes(`(${groupName})`));
    });

    it('a notice Jira refused is a warning and NO hand-back — the issue stays the AI\'s', async () => {
      jira.postOutcomes = [new Error('Jira POST failed with 403')];
      const warnings = mock.method(console, 'warn', () => {});
      try {
        await sink().refuseUntrusted(issueKey, { accountId: 'outsider-account' }, 'ai-trusted');
        assert.deepEqual(jira.calls, ['comment PROJ-12']);
        assert.equal(warnings.mock.calls.length, 1);
        assert.match(String(warnings.mock.calls[0].arguments[0]), /^\[jira\] PROJ-12: untrusted notice not posted: Jira did not take the comment/);
      } finally {
        warnings.mock.restore();
      }
    });

    it('no requester known: the notice stands and the issue stays assigned, with a warning', async () => {
      const warnings = mock.method(console, 'warn', () => {});
      try {
        await sink().refuseUntrusted(issueKey, null, 'ai-trusted');
        assert.deepEqual(jira.calls, ['comment PROJ-12']);
        assert.match(String(warnings.mock.calls[0].arguments[0]), /^\[jira\] PROJ-12: untrusted: no requester is known/);
      } finally {
        warnings.mock.restore();
      }
    });

    it('an issue someone took meanwhile keeps its new assignee', async () => {
      jira.assignee = 'someone-else';
      await sink().refuseUntrusted(issueKey, { accountId: 'outsider-account' }, 'ai-trusted');
      assert.deepEqual(jira.calls, ['comment PROJ-12', 'assignee? PROJ-12']);
    });
  });
});

describe('a mention request answers only — nothing is handed over, so nothing is handed back (T5–T7)', () => {
  const deliverMention = (kind: RequestAnswerKind, body: string) =>
    sink().deliverAnswer(key, { requestId: 'req_2', kind, body, origin: mentionOrigin, isRequestOpen: true });
  /** The requester's own comment, which the answer's mention is read from. */
  const requesterCommentId = mentionOrigin.attributes.triggerId.slice('mention:'.length);

  beforeEach(() => {
    jira.commentsById.set(requesterCommentId, {
      id: requesterCommentId,
      author: { accountId: 'requester-account', accountType: 'atlassian', displayName: 'Requester' },
      created: '2026-10-03T10:00:00.000+0000',
    });
  });

  it('a final answer is a comment and the issue stays where it is: no assignee read, no assignment', async () => {
    assert.deepEqual(await deliverMention('final', 'The export fails on an empty row.'), { ok: true });
    assert.deepEqual(jira.calls, [`getComment PROJ-12 ${requesterCommentId}`, 'comment PROJ-12']);
    assert.deepEqual(jira.postedTexts, ['@Requester\nThe export fails on an empty row.']);
  });

  it('a question stays a plain comment: no hand-back and no "to let me go on" line — it has nobody to hand back to', async () => {
    assert.deepEqual(await deliverMention('question', 'Which export?'), { ok: true });
    assert.deepEqual(jira.calls, [`getComment PROJ-12 ${requesterCommentId}`, 'comment PROJ-12']);
    assert.deepEqual(jira.postedTexts, ['@Requester\nWhich export?']);
  });

  it('the alert of a mention request is a comment and no hand-back', async () => {
    assert.deepEqual(await sink().deliverAlert(key, { requestId: 'req_2', reason: 'silentTurns', origin: mentionOrigin }), { ok: true });
    assert.deepEqual(jira.calls, ['comment PROJ-12']);
    assert.deepEqual(jira.postedTexts, [buildJiraAlertText('silentTurns')]);
  });

  it('an ACTING mention (mentionMode "act") hands nothing back either: its final answer and its alert are comments, the issue stays where it is', async () => {
    const actingOrigin: RequestOrigin = { kind: 'trackerMention', attributes: { ...mentionOrigin.attributes, mayAct: 'true' } };
    // The issue is the AI's (it assigned itself to take up the work): a final answer must still not hand it anywhere.
    assert.equal(jira.assignee, aiAccountId);
    assert.deepEqual(await sink().deliverAnswer(key, { requestId: 'req_2', kind: 'final', body: 'Split into PROJ-13 and PROJ-14.', origin: actingOrigin, isRequestOpen: true }), { ok: true });
    assert.deepEqual(await sink().deliverAlert(key, { requestId: 'req_2', reason: 'wakeCap', origin: actingOrigin }), { ok: true });
    assert.deepEqual(jira.calls, [`getComment PROJ-12 ${requesterCommentId}`, 'comment PROJ-12', 'comment PROJ-12']);
    assert.deepEqual(jira.postedTexts[0], '@Requester\nSplit into PROJ-13 and PROJ-14.');
  });
});

describe('a hand-over question tells the requester how to let the agent go on (T7)', () => {
  const continueLine = 'To let me go on, answer in a comment and assign the issue back to me.';

  it('the question ends with that line as a paragraph of its own, then the issue goes back', async () => {
    assert.equal(jiraQuestionContinueText, continueLine);
    await deliver('question', 'Which branch should I use?');
    assert.deepEqual(jira.postedTexts, [`Which branch should I use?\n${continueLine}`]);
    const [body] = jira.postedBodies;
    const lastParagraph = body.content[body.content.length - 1];
    assert.deepEqual(lastParagraph, { type: 'paragraph', content: [{ type: 'text', text: continueLine }] });
    assert.ok(jira.calls.includes('assign PROJ-12 requester-account'));
  });

  it('a question to a superseded request does not carry it — nothing is handed back', async () => {
    await deliver('question', 'Which branch should I use?', false);
    assert.deepEqual(jira.postedTexts, ['Which branch should I use?']);
    assert.ok(!jira.calls.some((call) => call.startsWith('assign ')));
  });

  it('a final answer and a progress note do not carry it', async () => {
    await deliver('final', 'Done.');
    await deliver('progress', 'Halfway.');
    assert.deepEqual(jira.postedTexts, ['Done.', 'Halfway.']);
  });

  it('a question split over several comments carries it once, on the last', async () => {
    const paragraph = 'x'.repeat(paragraphLength);
    await deliver('question', `${paragraph}\n\n${paragraph}`);
    assert.equal(jira.postedTexts.length, 2);
    assert.ok(!jira.postedTexts[0].includes(continueLine));
    assert.ok(jira.postedTexts[1].endsWith(continueLine));
  });
});

describe('the park notices (T5, T6)', () => {
  it('T6: a mention over the budget names the limit and tells the person to mention again; nothing is handed back', async () => {
    await sink().parkMention(issueKey);
    assert.deepEqual(jira.postedTexts, [buildJiraMentionParkText(5)]);
    assert.equal(
      jira.postedTexts[0],
      '⏸ The AI was asked about this issue 5 times in the last 24 hours (hand-overs and mentions together), its limit, ' +
        'so this mention was not answered. Mention it again later, or ask the operator to raise the limit.',
    );
    assert.deepEqual(jira.calls, ['comment PROJ-12']);
  });

  it('a mention notice that Jira refused is a warning, never a throw (the trigger is recorded already)', async () => {
    jira.postOutcomes = [new Error('Jira POST failed with 403')];
    const warn = mock.method(console, 'warn', () => {});
    try {
      await sink().parkMention(issueKey);
      assert.ok(warn.mock.calls.some((call) => String(call.arguments[0]).includes('mention park notice not posted')));
    } finally {
      warn.mock.restore();
    }
  });
});

describe('whom an answer notifies: the requester of a mention request, and the authors it replies to (T10–T12)', () => {
  const requester = { accountId: 'requester-account', accountType: 'atlassian', displayName: 'Requester' };
  const colleague = { accountId: 'colleague-account', accountType: 'atlassian', displayName: 'Colleague' };
  const outsider = { accountId: 'outsider-account', accountType: 'atlassian', displayName: 'Outsider' };
  const automation = { accountId: 'rule-account', accountType: 'app', displayName: 'Automation' };
  const created = '2026-10-03T10:00:00.000+0000';

  /** A comment of the issue; `isShown` puts it in what the conversation was shown. */
  function addComment(id: string, author: JiraComment['author'], options: { isShown?: boolean; isWithheld?: boolean; updateAuthor?: JiraComment['author'] } = {}): string {
    jira.commentsById.set(id, { id, author, created, ...(options.updateAuthor ? { updated: created, updateAuthor: options.updateAuthor } : {}) });
    if (options.isShown ?? true) jira.sentBlocks[`comment:${id}`] = { hash: `hash-${id}`, ...(options.isWithheld ? { isWithheld: true } : {}) };
    return id;
  }
  const createGroupTrust = (memberAccountIds: string[]): JiraTrust => createJiraTrust({
    client: { getGroupByName: async () => null, getGroupMembers: async () => [] },
    snapshot: { groupName: 'ai-trusted', groupId: 'group-1', memberAccountIds: new Set(memberAccountIds), readAtMs: nowMs },
    aiAccountId,
    now: () => nowMs,
  });
  const deliverMention = (kind: RequestAnswerKind, body: string, replyToCommentIds?: string[], isRequestOpen = true) =>
    sink().deliverAnswer(key, { requestId: 'req_2', kind, body, origin: mentionOrigin, isRequestOpen, ...(replyToCommentIds ? { replyToCommentIds } : {}) });
  const deliverHandOver = (kind: RequestAnswerKind, body: string, replyToCommentIds: string[]) =>
    sink().deliverAnswer(key, { requestId: 'req_1', kind, body, origin, isRequestOpen: true, replyToCommentIds });
  /** The mention nodes of the first posted comment's FIRST paragraph, by account id. */
  const getLeadingMentions = (): string[] => getMentionedAccountIds(jira.postedBodies[0].content[0]);
  const getTrigger = (): string => mentionOrigin.attributes.triggerId;

  beforeEach(() => {
    // The mention request's own comment, by its requester.
    addComment(getTrigger().slice('mention:'.length), requester);
  });

  it('T10: every answer to a mention request starts with a real mention of its requester — progress, question and final alike', async () => {
    for (const kind of ['progress', 'question', 'final'] as const) {
      jira.postedBodies = [];
      await deliverMention(kind, 'Looking into it.');
      assert.deepEqual(getLeadingMentions(), [requester.accountId], kind);
      assert.deepEqual(jira.postedBodies[0].content[0], {
        type: 'paragraph',
        content: [{ type: 'mention', attrs: { id: requester.accountId, text: '@Requester' } }],
      });
      assert.equal(getAdfText(jira.postedBodies[0]), '@Requester\nLooking into it.');
    }
  });

  it('an app that mentioned the AI is not mentioned back — it cannot be notified; the answer goes without', async () => {
    jira.commentsById.set(getTrigger().slice('mention:'.length), { id: '10240', author: automation, created });
    mentionOrigin.attributes.requester = automation.accountId;
    try {
      assert.deepEqual(await deliverMention('final', 'Done.'), { ok: true });
    } finally {
      mentionOrigin.attributes.requester = requester.accountId;
    }
    assert.deepEqual(jira.postedTexts, ['Done.']);
  });

  it('a requester\'s comment that is gone: the answer goes without a mention, never fails for it', async () => {
    jira.commentsById.delete(getTrigger().slice('mention:'.length));
    const warn = mock.method(console, 'warn', () => {});
    try {
      assert.deepEqual(await deliverMention('final', 'Done.'), { ok: true });
    } finally {
      warn.mock.restore();
    }
    assert.deepEqual(jira.postedTexts, ['Done.']);
  });

  it('a hand-over request mentions nobody on its own — the hand-back already tells the requester', async () => {
    await deliver('final', 'Done.');
    assert.deepEqual(jira.postedTexts, ['Done.']);
    assert.ok(!jira.calls.some((call) => call.startsWith('getComment')), 'no comment was read for it');
  });

  it('T11/T12: a reply to a delivered comment of a trusted person mentions its author, after the requester, once each', async () => {
    jira.trust = createGroupTrust([requester.accountId, colleague.accountId]);
    addComment('10250', colleague);
    addComment('10251', colleague);
    addComment('10252', requester);
    // Three top-level comments are three threads: the answer goes into the first one's, and the result says so.
    assert.deepEqual(await deliverMention('final', 'Both of you:', ['10250', '10251', '10250', '10252']), {
      ok: true,
      warning: buildJiraOtherThreadsWarning('10250', ['10251', '10252']),
    });
    assert.deepEqual(getLeadingMentions(), [requester.accountId, colleague.accountId], 'requester first; duplicates and the requester again are one mention each');
    assert.deepEqual(jira.postedParentIds, ['10250']);
  });

  it('a hand-over answer may reply too: the mention leads, the "to let me go on" line ends a question', async () => {
    addComment('10250', colleague);
    await deliverHandOver('question', 'Which branch?', ['10250']);
    assert.deepEqual(getLeadingMentions(), [colleague.accountId]);
    assert.equal(jira.postedTexts[0], `@Colleague\nWhich branch?\n${jiraQuestionContinueText}`);
    assert.ok(jira.calls.includes('assign PROJ-12 requester-account'));
  });

  it('left out, with the warning: a comment the conversation was never shown, a withheld one, the AI account\'s own, an app\'s, an unknown id', async () => {
    addComment('20001', colleague, { isShown: false });
    addComment('20002', colleague, { isWithheld: true });
    addComment('20003', { accountId: aiAccountId, accountType: 'atlassian', displayName: 'AI' });
    addComment('20004', automation);
    // 20005 is shown but Jira has no such comment any more.
    jira.sentBlocks['comment:20005'] = { hash: 'hash-20005' };
    const result = await deliverMention('final', 'Done.', ['20001', '20002', '20003', '20004', '20005']);
    assert.deepEqual(result, { ok: true, warning: buildJiraReplyLeftOutWarning(['20001', '20002', '20003', '20004', '20005']) });
    assert.deepEqual(getLeadingMentions(), [requester.accountId], 'only the requester was mentioned');
    assert.equal(
      buildJiraReplyLeftOutWarning(['10240', '10241']),
      'Delivered, but these comments\' authors were not mentioned: 10240, 10241. ' +
        'Only comments you were shown in this conversation, written by a trusted person, can be replied to this way.',
    );
  });

  it('with a trusted group a non-member\'s comment, or one a non-member last edited, is left out; a reply with no valid id still delivers the answer', async () => {
    jira.trust = createGroupTrust([requester.accountId, colleague.accountId]);
    addComment('20010', outsider);
    addComment('20011', colleague, { updateAuthor: outsider });
    const result = await deliverHandOver('final', 'Done.', ['20010', '20011']);
    assert.deepEqual(result, { ok: true, warning: buildJiraReplyLeftOutWarning(['20010', '20011']) });
    assert.deepEqual(jira.postedTexts, ['Done.'], 'the answer was delivered, with no mention at all');
  });

  it('without a trusted group a person\'s comment qualifies: nobody is judged', async () => {
    addComment('20020', outsider);
    assert.deepEqual(await deliverHandOver('final', 'Done.', ['20020']), { ok: true });
    assert.deepEqual(getLeadingMentions(), [outsider.accountId]);
  });

  it('a comment that could not be read for another reason than not existing is left out with a log line for the operator', async () => {
    addComment('20030', colleague);
    jira.commentsById.set('20030', new JiraHttpError(503, 'GET', '/rest/api/3/issue/PROJ-12/comment/20030', 'Service Unavailable'));
    const warn = mock.method(console, 'warn', () => {});
    try {
      const result = await deliverMention('final', 'Done.', ['20030', '99999']);
      assert.deepEqual(result, { ok: true, warning: buildJiraReplyLeftOutWarning(['20030', '99999']) });
      const lines = warn.mock.calls.map((call) => String(call.arguments[0]));
      assert.ok(lines.some((line) => line.includes('comment 20030 could not be read')), 'the 503 is logged');
      assert.ok(!lines.some((line) => line.includes('comment 99999')), 'an unknown id is not worth a line');
    } finally {
      warn.mock.restore();
    }
  });

  it('a long answer carries the mentions on its first comment only', async () => {
    const paragraph = 'x'.repeat(paragraphLength);
    await deliverMention('final', `${paragraph}\n\n${paragraph}`);
    assert.equal(jira.postedBodies.length, 2);
    assert.deepEqual(getMentionedAccountIds(jira.postedBodies[0]), [requester.accountId]);
    assert.deepEqual(getMentionedAccountIds(jira.postedBodies[1]), []);
  });

  it('the read-back of a post of unknown outcome compares the body WITH its mention — a landed comment is not posted twice', async () => {
    jira.postOutcomes = [{ outcome: 'deliveryUnknown', reason: 'timeout' }];
    // The comment did land: the same text, with the mention, by the AI account.
    jira.recentComments = [{
      id: 'c9',
      author: { accountId: aiAccountId },
      created: new Date(nowMs).toISOString(),
      body: { type: 'doc', content: [
        { type: 'paragraph', content: [{ type: 'mention', attrs: { id: requester.accountId, text: '@Requester' } }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Done.' }] },
      ] },
    }];
    assert.deepEqual(await deliverMention('final', 'Done.'), { ok: true });
    assert.equal(jira.postedTexts.length, 1, 'posted once');
  });
});

describe('the "updates paused" notice of an issue past the cap on updates', () => {
  it('says until when (UTC, to the minute), that nothing is lost and that a pause within a day is not told again; posted as plain text, nothing handed back', async () => {
    const untilMs = Date.parse('2026-11-14T09:30:41Z');
    assert.equal(
      buildJiraUpdatesPausedText(20, untilMs),
      '⏸ The AI got 20 updates from comments on this issue in the last 24 hours, its limit, so new comments reach it from 2026-11-14 09:30 UTC on — ' +
        'nothing is lost. If the limit is reached again within a day, comments wait the same way without another note. ' +
        'If you did not write that many, check that the AI posts only as its own account.',
    );
    await sink().postUpdatesPausedNotice(issueKey, 20, untilMs);
    assert.deepEqual(jira.calls, ['comment PROJ-12']);
    assert.deepEqual(jira.postedTexts, [buildJiraUpdatesPausedText(20, untilMs)]);
  });
});

describe('comment threads: an answer goes where it was asked, or into the thread of the comment it replies to', () => {
  const colleague = { accountId: 'colleague-account', accountType: 'atlassian', displayName: 'Colleague' };
  const created = '2026-10-03T10:00:00.000+0000';
  /** A hand-over the requester opened by a reply in the thread of comment 10200 (a comment's request on a handed issue). */
  const threadOrigin: RequestOrigin = { kind: 'trackerEvent', attributes: { issueKey, triggerId: 'comment:10201', requester: 'requester-account', threadCommentId: '10200' } };
  const deliverInThread = (kind: RequestAnswerKind, body: string, replyToCommentIds?: string[]) =>
    sink().deliverAnswer(key, { requestId: 'req_3', kind, body, origin: threadOrigin, isRequestOpen: true, ...(replyToCommentIds ? { replyToCommentIds } : {}) });
  /** An answer to the top-level hand-over that replies to `replyToCommentIds`. */
  const deliverReplying = (kind: RequestAnswerKind, body: string, replyToCommentIds: string[]) =>
    sink().deliverAnswer(key, { requestId: 'req_1', kind, body, origin, isRequestOpen: true, replyToCommentIds });

  /** A comment the conversation was shown; `parentId` (as Jira sends it, a number) makes it a reply in that thread. */
  function addShownComment(id: string, parentId?: number): void {
    jira.commentsById.set(id, { id, author: colleague, created, ...(parentId === undefined ? {} : { parentId }) });
    jira.sentBlocks[`comment:${id}`] = { hash: `hash-${id}` };
  }

  it('the answers of a request a reply opened go into that reply\'s thread — progress, question and final alike; the hand-back is as before', async () => {
    assert.deepEqual(await deliverInThread('progress', 'Looking.'), { ok: true });
    assert.deepEqual(await deliverInThread('final', 'Done.'), { ok: true });
    assert.deepEqual(jira.postedParentIds, ['10200', '10200']);
    assert.deepEqual(jira.calls, ['comment PROJ-12 in thread 10200', 'comment PROJ-12 in thread 10200', 'assignee? PROJ-12', 'assign PROJ-12 requester-account']);
  });

  it('a request opened top-level (a hand-over, a top-level comment) answers top-level; an origin thread that is no comment id is ignored', async () => {
    await deliver('final', 'Done.');
    const oddOrigin: RequestOrigin = { kind: 'trackerEvent', attributes: { ...origin.attributes, threadCommentId: '10200/../x' } };
    await sink().deliverAnswer(key, { requestId: 'req_4', kind: 'progress', body: 'Still on it.', origin: oddOrigin, isRequestOpen: true });
    assert.deepEqual(jira.postedParentIds, [null, null]);
  });

  it('every part of a long answer goes into the same thread', async () => {
    const paragraph = 'x'.repeat(paragraphLength);
    await deliverInThread('progress', `${paragraph}\n\n${paragraph}`);
    assert.deepEqual(jira.postedParentIds, ['10200', '10200']);
  });

  it('replying to a top-level comment puts the answer in that comment\'s thread; replying to a reply, in its thread\'s — never under the reply (one level)', async () => {
    addShownComment('10300');
    addShownComment('10301', 10300);
    await deliverReplying('progress', 'About that:', ['10300']);
    await deliverReplying('progress', 'And that:', ['10301']);
    assert.deepEqual(jira.postedParentIds, ['10300', '10300']);
  });

  it('the comment replied to wins over the thread the request was opened in', async () => {
    addShownComment('10400');
    assert.deepEqual(await deliverInThread('final', 'Answered there.', ['10400']), { ok: true });
    assert.deepEqual(jira.postedParentIds, ['10400']);
  });

  it('a replied-to id that does not qualify moves nothing: the answer stays in the request\'s own thread, with the left-out warning', async () => {
    jira.sentBlocks['comment:10500'] = { hash: 'hash-10500', isWithheld: true };
    jira.commentsById.set('10500', { id: '10500', author: colleague, created });
    assert.deepEqual(await deliverInThread('final', 'Done.', ['10500']), { ok: true, warning: buildJiraReplyLeftOutWarning(['10500']) });
    assert.deepEqual(jira.postedParentIds, ['10200']);
  });

  it('replies in several threads: the answer goes into the first one\'s, the others are mentioned and named in a warning', async () => {
    addShownComment('10600');
    addShownComment('10601', 10600);
    addShownComment('10700');
    const result = await deliverReplying('final', 'For all of you.', ['10601', '10600', '10700']);
    assert.deepEqual(result, { ok: true, warning: buildJiraOtherThreadsWarning('10600', ['10700']) });
    assert.deepEqual(jira.postedParentIds, ['10600']);
    assert.equal(
      buildJiraOtherThreadsWarning('10600', ['10700']),
      'Delivered in the thread of comment 10600, but comment 10700 is in another thread: its author was mentioned, and the answer is not there. ' +
        'To answer in that thread too, send a separate answer that replies to it.',
    );
  });

  it('a thread Jira refuses (400 — its comments are gone) gets the answer as a new top-level comment, and the agent is told; nothing is posted twice', async () => {
    jira.postOutcomes = [new JiraHttpError(400, 'POST', '/rest/api/3/issue/PROJ-12/comment', 'comment: Parent comment not found, and no child comments exist. Cannot create new child comments.')];
    const paragraph = 'x'.repeat(paragraphLength);
    const warn = mock.method(console, 'warn', () => {});
    try {
      const result = await deliverInThread('progress', `${paragraph}\n\n${paragraph}`);
      assert.deepEqual(result, { ok: true, warning: buildJiraThreadRefusedWarning('10200') });
    } finally {
      warn.mock.restore();
    }
    // The refused reply, the same part top-level, and the rest of the answer top-level too.
    assert.deepEqual(jira.postedParentIds, ['10200', null, null]);
    assert.equal(
      buildJiraThreadRefusedWarning('10200'),
      'The thread of comment 10200 no longer takes replies (Jira refused it), so the answer was posted as a new comment instead.',
    );
  });

  it('any other refusal is not taken for a gone thread: a reply refused with 403, a top-level post refused with 400 — the answer\'s error, posted nowhere else', async () => {
    jira.postOutcomes = [new JiraAuthError(403, 'POST', '/rest/api/3/issue/PROJ-12/comment')];
    assert.equal((await deliverInThread('final', 'Done.')).ok, false);
    jira.postOutcomes = [new JiraHttpError(400, 'POST', '/rest/api/3/issue/PROJ-12/comment', 'INVALID_INPUT')];
    assert.equal((await deliver('final', 'Done.')).ok, false);
    assert.deepEqual(jira.postedParentIds, ['10200', null], 'neither was tried again');
  });

  it('an issue update whose newest comment is a reply puts the request\'s NEXT answer in that thread — ahead of the request\'s own; the answer uses it up', async () => {
    answerThreads.note('req_1', '10900');
    assert.deepEqual(await deliver('progress', 'About your reply:'), { ok: true });
    assert.deepEqual(await deliver('final', 'Back to the work.'), { ok: true });
    answerThreads.note('req_3', '10900');
    await deliverInThread('progress', 'In the update\'s thread, not the one the request was opened in.');
    await deliverInThread('final', 'Back in the request\'s own thread.');
    assert.deepEqual(jira.postedParentIds, ['10900', null, '10900', '10200']);
  });

  it('a comment the agent replies to still decides first; a later top-level update sends the next answer where it goes by default; a restarted process keeps the thread', async () => {
    addShownComment('10950');
    answerThreads.note('req_1', '10900');
    await deliverReplying('progress', 'To that one:', ['10950']);
    assert.deepEqual(jira.postedParentIds, ['10950']);
    answerThreads.note('req_1', '10900');
    answerThreads.note('req_1', null);
    await deliver('progress', 'Top-level, as the newest comment was.');
    answerThreads.note('req_1', '10900');
    answerThreads = JiraAnswerThreads.createForDataDir(path.join(dataDir, jiraAnswerThreadsFileName), () => nowMs);
    await answerThreads.load();
    await deliver('final', 'Done, in the thread after a restart.');
    assert.deepEqual(jira.postedParentIds, ['10950', null, '10900']);
  });

  it('a notice the BOT writes (a usage limit, a refused sign-in) goes into the update\'s thread but uses nothing up: the agent\'s answer after the resume still goes there', async () => {
    answerThreads.note('req_1', '10900');
    const botNotice = await sink().deliverAnswer(key, { requestId: 'req_1', kind: 'progress', body: 'The AI hit its usage limit and goes on at 14:00.', origin, isRequestOpen: true, isBotNotice: true });
    assert.deepEqual(botNotice, { ok: true });
    assert.equal(answerThreads.get('req_1'), '10900', 'still owed to the agent\'s answer');
    await deliver('progress', 'About your reply, after the resume:');
    assert.equal(answerThreads.get('req_1'), null, 'the agent\'s answer used it up');
    await deliver('final', 'Back to the work.');
    assert.deepEqual(jira.postedParentIds, ['10900', '10900', null]);
  });

  it('an answer that was not delivered leaves the update\'s thread for the resend', async () => {
    answerThreads.note('req_1', '10900');
    jira.postOutcomes = [new JiraAuthError(403, 'POST', '/rest/api/3/issue/PROJ-12/comment')];
    assert.equal((await deliver('progress', 'First try.')).ok, false);
    await deliver('progress', 'Second try.');
    assert.deepEqual(jira.postedParentIds, ['10900', '10900'], 'the refused try and the resend, both in the thread');
  });

  it('the alert of a request a reply opened goes into its thread', async () => {
    await sink().deliverAlert(key, { requestId: 'req_3', reason: 'silentTurns', origin: threadOrigin });
    assert.deepEqual(jira.postedParentIds, ['10200']);
  });

  it('the notices about a trigger that is a reply go into its thread: park, mention park, queued; the untrusted and the updates-paused notices stay top-level', async () => {
    await sink().parkIssue(issueKey, { accountId: 'requester-account' }, '10200');
    await sink().parkMention(issueKey, '10210');
    await sink().postQueuedNotice(issueKey, { kind: 'queued', isNewlyQueued: true, aheadCount: 0, maxConcurrent: 5 }, '10220');
    await sink().refuseUntrusted(issueKey, { accountId: 'requester-account' }, 'ai-trusted');
    await sink().postUpdatesPausedNotice(issueKey, 20, nowMs);
    assert.deepEqual(jira.postedParentIds, ['10200', '10210', '10220', null, null]);
    // A notice without a thread, as every caller before threads: top-level.
    await sink().parkMention(issueKey);
    assert.equal(jira.postedParentIds.at(-1), null);
  });
});

describe('files: attached first, then shown in the comment after its text', () => {
  const shownNode = { type: 'mediaSingle', attrs: { layout: 'center' }, content: [{ type: 'media', attrs: { type: 'file', id: 'm-1', collection: '' } }] };
  /** What the fake attach did, in order. */
  let attachCalls: string[];

  beforeEach(() => {
    attachCalls = [];
    jira.attachFiles = async (issue, paths, options) => {
      attachCalls.push(`attach ${issue} ${paths.join(',')} ${options.isShownInline ? 'shown' : 'linked'}`);
      jira.calls.push('attach');
      return {
        ok: true,
        files: [{ name: 'shot.png', attachmentId: '9001', kind: 'image', mediaId: 'm-1', size: null, isReused: false }],
        nodes: [shownNode],
        summary: 'shot.png (shown in the comment, attachment 9001)',
        notes: [],
        sentKinds: ['photo'],
      };
    };
  });
  const deliverWithFiles = (kind: RequestAnswerKind, body: string, files: string[], answerOrigin: RequestOrigin = origin) =>
    sink().deliverAnswer(key, { requestId: 'req_5', kind, body, origin: answerOrigin, isRequestOpen: true, files });

  it('an answer\'s files are attached before its comment is posted, and shown after its text in that comment', async () => {
    assert.deepEqual(await deliverWithFiles('final', 'Fixed — see the screenshot.', ['shots/after.png']), { ok: true });
    assert.deepEqual(attachCalls, ['attach PROJ-12 shots/after.png shown']);
    assert.deepEqual(jira.calls.slice(0, 2), ['attach', 'comment PROJ-12']);
    assert.deepEqual(jira.postedBodies[0].content.map((node) => node.type), ['paragraph', 'mediaSingle']);
  });

  it('a hand-over\'s question: the files sit between the text and the line saying how to let the agent go on', async () => {
    await deliverWithFiles('question', 'Is this the layout you meant?', ['a.png']);
    const types = jira.postedBodies[0].content.map((node) => node.type);
    assert.deepEqual(types, ['paragraph', 'mediaSingle', 'paragraph']);
    assert.ok(getAdfText(jira.postedBodies[0]).endsWith(jiraQuestionContinueText));
  });

  it('in a thread the files go with the answer; what the attach had to say rides the result', async () => {
    const attachWithNote = jira.attachFiles;
    jira.attachFiles = async (issue, paths, options) => {
      const result = await attachWithNote?.(issue, paths, options);
      return result && result.ok ? { ...result, notes: ['run.webm is linked, not played'] } : { ok: false, error: 'x' };
    };
    const threadOrigin: RequestOrigin = { kind: 'trackerMention', attributes: { issueKey, triggerId: 'mention:10201', requester: 'requester-account', threadCommentId: '10200' } };
    jira.commentsById.set('10201', { id: '10201', author: { accountId: 'requester-account', accountType: 'atlassian', displayName: 'Requester' }, created: '2026-10-03T10:00:00.000+0000' });
    assert.deepEqual(await deliverWithFiles('final', 'Here.', ['run.webm'], threadOrigin), { ok: true, warning: 'run.webm is linked, not played' });
    assert.deepEqual(jira.postedParentIds, ['10200']);
  });

  it('a file that cannot be attached fails the answer with nothing posted — safe to send again', async () => {
    jira.attachFiles = async () => ({ ok: false, error: 'cut.png is not a complete PNG image — a partial file? Save it again whole. Nothing was attached or posted.' });
    assert.deepEqual(await deliverWithFiles('final', 'Done.', ['cut.png']), { ok: false, error: 'cut.png is not a complete PNG image — a partial file? Save it again whole. Nothing was attached or posted.' });
    assert.deepEqual(jira.postedBodies, []);
    assert.ok(!jira.calls.includes('assign PROJ-12 requester-account'), 'nothing handed back either');
  });

  it('an attach that throws is the same; a sink with no way to attach refuses files, nothing posted; an answer without files never asks', async () => {
    jira.attachFiles = async () => {
      throw new Error('Jira GET /rest/api/3/attachment/meta failed with 503');
    };
    const thrown = await deliverWithFiles('final', 'Done.', ['a.png']);
    assert.match(!thrown.ok ? thrown.error : '', /^the files could not be attached \(Jira GET .* 503\); nothing was posted$/);
    jira.attachFiles = undefined;
    assert.deepEqual(await deliverWithFiles('final', 'Done.', ['a.png']), { ok: false, error: jiraFilesUnavailableError });
    assert.deepEqual(await deliver('final', 'Done.'), { ok: true });
    assert.deepEqual(jira.postedTexts, ['Done.']);
  });
});

describe('send_file_to_user on an issue: the files in a comment of their own', () => {
  const nodes = [{ type: 'mediaSingle', attrs: { layout: 'center' }, content: [{ type: 'media', attrs: { type: 'file', id: 'm-1', collection: '' } }] }];
  beforeEach(() => {
    jira.attachFiles = async (_issue, _paths, options) => ({
      ok: true,
      files: [{ name: 'run.mp4', attachmentId: '9002', kind: 'video', mediaId: options.isShownInline ? 'm-1' : null, size: null, isReused: false }],
      nodes,
      summary: 'run.mp4 (plays in the comment, attachment 9002)',
      notes: [],
      sentKinds: ['video'],
    });
  });

  it('the caption is the comment\'s text, the files follow it; the comment goes into the thread it is given', async () => {
    const result = await sink().postFiles(issueKey, { paths: ['run.mp4'], caption: 'The passing run:', isAsLinks: false }, '10200');
    assert.deepEqual(result, { ok: true, summary: 'Posted in a comment in the thread of comment 10200 on PROJ-12: run.mp4 (plays in the comment, attachment 9002).', sentKinds: ['video'] });
    assert.deepEqual(jira.postedBodies[0].content.map((node) => node.type), ['paragraph', 'mediaSingle']);
    assert.deepEqual(jira.postedParentIds, ['10200']);
    assert.ok(!jira.calls.some((call) => call.startsWith('assign')), 'a file comment hands nothing back');
  });

  it('no caption: a comment of the files alone, top-level without a thread', async () => {
    const result = await sink().postFiles(issueKey, { paths: ['run.mp4'], isAsLinks: false }, null);
    assert.equal(result.ok && result.summary, 'Posted in a comment on PROJ-12: run.mp4 (plays in the comment, attachment 9002).');
    assert.deepEqual(jira.postedBodies, [{ version: 1, type: 'doc', content: nodes }]);
    assert.deepEqual(jira.postedParentIds, [null]);
  });

  it('a comment Jira refused: the files are attached, the error says so; one of unknown outcome is deliveryUnknown', async () => {
    jira.postOutcomes = [new JiraHttpError(400, 'POST', '/rest/api/3/issue/PROJ-12/comment', 'INVALID_INPUT')];
    const refused = await sink().postFiles(issueKey, { paths: ['run.mp4'], isAsLinks: false }, null);
    assert.equal(refused.ok, false);
    assert.match(!refused.ok ? refused.error : '', /^the files are attached to PROJ-12 — run\.mp4 \(plays in the comment, attachment 9002\) — but the comment that shows them was not posted \(.*INVALID_INPUT\); sending them again reuses the attachments$/);
    assert.ok(!('kind' in refused));

    jira.postOutcomes = [{ outcome: 'deliveryUnknown', reason: 'timeout' }];
    jira.recentComments = new Error('Jira 503');
    const warn = mock.method(console, 'warn', () => {});
    try {
      const unknown = await sink().postFiles(issueKey, { paths: ['run.mp4'], isAsLinks: false }, null);
      assert.equal(!unknown.ok && 'kind' in unknown && unknown.kind, 'deliveryUnknown');
    } finally {
      warn.mock.restore();
    }
  });

  it('as_file lists the files as links: the attach is asked not to show them; a sink with no way to attach refuses', async () => {
    let askedInline: boolean | null = null;
    const attach = jira.attachFiles;
    jira.attachFiles = async (issue, paths, options) => {
      askedInline = options.isShownInline;
      return attach ? attach(issue, paths, options) : { ok: false, error: 'x' };
    };
    await sink().postFiles(issueKey, { paths: ['run.mp4'], isAsLinks: true }, null);
    assert.equal(askedInline, false);
    jira.attachFiles = undefined;
    assert.deepEqual(await sink().postFiles(issueKey, { paths: ['run.mp4'], isAsLinks: false }, null), { ok: false, error: jiraFilesUnavailableError });
  });
});

describe('one progress comment per request: the first progress answer posts it, each next one edits it', () => {
  const updatedLine = 'Last updated 2026-10-03 12:00 UTC';
  const threadOrigin: RequestOrigin = { kind: 'trackerEvent', attributes: { issueKey, triggerId: '10300', requester: 'requester-account', threadCommentId: '10200' } };
  const colleague = { accountId: 'colleague-account', accountType: 'atlassian', displayName: 'Colleague' };
  const deliverFor = (requestId: string, kind: RequestAnswerKind, body: string, answerOrigin: RequestOrigin = origin) =>
    sink().deliverAnswer(key, { requestId, kind, body, origin: answerOrigin, isRequestOpen: true });
  const getEditedLine = (editIndex: number): unknown => jira.edits[editIndex].body.content.at(-1);
  /** A comment body as Jira returns it: a `doc` node holding one paragraph. */
  const getCommentBody = (text: string): NonNullable<JiraComment['body']> => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
  /** What the issue holds when an edit of unknown outcome is read back: the comment with this text. */
  const setReadBackText = (commentId: string, text: string): void => {
    jira.commentsById.set(commentId, { id: commentId, author: { accountId: aiAccountId }, created: '2026-10-03T11:59:00.000+0000', body: getCommentBody(text) });
  };

  it('progress → progress → final is two comments, the first edited to the newest text, with a line saying when it was updated; the final is new and hands the issue back', async () => {
    assert.deepEqual(await deliver('progress', 'Reading the code.'), { ok: true });
    assert.deepEqual(await deliver('progress', 'Halfway: **tests** written.'), { ok: true });
    assert.deepEqual(await deliver('progress', 'Almost done.'), { ok: true });
    assert.deepEqual(await deliver('final', 'Done.'), { ok: true });
    assert.deepEqual(jira.calls, [
      'comment PROJ-12', 'edit PROJ-12 c1', 'edit PROJ-12 c1', 'comment PROJ-12', 'assignee? PROJ-12', 'assign PROJ-12 requester-account',
    ]);
    assert.deepEqual(jira.postedTexts, ['Reading the code.', 'Done.'], 'two comments: the progress one without a line, the final');
    assert.deepEqual(jira.edits.map((edit) => edit.text), [`Halfway: tests written.\n${updatedLine}`, `Almost done.\n${updatedLine}`]);
    assert.deepEqual(getEditedLine(1), { type: 'paragraph', content: [{ type: 'text', text: updatedLine, marks: [{ type: 'em' }] }] });
  });

  it('after a question or a final answer the progress comment is left as it is: later notes of the request start a new one', async () => {
    await deliver('progress', 'Working.');
    await deliver('question', 'Which branch?');
    jira.assignee = aiAccountId;
    await deliver('progress', 'Back on it, on main.');
    await deliver('progress', 'Still on main.');
    assert.deepEqual(jira.postedTexts, ['Working.', `Which branch?\n${jiraQuestionContinueText}`, 'Back on it, on main.']);
    assert.deepEqual(jira.edits.map((edit) => [edit.commentId, edit.text]), [['c3', `Still on main.\n${updatedLine}`]]);
  });

  it('a later request has its own progress comment — requests never edit each other\'s', async () => {
    await deliverFor('req_1', 'progress', 'First request, working.');
    await deliverFor('req_2', 'progress', 'Second request, working.');
    await deliverFor('req_1', 'progress', 'First request, more.');
    await deliverFor('req_2', 'progress', 'Second request, more.');
    assert.deepEqual(jira.postedTexts, ['First request, working.', 'Second request, working.']);
    assert.deepEqual(jira.edits.map((edit) => edit.commentId), ['c1', 'c2']);
  });

  describe('an edit that does not land posts the text as a new comment, which is the one remembered', () => {
    const editUrl = '/rest/api/3/issue/PROJ-12/comment/c1';
    const refusals: Array<[string, Error]> = [
      ['the comment is gone (404)', new JiraHttpError(404, 'PUT', editUrl, "Can not find a comment with id c1")],
      ['Jira refuses the edit (400)', new JiraHttpError(400, 'PUT', editUrl, 'INVALID_INPUT')],
      ['the AI account may not edit it (403)', new JiraAuthError(403, 'PUT', editUrl)],
    ];
    for (const [name, failure] of refusals) {
      it(`${name}: a new comment with the newest text, and the next note edits THAT one`, async () => {
        await deliver('progress', 'First note.');
        jira.editFailures = [failure];
        assert.deepEqual(await deliver('progress', 'Second note.'), { ok: true });
        assert.deepEqual(await deliver('progress', 'Third note.'), { ok: true });
        assert.deepEqual(jira.postedTexts, ['First note.', 'Second note.'], 'the text was not lost; the new comment carries no updated line');
        assert.deepEqual(jira.calls, ['comment PROJ-12', 'edit PROJ-12 c1', 'comment PROJ-12', 'edit PROJ-12 c2']);
        assert.equal(jira.calls.filter((call) => call.startsWith('read-back') || call.startsWith('getComment')).length, 0, 'a refusal changed nothing: nothing to read back');
      });
    }

    it('an outcome Jira did not confirm: the comment is read after the wait — the new text on it counts as edited, no second comment', async () => {
      await deliver('progress', 'First note.');
      jira.editFailures = [new JiraHttpError(503, 'PUT', editUrl, 'unavailable')];
      setReadBackText('c1', `Second note.\n${updatedLine}`);
      assert.deepEqual(await deliver('progress', 'Second note.'), { ok: true });
      assert.deepEqual(jira.calls, ['comment PROJ-12', 'edit PROJ-12 c1', `wait ${jiraReadBackDelayMs}`, 'getComment PROJ-12 c1']);
      assert.deepEqual(jira.postedTexts, ['First note.']);
      await deliver('progress', 'Third note.');
      assert.deepEqual(jira.edits.map((edit) => edit.commentId), ['c1', 'c1'], 'still the same comment');
    });

    it('an outcome Jira did not confirm and the old text on the comment (or an unreadable comment): the text is posted as a new comment — never lost', async () => {
      await deliver('progress', 'First note.');
      jira.editFailures = [new JiraHttpError(0, 'PUT', editUrl, 'the request timed out')];
      setReadBackText('c1', 'First note.');
      assert.deepEqual(await deliver('progress', 'Second note.'), { ok: true });
      assert.deepEqual(jira.postedTexts, ['First note.', 'Second note.']);
      jira.editFailures = [new JiraHttpError(502, 'PUT', '/rest/api/3/issue/PROJ-12/comment/c2', 'bad gateway')];
      jira.commentsById.delete('c2');
      assert.deepEqual(await deliver('progress', 'Third note.'), { ok: true });
      assert.deepEqual(jira.postedTexts, ['First note.', 'Second note.', 'Third note.']);
    });

    it('the new comment is posted with R18\'s read-back: one of unknown outcome that did land is not posted twice', async () => {
      await deliver('progress', 'First note.');
      jira.editFailures = [new JiraHttpError(404, 'PUT', editUrl, 'gone')];
      jira.postOutcomes = [{ outcome: 'deliveryUnknown', reason: 'timed out' }];
      jira.recentComments = [{ id: 'c77', author: { accountId: aiAccountId }, created: new Date(nowMs).toISOString(), body: getCommentBody('Second note.') }];
      assert.deepEqual(await deliver('progress', 'Second note.'), { ok: true });
      assert.equal(jira.postedTexts.length, 2, 'posted once, found on the issue, not posted again');
      await deliver('progress', 'Third note.');
      assert.deepEqual(jira.edits.map((edit) => edit.commentId), ['c1', 'c77'], 'the comment the read-back found is the progress comment now');
    });

    it('a failed edit AND a refused post: the answer is not delivered, so the agent sends it again — and the old progress comment is still the one edited', async () => {
      await deliver('progress', 'First note.');
      jira.editFailures = [new JiraHttpError(404, 'PUT', editUrl, 'gone')];
      jira.postOutcomes = [new JiraHttpError(400, 'POST', '/rest/api/3/issue/PROJ-12/comment', 'INVALID_INPUT')];
      assert.equal((await deliver('progress', 'Second note.')).ok, false);
      await deliver('progress', 'Second note, again.');
      assert.deepEqual(jira.edits.map((edit) => [edit.commentId, edit.text.split('\n')[0]]), [['c1', 'Second note.'], ['c1', 'Second note, again.']]);
    });
  });

  describe('threads: an edit moves nothing', () => {
    it('the note stays in the thread the first one was posted in — the request\'s thread, and a thread Jira refused (then top-level)', async () => {
      await deliverFor('req_3', 'progress', 'In the thread.', threadOrigin);
      await deliverFor('req_3', 'progress', 'Still in the thread.', threadOrigin);
      assert.deepEqual(jira.postedParentIds, ['10200']);
      assert.deepEqual(jira.edits.map((edit) => edit.commentId), ['c1']);
      // The thread is gone: the first note is top-level, and so is everything after it.
      jira.postOutcomes = [new JiraHttpError(400, 'POST', '/rest/api/3/issue/PROJ-12/comment', 'Parent comment not found')];
      await deliverFor('req_4', 'progress', 'Thread refused.', { ...threadOrigin, attributes: { ...threadOrigin.attributes, threadCommentId: '10250' } });
      await deliverFor('req_4', 'progress', 'Edited, wherever it stands.', { ...threadOrigin, attributes: { ...threadOrigin.attributes, threadCommentId: '10250' } });
      assert.deepEqual(jira.postedParentIds, ['10200', '10250', null]);
      assert.deepEqual(jira.edits.map((edit) => edit.commentId), ['c1', 'c3']);
    });

    it('where the default thread would be another one the note is still edited where it stands: a first note posted top-level, a request opened in a thread later', async () => {
      await deliverFor('req_3', 'progress', 'Top-level first.', origin);
      await deliverFor('req_3', 'progress', 'Edited, not moved.', threadOrigin);
      assert.deepEqual(jira.postedParentIds, [null]);
      assert.deepEqual(jira.edits.map((edit) => edit.commentId), ['c1']);
    });

    it('a new comment after a failed edit goes into the thread the old one stood in', async () => {
      await deliverFor('req_3', 'progress', 'In the thread.', threadOrigin);
      jira.editFailures = [new JiraHttpError(404, 'PUT', '/rest/api/3/issue/PROJ-12/comment/c1', 'gone')];
      await deliverFor('req_3', 'progress', 'Back in the thread.', threadOrigin);
      assert.deepEqual(jira.postedParentIds, ['10200', '10200']);
      // …and a thread that no longer takes replies: top-level, remembered as such.
      jira.editFailures = [new JiraHttpError(404, 'PUT', '/rest/api/3/issue/PROJ-12/comment/c2', 'gone')];
      jira.postOutcomes = [new JiraHttpError(400, 'POST', '/rest/api/3/issue/PROJ-12/comment', 'Parent comment not found')];
      await deliverFor('req_3', 'progress', 'The thread is gone.', threadOrigin);
      assert.deepEqual(jira.postedParentIds, ['10200', '10200', '10200', null], 'the refused try, then top-level');
    });

    it('a person\'s reply in another thread (an issue update) pulls the next note there as a comment of its own — and the notes after it edit that one', async () => {
      await deliver('progress', 'Working.');
      answerThreads.note('req_1', '10900');
      assert.deepEqual(await deliver('progress', 'About your reply.'), { ok: true });
      assert.equal(answerThreads.get('req_1'), null, 'the answer used the update\'s thread up');
      await deliver('progress', 'More work.');
      assert.deepEqual(jira.postedParentIds, [null, '10900']);
      assert.deepEqual(jira.edits.map((edit) => edit.commentId), ['c2'], 'the one in the thread');
    });

    it('an update thread that is the one the note stands in is satisfied by the edit: used up, nothing new', async () => {
      await deliverFor('req_3', 'progress', 'In the thread.', threadOrigin);
      answerThreads.note('req_3', '10200');
      await deliverFor('req_3', 'progress', 'Answering your reply, in place.', threadOrigin);
      assert.deepEqual(jira.postedTexts, ['In the thread.']);
      assert.equal(answerThreads.get('req_3'), null);
    });
  });

  describe('a restart between two progress answers still edits the same comment', () => {
    it('the comment is remembered on disk: a process that reads the file edits it; one let go after a final answer is not edited', async () => {
      await deliver('progress', 'Before the restart.');
      progressComments = await loadProgressComments();
      await deliver('progress', 'After the restart.');
      assert.deepEqual(jira.postedTexts, ['Before the restart.']);
      assert.deepEqual(jira.edits.map((edit) => edit.commentId), ['c1']);
      await deliver('final', 'Done.');
      progressComments = await loadProgressComments();
      await deliver('progress', 'A note after the final answer.');
      assert.deepEqual(jira.postedTexts, ['Before the restart.', 'Done.', 'A note after the final answer.'], 'a new comment: the old one was let go');
    });

    it('the thread survives it too, and so does a comment that took over after a failed edit', async () => {
      await deliverFor('req_3', 'progress', 'In the thread.', threadOrigin);
      jira.editFailures = [new JiraHttpError(404, 'PUT', '/rest/api/3/issue/PROJ-12/comment/c1', 'gone')];
      await deliverFor('req_3', 'progress', 'Second.', threadOrigin);
      progressComments = await loadProgressComments();
      jira.editFailures = [new JiraHttpError(404, 'PUT', '/rest/api/3/issue/PROJ-12/comment/c2', 'gone')];
      await deliverFor('req_3', 'progress', 'Third.', threadOrigin);
      assert.deepEqual(jira.edits.map((edit) => edit.commentId), ['c1', 'c2']);
      assert.deepEqual(jira.postedParentIds, ['10200', '10200', '10200']);
    });

    it('a post of unknown outcome that landed late: the resend finds it, and it is the progress comment from then on', async () => {
      jira.postOutcomes = [{ outcome: 'deliveryUnknown', reason: 'timed out' }];
      jira.recentComments = [];
      assert.equal((await deliver('progress', 'First note.')).ok, false);
      jira.recentComments = [{ id: 'c88', author: { accountId: aiAccountId }, created: new Date(nowMs).toISOString(), body: getCommentBody('First note.') }];
      unconfirmedPosts = await loadUnconfirmedPosts();
      assert.deepEqual(await deliver('progress', 'First note.'), { ok: true });
      await deliver('progress', 'Second note.');
      assert.equal(jira.postedTexts.length, 1, 'posted once, found by the resend');
      assert.deepEqual(jira.edits.map((edit) => edit.commentId), ['c88']);
    });
  });

  describe('what is not a plain note is a comment of its own, and the progress comment is let go', () => {
    const shownNode = { type: 'mediaSingle', attrs: { layout: 'center' }, content: [{ type: 'media', attrs: { type: 'file', id: 'm-1', collection: '' } }] };

    it('files: attached and shown in a new comment — never put into an edited one that the next note would wipe; the note after it starts below', async () => {
      const attachCalls: string[] = [];
      jira.attachFiles = async (issue, paths) => {
        attachCalls.push(`attach ${issue} ${paths.join(',')}`);
        return { ok: true, files: [], nodes: [shownNode], summary: 'shot.png', notes: [], sentKinds: ['photo'] };
      };
      await deliver('progress', 'Working.');
      await sink().deliverAnswer(key, { requestId: 'req_1', kind: 'progress', body: 'Here is the screenshot.', origin, isRequestOpen: true, files: ['shot.png'] });
      await deliver('progress', 'Going on.');
      await deliver('progress', 'Still going.');
      assert.deepEqual(attachCalls, ['attach PROJ-12 shot.png']);
      assert.deepEqual(jira.postedTexts, ['Working.', 'Here is the screenshot.', 'Going on.']);
      assert.deepEqual(jira.postedBodies[1].content.map((node) => node.type), ['paragraph', 'mediaSingle']);
      assert.deepEqual(jira.edits.map((edit) => edit.commentId), ['c3']);
    });

    it('a note that replies to a comment notifies its author, which an edit never does: a comment of its own, in that comment\'s thread', async () => {
      jira.commentsById.set('10950', { id: '10950', author: colleague, created: '2026-10-03T10:00:00.000+0000' });
      jira.sentBlocks['comment:10950'] = { hash: 'hash-10950' };
      await deliver('progress', 'Working.');
      await sink().deliverAnswer(key, { requestId: 'req_1', kind: 'progress', body: 'To your comment: yes.', origin, isRequestOpen: true, replyToCommentIds: ['10950'] });
      await deliver('progress', 'Back to the work.');
      assert.deepEqual(jira.postedTexts, ['Working.', '@Colleague\nTo your comment: yes.', 'Back to the work.']);
      assert.deepEqual(jira.postedParentIds, [null, '10950', null]);
      assert.deepEqual(jira.edits, []);
    });

    it('a note too long for one comment is several comments, as ever — not an edit that would cut it', async () => {
      const paragraphs = Array.from({ length: 2 }, (_, index) => `${index}`.repeat(paragraphLength));
      await deliver('progress', 'Working.');
      assert.deepEqual(await deliver('progress', paragraphs.join('\n\n')), { ok: true });
      assert.deepEqual(jira.postedTexts.map((text) => text[0]), ['W', '0', '1']);
      assert.deepEqual(jira.edits, []);
      await deliver('progress', 'Short again.');
      assert.deepEqual(jira.postedTexts.length, 4, 'the one before the long note was let go: a new comment');
    });

    it('the alert: the request\'s later notes start a new comment below it', async () => {
      await deliver('progress', 'Working.');
      await sink().deliverAlert(key, { requestId: 'req_1', reason: 'silentTurns', origin });
      await deliver('progress', 'Back.');
      await deliver('progress', 'Still here.');
      assert.deepEqual(jira.postedTexts.length, 3);
      assert.deepEqual(jira.edits.map((edit) => edit.commentId), ['c3']);
    });

    it('a mention request keeps its mention on the edited comment', async () => {
      const requester = { accountId: 'requester-account', accountType: 'atlassian', displayName: 'Requester' };
      jira.commentsById.set('10240', { id: '10240', author: requester, created: '2026-10-03T10:00:00.000+0000' });
      await deliverFor('req_2', 'progress', 'Looking into it.', mentionOrigin);
      await deliverFor('req_2', 'progress', 'Found it.', mentionOrigin);
      assert.deepEqual(jira.edits.map((edit) => edit.text), [`@Requester\nFound it.\n${updatedLine}`]);
      assert.deepEqual(getMentionedAccountIds(jira.edits[0].body.content[0]), [requester.accountId]);
    });
  });

  describe('the bot\'s own notices', () => {
    const deliverNotice = (body: string, repeatKey?: string) => sink().deliverAnswer(key, {
      requestId: 'req_1', kind: 'progress', body, origin, isRequestOpen: true, isBotNotice: true, ...(repeatKey === undefined ? {} : { repeatKey }),
    });

    it('a notice that repeats for the request (the same repeat key) edits the earlier one — in a slot of its own, apart from the agent\'s notes', async () => {
      await deliver('progress', 'Working.');
      await deliverNotice('Usage limit: the AI goes on at 14:00.', 'usageLimitWait');
      await deliverNotice('Usage limit: the AI goes on at 19:00.', 'usageLimitWait');
      await deliver('progress', 'Working, more.');
      await deliverNotice('Usage limit: the AI goes on at 21:00.', 'usageLimitWait');
      assert.deepEqual(jira.postedTexts, ['Working.', 'Usage limit: the AI goes on at 14:00.']);
      assert.deepEqual(jira.edits.map((edit) => [edit.commentId, edit.text.split('\n')[0]]), [
        ['c2', 'Usage limit: the AI goes on at 19:00.'],
        ['c1', 'Working, more.'],
        ['c2', 'Usage limit: the AI goes on at 21:00.'],
      ]);
    });

    it('a notice with no repeat key (an account move) is a comment every time and touches no slot', async () => {
      await deliver('progress', 'Working.');
      await deliverNotice('The AI\'s account was moved to «second».');
      await deliverNotice('The AI\'s account was moved to «third».');
      await deliver('progress', 'Working, more.');
      assert.deepEqual(jira.postedTexts, ['Working.', 'The AI\'s account was moved to «second».', 'The AI\'s account was moved to «third».']);
      assert.deepEqual(jira.edits.map((edit) => edit.commentId), ['c1']);
    });

    it('the update\'s thread stays owed to the agent\'s answer: an edited notice uses nothing up', async () => {
      await deliverNotice('Usage limit: the AI goes on at 14:00.', 'usageLimitWait');
      answerThreads.note('req_1', null);
      await deliverNotice('Usage limit: the AI goes on at 19:00.', 'usageLimitWait');
      assert.deepEqual(jira.edits.map((edit) => edit.commentId), ['c1']);
      answerThreads.note('req_1', '10200');
      jira.postedParentIds = [];
      await deliverNotice('Usage limit: the AI goes on at 21:00.', 'usageLimitWait');
      assert.deepEqual(jira.postedParentIds, ['10200'], 'the update asked for another thread: a comment there');
      assert.equal(answerThreads.get('req_1'), '10200', 'and it is still owed to the agent\'s answer');
    });
  });
});
