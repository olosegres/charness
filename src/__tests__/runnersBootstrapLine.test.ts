/**
 * @description `runners/bootstrapLine.ts`: the one `sh` line the operator pastes on the runner machine. It is run here by a real `sh`
 * with a stand-in `ssh` that serves a package: the key and the pinned host key reach ssh as files, ssh is called with strict host key
 * checking and nothing else to log in with, the package is unpacked, the runner utility is handed the code — and the temp folder is gone.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { gzipSync } from 'zlib';
import { buildBootstrapLine } from '../runners/bootstrapLine';
import { formatGateAnswerHead } from '../runners/gateProtocol';
import { encodePairCode } from '../runners/pairCode';
import { createTarArchive } from '../runners/tarArchive';
import { createPairCodePayload } from './runnersTestKit';

let workDir = '';

/** A stand-in `ssh` that records what it was given and serves the file `answer.bin`. */
function installStubSsh(binDir: string): void {
  fs.mkdirSync(binDir, { recursive: true });
  const script = [
    '#!/bin/sh',
    `echo "$@" > "${workDir}/ssh.args"`,
    'while [ $# -gt 0 ]; do',
    '  case "$1" in',
    `    -i) cp "$2" "${workDir}/key.copy" ;;`,
    `    -o) case "$2" in UserKnownHostsFile=*) cp "\${2#UserKnownHostsFile=}" "${workDir}/known_hosts.copy" ;; esac ;;`,
    '  esac',
    '  shift',
    'done',
    `cat "${workDir}/answer.bin"`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(binDir, 'ssh'), script, { mode: 0o755 });
}

/** What the hub's `bootstrap` sends: whatever its shell printed first (`noise`), then the gate's marker and the archive. */
function createBootstrapAnswer(noise: string = ''): Buffer {
  const runnerCli = 'console.log("RUNNER_CLI " + process.argv.slice(2).join(" "));\n';
  const archive = gzipSync(createTarArchive([{ path: 'dist/runnerUtility/runnerCli.js', content: Buffer.from(runnerCli), mode: 0o644 }]));
  const answer = Buffer.concat([Buffer.from(noise), Buffer.from(formatGateAnswerHead('bootstrap', { id: '0123456789abcdef' })), archive]);
  fs.writeFileSync(path.join(workDir, 'answer.bin'), answer);
  return answer;
}

function runLine(payload = createPairCodePayload()): ReturnType<typeof spawnSync> {
  return spawnSync('sh', ['-c', buildBootstrapLine(payload)], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(workDir, 'bin')}:${process.env.PATH}`, TMPDIR: path.join(workDir, 'tmp') },
  });
}

describe('bootstrap line', () => {
  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-'));
    fs.mkdirSync(path.join(workDir, 'tmp'));
  });
  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('is one line of `sh -c` with the code in it, and the script is valid sh', () => {
    const payload = createPairCodePayload();
    const line = buildBootstrapLine(payload);
    assert.ok(line.startsWith("sh -c '") && line.endsWith("'"));
    assert.ok(!line.includes('\n'));
    assert.ok(line.includes(encodePairCode(payload)));
    const script = line.slice("sh -c '".length, -1);
    assert.ok(!script.includes("'"));
    assert.equal(spawnSync('sh', ['-n', '-c', script]).status, 0);
  });

  it('carries no value that could end its quoting', () => {
    const line = buildBootstrapLine(createPairCodePayload());
    const script = line.slice("sh -c '".length, -1);
    assert.ok(!/[`\\]/.test(script.replace(/\\"/g, '').replace(/\\n/g, '')), 'no backtick and no stray backslash');
  });

  it('fetches the package with the pairing\'s key, strict host key checking and no agent, then hands the code to the runner utility', () => {
    const payload = createPairCodePayload({ host: 'hub.example', port: 2222, user: 'hubuser' });
    installStubSsh(path.join(workDir, 'bin'));
    createBootstrapAnswer();
    const result = spawnSync('sh', ['-c', buildBootstrapLine(payload)], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${path.join(workDir, 'bin')}:${process.env.PATH}`, TMPDIR: path.join(workDir, 'tmp') },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^RUNNER_CLI pair --bootstrap \\S+/pkg ${encodePairCode(payload).replace(/\./g, '\\.')}$`, 'm'));

    const sshArgs = fs.readFileSync(path.join(workDir, 'ssh.args'), 'utf8');
    for (const expected of ['-T', '-F /dev/null', 'BatchMode=yes', 'IdentitiesOnly=yes', 'IdentityAgent=none', 'StrictHostKeyChecking=yes', 'GlobalKnownHostsFile=/dev/null', 'HostKeyAlias=charness-hub', '-p 2222', 'hubuser@hub.example bootstrap']) {
      assert.ok(sshArgs.includes(expected), expected);
    }
    assert.ok(!sshArgs.includes('StrictHostKeyChecking=no'));

    const body = (text: string): string => text.replace(/-----(BEGIN|END) OPENSSH PRIVATE KEY-----/g, '').replace(/\s+/g, '');
    assert.equal(body(fs.readFileSync(path.join(workDir, 'key.copy'), 'utf8')), body(payload.privateKey));
    assert.match(fs.readFileSync(path.join(workDir, 'key.copy'), 'utf8'), /^-----BEGIN OPENSSH PRIVATE KEY-----\n[^\n]{1,70}\n/);
    assert.equal(fs.readFileSync(path.join(workDir, 'known_hosts.copy'), 'utf8'), `charness-hub ${payload.hostKey}\n`);
  });

  it('skips what the hub\'s shell printed before the gate ran — a banner, a line without its newline — and unpacks the archive byte for byte', () => {
    installStubSsh(path.join(workDir, 'bin'));
    createBootstrapAnswer('Welcome to the hub!\nLast login: Sat Nov  1 12:00:00 2026\nunterminated banner');
    const payload = createPairCodePayload();
    const result = runLine(payload);
    assert.equal(result.status, 0, String(result.stderr));
    assert.match(String(result.stdout), /^RUNNER_CLI pair --bootstrap /m);
  });

  it('stops with a clear line when the answer has no marker (an expired line, a refusal), and cleans up', () => {
    installStubSsh(path.join(workDir, 'bin'));
    fs.writeFileSync(path.join(workDir, 'answer.bin'), 'Welcome to the hub!\n');
    const result = runLine();
    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /the hub did not send the package/);
    assert.ok(!String(result.stdout).includes('RUNNER_CLI'));
    assert.deepEqual(fs.readdirSync(path.join(workDir, 'tmp')), []);
  });

  it('leaves nothing behind in the temp folder, not even the key', () => {
    installStubSsh(path.join(workDir, 'bin'));
    createBootstrapAnswer();
    const result = spawnSync('sh', ['-c', buildBootstrapLine(createPairCodePayload())], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${path.join(workDir, 'bin')}:${process.env.PATH}`, TMPDIR: path.join(workDir, 'tmp') },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readdirSync(path.join(workDir, 'tmp')), []);
  });

  it('stops with a clear line when ssh cannot fetch the package, and still cleans up', () => {
    installStubSsh(path.join(workDir, 'bin'));
    fs.writeFileSync(path.join(workDir, 'bin', 'ssh'), '#!/bin/sh\necho "Permission denied" >&2\nexit 255\n', { mode: 0o755 });
    const result = spawnSync('sh', ['-c', buildBootstrapLine(createPairCodePayload())], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${path.join(workDir, 'bin')}:${process.env.PATH}`, TMPDIR: path.join(workDir, 'tmp') },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Permission denied/);
    assert.ok(!result.stdout.includes('RUNNER_CLI'));
    assert.deepEqual(fs.readdirSync(path.join(workDir, 'tmp')), []);
  });

  it('says what is missing when node is absent or too old, and cleans up', () => {
    installStubSsh(path.join(workDir, 'bin'));
    createBootstrapAnswer();
    const toolsBin = path.join(workDir, 'tools');
    fs.mkdirSync(toolsBin);
    for (const tool of ['mktemp', 'rm', 'cat', 'tar', 'fold', 'mkdir', 'cp']) {
      const resolved = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      if (resolved.startsWith('/')) fs.symlinkSync(resolved, path.join(toolsBin, tool));
    }
    const oldNodeBin = path.join(workDir, 'oldnode');
    fs.mkdirSync(oldNodeBin);
    fs.writeFileSync(path.join(oldNodeBin, 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    for (const pathValue of [toolsBin, `${oldNodeBin}:${toolsBin}`]) {
      const result = spawnSync('/bin/sh', ['-c', buildBootstrapLine(createPairCodePayload())], {
        encoding: 'utf8',
        env: { ...process.env, PATH: pathValue, TMPDIR: path.join(workDir, 'tmp') },
      });
      assert.notEqual(result.status, 0, pathValue);
      assert.match(result.stderr, /Node\.js 22\.12 or newer is needed/);
      assert.deepEqual(fs.readdirSync(path.join(workDir, 'tmp')), []);
    }
  });
});
