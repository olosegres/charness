import * as path from 'path';
import { getImageDimensions, type ImageByteReader, type ImageDimensions } from '../../utils/imageDimensions';

/**
 * @description What a file the agent sends to a Jira issue is, read from the file itself before anything is uploaded
 * (`outgoingFiles.ts`). Jira shows an image in a comment and plays a video there only when the file is what it claims:
 *
 *  - an image (`.png`, `.jpg` / `.jpeg`, `.gif`, `.webp`) must hold that format, WHOLE — a PNG with its end chunk, a JPEG
 *    with its end marker, a GIF with its trailer, a WebP whose RIFF size is the file's — else the comment shows a broken
 *    picture: a partial or renamed file is refused;
 *  - an `.mp4` must be a complete MP4 (its boxes tile the file, its movie header is there) whose first video track is
 *    H.264 (`avc1` / `avc3`) — Jira plays nothing else in a comment, and a recording cut short shows a dead player. The
 *    boxes are read by position, so a file of any size costs a few small reads and its movie header;
 *  - anything else is a plain file: attached, and linked from the comment. A video in another container (`.mov`,
 *    `.webm`, …) is one too, with a note saying how to make it play.
 *
 * Pure over a positional byte reader, like `utils/imageDimensions.ts`: a buffer in a test, an open descriptor in use.
 */

export type JiraOutgoingFileKind = 'image' | 'video' | 'file';

export type JiraOutgoingFileCheck =
  | {
    ok: true;
    kind: JiraOutgoingFileKind;
    mimeType: string;
    /** The size to show an image or a video at, as the file states it; `null` when it does not say. */
    size: ImageDimensions | null;
    /** Said to the agent with the result: why a file that looks like a video is only linked. */
    note?: string;
  }
  | { ok: false; error: string };

const imageTypesByExtension: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
const imageKindNames: Readonly<Record<string, string>> = {
  'image/png': 'a PNG',
  'image/jpeg': 'a JPEG',
  'image/gif': 'a GIF',
  'image/webp': 'a WebP',
};
const mp4Extension = '.mp4';
const mp4MimeType = 'video/mp4';
/** Video containers Jira does not play in a comment: attached and linked, with a note. */
const otherVideoExtensions: ReadonlySet<string> = new Set(['.mov', '.webm', '.mkv', '.avi', '.m4v', '.wmv', '.flv']);
/** A plain file's type for the upload; Jira works out the rest itself. */
const fileTypesByExtension: Readonly<Record<string, string>> = {
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};
const defaultFileType = 'application/octet-stream';
/** How to make a video Jira plays — the agent's next step when one is refused or only linked. */
export const jiraVideoConvertHint = 'ffmpeg -i in.webm -c:v libx264 -pix_fmt yuv420p -movflags +faststart out.mp4';

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** The IEND chunk a complete PNG ends with: its zero length, its type and its CRC. */
const pngEnd = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const jpegStart = Buffer.from([0xff, 0xd8, 0xff]);
const jpegEnd = Buffer.from([0xff, 0xd9]);
/** A JPEG may carry zero padding after its end marker: this much of its tail is looked through. */
const jpegTailBytes = 1024;
const gifSignatures = ['GIF87a', 'GIF89a'];
const gifTrailer = 0x3b;
const gifHeaderLength = 10;
const webpHeaderLength = 12;
/** RIFF's own header (`RIFF` and the size field) is not counted in its size field. */
const riffHeaderBytes = 8;

/** One MP4 box header: its type, where its payload starts and where the box ends. */
interface Mp4Box {
  type: string;
  payloadStart: number;
  end: number;
}

const mp4BoxHeaderBytes = 8;
const mp4LargeBoxHeaderBytes = 16;
/** A file of more top-level boxes than this is no recording: it is not walked to its end. */
const mp4MaxTopLevelBoxes = 10_000;
/** The movie header is read whole; one bigger than this is not checked (a real one is kilobytes, a long recording's a few megabytes). */
const mp4MaxMovieHeaderBytes = 64 * 1024 * 1024;
const h264SampleEntryTypes: ReadonlySet<string> = new Set(['avc1', 'avc3']);
/** Where the width and height sit in a visual sample entry: after its 8-byte header, 6 reserved, 2 index, 16 pre-defined and reserved bytes. */
const sampleEntryWidthOffset = 32;
const sampleEntryHeightOffset = 34;
/** The `hdlr` payload: version and flags, pre-defined, then the handler type. */
const handlerTypeOffset = 8;
/** The `stsd` payload: version and flags, the entry count, then the first entry. */
const firstSampleEntryOffset = 8;

/** What an image file holds, by its first bytes; `null` when none of the four. */
function getImageContentType(readBytes: ImageByteReader): string | null {
  const head = readBytes(0, webpHeaderLength);
  if (head.subarray(0, pngSignature.length).equals(pngSignature)) return 'image/png';
  if (head.subarray(0, jpegStart.length).equals(jpegStart)) return 'image/jpeg';
  if (gifSignatures.includes(head.toString('latin1', 0, 6))) return 'image/gif';
  if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Is the image whole: does it end the way its format ends? */
function checkIsImageComplete(mimeType: string, readBytes: ImageByteReader, sizeBytes: number): boolean {
  switch (mimeType) {
    case 'image/png':
      return sizeBytes >= pngSignature.length + pngEnd.length && readBytes(sizeBytes - pngEnd.length, pngEnd.length).equals(pngEnd);
    case 'image/jpeg': {
      const tailStart = Math.max(0, sizeBytes - jpegTailBytes);
      const tail = readBytes(tailStart, sizeBytes - tailStart);
      let end = tail.length;
      while (end > 0 && tail[end - 1] === 0) end -= 1;
      return end >= jpegEnd.length && tail.subarray(end - jpegEnd.length, end).equals(jpegEnd);
    }
    case 'image/gif':
      return sizeBytes > gifHeaderLength && readBytes(sizeBytes - 1, 1)[0] === gifTrailer;
    case 'image/webp': {
      const riffSize = readBytes(4, 4);
      return riffSize.length === 4 && riffSize.readUInt32LE(0) + riffHeaderBytes === sizeBytes;
    }
    default:
      return false;
  }
}

/** A GIF's logical screen size: two little-endian words after its signature. */
function getGifDimensions(readBytes: ImageByteReader): ImageDimensions | null {
  const head = readBytes(0, gifHeaderLength);
  if (head.length < gifHeaderLength) return null;
  const width = head.readUInt16LE(6);
  const height = head.readUInt16LE(8);
  return width > 0 && height > 0 ? { width, height } : null;
}

function checkImage(name: string, mimeType: string, readBytes: ImageByteReader, sizeBytes: number): JiraOutgoingFileCheck {
  const contentType = getImageContentType(readBytes);
  if (contentType === null) return { ok: false, error: `${name} is not ${imageKindNames[mimeType]} image — a renamed file?` };
  if (contentType !== mimeType) {
    return { ok: false, error: `${name} holds ${imageKindNames[contentType]} image, which its name does not say — a renamed file? Give it the right extension.` };
  }
  if (!checkIsImageComplete(mimeType, readBytes, sizeBytes)) {
    return { ok: false, error: `${name} is not a complete ${imageKindNames[mimeType].slice(2)} image — a partial file? Save it again whole.` };
  }
  const size = mimeType === 'image/gif' ? getGifDimensions(readBytes) : getImageDimensions(readBytes);
  return { ok: true, kind: 'image', mimeType, size };
}

/** The boxes of `buffer` between `start` and `end`, each fully inside them; `null` when one runs past the end. */
function listBoxes(buffer: Buffer, start: number, end: number): Mp4Box[] | null {
  const boxes: Mp4Box[] = [];
  for (let position = start; position < end;) {
    if (end - position < mp4BoxHeaderBytes) return null;
    let boxSize = buffer.readUInt32BE(position);
    let headerBytes = mp4BoxHeaderBytes;
    if (boxSize === 1) {
      if (end - position < mp4LargeBoxHeaderBytes) return null;
      boxSize = Number(buffer.readBigUInt64BE(position + mp4BoxHeaderBytes));
      headerBytes = mp4LargeBoxHeaderBytes;
    } else if (boxSize === 0) {
      boxSize = end - position;
    }
    if (boxSize < headerBytes || position + boxSize > end) return null;
    boxes.push({ type: buffer.toString('latin1', position + 4, position + 8), payloadStart: position + headerBytes, end: position + boxSize });
    position += boxSize;
  }
  return boxes;
}

/** The child box of `type` under `parent`, or `null`. */
function findChildBox(buffer: Buffer, parent: Mp4Box, type: string): Mp4Box | null {
  return listBoxes(buffer, parent.payloadStart, parent.end)?.find((box) => box.type === type) ?? null;
}

/** The first video track's sample entry: its codec type and the size it states; `null` when the movie has no video track. */
function getVideoSampleEntry(movie: Buffer): { codec: string; size: ImageDimensions | null } | null {
  for (const track of listBoxes(movie, 0, movie.length)?.filter((box) => box.type === 'trak') ?? []) {
    const media = findChildBox(movie, track, 'mdia');
    const handler = media && findChildBox(movie, media, 'hdlr');
    if (!media || !handler || handler.end - handler.payloadStart < handlerTypeOffset + 4) continue;
    if (movie.toString('latin1', handler.payloadStart + handlerTypeOffset, handler.payloadStart + handlerTypeOffset + 4) !== 'vide') continue;
    const mediaInfo = findChildBox(movie, media, 'minf');
    const sampleTable = mediaInfo && findChildBox(movie, mediaInfo, 'stbl');
    const descriptions = sampleTable && findChildBox(movie, sampleTable, 'stsd');
    if (!descriptions) continue;
    const entries = listBoxes(movie, descriptions.payloadStart + firstSampleEntryOffset, descriptions.end);
    const entry = entries?.[0];
    if (!entry) continue;
    const entryStart = entry.payloadStart - mp4BoxHeaderBytes;
    const hasSize = entry.end - entryStart >= sampleEntryHeightOffset + 2;
    const width = hasSize ? movie.readUInt16BE(entryStart + sampleEntryWidthOffset) : 0;
    const height = hasSize ? movie.readUInt16BE(entryStart + sampleEntryHeightOffset) : 0;
    return { codec: entry.type, size: width > 0 && height > 0 ? { width, height } : null };
  }
  return null;
}

function checkMp4(name: string, readBytes: ImageByteReader, sizeBytes: number): JiraOutgoingFileCheck {
  const partialError = `${name} is not a complete MP4 — a recording that was cut short? Record or convert it again.`;
  let movie: { start: number; end: number } | null = null;
  let hasFileType = false;
  let boxCount = 0;
  for (let position = 0; position < sizeBytes; boxCount += 1) {
    if (boxCount >= mp4MaxTopLevelBoxes) return { ok: false, error: `${name} is not an MP4 recording (too many boxes).` };
    const header = readBytes(position, mp4LargeBoxHeaderBytes);
    if (header.length < mp4BoxHeaderBytes) return { ok: false, error: partialError };
    let boxSize = header.readUInt32BE(0);
    let headerBytes = mp4BoxHeaderBytes;
    if (boxSize === 1) {
      if (header.length < mp4LargeBoxHeaderBytes) return { ok: false, error: partialError };
      boxSize = Number(header.readBigUInt64BE(mp4BoxHeaderBytes));
      headerBytes = mp4LargeBoxHeaderBytes;
    } else if (boxSize === 0) {
      boxSize = sizeBytes - position;
    }
    const type = header.toString('latin1', 4, 8);
    if (boxCount === 0 && type !== 'ftyp') return { ok: false, error: `${name} is not an MP4 (it does not start with an ftyp box) — a renamed file?` };
    if (boxSize < headerBytes || position + boxSize > sizeBytes) return { ok: false, error: partialError };
    if (type === 'ftyp') hasFileType = true;
    if (type === 'moov') movie = { start: position + headerBytes, end: position + boxSize };
    position += boxSize;
  }
  if (!hasFileType) return { ok: false, error: `${name} is not an MP4 — a renamed file?` };
  if (!movie) return { ok: false, error: `${name} has no movie header (moov) — a recording that was not finished? Record or convert it again.` };
  if (movie.end - movie.start > mp4MaxMovieHeaderBytes) return { ok: false, error: `${name} has a movie header too big to check; convert it: ${jiraVideoConvertHint}` };
  const video = getVideoSampleEntry(readBytes(movie.start, movie.end - movie.start));
  if (!video) return { ok: false, error: `${name} holds no video track Jira can read.` };
  if (!h264SampleEntryTypes.has(video.codec)) {
    return { ok: false, error: `${name} holds ${video.codec.trim() || 'unknown'} video, not H.264 — Jira plays only H.264 in an .mp4. Convert it: ${jiraVideoConvertHint}` };
  }
  return { ok: true, kind: 'video', mimeType: mp4MimeType, size: video.size };
}

/**
 * @description What file `name` (its own base name) of `sizeBytes` bytes is, and whether it may be shown: an image or an
 * H.264 `.mp4` that is whole, or a plain file. A refusal names the file and the fix; nothing should be uploaded then.
 */
export function checkJiraOutgoingFile(name: string, sizeBytes: number, readBytes: ImageByteReader): JiraOutgoingFileCheck {
  const extension = path.extname(name).toLowerCase();
  try {
    const imageType = imageTypesByExtension[extension];
    if (imageType !== undefined) return checkImage(name, imageType, readBytes, sizeBytes);
    if (extension === mp4Extension) return checkMp4(name, readBytes, sizeBytes);
  } catch (error) {
    return { ok: false, error: `${name} could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  const mimeType = fileTypesByExtension[extension] ?? defaultFileType;
  return otherVideoExtensions.has(extension)
    ? { ok: true, kind: 'file', mimeType, size: null, note: `${name} is linked, not played: Jira plays only an H.264 .mp4 in a comment (${jiraVideoConvertHint})` }
    : { ok: true, kind: 'file', mimeType, size: null };
}
