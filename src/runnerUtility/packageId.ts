import { createHash } from 'crypto';
import * as fs from 'fs';
import { gunzipSync } from 'zlib';

/**
 * @description The id of a hub package: the first 16 hex digits of the sha256 of the tar BEFORE compression (`runners/hubPackage.ts`
 * computes it the same way). Builtins only: the very first step of a pairing, which has no dependencies installed, checks the archive it
 * downloaded against the id the hub announced with it.
 */

const packageIdLength = 16;
const packageIdPattern = /^[0-9a-f]{16}$/;

export function getPackageIdOfArchive(archive: Buffer): string {
  return createHash('sha256').update(gunzipSync(archive)).digest('hex').slice(0, packageIdLength);
}

export function checkIsPackageId(value: string): boolean {
  return packageIdPattern.test(value);
}

/** @description Does the archive file hold the package `expectedId` names? An unreadable or damaged archive does not. */
export function checkArchiveHasId(archivePath: string, expectedId: string): boolean {
  try {
    return checkIsPackageId(expectedId) && getPackageIdOfArchive(fs.readFileSync(archivePath)) === expectedId;
  } catch {
    return false;
  }
}
