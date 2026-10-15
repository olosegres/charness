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
  buildJiraMentionParkText,
  buildJiraParkText,
  buildJiraReplyLeftOutWarning,
  buildJiraUntrustedText,
  createJiraAnswerSink,
  jiraQuestionContinueText,
  jiraReadBackClockSkewMs,
  jiraReadBackDelayMs,
} from '../connectors/jira/answerSink';
import { getAdfText, getMentionedAccountIds, jiraCommentMarkdownMaxChars, type AdfDocument } from '../connectors/jira/adf';
import { createJiraTrust, type JiraTrust } from '../connectors/jira/trustedGroup';
import type { JiraSentBlocks } from '../connectors/jira/contextLedger';
import { makeJiraKey } from '../connectors/jira/sessionKeyCodec';
import { JiraHttpError, type JiraClient, type JiraComment, type JiraCommentPostResult, type JiraIssue } from '../connectors/jira/client';
import { getCommentBodyHash, JiraUnconfirmedPosts, jiraUnconfirmedPostsFileName } from '../connectors/jira/unconfirmedPosts';
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
  /** `getComment` answers by comment id: a comment, or the failure Jira would give. */
  commentsById: Map<string, JiraComment | Error>;
  /** What the conversation was shown (`comment:<id>` → the block), as the context ledger holds it. */
  sentBlocks: JiraSentBlocks;
  /** The trusted group's trust, `null` without a group. */
  trust: JiraTrust | null;
  assignee: string;
  /** Per comment post, in order: what Jira answers; `created` when the list runs out. */
  postOutcomes: Array<JiraCommentPostResult | Error>;
  /** What the read-back sees (newest first), or an error. */
  recentComments: JiraComment[] | Error;
  isAssignFailing: boolean;
}

let jira: FakeJira;
let dataDir: string;
let unconfirmedPosts: JiraUnconfirmedPosts;

/** The store as a restarted process finds it: read back from its file. */
async function loadUnconfirmedPosts(): Promise<JiraUnconfirmedPosts> {
  const store = JiraUnconfirmedPosts.createForDataDir(path.join(dataDir, jiraUnconfirmedPostsFileName), () => nowMs);
  await store.load();
  return store;
}

function createClient(): Pick<JiraClient, 'addComment' | 'getRecentComments' | 'getIssue' | 'assignIssue' | 'getComment'> {
  return {
    getComment: async (issue, commentId) => {
      jira.calls.push(`getComment ${issue} ${commentId}`);
      const comment = jira.commentsById.get(commentId);
      if (comment === undefined) throw new Error(`Jira GET comment ${commentId} failed with 404`);
      if (comment instanceof Error) throw comment;
      return comment;
    },
    addComment: async (issue, body: AdfDocument) => {
      jira.calls.push(`comment ${issue}`);
      jira.postedTexts.push(getAdfText(body));
      jira.postedBodies.push(body);
      const outcome = jira.postOutcomes.shift() ?? { outcome: 'created', id: `c${jira.postedTexts.length}` };
      if (outcome instanceof Error) throw outcome;
      return outcome;
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
});
const deliver = (kind: RequestAnswerKind, body: string, isRequestOpen = true) =>
  sink().deliverAnswer(key, { requestId: 'req_1', kind, body, origin, isRequestOpen });

beforeEach(async () => {
  jira = { calls: [], postedTexts: [], postedBodies: [], commentsById: new Map(), sentBlocks: {}, trust: null, assignee: aiAccountId, postOutcomes: [], recentComments: [], isAssignFailing: false };
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'jira-sink-'));
  unconfirmedPosts = await loadUnconfirmedPosts();
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
  it('the alert is an English comment naming the request and the reason, then the hand-back; nothing to release', async () => {
    assert.deepEqual(await sink().deliverAlert(key, { requestId: 'req_9', reason: 'wakeFailed', origin }), { ok: true });
    assert.deepEqual(jira.postedTexts, [buildJiraAlertText('req_9', 'wakeFailed')]);
    assert.match(jira.postedTexts[0], /^⚠️ The AI could not finish request req_9: the agent's session could not be reached to remind it\. A person needs to look at this issue\.$/);
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
    assert.deepEqual(jira.postedTexts, [buildJiraAlertText('req_2', 'silentTurns')]);
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
    assert.deepEqual(await deliverMention('final', 'Both of you:', ['10250', '10251', '10250', '10252']), { ok: true });
    assert.deepEqual(getLeadingMentions(), [requester.accountId, colleague.accountId], 'requester first; duplicates and the requester again are one mention each');
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
