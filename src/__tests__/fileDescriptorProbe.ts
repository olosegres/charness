/**
 * @description How a test proves that a descriptor it saw OPEN was released since. A number alone cannot prove it: the process hands out the lowest
 * free descriptor number to ANY open, so once the owner has closed `fd`, a file opened by anything else in the process (a module the loader reads,
 * the test runner's own bookkeeping) can take the same number before the test looks — `fstat(fd)` then succeeds and "still open" is a lie about
 * somebody else's file (Windows' CRT does the same; a Windows run of the file-send suite met it). So the descriptor is captured WITH the identity
 * (`dev`, `ino`) of the object it named while it was open, and the number is then in one of three states: `closed` (the OS says `EBADF`),
 * `reused` (it names another object) or `same` (it still names the captured object — a leak, or an early close that did not happen).
 * Anything else the OS says (`EIO`, a volume that went away) proves nothing about the descriptor and is thrown, not counted as a release.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';

/** The identity of the object a descriptor names: the device (volume) and the file's number on it. */
export interface DescriptorIdentity {
  dev: bigint;
  ino: bigint;
}

/** A descriptor as it was when the test saw it open: its number and the object (file or folder) it named. */
export interface CapturedDescriptor extends DescriptorIdentity {
  fd: number;
}

/** What the number names now, or throws as `fs.fstatSync` does. The seam that lets a test drive every state without depending on the OS reusing a number. */
export type DescriptorInspector = (fileDescriptor: number) => DescriptorIdentity;

export type DescriptorState = 'closed' | 'reused' | 'same';

const badDescriptorCode = 'EBADF';

/** @description The OS's own answer: the identity (bigint, so a file index above 2^53 survives) of the object the number names. */
export const inspectNativeDescriptor: DescriptorInspector = (fileDescriptor) => {
  const { dev, ino } = fs.fstatSync(fileDescriptor, { bigint: true });
  return { dev, ino };
};

/** @description Capture an OPEN descriptor with the identity of the object it names. Throws when the descriptor is not open. */
export function captureDescriptor(fileDescriptor: number, inspect: DescriptorInspector = inspectNativeDescriptor): CapturedDescriptor {
  return { fd: fileDescriptor, ...inspect(fileDescriptor) };
}

/** @description What the captured number is now. Only `EBADF` means closed; any other failure to inspect it is rethrown. */
export function getDescriptorState(captured: CapturedDescriptor, inspect: DescriptorInspector = inspectNativeDescriptor): DescriptorState {
  try {
    const { dev, ino } = inspect(captured.fd);
    return dev === captured.dev && ino === captured.ino ? 'same' : 'reused';
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === badDescriptorCode) return 'closed';
    throw error;
  }
}

/** @description The captured descriptor was released: its number is closed, or has since been given to another object. */
export function assertDescriptorReleased(captured: CapturedDescriptor, message?: string, inspect: DescriptorInspector = inspectNativeDescriptor): void {
  assert.notEqual(getDescriptorState(captured, inspect), 'same', message ?? `descriptor ${captured.fd} still names the object it was handed out for (dev ${captured.dev}, ino ${captured.ino}): it leaked`);
}

/** @description The captured descriptor is still open on the object it was handed out for. */
export function assertDescriptorOpen(captured: CapturedDescriptor, message?: string, inspect: DescriptorInspector = inspectNativeDescriptor): void {
  assert.equal(getDescriptorState(captured, inspect), 'same', message ?? `descriptor ${captured.fd} no longer names the object it was handed out for (dev ${captured.dev}, ino ${captured.ino}): it was closed early`);
}
