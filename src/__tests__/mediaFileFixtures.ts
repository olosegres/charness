import { createPngBytes } from './imageFixtures';

/**
 * @description Whole media files for the tests of files shown on a Jira issue (not a test file): a PNG with its end
 * chunk, and an MP4 built box by box — `ftyp`, a movie header whose tracks state their codec and size, the media data.
 * No pixel or sample data anyone could play; just what `connectors/jira/outgoingFileCheck.ts` reads.
 */

/** The IEND chunk a whole PNG ends with: its zero length, its type and its CRC. */
export const pngEndChunk = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

/** A whole PNG stating `width` × `height`. */
export function createCompletePngBytes(width: number, height: number): Buffer {
  return Buffer.concat([createPngBytes(width, height), pngEndChunk]);
}

/** An MP4 box: its size, its type, its payload. */
export function createMp4Box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
}

/** A full box: its version and flags, then `rest`. */
function createMp4FullBox(type: string, rest: Buffer): Buffer {
  return createMp4Box(type, Buffer.alloc(4), rest);
}

/** A visual sample entry of `codec` (`avc1` is H.264) stating `width` × `height`. */
export function createMp4SampleEntry(codec: string, width: number, height: number): Buffer {
  const fields = Buffer.alloc(70);
  fields.writeUInt16BE(1, 6);
  fields.writeUInt16BE(width, 24);
  fields.writeUInt16BE(height, 26);
  return createMp4Box(codec, fields);
}

/** A track whose handler is `handlerType` (`vide`, `soun`) and whose first sample entry is `entry`. */
export function createMp4Track(handlerType: string, entry: Buffer): Buffer {
  const handler = Buffer.alloc(20);
  handler.write(handlerType, 4, 'latin1');
  const entryCount = Buffer.alloc(4);
  entryCount.writeUInt32BE(1, 0);
  const sampleDescriptions = createMp4FullBox('stsd', Buffer.concat([entryCount, entry]));
  return createMp4Box('trak', createMp4Box('mdia', createMp4FullBox('hdlr', handler), createMp4Box('minf', createMp4Box('stbl', sampleDescriptions))));
}

/** An MP4 file: `ftyp`, the movie header holding `tracks`, then `mediaBytes` of media data. */
export function createMp4Bytes(tracks: Buffer[], mediaBytes = 64): Buffer {
  return Buffer.concat([
    createMp4Box('ftyp', Buffer.from('isom\0\0\x02\0isomavc1', 'latin1')),
    createMp4Box('moov', ...tracks),
    createMp4Box('mdat', Buffer.alloc(mediaBytes, 7)),
  ]);
}

/** An H.264 recording of `width` × `height`: what Jira plays in a comment. */
export function createH264Mp4Bytes(width = 320, height = 240): Buffer {
  return createMp4Bytes([createMp4Track('vide', createMp4SampleEntry('avc1', width, height))], 256);
}
