import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { hashContent } from './depsPlan';

/**
 * @description «Held back N secret-looking files» is said when the LIST changes, not on every submit: a project with `.pem` test fixtures
 * would repeat the same sixteen names before every run until the agent stopped reading the line. The main box remembers, per project, a hash
 * of the list it last said (`<cache>/held-back/<slug>.json`, mode 0600, no file names in it); a list that differs — a file added, one
 * removed, one opted in — is said again, and an empty one resets it, so the same file held back again later is news again.
 */

const noticeDirectoryName = 'held-back';
const noticeFileMode = 0o600;
const noticeDirectoryMode = 0o700;
const noticeSuffix = '.json';
const safeSlugPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const noticeSchema = z.looseObject({ key: z.string().min(1) });

function getNoticePath(cacheDir: string, slug: string): string | null {
  return safeSlugPattern.test(slug) ? path.join(cacheDir, noticeDirectoryName, `${slug}${noticeSuffix}`) : null;
}

function readLastKey(noticePath: string): string | null {
  try {
    const parsed = noticeSchema.safeParse(JSON.parse(fs.readFileSync(noticePath, 'utf8')));
    return parsed.success ? parsed.data.key : null;
  } catch {
    return null;
  }
}

/**
 * @description Remember `files` (the held-back and the sent-on-request ones of this submit) as the list last seen, and say whether it is another list
 * than the one remembered — that is, whether the held-back files are news. Never fails the submit: a cache that cannot be written only means the
 * line is said again next time.
 */
export function recordHeldBackFiles(cacheDir: string, slug: string, files: readonly string[]): boolean {
  const noticePath = getNoticePath(cacheDir, slug);
  if (noticePath === null) return true;
  const lastKey = readLastKey(noticePath);
  if (files.length === 0) {
    if (lastKey !== null) fs.rmSync(noticePath, { force: true });
    return false;
  }
  const key = hashContent(Buffer.from([...files].sort().join('\n')));
  if (key === lastKey) return false;
  try {
    fs.mkdirSync(path.dirname(noticePath), { recursive: true, mode: noticeDirectoryMode });
    fs.writeFileSync(noticePath, JSON.stringify({ key }), { mode: noticeFileMode });
  } catch {
    /* an unwritable cache only costs the next submit the same line */
  }
  return true;
}
