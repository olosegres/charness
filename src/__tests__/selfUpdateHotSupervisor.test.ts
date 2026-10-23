/**
 * @description Coverage for `src/selfUpdate/hotSupervisor.ts` — the contract between the hot supervisor and its worker: what the
 * supervisor records about itself (identity + the hash of every `dist/` module it loaded), how a worker finds that a loaded
 * module has changed, and that the re-exec signal goes only to the SAME process — never to a pid that has been reused.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  collectLoadedDistModules,
  getHotSupervisorRecordPath,
  getStaleSupervisorModules,
  hashFile,
  readHotSupervisorRecord,
  requestSupervisorReexec,
  writeHotSupervisorRecord,
  type HotSupervisorRecord,
} from '../selfUpdate/hotSupervisor';

let root: string;
let distDirectory: string;

function writeDist(relativePath: string, content: string): string {
  const filePath = path.join(distDirectory, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-hotsup-'));
  distDirectory = path.join(root, 'dist');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('what the supervisor records', () => {
  test('every loaded module under dist, relative with forward slashes, hashed, sorted; modules elsewhere and non-js are left out', () => {
    const cli = writeDist('cli.js', 'cli v1');
    const hot = writeDist('cli/hot.js', 'hot v1');
    const outside = path.join(root, 'node_modules', 'zod', 'index.js');
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, 'zod');
    const modules = collectLoadedDistModules(distDirectory, [hot, cli, outside, path.join(distDirectory, 'cli.js.map'), `${distDirectory}-other/x.js`]);
    assert.deepEqual(modules, [
      { path: 'cli.js', sha256: hashFile(cli) },
      { path: 'cli/hot.js', sha256: hashFile(hot) },
    ]);
  });

  test('the record round-trips through the data dir and is private to the owner', () => {
    const record: HotSupervisorRecord = { pid: 4242, startToken: 'tok-1', canReexec: true, modules: [{ path: 'cli.js', sha256: 'abc' }] };
    writeHotSupervisorRecord(root, record);
    assert.deepEqual(readHotSupervisorRecord(root), record);
    assert.equal(fs.statSync(getHotSupervisorRecordPath(root)).mode & 0o777, 0o600);
  });

  test('no file, garbage, or a wrong shape reads as "no record" — a supervisor that predates re-exec', () => {
    assert.equal(readHotSupervisorRecord(root), null);
    fs.writeFileSync(getHotSupervisorRecordPath(root), 'not json');
    assert.equal(readHotSupervisorRecord(root), null);
    fs.writeFileSync(getHotSupervisorRecordPath(root), JSON.stringify({ pid: 'x' }));
    assert.equal(readHotSupervisorRecord(root), null);
  });
});

describe('a worker comparing the record with dist', () => {
  test('nothing changed → nothing stale; a changed or missing module is named', () => {
    const cli = writeDist('cli.js', 'cli v1');
    const hot = writeDist('cli/hot.js', 'hot v1');
    const record: HotSupervisorRecord = { pid: 1, startToken: 't', canReexec: true, modules: collectLoadedDistModules(distDirectory, [cli, hot]) };
    assert.deepEqual(getStaleSupervisorModules(record, distDirectory), []);
    fs.writeFileSync(hot, 'hot v2');
    assert.deepEqual(getStaleSupervisorModules(record, distDirectory), ['cli/hot.js']);
    fs.rmSync(cli);
    assert.deepEqual(getStaleSupervisorModules(record, distDirectory), ['cli.js', 'cli/hot.js']);
  });

  test('a module the supervisor did NOT load changing is no reason to replace it', () => {
    const cli = writeDist('cli.js', 'cli v1');
    const record: HotSupervisorRecord = { pid: 1, startToken: 't', canReexec: true, modules: collectLoadedDistModules(distDirectory, [cli]) };
    writeDist('bot.js', 'a worker-only module');
    assert.deepEqual(getStaleSupervisorModules(record, distDirectory), []);
  });
});

describe('signalling the supervisor', () => {
  const record: HotSupervisorRecord = { pid: 4242, startToken: 'tok-1', canReexec: true, modules: [] };

  function createDeps(startToken: string | null): { deps: Parameters<typeof requestSupervisorReexec>[1]; kills: [number, string][] } {
    const kills: [number, string][] = [];
    return { deps: { getStartToken: () => startToken, kill: (pid, signal) => kills.push([pid, signal]) }, kills };
  }

  test('the same process (pid and start token) gets SIGUSR2', () => {
    const { deps, kills } = createDeps('tok-1');
    assert.equal(requestSupervisorReexec(record, deps), 'signaled');
    assert.deepEqual(kills, [[4242, 'SIGUSR2']]);
  });

  test('a pid that now belongs to a different process gets nothing', () => {
    const { deps, kills } = createDeps('tok-OTHER');
    assert.equal(requestSupervisorReexec(record, deps), 'differentProcess');
    assert.deepEqual(kills, []);
  });

  test('a pid that is gone gets nothing; neither does a supervisor that says it cannot re-execute', () => {
    const gone = createDeps(null);
    assert.equal(requestSupervisorReexec(record, gone.deps), 'gone');
    const cannot = createDeps('tok-1');
    assert.equal(requestSupervisorReexec({ ...record, canReexec: false }, cannot.deps), 'cannotReexec');
    assert.deepEqual([...gone.kills, ...cannot.kills], []);
  });
});
