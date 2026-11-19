/**
 * @description Files an agent shows on a Jira issue (`outgoingFiles.ts`) over real files in a temporary folder and a fake
 * client that records every call: everything checked before anything is uploaded, the folder rule of the file send,
 * the site's switch and upload limit, reuse of a recent attachment of the AI account's own, an upload Jira did not
 * confirm, the media ids read for what is shown and the nodes the comment carries.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendNodesToBodies,
  attachFilesToIssue,
  createAttachedFilesNodes,
  jiraAttachmentReuseMaxAgeMs,
  jiraFilesMaxCount,
  type JiraFileAttachDeps,
} from '../connectors/jira/outgoingFiles';
import { convertMarkdownToAdf, jiraCommentAdfMaxChars } from '../connectors/jira/adf';
import type { JiraAttachment, JiraAttachmentSettings, JiraAttachmentUploadResult, JiraIssue } from '../connectors/jira/client';
import { createPngBytes } from './imageFixtures';
import { createCompletePngBytes, createH264Mp4Bytes } from './mediaFileFixtures';

const aiAccountId = 'ai-account';
const issueKey = 'PROJ-12';
const siteUrl = 'https://example.atlassian.net';
const nowMs = Date.parse('2026-11-20T10:00:00Z');
const pngBytes = createCompletePngBytes(64, 48);
const createMp4Bytes = (): Buffer => createH264Mp4Bytes(320, 240);

interface FakeAttachJira {
  calls: string[];
  settings: JiraAttachmentSettings;
  onIssue: JiraAttachment[];
  /**
   * Per upload, in order: `uploaded` (also when the list runs out), `landedUnconfirmed` (on the issue, but Jira's answer
   * did not say), `lost` (not confirmed and not on the issue), or the error Jira refused it with.
   */
  uploadOutcomes: Array<'uploaded' | 'landedUnconfirmed' | 'lost' | Error>;
  /** The media id each attachment's content redirects to; absent: none. */
  mediaIds: Map<string, string>;
  /** The bytes each upload read from its descriptor. */
  uploadedBytes: Buffer[];
  nextId: number;
}

let jira: FakeAttachJira;
/** Holds the issue's folder and, beside it, a file outside it. */
let baseDir: string;
let workDir: string;

function createDeps(): JiraFileAttachDeps {
  return {
    aiAccountId,
    siteUrl,
    now: () => nowMs,
    client: {
      getAttachmentSettings: async () => {
        jira.calls.push('settings');
        return jira.settings;
      },
      getIssue: async (key): Promise<JiraIssue> => {
        jira.calls.push(`attachments ${key}`);
        return { id: '1', key, fields: { attachment: [...jira.onIssue] } };
      },
      uploadAttachment: async (key, file) => {
        jira.calls.push(`upload ${key} ${file.filename} ${file.mimeType} ${file.sizeBytes}`);
        const content = Buffer.alloc(file.sizeBytes);
        readSync(file.fd, content, 0, file.sizeBytes, 0);
        jira.uploadedBytes.push(content);
        const outcome = jira.uploadOutcomes.shift() ?? 'uploaded';
        if (outcome instanceof Error) throw outcome;
        const attachment: JiraAttachment = {
          id: String(jira.nextId++),
          filename: file.filename,
          size: file.sizeBytes,
          mimeType: file.mimeType,
          created: new Date(nowMs).toISOString(),
          author: { accountId: aiAccountId },
        };
        if (outcome === 'lost') return { outcome: 'deliveryUnknown', reason: 'timeout' } satisfies JiraAttachmentUploadResult;
        jira.onIssue.push(attachment);
        if (outcome === 'landedUnconfirmed') return { outcome: 'deliveryUnknown', reason: 'timeout' };
        return { outcome: 'uploaded', attachments: [attachment] };
      },
      getAttachmentMediaId: async (attachmentId) => {
        jira.calls.push(`media ${attachmentId}`);
        return jira.mediaIds.get(attachmentId) ?? null;
      },
    },
  };
}

const attach = (paths: string[], isShownInline = true) => attachFilesToIssue(createDeps(), issueKey, workDir, paths, { isShownInline });
const uploads = (): string[] => jira.calls.filter((call) => call.startsWith('upload'));

beforeEach(() => {
  jira = { calls: [], settings: { isEnabled: true, uploadLimitBytes: 10 * 1024 * 1024 }, onIssue: [], uploadOutcomes: [], mediaIds: new Map([['9001', 'aaaaaaaa-0000-4000-8000-000000000001'], ['9002', 'aaaaaaaa-0000-4000-8000-000000000002']]), uploadedBytes: [], nextId: 9001 };
  baseDir = mkdtempSync(path.join(os.tmpdir(), 'jira-files-'));
  workDir = path.join(baseDir, 'proj');
  mkdirSync(workDir);
  writeFileSync(path.join(baseDir, 'escape.png'), pngBytes);
  writeFileSync(path.join(workDir, 'shot.png'), pngBytes);
  writeFileSync(path.join(workDir, 'run.mp4'), createMp4Bytes());
  writeFileSync(path.join(workDir, 'notes.txt'), 'the log\n');
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('attaching the files', () => {
  it('an image, a video and a text file: uploaded in order from the folder, the image and the video shown, the text file linked', async () => {
    const result = await attach(['shot.png', 'run.mp4', 'notes.txt']);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(uploads(), [
      `upload ${issueKey} shot.png image/png ${pngBytes.length}`,
      `upload ${issueKey} run.mp4 video/mp4 ${createMp4Bytes().length}`,
      `upload ${issueKey} notes.txt text/plain 8`,
    ]);
    assert.ok(jira.uploadedBytes[0].equals(pngBytes), 'the file itself, read from its start');
    assert.ok(jira.calls.indexOf('settings') < jira.calls.indexOf(uploads()[0]), 'the site is asked before anything is uploaded');
    assert.deepEqual(jira.calls.filter((call) => call.startsWith('media')), ['media 9001', 'media 9002'], 'a linked file needs no media id');
    assert.deepEqual(result.nodes, [
      { type: 'mediaSingle', attrs: { layout: 'center' }, content: [{ type: 'media', attrs: { type: 'file', id: 'aaaaaaaa-0000-4000-8000-000000000001', collection: '', width: 64, height: 48 } }] },
      { type: 'mediaSingle', attrs: { layout: 'center' }, content: [{ type: 'media', attrs: { type: 'file', id: 'aaaaaaaa-0000-4000-8000-000000000002', collection: '', width: 320, height: 240 } }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'notes.txt', marks: [{ type: 'link', attrs: { href: `${siteUrl}/rest/api/3/attachment/content/9003` } }] }] }] }] },
    ]);
    assert.equal(result.summary, 'shot.png (shown in the comment, attachment 9001), run.mp4 (plays in the comment, attachment 9002), notes.txt (linked, attachment 9003)');
    assert.deepEqual(result.sentKinds, ['photo', 'video', 'document']);
    assert.deepEqual(result.notes, []);
  });

  it('as links (`as_file`): every file linked, no media id asked for', async () => {
    const result = await attach(['shot.png', 'run.mp4'], false);
    assert.equal(result.ok && result.nodes.length, 1);
    assert.deepEqual(jira.calls.filter((call) => call.startsWith('media')), []);
    assert.deepEqual(result.ok && result.sentKinds, ['document', 'document']);
  });

  it('a file Jira gives no media id for is attached and linked, and the agent is told', async () => {
    jira.mediaIds.clear();
    const result = await attach(['shot.png']);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.nodes[0].type, 'bulletList');
    assert.deepEqual(result.notes, ['shot.png is attached and linked, but not shown in the comment: Jira gave no media file for it']);
  });

  it('a media id that cannot be read is the same: linked, with a log line', async () => {
    const deps = createDeps();
    deps.client.getAttachmentMediaId = async () => {
      throw new Error('Jira GET failed with 503');
    };
    const warn = mock.method(console, 'warn', () => {});
    try {
      const result = await attachFilesToIssue(deps, issueKey, workDir, ['shot.png'], { isShownInline: true });
      assert.equal(result.ok && result.files[0].mediaId, null);
    } finally {
      warn.mock.restore();
    }
  });
});

describe('nothing is uploaded unless every file passes', () => {
  it('a partial image among good files: refused, naming it; nothing uploaded', async () => {
    writeFileSync(path.join(workDir, 'cut.png'), createPngBytes(10, 10));
    const result = await attach(['shot.png', 'cut.png']);
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error : '', /^cut\.png is not a complete PNG image — a partial file\? .* Nothing was attached or posted\.$/);
    assert.deepEqual(uploads(), []);
  });

  it('a path outside the folder, or one that does not exist: refused by the file send\'s rule, nothing uploaded', async () => {
    const outside = await attach(['../escape.png']);
    assert.match(!outside.ok ? outside.error : '', /outside the bound folder.*; nothing was attached or posted$/);
    const missing = await attach(['nope.png']);
    assert.match(!missing.ok ? missing.error : '', /file not found: nope\.png; nothing was attached or posted$/);
    assert.deepEqual(uploads(), []);
  });

  it('attachments switched off on the site, a file over its upload limit, too many files: refused before any upload', async () => {
    jira.settings = { isEnabled: false, uploadLimitBytes: null };
    assert.deepEqual(await attach(['shot.png']), { ok: false, error: 'attachments are switched off on this Jira site, so no file can be shown; nothing was posted' });
    jira.settings = { isEnabled: true, uploadLimitBytes: 20 };
    const tooBig = await attach(['notes.txt', 'shot.png']);
    assert.equal(!tooBig.ok && tooBig.error, 'shot.png is over the site\'s upload limit of 0.0 MB — shorten the recording or shrink the image; nothing was attached or posted');
    const many = await attach(Array.from({ length: jiraFilesMaxCount + 1 }, () => 'notes.txt'));
    assert.match(!many.ok ? many.error : '', /^too many files: 11 \(max 10\)/);
    assert.deepEqual(uploads(), []);
  });
});

describe('sending again attaches nothing twice', () => {
  const ownAttachment = (id: string, name: string, size: number, ageMs: number, accountId = aiAccountId): JiraAttachment => ({
    id, filename: name, size, created: new Date(nowMs - ageMs).toISOString(), author: { accountId },
  });

  it('a recent attachment of the AI account\'s own of the same name and size is reused; each one stands for one file only', async () => {
    jira.onIssue = [ownAttachment('8001', 'notes.txt', 8, 5 * 60 * 1000)];
    const result = await attach(['notes.txt', 'notes.txt']);
    assert.deepEqual(uploads(), [`upload ${issueKey} notes.txt text/plain 8`], 'the second file of that name is a new upload');
    assert.deepEqual(result.ok && result.files.map((file) => [file.attachmentId, file.isReused]), [['8001', true], ['9001', false]]);
    assert.match(result.ok ? result.summary : '', /notes\.txt \(linked, attachment 8001, attached before\)/);
  });

  it('not reused: someone else\'s, one older than the hour, one of another size', async () => {
    jira.onIssue = [
      ownAttachment('8001', 'notes.txt', 8, 60_000, 'someone-else'),
      ownAttachment('8002', 'notes.txt', 8, jiraAttachmentReuseMaxAgeMs + 60_000),
      ownAttachment('8003', 'notes.txt', 9, 60_000),
    ];
    await attach(['notes.txt']);
    assert.equal(uploads().length, 1);
  });

  it('an upload Jira did not confirm: found on the issue it counts as attached; not found it is an error naming what is attached already — never a second upload', async () => {
    jira.uploadOutcomes = ['landedUnconfirmed'];
    const landed = await attach(['notes.txt']);
    assert.equal(landed.ok && landed.files[0].attachmentId, '9001');

    jira.onIssue = [];
    jira.calls = [];
    jira.uploadOutcomes = ['uploaded', 'lost'];
    jira.nextId = 9101;
    const lost = await attach(['shot.png', 'notes.txt']);
    assert.equal(!lost.ok && lost.error,
      'the upload of notes.txt was not confirmed (timeout) and it is not on the issue; nothing was posted. Already attached: shot.png (attachment 9101) — sending again reuses them.');
    assert.equal(uploads().length, 2, 'the unconfirmed upload was not repeated');
  });

  it('an upload Jira refused is the error, with what is attached already', async () => {
    jira.uploadOutcomes = ['uploaded', new Error('Jira POST /rest/api/3/issue/PROJ-12/attachments failed with 413: too large')];
    const result = await attach(['shot.png', 'notes.txt']);
    assert.match(!result.ok ? result.error : '', /^notes\.txt could not be attached: Jira POST .* failed with 413: too large; nothing was posted\. Already attached: shot\.png \(attachment 9001\)/);
  });
});

describe('the comment carries the files after its text', () => {
  const node = createAttachedFilesNodes([{ name: 'shot.png', attachmentId: '9001', kind: 'image', mediaId: 'm-1', size: null, isReused: false }], siteUrl)[0];

  it('a media node without a stated size carries no width or height (Jira shows it at a default size)', () => {
    assert.deepEqual(node, { type: 'mediaSingle', attrs: { layout: 'center' }, content: [{ type: 'media', attrs: { type: 'file', id: 'm-1', collection: '' } }] });
  });

  it('in the last body when it fits, else in a body of its own; with no text, one body of them', () => {
    const text = convertMarkdownToAdf('Done.');
    const [extended] = appendNodesToBodies([text], [node]);
    assert.deepEqual(extended.content.map((child) => child.type), ['paragraph', 'mediaSingle']);
    const full = convertMarkdownToAdf('x'.repeat(jiraCommentAdfMaxChars - 200));
    assert.equal(appendNodesToBodies([full], [node, node, node]).length, 2);
    assert.deepEqual(appendNodesToBodies([], [node]), [{ version: 1, type: 'doc', content: [node] }]);
    assert.deepEqual(appendNodesToBodies([text], []), [text]);
  });
});
