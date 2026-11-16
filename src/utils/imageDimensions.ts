/**
 * @description Pixel size of a PNG / JPEG / WebP read from the file's header, without decoding it or loading it whole.
 * The photo/document decision of `send_file_to_user` needs the size before Telegram sees the file
 * (`fileSendPlan.ts` § `checkIsPhotoKeptIntact`). The parser works over a positional byte reader, so it runs on a
 * buffer in a test and on an already-open descriptor in the send path — a positional read leaves the descriptor's
 * offset alone, so the upload that follows still starts at byte 0.
 *
 * A file that is not one of the three formats, is cut short or carries an impossible size yields `null`; the caller
 * decides what an unknown size means.
 */

import * as fs from 'fs';

/** Width × height in pixels, as the file's header states them (EXIF orientation not applied). */
export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Read up to `length` bytes at `position`; a shorter (or empty) result means the end of the file.
 * Must not throw on a short read.
 */
export type ImageByteReader = (position: number, length: number) => Buffer;

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngHeaderLength = 24;
const pngWidthOffset = 16;
const pngHeightOffset = 20;

const jpegSignature = Buffer.from([0xff, 0xd8]);
const jpegMarkerPrefix = 0xff;
const jpegSegmentHeaderLength = 4;
/** A real JPEG states its size within a few segments (APPn, tables); a crafted file of tiny ones is not walked to its end. */
const jpegMaxSegmentsBeforeFrame = 1024;
/** Marker, length, precision, height, width — the part of a start-of-frame segment that holds the size. */
const jpegFrameHeaderLength = 9;
const jpegFrameHeightOffset = 5;
const jpegFrameWidthOffset = 7;
/** Start-of-frame markers; 0xc4 (huffman table), 0xc8 (reserved) and 0xcc (arithmetic conditioning) are not frames. */
const jpegFrameMarkers: ReadonlySet<number> = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
/** Markers that carry no length field: TEM, the restart markers and start-of-image. */
const jpegStandaloneMarkers: ReadonlySet<number> = new Set([
  0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8,
]);
/** Start-of-scan and end-of-image: a frame header that did not come before them is not coming. */
const jpegImageDataMarkers: ReadonlySet<number> = new Set([0xd9, 0xda]);

const webpRiffHeaderLength = 12;
const webpChunkHeaderLength = 8;
/** Bytes of the first chunk's data that state the size: lossy (VP8) and extended (VP8X) need 10, lossless (VP8L) 5. */
const webpLossyDataLength = 10;
const webpLosslessDataLength = 5;
const webpExtendedDataLength = 10;
const webpLossyStartCode = Buffer.from([0x9d, 0x01, 0x2a]);
const webpLosslessSignature = 0x2f;
/** Both the lossy header and the lossless one keep a side in 14 bits. */
const webpSideBits = 14;
const webpSideMask = (1 << webpSideBits) - 1;

function checkIsValidDimensions(width: number, height: number): boolean {
  return width > 0 && height > 0;
}

function getPngDimensions(readBytes: ImageByteReader): ImageDimensions | null {
  const header = readBytes(0, pngHeaderLength);
  if (header.length < pngHeaderLength || !header.subarray(0, pngSignature.length).equals(pngSignature)) return null;
  const width = header.readUInt32BE(pngWidthOffset);
  const height = header.readUInt32BE(pngHeightOffset);
  return checkIsValidDimensions(width, height) ? { width, height } : null;
}

/** Walk the JPEG segments by their length fields until the start-of-frame one, which holds the size. */
function getJpegDimensions(readBytes: ImageByteReader): ImageDimensions | null {
  let position = jpegSignature.length;
  for (let segmentIndex = 0; segmentIndex < jpegMaxSegmentsBeforeFrame; segmentIndex += 1) {
    const segmentHeader = readBytes(position, jpegSegmentHeaderLength);
    if (segmentHeader.length < jpegSegmentHeaderLength || segmentHeader[0] !== jpegMarkerPrefix) return null;
    const marker = segmentHeader[1];
    if (marker === jpegMarkerPrefix) {
      // Fill byte before a marker.
      position += 1;
    } else if (jpegStandaloneMarkers.has(marker)) {
      position += 2;
    } else if (jpegImageDataMarkers.has(marker)) {
      return null;
    } else if (jpegFrameMarkers.has(marker)) {
      const frame = readBytes(position, jpegFrameHeaderLength);
      if (frame.length < jpegFrameHeaderLength) return null;
      const height = frame.readUInt16BE(jpegFrameHeightOffset);
      const width = frame.readUInt16BE(jpegFrameWidthOffset);
      return checkIsValidDimensions(width, height) ? { width, height } : null;
    } else {
      position += 2 + segmentHeader.readUInt16BE(2);
    }
  }
  return null;
}

function getWebpDimensions(readBytes: ImageByteReader): ImageDimensions | null {
  const riffHeader = readBytes(0, webpRiffHeaderLength);
  if (
    riffHeader.length < webpRiffHeaderLength ||
    riffHeader.toString('ascii', 0, 4) !== 'RIFF' ||
    riffHeader.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    return null;
  }
  // The first chunk decides the format: lossy (VP8), lossless (VP8L) or extended (VP8X).
  const chunk = readBytes(
    webpRiffHeaderLength,
    webpChunkHeaderLength + Math.max(webpLossyDataLength, webpLosslessDataLength, webpExtendedDataLength),
  );
  const fourCc = chunk.toString('ascii', 0, 4);
  const data = chunk.subarray(webpChunkHeaderLength);
  let dimensions: ImageDimensions | null = null;
  if (fourCc === 'VP8 ' && data.length >= webpLossyDataLength && data.subarray(3, 6).equals(webpLossyStartCode)) {
    dimensions = {
      width: data.readUInt16LE(6) & webpSideMask,
      height: data.readUInt16LE(8) & webpSideMask,
    };
  } else if (fourCc === 'VP8L' && data.length >= webpLosslessDataLength && data[0] === webpLosslessSignature) {
    const packedSize = data.readUInt32LE(1);
    // The sizes are stored minus one.
    dimensions = { width: (packedSize & webpSideMask) + 1, height: ((packedSize >>> webpSideBits) & webpSideMask) + 1 };
  } else if (fourCc === 'VP8X' && data.length >= webpExtendedDataLength) {
    dimensions = { width: data.readUIntLE(4, 3) + 1, height: data.readUIntLE(7, 3) + 1 };
  }
  return dimensions !== null && checkIsValidDimensions(dimensions.width, dimensions.height) ? dimensions : null;
}

/**
 * @description Pixel size of the image a reader exposes, or `null` when it is not a readable PNG, JPEG or WebP.
 * A reader that throws counts as unreadable.
 */
export function getImageDimensions(readBytes: ImageByteReader): ImageDimensions | null {
  try {
    return getPngDimensions(readBytes) ?? getJpegDimensions(readBytes) ?? getWebpDimensions(readBytes);
  } catch {
    return null;
  }
}

/** A reader over a buffer. */
export function createBufferByteReader(buffer: Buffer): ImageByteReader {
  return (position, length) => buffer.subarray(position, position + length);
}

/**
 * A reader over an open descriptor. Positional (`pread`), so the descriptor's own offset stays where it was.
 */
export function createDescriptorByteReader(fileDescriptor: number): ImageByteReader {
  return (position, length) => {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fileDescriptor, buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  };
}
