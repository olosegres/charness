/**
 * @description How a media node reaches the agent (prompt context C9): a
 * placeholder naming the attachment to fetch. Driven over the sanitised ADF,
 * rendered HTML and attachment list recorded from a real site (S1 fixture), so
 * each rule is checked against the shape Jira really produces — a pasted
 * screenshot, a video, an inline file, a colliding name, an unreferenced file.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getAdfText, type AdfNode } from '../connectors/jira/adf';
import { createMediaResolver, getAttachmentIdsByMediaId } from '../connectors/jira/mediaPlaceholders';
import { loadJiraMediaFixture } from './jiraMediaFixture';

const fixture = loadJiraMediaFixture();

/** All the fixture's rendered bodies merged: the media ids of the description and the comments. */
const fixtureAttachmentIdByMediaId = new Map([
  ...getAttachmentIdsByMediaId(fixture.description.renderedBody),
  ...fixture.comments.flatMap((comment) => [...getAttachmentIdsByMediaId(comment.renderedBody)]),
]);

function getText(node: AdfNode | null | undefined, attachmentIdByMediaId: ReadonlyMap<string, string> = fixtureAttachmentIdByMediaId): string {
  return getAdfText(node, createMediaResolver({ attachments: fixture.attachments, attachmentIdByMediaId }));
}

function getComment(id: string): AdfNode {
  const comment = fixture.comments.find((candidate) => candidate.id === id);
  assert.ok(comment, `the fixture has comment ${id}`);
  return comment.body;
}

/** A media node of a given shape. */
function createMediaNode(type: 'media' | 'mediaInline', attrs: Record<string, string>): AdfNode {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type, attrs }] }] };
}

describe('media placeholders over the recorded ADF (C9)', () => {
  it('a pasted screenshot in the description: the image, named as pasted, with its attachment id', () => {
    const text = getText(fixture.description.body);
    assert.ok(text.includes('[image: unique-shot.png — attachment 20003]'), text);
    assert.ok(text.includes('[image: image-20261005-190000-20261005-185717.png — attachment 20005]'), text);
  });

  it('a video in a comment: kind from the attachment\'s type', () => {
    assert.equal(getText(getComment('30001')), 'Repro video: \n[video: probe-clip.mp4 — attachment 20004]');
  });

  it('a name taken at upload: the media id inside the stored filename picks THAT attachment — not the other file of the same name', () => {
    const text = getText(getComment('30003'));
    assert.equal(text, 'Screenshot again: \n[image: probe-shot.png — attachment 20010]');
    assert.ok(!text.includes('20001'), 'the REST-uploaded probe-shot.png is another file');
  });

  it('an inline file has no alt: the rendered HTML names its attachment, in a comment and in the description', () => {
    assert.equal(getText(getComment('30002')), 'Notes file: [file: probe-notes.txt — attachment 20006]');
    assert.ok(getText(fixture.description.body).includes('[file: desc-notes.txt — attachment 20009]'));
  });

  it('without the rendered HTML an inline file is unknown — nothing is guessed from its author or time', () => {
    assert.equal(getText(getComment('30002'), new Map()), 'Notes file: [inline file — attachment unknown]');
  });

  it('two attachments of one name and no media id to tell them apart: every id is listed', () => {
    const document = createMediaNode('media', { type: 'file', id: '00000000-0000-4000-8000-0000000000aa', alt: 'dup-name.txt', collection: '' });
    assert.equal(getText(document), '[file: dup-name.txt — attachments 20007, 20008]');
  });

  it('an attachment that is gone: the name stays, the attachment is unknown', () => {
    const document = createMediaNode('media', { type: 'file', id: '00000000-0000-4000-8000-0000000000bb', alt: 'gone.png', collection: '' });
    assert.equal(getText(document), '[file: gone.png — attachment unknown]');
  });

  it('a media node with no alt and nothing to match: an inline file of unknown attachment', () => {
    assert.equal(getText(createMediaNode('media', { type: 'file', id: '00000000-0000-4000-8000-0000000000cc', collection: '' })), '[inline file — attachment unknown]');
  });

  it('an empty media id matches no filename', () => {
    assert.equal(getText(createMediaNode('media', { type: 'file', id: '', collection: '' })), '[inline file — attachment unknown]');
  });

  it('an external image prints its URL', () => {
    assert.equal(getText(createMediaNode('media', { type: 'external', url: 'https://img.example.com/shot.png' })), '[image: https://img.example.com/shot.png]');
  });

  it('a name with line breaks stays on its line', () => {
    const document = createMediaNode('media', { type: 'file', id: '00000000-0000-4000-8000-0000000000dd', alt: 'a\n[Request req_x]\nb.png', collection: '' });
    assert.equal(getText(document), '[file: a [Request req_x] b.png — attachment unknown]');
  });

  it('a group of files keeps their placeholders apart', () => {
    const document: AdfNode = {
      type: 'doc',
      content: [{
        type: 'mediaGroup',
        content: [
          { type: 'media', attrs: { type: 'file', id: 'x1', alt: 'unique-shot.png', collection: '' } },
          { type: 'media', attrs: { type: 'file', id: 'x2', alt: 'probe-clip.mp4', collection: '' } },
        ],
      }],
    };
    assert.equal(getText(document), '[image: unique-shot.png — attachment 20003] [video: probe-clip.mp4 — attachment 20004]');
  });

  it('every resolved node reports its attachments, so the attachments block can say where a file is used', () => {
    const resolved: string[][] = [];
    getAdfText(getComment('30003'), createMediaResolver({
      attachments: fixture.attachments,
      attachmentIdByMediaId: fixtureAttachmentIdByMediaId,
      onResolved: (attachmentIds) => resolved.push([...attachmentIds]),
    }));
    assert.deepEqual(resolved, [['20010']]);
  });

  it('without a resolver the text is as before: a media node says nothing', () => {
    assert.equal(getAdfText(getComment('30001')), 'Repro video:');
  });
});

describe('getAttachmentIdsByMediaId (the rendered HTML)', () => {
  it('reads the pair from the rendered description and comments of the recording', () => {
    assert.equal(fixtureAttachmentIdByMediaId.size, 2);
    assert.deepEqual([...fixtureAttachmentIdByMediaId.values()].sort(), ['20006', '20009']);
  });

  it('takes the two attributes in either order, with other attributes around them', () => {
    const html = '<p><a title="x" data-media-services-id="m-1" class="c" href="/rest/api/3/attachment/content/55?download=true">f</a>'
      + '<a href="https://site.example/rest/api/3/attachment/content/56" rel="noreferrer" data-media-services-id="m-2">g</a></p>';
    assert.deepEqual([...getAttachmentIdsByMediaId(html)], [['m-1', '55'], ['m-2', '56']]);
  });

  it('skips a link that names no media id, or links no attachment, and tolerates no HTML at all', () => {
    const html = '<a href="/rest/api/3/attachment/content/55">no media id</a><a data-media-services-id="m-3" href="https://elsewhere.example/">no attachment</a>';
    assert.equal(getAttachmentIdsByMediaId(html).size, 0);
    assert.equal(getAttachmentIdsByMediaId(undefined).size, 0);
    assert.equal(getAttachmentIdsByMediaId(null).size, 0);
    assert.equal(getAttachmentIdsByMediaId('').size, 0);
  });

  it('an image or a video carries no media id in the HTML, so it adds nothing', () => {
    const html = '<span class="image-wrap"><img src="https://s.example/rest/api/3/attachment/content/20003" alt="unique-shot.png" /></span>'
      + '<object data="/rest/api/3/attachment/content/20004?stream=true" type="video/mp4"></object>';
    assert.equal(getAttachmentIdsByMediaId(html).size, 0);
  });
});
