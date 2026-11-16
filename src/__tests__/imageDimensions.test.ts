/**
 * @description Tests for `utils/imageDimensions.ts` — the pixel size read from a PNG / JPEG / WebP header, which the
 * `send_file_to_user` photo-vs-document decision stands on. A wrong size here sends a blurred screenshot as a photo or
 * a fine one as a file, so every format, the JPEG segment walk and the "unknown" outcomes are pinned.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createBufferByteReader,
  createDescriptorByteReader,
  getImageDimensions,
} from '../utils/imageDimensions';
import {
  createExtendedWebpBytes,
  createJpegBytes,
  createJpegWithoutFrameBytes,
  createLosslessWebpBytes,
  createLossyWebpBytes,
  createPngBytes,
} from './imageFixtures';

function getDimensionsOf(bytes: Buffer) {
  return getImageDimensions(createBufferByteReader(bytes));
}

test('getImageDimensions: a PNG states its size in the IHDR chunk', () => {
  assert.deepEqual(getDimensionsOf(createPngBytes(1920, 1080)), { width: 1920, height: 1080 });
});

test('getImageDimensions: a JPEG states its size in the start-of-frame segment', () => {
  assert.deepEqual(getDimensionsOf(createJpegBytes(3840, 2160)), { width: 3840, height: 2160 });
});

test('getImageDimensions: a JPEG walks past large EXIF/ICC segments before its frame header', () => {
  const bytes = createJpegBytes(2560, 1440, { appSegmentPayloadLengths: [60_000, 40_000, 12] });
  assert.deepEqual(getDimensionsOf(bytes), { width: 2560, height: 1440 });
});

test('getImageDimensions: a JPEG is not walked through a runaway number of segments before its frame header', () => {
  const manySegments = (count: number) => createJpegBytes(1920, 1080, { appSegmentPayloadLengths: new Array<number>(count).fill(0) });
  assert.deepEqual(getDimensionsOf(manySegments(100)), { width: 1920, height: 1080 });
  assert.equal(getDimensionsOf(manySegments(1_100)), null);
});

test('getImageDimensions: a progressive JPEG and a fill byte before the marker are read too', () => {
  assert.deepEqual(
    getDimensionsOf(createJpegBytes(1000, 700, { frameMarker: 0xc2, isWithFillByte: true })),
    { width: 1000, height: 700 },
  );
});

test('getImageDimensions: a JPEG that reaches the scan without a frame header is unknown', () => {
  assert.equal(getDimensionsOf(createJpegWithoutFrameBytes()), null);
});

test('getImageDimensions: WebP lossy, lossless and extended each state their size their own way', () => {
  assert.deepEqual(getDimensionsOf(createLossyWebpBytes(1600, 900)), { width: 1600, height: 900 });
  assert.deepEqual(getDimensionsOf(createLosslessWebpBytes(1600, 900)), { width: 1600, height: 900 });
  assert.deepEqual(getDimensionsOf(createExtendedWebpBytes(4000, 3000)), { width: 4000, height: 3000 });
});

test('getImageDimensions: not an image, a cut-off header and a zero side are unknown', () => {
  assert.equal(getDimensionsOf(Buffer.from('not an image at all, just text')), null);
  assert.equal(getDimensionsOf(Buffer.alloc(0)), null);
  assert.equal(getDimensionsOf(createPngBytes(1920, 1080).subarray(0, 20)), null);
  assert.equal(getDimensionsOf(createJpegBytes(1920, 1080).subarray(0, 8)), null);
  assert.equal(getDimensionsOf(createLossyWebpBytes(1920, 1080).subarray(0, 24)), null);
  assert.equal(getDimensionsOf(createPngBytes(0, 600)), null);
  assert.equal(getDimensionsOf(createJpegBytes(800, 0)), null);
});

test('getImageDimensions: a reader that throws leaves the size unknown instead of throwing', () => {
  assert.equal(getImageDimensions(() => { throw new Error('EIO'); }), null);
});

test('createDescriptorByteReader reads an open file by position and leaves its offset at byte 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imageDimensions-'));
  const filePath = path.join(dir, 'shot.jpg');
  const bytes = createJpegBytes(1920, 1080, { appSegmentPayloadLengths: [500] });
  fs.writeFileSync(filePath, bytes);
  const fileDescriptor = fs.openSync(filePath, 'r');
  try {
    assert.deepEqual(getImageDimensions(createDescriptorByteReader(fileDescriptor)), { width: 1920, height: 1080 });

    // The upload that follows reads from the descriptor's own offset: it must still be the start of the file.
    const firstBytes = Buffer.alloc(2);
    fs.readSync(fileDescriptor, firstBytes, 0, 2, null);
    assert.deepEqual([...firstBytes], [0xff, 0xd8]);
  } finally {
    fs.closeSync(fileDescriptor);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createDescriptorByteReader: a descriptor that cannot be read leaves the size unknown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imageDimensions-'));
  const filePath = path.join(dir, 'shot.png');
  fs.writeFileSync(filePath, createPngBytes(100, 100));
  const fileDescriptor = fs.openSync(filePath, 'r');
  fs.closeSync(fileDescriptor);
  try {
    assert.equal(getImageDimensions(createDescriptorByteReader(fileDescriptor)), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
