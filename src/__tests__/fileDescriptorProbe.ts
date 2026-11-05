/**
 * @description How a test proves that a descriptor it saw OPEN was released since. A number alone cannot prove it: the process hands out the lowest
 * free descriptor number to ANY open, so once the owner has closed `fd`, a file opened by anything else in the process (a module the loader reads,
 * the test runner's own bookkeeping) can take the same number before the test looks — `fstat(fd)` then succeeds and "still open" is a lie about
 * somebody else's file (Windows' CRT does the same; a Windows run of the file-send suite met it). So the descriptor is captured WITH the identity
 * (`dev`, `ino`) of the object it named while it was open, and "released" means: the number is gone, or it now names another object.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';

/** A descriptor as it was when the test saw it open: its number and the object (file or folder) it named. */
export interface CapturedDescriptor {
  fd: number;
  dev: bigint;
  ino: bigint;
}

/** @description Capture an OPEN descriptor with the identity of the object it names. Throws when the descriptor is not open. */
export function captureDescriptor(fileDescriptor: number): CapturedDescriptor {
  const { dev, ino } = fs.fstatSync(fileDescriptor, { bigint: true });
  return { fd: fileDescriptor, dev, ino };
}

/** Does the number still name the captured object? A number that cannot be asked about (closed, or somebody's non-file) does not. */
function checkIsStillTheCapturedObject(captured: CapturedDescriptor): boolean {
  try {
    const { dev, ino } = fs.fstatSync(captured.fd, { bigint: true });
    return dev === captured.dev && ino === captured.ino;
  } catch {
    return false;
  }
}

/** @description The captured descriptor was released: its number is closed, or has since been given to another object. */
export function assertDescriptorReleased(captured: CapturedDescriptor, message?: string): void {
  assert.equal(checkIsStillTheCapturedObject(captured), false, message ?? `descriptor ${captured.fd} still names the object it was handed out for (dev ${captured.dev}, ino ${captured.ino}): it leaked`);
}

/** @description The captured descriptor is still open on the object it was handed out for. */
export function assertDescriptorOpen(captured: CapturedDescriptor, message?: string): void {
  assert.equal(checkIsStillTheCapturedObject(captured), true, message ?? `descriptor ${captured.fd} no longer names the object it was handed out for (dev ${captured.dev}, ino ${captured.ino}): it was closed early`);
}
