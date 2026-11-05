/**
 * @description `fileDescriptorProbe.ts`, the way the file-send suites prove a descriptor was released. Its three states — the number is closed
 * (`EBADF`), was given to ANOTHER object (a bare `fstat` check called that «still open» on a Windows run), or still names the captured object
 * (a leak) — are driven with a controlled inspector, so no case depends on the OS handing a freed number to the next open (a loader or runner
 * thread may take it first). A failure to inspect that is not `EBADF` is thrown, never counted as a release. The native cases use the real
 * `fstat` on descriptors that stay open, or accept either outcome of a close; they run on Linux, macOS and Windows (the file-send workflow).
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  assertDescriptorOpen,
  assertDescriptorReleased,
  captureDescriptor,
  getDescriptorState,
  type CapturedDescriptor,
  type DescriptorIdentity,
  type DescriptorInspector,
} from './fileDescriptorProbe';

const capturedFile: CapturedDescriptor = { fd: 7, dev: 1n, ino: 42n };

function inspectAs(identity: DescriptorIdentity): DescriptorInspector {
  return () => identity;
}

function inspectFailingWith(error: Error): DescriptorInspector {
  return () => {
    throw error;
  };
}

function createErrnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

describe('the descriptor probe, driven with controlled stat results', () => {
  it('a number the OS calls EBADF is closed: released, and not open', () => {
    const inspect = inspectFailingWith(createErrnoError('EBADF'));
    assert.equal(getDescriptorState(capturedFile, inspect), 'closed');
    assertDescriptorReleased(capturedFile, undefined, inspect);
    assert.throws(() => assertDescriptorOpen(capturedFile, undefined, inspect), /closed early/);
  });

  it('a number that now names ANOTHER file is released too — however open that file is; a different ino or a different device both count', () => {
    for (const other of [{ dev: 1n, ino: 43n }, { dev: 2n, ino: 42n }]) {
      const inspect = inspectAs(other);
      assert.equal(getDescriptorState(capturedFile, inspect), 'reused', `dev ${other.dev}, ino ${other.ino}`);
      assertDescriptorReleased(capturedFile, undefined, inspect);
      assert.throws(() => assertDescriptorOpen(capturedFile, undefined, inspect), /closed early/);
    }
  });

  it('a number that still names the captured file is a leak: not released, and open — the negative control of the whole probe', () => {
    const inspect = inspectAs({ dev: capturedFile.dev, ino: capturedFile.ino });
    assert.equal(getDescriptorState(capturedFile, inspect), 'same');
    assertDescriptorOpen(capturedFile, undefined, inspect);
    assert.throws(() => assertDescriptorReleased(capturedFile, undefined, inspect), /it leaked/);
  });

  it('asks the OS about the captured number, and the given message wins over the default one', () => {
    const asked: number[] = [];
    const inspect: DescriptorInspector = (fileDescriptor) => {
      asked.push(fileDescriptor);
      return { dev: capturedFile.dev, ino: capturedFile.ino };
    };
    assert.throws(() => assertDescriptorReleased(capturedFile, 'the sender must have closed it', inspect), /the sender must have closed it/);
    assert.deepEqual(asked, [capturedFile.fd]);
  });

  it('a failure to inspect that is not EBADF proves nothing about the descriptor: it is thrown, in a release check and in an open check, with an errno or without', () => {
    for (const failure of [createErrnoError('EIO'), createErrnoError('ENOTSUP'), new Error('boom')]) {
      const inspect = inspectFailingWith(failure);
      assert.throws(() => getDescriptorState(capturedFile, inspect), (thrown) => thrown === failure);
      assert.throws(() => assertDescriptorReleased(capturedFile, undefined, inspect), (thrown) => thrown === failure);
      assert.throws(() => assertDescriptorOpen(capturedFile, undefined, inspect), (thrown) => thrown === failure);
    }
  });

  it('captures the number with the identity the inspector reports, and refuses a descriptor that is not open', () => {
    assert.deepEqual(captureDescriptor(9, inspectAs({ dev: 5n, ino: 6n })), { fd: 9, dev: 5n, ino: 6n });
    assert.throws(() => captureDescriptor(9, inspectFailingWith(createErrnoError('EBADF'))), { code: 'EBADF' });
  });
});

describe('the descriptor probe on the real OS', () => {
  let workDir = '';
  let heldDescriptors: number[] = [];

  function openFile(name: string): number {
    const filePath = path.join(workDir, name);
    fs.writeFileSync(filePath, name);
    const fileDescriptor = fs.openSync(filePath, 'r');
    heldDescriptors.push(fileDescriptor);
    return fileDescriptor;
  }

  function closeFile(fileDescriptor: number): void {
    fs.closeSync(fileDescriptor);
    heldDescriptors = heldDescriptors.filter((held) => held !== fileDescriptor);
  }

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'descriptorProbe-'));
    heldDescriptors = [];
  });
  afterEach(() => {
    for (const held of heldDescriptors) fs.closeSync(held);
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('a descriptor that is held open is the captured file (open, never released) — the OS reports a stable volume and file number for it', () => {
    const leaked = captureDescriptor(openFile('leaked.txt'));
    const other = captureDescriptor(openFile('other.txt'));
    assert.notDeepEqual([leaked.dev, leaked.ino], [other.dev, other.ino], 'two files are two identities');
    assert.equal(getDescriptorState(leaked), 'same');
    assertDescriptorOpen(leaked);
    assert.throws(() => assertDescriptorReleased(leaked), /it leaked/);
  });

  it('a descriptor that was closed is released and no longer open — whether its number is free or already someone else\'s', () => {
    const fileDescriptor = openFile('closed.txt');
    const captured = captureDescriptor(fileDescriptor);
    closeFile(fileDescriptor);
    assert.notEqual(getDescriptorState(captured), 'same');
    assertDescriptorReleased(captured);
    assert.throws(() => assertDescriptorOpen(captured), /closed early/);
  });
});
