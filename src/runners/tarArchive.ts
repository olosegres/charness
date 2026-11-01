/**
 * @description A minimal, DETERMINISTIC tar writer (ustar): the same entries always give the same bytes, so the hash of the archive is
 * a stable id of the package it carries (a system `tar` writes its own timestamps and ordering). Regular files only — a runner
 * extracts the archive with the `tar` of its machine, which creates the folders on the way.
 */

const blockSize = 512;
/** 2000-01-01: a fixed, plausible timestamp (GNU tar warns about a 1970 one). */
const fixedModifiedTimeSeconds = 946684800;
const maxNameLength = 100;
const maxPrefixLength = 155;
const checksumFieldOffset = 148;
const checksumFieldLength = 8;

export interface TarEntry {
  /** A relative path with `/` separators. */
  path: string;
  content: Buffer;
  /** `0o755` for something that runs, else `0o644`. */
  mode: number;
}

function writeText(header: Buffer, offset: number, length: number, text: string): void {
  header.write(text, offset, length, 'utf8');
}

/** An octal number, zero-padded to `length - 1` digits and ended by a NUL. */
function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  header.write(value.toString(8).padStart(length - 1, '0'), offset, length - 1, 'ascii');
}

/** @description The ustar `name` and `prefix` fields for `entryPath`, or `null` when no `/` splits it into pieces that fit. */
export function splitTarPath(entryPath: string): { name: string; prefix: string } | null {
  if (Buffer.byteLength(entryPath) <= maxNameLength) return { name: entryPath, prefix: '' };
  for (let slash = entryPath.indexOf('/'); slash !== -1; slash = entryPath.indexOf('/', slash + 1)) {
    const prefix = entryPath.slice(0, slash);
    const name = entryPath.slice(slash + 1);
    if (Buffer.byteLength(prefix) <= maxPrefixLength && Buffer.byteLength(name) <= maxNameLength) return { name, prefix };
  }
  return null;
}

function buildHeader(entry: TarEntry): Buffer {
  const split = splitTarPath(entry.path);
  if (split === null) throw new Error(`the path is too long for a tar header: ${entry.path}`);
  const header = Buffer.alloc(blockSize);
  writeText(header, 0, maxNameLength, split.name);
  writeOctal(header, 100, 8, entry.mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.content.length);
  writeOctal(header, 136, 12, fixedModifiedTimeSeconds);
  header.fill(0x20, checksumFieldOffset, checksumFieldOffset + checksumFieldLength);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  writeText(header, 345, maxPrefixLength, split.prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0'), checksumFieldOffset, 6, 'ascii');
  header[checksumFieldOffset + 6] = 0;
  header[checksumFieldOffset + 7] = 0x20;
  return header;
}

/** @description The archive of `entries`, in the order given, ended by the two empty blocks tar expects. */
export function createTarArchive(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(buildHeader(entry), entry.content);
    const remainder = entry.content.length % blockSize;
    if (remainder !== 0) parts.push(Buffer.alloc(blockSize - remainder));
  }
  parts.push(Buffer.alloc(blockSize * 2));
  return Buffer.concat(parts);
}
