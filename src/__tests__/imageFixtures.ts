/**
 * @description Minimal image HEADERS for tests: just enough bytes for `utils/imageDimensions.ts` to read a size from
 * (no pixel data, no checksums). They stand in for a real screenshot where a test only cares how big it claims to be.
 */

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngHeaderChunkLength = 13;

/** A PNG signature plus its IHDR chunk. */
export function createPngBytes(width: number, height: number): Buffer {
  const header = Buffer.alloc(pngHeaderChunkLength + 8 + 4);
  header.writeUInt32BE(pngHeaderChunkLength, 0);
  header.write('IHDR', 4, 'ascii');
  header.writeUInt32BE(width, 8);
  header.writeUInt32BE(height, 12);
  return Buffer.concat([pngSignature, header]);
}

interface JpegOptions {
  /** Start-of-frame marker: 0xc0 baseline (default), 0xc2 progressive. */
  frameMarker?: number;
  /** Payload sizes of APPn segments placed before the frame header (EXIF, ICC and the like). */
  appSegmentPayloadLengths?: number[];
  /** Insert a fill byte (0xff) in front of the frame marker, as the format allows. */
  isWithFillByte?: boolean;
}

/** SOI, optional APPn segments, a start-of-frame segment, then end-of-image. */
export function createJpegBytes(width: number, height: number, options: JpegOptions = {}): Buffer {
  const { frameMarker = 0xc0, appSegmentPayloadLengths = [], isWithFillByte = false } = options;
  const appSegments = appSegmentPayloadLengths.map((payloadLength) => {
    const segment = Buffer.alloc(2 + 2 + payloadLength, 0x41);
    segment.writeUInt8(0xff, 0);
    segment.writeUInt8(0xe1, 1);
    segment.writeUInt16BE(2 + payloadLength, 2);
    return segment;
  });
  const frame = Buffer.alloc(2 + 2 + 6);
  frame.writeUInt8(0xff, 0);
  frame.writeUInt8(frameMarker, 1);
  frame.writeUInt16BE(8, 2);
  frame.writeUInt8(8, 4);
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...appSegments,
    ...(isWithFillByte ? [Buffer.from([0xff])] : []),
    frame,
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** A JPEG that reaches start-of-scan without ever stating a size. */
export function createJpegWithoutFrameBytes(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x00, 0x00]);
}

function createWebpBytes(chunkFourCc: string, chunkData: Buffer): Buffer {
  const chunk = Buffer.alloc(8 + chunkData.length);
  chunk.write(chunkFourCc, 0, 'ascii');
  chunk.writeUInt32LE(chunkData.length, 4);
  chunkData.copy(chunk, 8);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(4 + chunk.length, 4);
  riff.write('WEBP', 8, 'ascii');
  return Buffer.concat([riff, chunk]);
}

/** A lossy (VP8) WebP: frame tag, start code, then 14-bit sides. */
export function createLossyWebpBytes(width: number, height: number): Buffer {
  const data = Buffer.alloc(10);
  data.set([0x9d, 0x01, 0x2a], 3);
  data.writeUInt16LE(width, 6);
  data.writeUInt16LE(height, 8);
  return createWebpBytes('VP8 ', data);
}

/** A lossless (VP8L) WebP: signature byte, then both sides minus one packed into 28 bits. */
export function createLosslessWebpBytes(width: number, height: number): Buffer {
  const data = Buffer.alloc(5);
  data.writeUInt8(0x2f, 0);
  data.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 1);
  return createWebpBytes('VP8L', data);
}

/** An extended (VP8X) WebP: flags, then the canvas sides minus one in 24 bits each. */
export function createExtendedWebpBytes(width: number, height: number): Buffer {
  const data = Buffer.alloc(10);
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  return createWebpBytes('VP8X', data);
}
