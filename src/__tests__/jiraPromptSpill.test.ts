/**
 * @description Nothing in a Jira prompt is cut, nothing is lost (prompt context
 * C8): a comment over 10 000 characters goes whole to a file; a prompt over the
 * ledger's stored-prompt cap moves its biggest blocks to files, largest first;
 * stubs that still do not fit collapse the comments into ONE file. The files are
 * checked byte for byte against the text they stand for.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { convertMarkdownToAdf } from '../connectors/jira/adf';
import { buildIssueBlocks, getIssueBlockText, type IssueBlock } from '../connectors/jira/issueBlocks';
import { buildJiraRequestPrompt } from '../connectors/jira/prompt';
import {
  fitBlocksToPrompt,
  getSpillNoticeText,
  jiraCommentSpillMinChars,
  jiraPromptMaxChars,
  standInRequestId,
  type FittedBlocks,
} from '../connectors/jira/promptSpill';
import { requestPromptMaxLength } from '../requests/requestLedger';
import type { JiraIssueTrigger } from '../connectors/jira/trigger';
import { createIssueContext, createTestComment, testAiAccountId } from './jiraIssueTestData';

const trigger: JiraIssueTrigger = { triggerId: '1', kind: 'assigned', author: null };
const promptBase = {
  issueKey: 'PROJ-12',
  statusName: 'To Do',
  issueUrl: 'https://example.atlassian.net/browse/PROJ-12',
  trigger,
  requester: null,
};

describe('fitBlocksToPrompt (C8)', () => {
  let textDir = '';

  beforeEach(() => {
    textDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jira-spill-')), 'files', 'jira', 'text');
  });
  afterEach(() => {
    fs.rmSync(path.resolve(textDir, '..', '..', '..'), { recursive: true, force: true });
  });

  const measure = (candidate: FittedBlocks): number => buildJiraRequestPrompt({ ...promptBase, requestId: standInRequestId, ...candidate }).length;
  const getText = (length: number, seed = 'x'): string => seed.repeat(length);
  const fit = (blocks: readonly IssueBlock[]): Promise<FittedBlocks> => fitBlocksToPrompt({ blocks, textDir, measure });
  const getBlock = (fitted: FittedBlocks, key: string): IssueBlock => {
    const block = fitted.blocks.find((candidate) => candidate.key === key);
    assert.ok(block, `block ${key}`);
    return block;
  };
  const readSpillFile = (filePath: string | undefined): string => {
    assert.ok(filePath, 'the block was spilled');
    return fs.readFileSync(filePath, 'utf8');
  };

  it('a comment of exactly 10 000 characters stays in the prompt; one character more goes whole to a file, its header kept', async () => {
    const blocks = buildIssueBlocks(createIssueContext({
      comments: [createTestComment('1', 0, getText(jiraCommentSpillMinChars)), createTestComment('2', 1, getText(jiraCommentSpillMinChars + 1, 'y'))],
    }), [], testAiAccountId);
    const fitted = await fit(blocks);
    assert.equal(getBlock(fitted, 'comment:1').spilledTo, undefined);
    assert.equal(getBlock(fitted, 'comment:1').body, blocks[5].body);
    const spilled = getBlock(fitted, 'comment:2');
    assert.equal(spilled.heading, 'Comment 2 by Ann Author, 2026-10-05T10:01:00.000+0000');
    assert.equal(spilled.body, getSpillNoticeText(spilled.spilledTo ?? '', jiraCommentSpillMinChars + 1));
    assert.match(spilled.body, /^written whole to .+ \(10001 chars\) — read it$/);
    assert.equal(readSpillFile(spilled.spilledTo), getText(jiraCommentSpillMinChars + 1, 'y'), 'the file holds the comment whole, byte for byte');
    assert.match(path.basename(spilled.spilledTo ?? ''), /^comment-2-[0-9a-f]{8}\.txt$/);
    assert.equal(path.dirname(spilled.spilledTo ?? ''), textDir);
  });

  it('a spilled block is still hashed as before — it counts as sent like any other', async () => {
    const blocks = buildIssueBlocks(createIssueContext({ comments: [createTestComment('1', 0, getText(jiraCommentSpillMinChars + 5))] }), [], testAiAccountId);
    const fitted = await fit(blocks);
    assert.equal(getBlock(fitted, 'comment:1').hash, blocks[5].hash);
    assert.deepEqual(fitted.blocks.map((block) => block.hash), blocks.map((block) => block.hash));
  });

  it('a prompt that fits changes nothing and writes nothing', async () => {
    const blocks = buildIssueBlocks(createIssueContext({ comments: [createTestComment('1', 0, 'short'), createTestComment('2', 1, getText(9_000))] }), [], testAiAccountId);
    const fitted = await fit(blocks);
    assert.deepEqual(fitted.blocks, blocks);
    assert.equal(fitted.commentsFile, null);
    assert.equal(fs.existsSync(textDir), false, 'not even the folder');
  });

  it('over the cap: the biggest blocks go to files, largest first, until the prompt fits — the smaller ones stay', async () => {
    const sizes = [9_900, 9_500, 9_000, 8_500, 8_000, 7_500, 7_000, 6_500, 6_000, 5_500, 5_000, 4_500, 4_000];
    const comments = sizes.map((size, index) => createTestComment(`${index + 1}`, index, getText(size, String.fromCharCode(97 + index))));
    const context = createIssueContext({ fields: { description: convertMarkdownToAdf(getText(20_000, 'd')) }, comments });
    const blocks = buildIssueBlocks(context, [], testAiAccountId);
    assert.ok(measure({ blocks, commentsFile: null }) > jiraPromptMaxChars, 'the premise: it does not fit');

    const fitted = await fit(blocks);

    assert.ok(measure(fitted) <= jiraPromptMaxChars, `${measure(fitted)} chars`);
    const spilledKeys = fitted.blocks.filter((block) => block.spilledTo !== undefined).map((block) => block.key);
    const originalChars = new Map(blocks.map((block) => [block.key, getIssueBlockText(block).length]));
    assert.ok(spilledKeys.includes('description') && spilledKeys.includes('comment:1'), spilledKeys.join(','));
    const smallestSpilled = Math.min(...spilledKeys.map((key) => originalChars.get(key) ?? 0));
    const largestInline = Math.max(...fitted.blocks.filter((block) => block.spilledTo === undefined).map((block) => originalChars.get(block.key) ?? 0));
    assert.ok(largestInline <= smallestSpilled, `every block left inline (${largestInline}) is no bigger than any spilled one (${smallestSpilled})`);
    assert.ok(fitted.blocks.length === blocks.length && fitted.blocks.some((block) => block.spilledTo === undefined && block.kind === 'comment'), 'small comments stay inline');
    // Nothing lost: each file is the block's whole text.
    for (const block of fitted.blocks.filter((candidate) => candidate.spilledTo !== undefined)) {
      assert.equal(readSpillFile(block.spilledTo), blocks.find((original) => original.key === block.key)?.fullText);
    }
  });

  it('the real prompt — real request id, a list of replaced requests — still fits what the ledger keeps', async () => {
    const comments = Array.from({ length: 30 }, (_, index) => createTestComment(`${index + 1}`, 0, getText(5_000, String.fromCharCode(97 + (index % 26)))));
    const blocks = buildIssueBlocks(createIssueContext({ comments }), [], testAiAccountId);
    const fitted = await fit(blocks);
    const real = buildJiraRequestPrompt({
      ...promptBase,
      requestId: 'req_AbCd1234',
      supersededRequestIds: ['req_aaaaaaaa', 'req_bbbbbbbb', 'req_cccccccc', 'req_dddddddd', 'req_eeeeeeee'],
      ...fitted,
    });
    assert.ok(real.length <= requestPromptMaxLength, `${real.length} chars`);
    assert.ok(measure(fitted) <= jiraPromptMaxChars);
  });

  it('hundreds of comments whose stubs alone do not fit: ONE file holds every comment whole, in order, and the prompt names it', async () => {
    const comments = Array.from({ length: 600 }, (_, index) => createTestComment(`${index + 1}`, index % 60, `comment number ${index + 1} ${getText(300, 'z')}`));
    const blocks = buildIssueBlocks(createIssueContext({ comments }), [], testAiAccountId);

    const fitted = await fit(blocks);

    assert.ok(fitted.commentsFile, 'the comments collapsed into a file');
    assert.equal(fs.readdirSync(textDir).length, 1, 'no file per comment');
    const fileText = readSpillFile(fitted.commentsFile.path);
    assert.equal(fileText, fitted.commentsFile.text);
    assert.equal(fitted.commentsFile.chars, fileText.length);
    const commentBlocks = blocks.filter((block) => block.kind === 'comment');
    assert.equal(fileText, commentBlocks.map((block) => `${block.heading}:\n${block.fullText}`).join('\n\n'));
    assert.ok(fileText.indexOf('comment number 1 ') < fileText.indexOf('comment number 2 ') && fileText.includes('comment number 600 '));
    const prompt = buildJiraRequestPrompt({ ...promptBase, requestId: standInRequestId, ...fitted });
    assert.ok(prompt.includes(`Comments (600, oldest first): ${getSpillNoticeText(fitted.commentsFile.path, fitted.commentsFile.chars)}`));
    assert.ok(!prompt.includes('comment number 7 '), 'no comment is also printed');
    assert.ok(prompt.length <= jiraPromptMaxChars, `${prompt.length} chars`);
    // Every block is still a block with its own hash and no dangling pointer: a stub would name a file nobody wrote.
    assert.deepEqual(fitted.blocks.map((block) => block.hash), blocks.map((block) => block.hash));
    assert.ok(fitted.blocks.every((block) => block.spilledTo === undefined || fs.existsSync(block.spilledTo)));
  });

  it('a long comment keeps its own file even when the comments collapse into one', async () => {
    const comments = [
      createTestComment('1', 0, getText(jiraCommentSpillMinChars + 1, 'L')),
      ...Array.from({ length: 600 }, (_, index) => createTestComment(`${index + 2}`, 1, `body ${index} ${getText(300, 'z')}`)),
    ];
    const fitted = await fit(buildIssueBlocks(createIssueContext({ comments }), [], testAiAccountId));
    assert.ok(fitted.commentsFile);
    const long = getBlock(fitted, 'comment:1');
    assert.equal(fs.readFileSync(long.spilledTo ?? '', 'utf8').length, jiraCommentSpillMinChars + 1);
    assert.equal(fs.readdirSync(textDir).length, 2, 'the long comment\'s file and the comments file');
    assert.ok(fitted.commentsFile.text.includes(getText(jiraCommentSpillMinChars + 1, 'L')), 'the comments file holds even the long comment whole');
  });

  it('a block that would not shrink as a stub is left alone, and the loop ends however far over the budget stays', async () => {
    const blocks = buildIssueBlocks(createIssueContext({ comments: [createTestComment('1', 0, 'tiny')] }), [], testAiAccountId);
    const fitted = await fitBlocksToPrompt({ blocks, textDir, measure: () => Number.MAX_SAFE_INTEGER });
    assert.equal(fitted.blocks.filter((block) => block.spilledTo !== undefined).length, 0);
    assert.ok(fitted.commentsFile, 'the last resort is the one comments file');
  });

  it('every request writes its files again at the same path: a file the 30-day sweep removed comes back', async () => {
    const blocks = buildIssueBlocks(createIssueContext({ comments: [createTestComment('1', 0, getText(jiraCommentSpillMinChars + 1))] }), [], testAiAccountId);
    const first = getBlock(await fit(blocks), 'comment:1').spilledTo ?? '';
    fs.rmSync(first);
    const second = getBlock(await fit(blocks), 'comment:1').spilledTo ?? '';
    assert.equal(second, first, 'the path holds the block\'s hash, so it is the same');
    assert.equal(fs.readFileSync(second, 'utf8'), getText(jiraCommentSpillMinChars + 1));
  });

  it('a changed comment is a new file; the old one is left for the sweep', async () => {
    const original = getBlock(await fit(buildIssueBlocks(createIssueContext({ comments: [createTestComment('1', 0, getText(jiraCommentSpillMinChars + 1, 'a'))] }), [], testAiAccountId)), 'comment:1');
    const edited = getBlock(await fit(buildIssueBlocks(createIssueContext({ comments: [createTestComment('1', 0, getText(jiraCommentSpillMinChars + 1, 'b'))] }), [], testAiAccountId)), 'comment:1');
    assert.notEqual(original.spilledTo, edited.spilledTo);
    assert.equal(fs.readdirSync(textDir).length, 2);
  });

  it('files are private to the owner, written atomically (no half-written leftovers), in folders made for it', async () => {
    const blocks = buildIssueBlocks(createIssueContext({ comments: [createTestComment('1', 0, getText(jiraCommentSpillMinChars + 1))] }), [], testAiAccountId);
    const spilledTo = getBlock(await fit(blocks), 'comment:1').spilledTo ?? '';
    assert.equal(fs.statSync(spilledTo).mode & 0o777, 0o600);
    assert.equal(fs.statSync(textDir).mode & 0o777, 0o700);
    assert.deepEqual(fs.readdirSync(textDir).filter((name) => name.endsWith('.tmp')), []);
  });

  it('a file that cannot be written fails the fit, so no prompt ever points at a file that is not there', async () => {
    const blocks = buildIssueBlocks(createIssueContext({ comments: [createTestComment('1', 0, getText(jiraCommentSpillMinChars + 1))] }), [], testAiAccountId);
    fs.mkdirSync(path.dirname(textDir), { recursive: true });
    fs.writeFileSync(textDir, 'a file where the folder should be');
    await assert.rejects(fit(blocks));
  });

  it('a file name holds only safe characters, whatever the key', async () => {
    const [description] = buildIssueBlocks(createIssueContext({ fields: { description: convertMarkdownToAdf(getText(70_000)) } }), [], testAiAccountId);
    const unsafe: IssueBlock = { ...description, key: 'comment:../../etc/passwd', kind: 'comment', fullText: getText(jiraCommentSpillMinChars + 1) };
    const fitted = await fit([unsafe]);
    assert.equal(path.dirname(fitted.blocks[0].spilledTo ?? ''), textDir);
    assert.match(path.basename(fitted.blocks[0].spilledTo ?? ''), /^comment-[-A-Za-z0-9_]+-[0-9a-f]{8}\.txt$/);
  });
});
