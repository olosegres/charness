/**
 * @description The Jira connector end to end, at PROCESS level (Jira connector plan J7, E1–E9): what the prompts carry.
 * The BUILT charness serving Jira only on the per-turn lifecycle (each process stops after its answer, the next
 * hand-over resumes the conversation), against the fake Jira and the fake `claude` (`jiraE2e/jiraFlowKit.ts`). One
 * flow, in order:
 *
 *   isolation checked before the boot; the boot
 *   → E1 E2 E4 E6: the first prompt carries every block, later ones only what changed — across a stop, a restart and a
 *     deleted comment; the agent's own answer is never sent back
 *   → E3: a prompt that reached the agent but was never taken in counts for nothing; the re-post is the stored whole prompt
 *   → E5: a compaction the bot ran, and one the CLI ran by itself, each make the next prompt the whole issue again
 *   → E4, E4b, E4c: a resume the CLI refuses, a transcript with no message, a transcript removed entirely: a fresh session
 *     that gets the whole issue
 *   → E7: the attachment tool saves the issue's own file whole and refuses another issue's id
 *   → E8: a long comment is written whole to a file the prompt names; E9: a tool linked by `agentBinaries` runs by name
 *   → the instance invariants (R11, R32, R6, the private tmux server)
 *
 * Nothing leaves the machine; everything the test starts is stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  fakeClaudeCrashOnPromptFileName,
  fakeClaudeLogFileNames,
  getFakeClaudeTranscriptPath,
  getFakeClaudeUnrestorableConversationFileName,
  getFlagValues,
  getLaunchSessionId,
} from './jiraE2e/fakeClaudeContract';
import { resolveThreadFilesDir } from '../botFileStorage';
import { makeJiraKey } from '../connectors/jira/sessionKeyCodec';
import {
  answerTimeoutMs,
  bootJiraOnly,
  checkIsProcessAlive,
  countClosedRequestsOf,
  createIssue,
  fakeJira,
  getCharness,
  getLaunchOfPrompt,
  getLayout,
  getProbeToolPath,
  getPrompts,
  getSessionLaunchOf,
  getToolCalls,
  getTurns,
  handIssueToAi,
  handOverAndAwaitAnswer,
  isDeltaPrompt,
  isWholePrompt,
  itHoldsIsolationBeforeBoot,
  itHoldsTheInstanceInvariants,
  largeAttachmentBytes,
  perTurnStopTimeoutMs,
  probeToolMarker,
  probeToolName,
  projectFolder,
  readFakeLog,
  registerJiraFlowHooks,
  requester,
  resumeTimeoutMs,
  spilledCommentWord,
  spilledCommentWords,
  startCharness,
  waitFor,
  type FakeCompaction,
} from './jiraE2e/jiraFlowKit';

describe('Jira connector end to end — what the prompts carry: built charness, fake Jira, fake claude (J7)', () => {
  registerJiraFlowHooks({ layoutPrefix: 'charness-j7-prompt-', config: { adapter: 'claude-per-turn' } });

  itHoldsIsolationBeforeBoot();

  it('boots Jira-only on the per-turn lifecycle, started with nothing but run-isolated.sh\'s variables', async () => {
    await bootJiraOnly();
  });

  it('E1 E2 E4 E6: the first prompt carries every block; later ones only what changed — across a stop, a restart and a deleted comment; the agent\'s own answer is never sent back', async () => {
    const issueKey = 'PROJ-11';
    createIssue(issueKey, 'answer');
    fakeJira.addComment(issueKey, requester, 'First report: the export fails.');
    const firstText = await handOverAndAwaitAnswer(issueKey);
    // E1: the whole issue — every block, the person's comment included.
    assert.ok(isWholePrompt(firstText), firstText);
    for (const phrase of ['\nFields:\nSummary: [fake:answer] Task PROJ-11\n', '\nDescription:\n> Please handle PROJ-11.\n', 'Sub-tasks (0):', '\nLinks:\n', 'Attachments (0):', 'Comments (1, oldest first):', '> First report: the export fails.']) {
      assert.ok(firstText.includes(phrase), `the first prompt carries ${JSON.stringify(phrase)}`);
    }
    const [firstTurn] = getTurns(issueKey);
    const sessionId = getLaunchSessionId(getSessionLaunchOf(firstTurn.pid)?.argv ?? []);
    assert.ok(sessionId, 'the first launch named the conversation');
    await waitFor(`${issueKey}'s process stopped (per-turn)`, perTurnStopTimeoutMs, () => !checkIsProcessAlive(firstTurn.pid));

    // E1 + E4 + E6: one new comment and an edited description; the process is gone, so this is a RESUME — still a delta.
    const stillFailsId = fakeJira.addComment(issueKey, requester, 'Still fails on Monday.');
    fakeJira.setDescription(issueKey, 'Please handle PROJ-11. It fails on Mondays.');
    const stillFailsCreated = fakeJira.getIssue(issueKey).comments.find((comment) => comment.id === stillFailsId)?.created ?? '';
    const secondText = await handOverAndAwaitAnswer(issueKey);
    assert.ok(isDeltaPrompt(secondText), secondText);
    assert.ok(secondText.includes(`Jira issue ${issueKey} — what changed since your last prompt:`));
    assert.ok(secondText.includes('Description (changed since your last prompt):\n> Please handle PROJ-11. It fails on Mondays.'));
    assert.ok(secondText.includes(`Comment ${stillFailsId} by Requester, ${stillFailsCreated} (new):\n> Still fails on Monday.`));
    // The summary line names everything left out: the unchanged blocks, and the person's first comment and the agent's own answer.
    assert.ok(secondText.includes('Unchanged since your last prompt: fields, hierarchy, links, attachments, 2 comments.'), secondText);
    assert.ok(!secondText.includes('First report: the export fails.'), 'a comment already told is not told again');
    assert.ok(!secondText.includes('Fake final answer for PROJ-11'), 'E6: the agent\'s own answer is not sent back');
    const secondLaunch = getLaunchOfPrompt(getPrompts(issueKey)[1]);
    assert.deepEqual(getFlagValues(secondLaunch?.argv ?? [], '--resume'), [sessionId], 'E4: the delta went to a RESUMED session');

    // E4: a bot restart between two requests — the sent-state is on disk, the next prompt is still a delta. The
    // conversation sleeps between them (its process stopped after the turn), so the restart adopts nothing.
    const secondTurn = getTurns(issueKey).at(-1);
    assert.ok(secondTurn);
    await waitFor(`${issueKey}'s process stopped (per-turn)`, perTurnStopTimeoutMs, () => !checkIsProcessAlive(secondTurn.pid));
    await waitFor('the per-turn stop logged', perTurnStopTimeoutMs, () => getCharness().output.includes(`[compact-on-idle] jira:PROJ:${issueKey} process stopped; the session sleeps`));
    await getCharness().stop();
    await startCharness();
    // E2: a comment deleted between requests — one line, then never again.
    fakeJira.deleteComment(issueKey, stillFailsId);
    const thirdText = await handOverAndAwaitAnswer(issueKey);
    assert.ok(isDeltaPrompt(thirdText), `E4: after a restart the prompt is still a delta: ${thirdText}`);
    assert.ok(thirdText.includes(`comment ${stillFailsId} by Requester from ${stillFailsCreated} was deleted`), thirdText);
    const fourthText = await handOverAndAwaitAnswer(issueKey);
    assert.ok(!fourthText.includes('was deleted'), 'then it is forgotten');
    assert.ok(fourthText.includes('Nothing in the issue changed since your last prompt.'), fourthText);
  });

  it('E3: a prompt that reached the agent but was never taken in counts for nothing — a new trigger still carries what it carried, the re-post is the stored whole prompt, and after the take-in the next one is a delta', async () => {
    const issueKey = 'PROJ-19';
    createIssue(issueKey, 'answer');
    await handOverAndAwaitAnswer(issueKey);
    const [firstTurn] = getTurns(issueKey);
    await waitFor(`${issueKey}'s process stopped (per-turn)`, perTurnStopTimeoutMs, () => !checkIsProcessAlive(firstTurn.pid));

    const observationId = fakeJira.addComment(issueKey, requester, 'Second observation: the export hangs.');
    const crashSwitch = path.join(getLayout().fakeStateDir, fakeClaudeCrashOnPromptFileName);
    fs.writeFileSync(crashSwitch, '');
    try {
      // Every agent process now reads its message and dies before it echoes it: built, forwarded, never taken in.
      handIssueToAi(issueKey, requester);
      await waitFor(`${issueKey}: the agent read the second prompt and died`, answerTimeoutMs, () => getPrompts(issueKey).length === 2);
      const secondPrompt = getPrompts(issueKey)[1].text;
      assert.ok(isDeltaPrompt(secondPrompt) && secondPrompt.includes(`Comment ${observationId} by Requester`), secondPrompt);
      assert.equal(getTurns(issueKey).length, 1, 'it was never taken in: no turn began');

      // A new trigger before any take-in: built against what the agent really has — the first prompt's blocks.
      handIssueToAi(issueKey, requester);
      await waitFor(`${issueKey}: the agent read the third prompt and died`, answerTimeoutMs, () => getPrompts(issueKey).length === 3);
      const thirdPrompt = getPrompts(issueKey)[2].text;
      assert.ok(isDeltaPrompt(thirdPrompt), 'a delta against the last prompt TAKEN IN');
      assert.ok(thirdPrompt.includes(`Comment ${observationId} by Requester`) && thirdPrompt.includes('(new)'), `the comment the dead prompt carried is still new:\n${thirdPrompt}`);
      assert.ok(thirdPrompt.includes('It replaces the same requester\'s earlier request'), 'the header names the replaced request');
    } finally {
      fs.rmSync(crashSwitch, { force: true });
    }

    // The wake-up engine re-posts the request that was never taken in: the stored WHOLE prompt (R21), never a delta.
    await waitFor(`${issueKey}: the request re-posted to a resumed agent and answered`, resumeTimeoutMs, () => getPrompts(issueKey).length >= 4 && countClosedRequestsOf(issueKey) >= 3);
    const repost = getPrompts(issueKey)[3].text;
    assert.ok(isWholePrompt(repost), `the re-post is the stored whole prompt:\n${repost}`);
    assert.ok(repost.includes(`> Second observation: the export hangs.`) && repost.includes('Fake final answer for PROJ-19'), 'whole: the comment and the agent\'s own answer');
    await waitFor(`${issueKey} handed back`, answerTimeoutMs, () => fakeJira.getIssue(issueKey).assignee?.accountId === requester.accountId);

    // After the take-in the next prompt is a delta again, and the comment taken in is not repeated.
    fakeJira.addComment(issueKey, requester, 'Third observation: also on import.');
    const nextPrompt = await handOverAndAwaitAnswer(issueKey);
    assert.ok(isDeltaPrompt(nextPrompt), nextPrompt);
    assert.ok(nextPrompt.includes('> Third observation: also on import.') && !nextPrompt.includes('Second observation'), nextPrompt);
  });

  it('E5: a compaction the bot ran, and one the CLI ran by itself, each make the next prompt the whole issue again', async () => {
    const compactions = (): FakeCompaction[] => readFakeLog<FakeCompaction>(fakeClaudeLogFileNames.compactions);
    // The bot's: the agent asks for it (`compact_conversation`), the bot runs it when the turn ends.
    createIssue('PROJ-12', 'compact');
    const compactionsBefore = compactions().length;
    const firstText = await handOverAndAwaitAnswer('PROJ-12');
    assert.ok(isWholePrompt(firstText));
    await waitFor('PROJ-12\'s compaction ran', answerTimeoutMs, () => compactions().length > compactionsBefore);
    await waitFor('the bot noted the reset', answerTimeoutMs, () => getCharness().output.includes('[jira] PROJ-12: its context was reset (compaction (manual))'));
    assert.ok(isWholePrompt(await handOverAndAwaitAnswer('PROJ-12')), 'after the bot\'s compaction the prompt is whole');

    // The CLI's own: a `compact_boundary` nobody asked for.
    createIssue('PROJ-13', 'overflow');
    assert.ok(isWholePrompt(await handOverAndAwaitAnswer('PROJ-13')));
    await waitFor('the bot noted the reset', answerTimeoutMs, () => getCharness().output.includes('[jira] PROJ-13: its context was reset (compaction (auto))'));
    assert.ok(isWholePrompt(await handOverAndAwaitAnswer('PROJ-13')), 'after the CLI\'s own compaction the prompt is whole');
  });

  it('E4: a resume the CLI refuses starts a fresh session, and the fresh session gets the whole issue', async () => {
    const issueKey = 'PROJ-14';
    createIssue(issueKey, 'answer');
    await handOverAndAwaitAnswer(issueKey);
    const [firstTurn] = getTurns(issueKey);
    const sessionId = getLaunchSessionId(getSessionLaunchOf(firstTurn.pid)?.argv ?? []);
    assert.ok(sessionId);
    await waitFor(`${issueKey}'s process stopped (per-turn)`, perTurnStopTimeoutMs, () => !checkIsProcessAlive(firstTurn.pid));
    // The conversation cannot be restored though its transcript holds messages (the bot resumes a conversation whose
    // transcript has a message): the real CLI answers `No conversation found with session ID`.
    fs.writeFileSync(path.join(getLayout().fakeStateDir, getFakeClaudeUnrestorableConversationFileName(sessionId)), '');
    const text = await handOverAndAwaitAnswer(issueKey);
    assert.ok(isWholePrompt(text), `a fresh session knows nothing of the issue:\n${text}`);
    assert.ok(text.includes('Fake final answer for PROJ-14'), 'it learns what its predecessor already answered');
    const prompt = getPrompts(issueKey)[1];
    assert.ok(getFlagValues(getLaunchOfPrompt(prompt)?.argv ?? [], '--session-id').length === 1, 'the answering process started a NEW conversation');
    const refusals = readFakeLog<{ reason: string }>(fakeClaudeLogFileNames.violations).filter((violation) => violation.reason === `No conversation found with session ID: ${sessionId}`);
    assert.equal(refusals.length, 1, 'the resume was tried once and refused');
  });

  it('E4b: a conversation whose transcript holds no message is not resumed at all: a fresh session starts at once and gets the whole issue', async () => {
    const issueKey = 'PROJ-32';
    createIssue(issueKey, 'answer');
    await handOverAndAwaitAnswer(issueKey);
    const [firstTurn] = getTurns(issueKey);
    const sessionId = getLaunchSessionId(getSessionLaunchOf(firstTurn.pid)?.argv ?? []);
    assert.ok(sessionId);
    await waitFor(`${issueKey}'s process stopped (per-turn)`, perTurnStopTimeoutMs, () => !checkIsProcessAlive(firstTurn.pid));
    // The CLI's cleanup removed the conversation; what a stopped process writes back is only its metadata, which no launch accepts.
    const transcriptPath = getFakeClaudeTranscriptPath({ homeDir: getLayout().instanceHome, workDir: path.join(getLayout().workRoot, projectFolder), sessionId });
    fs.writeFileSync(transcriptPath, `${JSON.stringify({ type: 'last-prompt', lastPrompt: 'an old prompt', sessionId })}\n${JSON.stringify({ type: 'cost-state', sessionId })}\n`);
    const refusalsBefore = readFakeLog<{ reason: string }>(fakeClaudeLogFileNames.violations).length;
    const text = await handOverAndAwaitAnswer(issueKey);
    assert.ok(isWholePrompt(text), `a fresh session knows nothing of the issue:\n${text}`);
    const prompt = getPrompts(issueKey)[1];
    const argv = getLaunchOfPrompt(prompt)?.argv ?? [];
    assert.equal(getFlagValues(argv, '--resume').length, 0, 'no resume was tried: the transcript holds nothing to resume');
    assert.equal(getFlagValues(argv, '--session-id').length, 1, 'the answering process started a NEW conversation');
    assert.notEqual(getLaunchSessionId(argv), sessionId, 'under a new id: the old one is not reused');
    assert.equal(readFakeLog<{ reason: string }>(fakeClaudeLogFileNames.violations).length, refusalsBefore, 'no launch was refused');
  });

  it('E4c: a sleeping conversation whose transcript the cleanup removed ENTIRELY (no stub) is not started silently under its id: a fresh session gets the whole issue', async () => {
    const issueKey = 'PROJ-33';
    createIssue(issueKey, 'answer');
    await handOverAndAwaitAnswer(issueKey);
    const [firstTurn] = getTurns(issueKey);
    const sessionId = getLaunchSessionId(getSessionLaunchOf(firstTurn.pid)?.argv ?? []);
    assert.ok(sessionId);
    await waitFor(`${issueKey}'s process stopped (per-turn)`, perTurnStopTimeoutMs, () => !checkIsProcessAlive(firstTurn.pid));
    // Removed while no process was there to write a stub back: no file at all, like a session that never took a turn.
    fs.rmSync(getFakeClaudeTranscriptPath({ homeDir: getLayout().instanceHome, workDir: path.join(getLayout().workRoot, projectFolder), sessionId }));
    const text = await handOverAndAwaitAnswer(issueKey);
    assert.ok(isWholePrompt(text), `a fresh session knows nothing of the issue:\n${text}`);
    const argv = getLaunchOfPrompt(getPrompts(issueKey)[1])?.argv ?? [];
    assert.equal(getFlagValues(argv, '--resume').length, 0, 'nothing to resume');
    assert.notEqual(getLaunchSessionId(argv), sessionId, 'a NEW conversation under a new id, not the lost one started again');
  });

  it('E7: the attachment tool saves the issue\'s own file whole under files/<conversation>/jira, and refuses another issue\'s id', async () => {
    createIssue('PROJ-15', 'fetch-attachment');
    createIssue('PROJ-16', 'answer');
    const ownBytes = Buffer.alloc(largeAttachmentBytes, 'own-file-bytes ');
    const ownId = fakeJira.addAttachment('PROJ-15', { filename: 'screen shot.png', mimeType: 'image/png', content: ownBytes });
    const foreignId = fakeJira.addAttachment('PROJ-16', { filename: 'private.png', mimeType: 'image/png', content: Buffer.from('another issue\'s file') });
    fakeJira.getIssue('PROJ-15').summary = `[fake:fetch-attachment] [fetch:${ownId},${foreignId}] Task PROJ-15`;
    const text = await handOverAndAwaitAnswer('PROJ-15');
    assert.ok(text.includes(`${ownId} screen shot.png (image/png, ${ownBytes.length} bytes`), 'the attachments block lists the file');
    const [ownCall, foreignCall] = getToolCalls('PROJ-15');
    const savedAt = path.join(resolveThreadFilesDir(getLayout().dataDir, makeJiraKey('PROJ-15')), 'jira', `${ownId}-screen shot.png`);
    assert.equal(ownCall.tool, 'jira_get_attachment');
    assert.ok(ownCall.outcome.includes(`is saved at ${savedAt}`), ownCall.outcome);
    assert.ok(fs.readFileSync(savedAt).equals(ownBytes), 'the file is the original, whole');
    assert.ok(foreignCall.outcome.startsWith(`error: Attachment ${foreignId} is not an attachment of PROJ-15.`), foreignCall.outcome);
    const contentRequests = fakeJira.requestLog.filter((request) => request.startsWith('GET /rest/api/3/attachment/content/'));
    assert.deepEqual(contentRequests, [`GET /rest/api/3/attachment/content/${ownId}`], 'the other issue\'s file was never even requested');
  });

  it('E8: a comment of 12 000 characters is written whole to a file and the prompt names it; E9: the agent runs a tool linked by agentBinaries by its name', async () => {
    const longText = spilledCommentWord.repeat(spilledCommentWords);
    createIssue('PROJ-17', 'answer');
    const commentId = fakeJira.addComment('PROJ-17', requester, longText);
    const text = await handOverAndAwaitAnswer('PROJ-17');
    const spillDir = path.join(resolveThreadFilesDir(getLayout().dataDir, makeJiraKey('PROJ-17')), 'jira', 'text');
    const spillPath = new RegExp(`Comment ${commentId} by Requester, \\S+\\nwritten whole to (${spillDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/comment-${commentId}-[0-9a-f]{8}\\.txt) \\(${longText.length} chars\\) — read it`).exec(text)?.[1];
    assert.ok(spillPath, text);
    assert.equal(fs.readFileSync(spillPath, 'utf8'), longText, 'the file holds the comment whole');
    assert.ok(!text.includes(spilledCommentWord.repeat(10)), 'none of it is in the prompt');

    // E9: found on no PATH of the box — only the link in DATA_DIR/agent-bin makes it runnable by name.
    assert.equal(spawnSync(probeToolName).error?.message.includes('ENOENT'), true, 'the box has no such tool of its own');
    createIssue('PROJ-18', 'run-tool');
    await handOverAndAwaitAnswer('PROJ-18');
    assert.deepEqual(getToolCalls('PROJ-18').map((call) => [call.tool, call.outcome]), [[probeToolName, probeToolMarker]]);
    assert.equal(fs.readlinkSync(path.join(getLayout().dataDir, 'agent-bin', probeToolName)), getProbeToolPath());
  });


  itHoldsTheInstanceInvariants();
});
