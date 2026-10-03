/**
 * @description The Jira answer sink (plan J6, D20, R18) over a fake client that
 * records every call: comments in order, the hand-back only for a question or a
 * final answer to an open request and only while the issue is still the AI's,
 * a failed hand-back as a warning, the read-back of a post of unknown outcome,
 * the alert and the park notice.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildJiraAlertText, buildJiraParkText, createJiraAnswerSink, jiraReadBackClockSkewMs, jiraReadBackDelayMs } from '../connectors/jira/answerSink';
import { getAdfText, jiraCommentMarkdownMaxChars, type AdfDocument } from '../connectors/jira/adf';
import { makeJiraKey } from '../connectors/jira/sessionKeyCodec';
import type { JiraClient, JiraComment, JiraCommentPostResult, JiraIssue } from '../connectors/jira/client';
import type { RequestAnswerKind, RequestOrigin } from '../requests/types';

const aiAccountId = 'ai-account';
const issueKey = 'PROJ-12';
const key = makeJiraKey(issueKey);
const nowMs = Date.parse('2026-10-03T12:00:00Z');
/** Two paragraphs never fit one comment; one fits by both counts (R19). */
const paragraphLength = Math.floor(jiraCommentMarkdownMaxChars * 2 / 3);
const origin: RequestOrigin = { kind: 'trackerEvent', attributes: { issueKey, triggerId: '100', requesterAccountId: 'requester-account' } };

interface FakeJira {
  calls: string[];
  postedTexts: string[];
  assignee: string;
  /** Per comment post, in order: what Jira answers; `created` when the list runs out. */
  postOutcomes: Array<JiraCommentPostResult | Error>;
  /** What the read-back sees (newest first), or an error. */
  recentComments: JiraComment[] | Error;
  isAssignFailing: boolean;
}

let jira: FakeJira;

function createClient(): Pick<JiraClient, 'addComment' | 'getRecentComments' | 'getIssue' | 'assignIssue'> {
  return {
    addComment: async (issue, body: AdfDocument) => {
      jira.calls.push(`comment ${issue}`);
      jira.postedTexts.push(getAdfText(body));
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
  runBudgetPer24h: 5,
  now: () => nowMs,
  wait: async (ms) => {
    jira.calls.push(`wait ${ms}`);
  },
});
const deliver = (kind: RequestAnswerKind, body: string, isRequestOpen = true) =>
  sink().deliverAnswer(key, { requestId: 'req_1', kind, body, origin, isRequestOpen });

beforeEach(() => {
  jira = { calls: [], postedTexts: [], assignee: aiAccountId, postOutcomes: [], recentComments: [], isAssignFailing: false };
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
        'Send the rest again, starting at "1{80}…" \\(if that comment did land, the requester sees it twice\\)'),
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

describe('a comment post of unknown outcome is read back, never re-posted blindly (R18)', () => {
  const unknown: JiraCommentPostResult = { outcome: 'deliveryUnknown', reason: 'Jira POST: outcome unknown — 502' };
  const comment = (author: string, createdMs: number, text: string): JiraComment => ({
    id: 'x',
    author: { accountId: author },
    created: new Date(createdMs).toISOString(),
    body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
  });

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
        'Send the answer again (if the first one did land, the requester sees it twice)',
    );
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
    assert.match(jira.postedTexts[0], /handed to the AI 5 times in the last 24 hours/);
    assert.ok(jira.calls.includes('assign PROJ-12 requester-account'));
  });
});
