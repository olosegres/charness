/**
 * @description What a file the agent shows on a Jira issue is (`outgoingFileCheck.ts`): an image shown only when it is
 * whole and what its name says, an `.mp4` only when it is complete and H.264 — read from its boxes, no ffprobe — and
 * anything else a plain file to link. Over minimal files (`imageFixtures.ts`, `mediaFileFixtures.ts`), read through
 * the same positional reader as a descriptor.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkJiraOutgoingFile, jiraVideoConvertHint, type JiraOutgoingFileCheck } from '../connectors/jira/outgoingFileCheck';
import { createBufferByteReader } from '../utils/imageDimensions';
import { createJpegBytes, createLossyWebpBytes, createPngBytes } from './imageFixtures';
import { createMp4Box, createMp4Bytes, createMp4SampleEntry, createMp4Track, pngEndChunk } from './mediaFileFixtures';

const check = (name: string, bytes: Buffer): JiraOutgoingFileCheck => checkJiraOutgoingFile(name, bytes.length, createBufferByteReader(bytes));
const box = createMp4Box;
const createTrack = createMp4Track;
const createSampleEntry = createMp4SampleEntry;
const createMp4 = createMp4Bytes;

describe('images: shown only when whole and what the name says', () => {
  it('a whole PNG, JPEG, GIF and WebP pass, with the size they state', () => {
    assert.deepEqual(check('shot.png', Buffer.concat([createPngBytes(1366, 768), pngEndChunk])), { ok: true, kind: 'image', mimeType: 'image/png', size: { width: 1366, height: 768 } });
    assert.deepEqual(check('photo.JPG', createJpegBytes(640, 480)), { ok: true, kind: 'image', mimeType: 'image/jpeg', size: { width: 640, height: 480 } });
    const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([0x20, 0x00, 0x10, 0x00, 0, 0, 0]), Buffer.from([0x3b])]);
    assert.deepEqual(check('spin.gif', gif), { ok: true, kind: 'image', mimeType: 'image/gif', size: { width: 32, height: 16 } });
    assert.deepEqual(check('pic.webp', createLossyWebpBytes(300, 200)), { ok: true, kind: 'image', mimeType: 'image/webp', size: { width: 300, height: 200 } });
  });

  it('a JPEG may carry zero padding after its end marker', () => {
    assert.equal(check('pad.jpeg', Buffer.concat([createJpegBytes(10, 10), Buffer.alloc(40)])).ok, true);
  });

  it('a partial file is refused: a PNG without its end chunk, a JPEG without its end marker, a GIF without its trailer, a WebP shorter than its RIFF size', () => {
    const partials: Array<[string, Buffer]> = [
      ['shot.png', createPngBytes(10, 10)],
      ['photo.jpg', createJpegBytes(10, 10).subarray(0, -2)],
      ['spin.gif', Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(8)])],
      ['pic.webp', createLossyWebpBytes(10, 10).subarray(0, -2)],
    ];
    for (const [name, bytes] of partials) {
      const result = check(name, bytes);
      assert.equal(result.ok, false, name);
      assert.match(!result.ok ? result.error : '', new RegExp(`^${name.replace('.', '\\.')} is not a complete .* image — a partial file\\?`), name);
    }
  });

  it('a renamed file is refused, naming what it holds; a file that is no image at all too', () => {
    const renamed = check('shot.png', createJpegBytes(10, 10));
    assert.deepEqual(renamed, { ok: false, error: 'shot.png holds a JPEG image, which its name does not say — a renamed file? Give it the right extension.' });
    assert.deepEqual(check('shot.png', Buffer.from('<html>not found</html>')), { ok: false, error: 'shot.png is not a PNG image — a renamed file?' });
  });
});

describe('an .mp4: played only when complete and H.264', () => {
  it('an H.264 recording passes with the size its video track states', () => {
    assert.deepEqual(check('run.mp4', createMp4([createTrack('soun', createSampleEntry('mp4a', 0, 0)), createTrack('vide', createSampleEntry('avc1', 1366, 768))])), {
      ok: true,
      kind: 'video',
      mimeType: 'video/mp4',
      size: { width: 1366, height: 768 },
    });
    assert.equal(check('run.mp4', createMp4([createTrack('vide', createSampleEntry('avc3', 320, 240))])).ok, true, 'avc3 is H.264 too');
  });

  it('the movie header may come after the media data (no faststart), and a last box may run to the end (size 0)', () => {
    const ftyp = box('ftyp', Buffer.from('isom', 'latin1'));
    const moov = box('moov', createTrack('vide', createSampleEntry('avc1', 640, 360)));
    const toEnd = box('mdat', Buffer.alloc(16));
    toEnd.writeUInt32BE(0, 0);
    assert.equal(check('late.mp4', Buffer.concat([ftyp, box('mdat', Buffer.alloc(32)), moov])).ok, true);
    assert.equal(check('open.mp4', Buffer.concat([ftyp, moov, toEnd])).ok, true);
  });

  it('another codec is refused with how to convert it', () => {
    assert.deepEqual(check('run.mp4', createMp4([createTrack('vide', createSampleEntry('hvc1', 1920, 1080))])), {
      ok: false,
      error: `run.mp4 holds hvc1 video, not H.264 — Jira plays only H.264 in an .mp4. Convert it: ${jiraVideoConvertHint}`,
    });
  });

  it('a cut recording, one without its movie header, one without a video track, and a renamed file are refused', () => {
    const whole = createMp4([createTrack('vide', createSampleEntry('avc1', 320, 240))], 4096);
    assert.match(errorOf(check('cut.mp4', whole.subarray(0, whole.length - 100))), /^cut\.mp4 is not a complete MP4 — a recording that was cut short\?/);
    const ftyp = box('ftyp', Buffer.from('isom', 'latin1'));
    assert.match(errorOf(check('nomoov.mp4', Buffer.concat([ftyp, box('mdat', Buffer.alloc(64))]))), /^nomoov\.mp4 has no movie header \(moov\)/);
    assert.equal(errorOf(check('audio.mp4', createMp4([createTrack('soun', createSampleEntry('mp4a', 0, 0))]))), 'audio.mp4 holds no video track Jira can read.');
    assert.match(errorOf(check('fake.mp4', Buffer.from('not a video at all, just text'))), /^fake\.mp4 is not an MP4 \(it does not start with an ftyp box\)/);
  });
});

describe('anything else is a plain file to link', () => {
  it('a text file, a report, a file with no extension: linked, with a type for the upload', () => {
    assert.deepEqual(check('notes.txt', Buffer.from('hi')), { ok: true, kind: 'file', mimeType: 'text/plain', size: null });
    assert.deepEqual(check('report.pdf', Buffer.from('%PDF')), { ok: true, kind: 'file', mimeType: 'application/pdf', size: null });
    assert.deepEqual(check('Makefile', Buffer.from('all:')), { ok: true, kind: 'file', mimeType: 'application/octet-stream', size: null });
  });

  it('a video in another container is linked, with a note saying how to make it play', () => {
    assert.deepEqual(check('run.webm', Buffer.from('webm')), {
      ok: true,
      kind: 'file',
      mimeType: 'video/webm',
      size: null,
      note: `run.webm is linked, not played: Jira plays only an H.264 .mp4 in a comment (${jiraVideoConvertHint})`,
    });
  });
});

function errorOf(result: JiraOutgoingFileCheck): string {
  assert.equal(result.ok, false);
  return result.ok ? '' : result.error;
}
