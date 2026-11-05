/**
 * @description `fileDescriptorProbe.ts`, the way the file-send suites prove a descriptor was released. A closed number is released; a number still
 * open on the object it was handed out for is a leak; and — the case a bare `fstat(fd)` → `EBADF` check got wrong on a Windows run — a number
 * that was closed and then given to ANOTHER file is released too, however open that other file is.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assertDescriptorOpen, assertDescriptorReleased, captureDescriptor } from './fileDescriptorProbe';

let workDir = '';
let openedDescriptors: number[] = [];

function openFile(name: string): number {
  const filePath = path.join(workDir, name);
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, name);
  const fileDescriptor = fs.openSync(filePath, 'r');
  openedDescriptors.push(fileDescriptor);
  return fileDescriptor;
}

function closeFile(fileDescriptor: number): void {
  fs.closeSync(fileDescriptor);
  openedDescriptors = openedDescriptors.filter((opened) => opened !== fileDescriptor);
}

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'descriptorProbe-'));
  openedDescriptors = [];
});
afterEach(() => {
  for (const opened of openedDescriptors) fs.closeSync(opened);
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('the descriptor probe', () => {
  it('calls a descriptor that is still open on its file open — and not released: a leak is caught', () => {
    const captured = captureDescriptor(openFile('leaked.txt'));
    assertDescriptorOpen(captured);
    assert.throws(() => assertDescriptorReleased(captured), /it leaked/);
  });

  it('calls a closed descriptor released — and not open', () => {
    const fileDescriptor = openFile('closed.txt');
    const captured = captureDescriptor(fileDescriptor);
    closeFile(fileDescriptor);
    assertDescriptorReleased(captured);
    assert.throws(() => assertDescriptorOpen(captured), /closed early/);
  });

  it('calls a descriptor released when its number was closed and then given to ANOTHER file — the bare `fstat` check said "still open" there', () => {
    const fileDescriptor = openFile('first.txt');
    const captured = captureDescriptor(fileDescriptor);
    closeFile(fileDescriptor);
    const reused = openFile('second.txt');
    assert.equal(reused, captured.fd, 'precondition: the process gave the freed number to the next open');
    assert.doesNotThrow(() => fs.fstatSync(captured.fd), 'precondition: the bare `fstat` check would see an open descriptor here');
    assertDescriptorReleased(captured);
    assert.throws(() => assertDescriptorOpen(captured), /closed early/);
  });

  it('calls a number that was reopened on the SAME file open — that is a leak the probe cannot tell from the original', () => {
    const fileDescriptor = openFile('same.txt');
    const captured = captureDescriptor(fileDescriptor);
    closeFile(fileDescriptor);
    assert.equal(openFile('same.txt'), captured.fd, 'precondition: the process gave the freed number to the next open');
    assert.throws(() => assertDescriptorReleased(captured), /it leaked/);
  });

  it('refuses to capture a descriptor that is not open', () => {
    const fileDescriptor = openFile('gone.txt');
    closeFile(fileDescriptor);
    assert.throws(() => captureDescriptor(fileDescriptor), { code: 'EBADF' });
  });
});
