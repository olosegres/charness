import fs from 'fs';
import os from 'os';
import path from 'path';
import { Writable } from 'stream';
import { injectStreamIntoSshServer } from '../runnerUtility/injectStream';
import type { RedeemRequest } from '../runners/gateProtocol';
import { createHubContext, type HubContext } from '../runners/hubPaths';
import { generateEd25519KeyPair, type SshKeyPair } from '../runners/sshKeys';
import type { PairCodePayload } from '../runners/pairCode';

/**
 * Shared fixtures of the `runners*.test.ts` files: a throwaway hub (registry folder, `authorized_keys`, a package root to pack), fresh
 * keys, and a stream that collects what a gate writes. Not a test itself.
 */

export interface HubFixture {
  root: string;
  ctx: HubContext;
  cleanup: () => void;
}

/** The hub's `package.json` in a fixture: more dependencies than the runner needs (the bot's own), so that the packer's cutting down shows. */
export const fixturePackageJson = {
  name: 'charness',
  version: '0.0.0-test',
  license: 'MIT',
  engines: { node: '>=22.12' },
  scripts: { build: 'tsc' },
  dependencies: { ssh2: '^1.17.0', telegraf: '^4.16.3', zod: '^4.4.3' },
  devDependencies: { typescript: '^5.7.0' },
};

/** The runner's lock in a fixture: the two packages the runner needs, the way `yarn runner-lock` writes them. */
export const fixtureRunnerLock = {
  name: 'charness',
  version: '0.0.0',
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': { name: 'charness', version: '0.0.0', dependencies: { ssh2: '^1.17.0', zod: '^4.4.3' }, engines: { node: '>=22.12' } },
    'node_modules/ssh2': { version: '1.17.0', resolved: 'https://registry.npmjs.org/ssh2/-/ssh2-1.17.0.tgz', integrity: 'sha512-ssh2ExampleIntegrity==' },
    'node_modules/zod': { version: '4.4.3', resolved: 'https://registry.npmjs.org/zod/-/zod-4.4.3.tgz', integrity: 'sha512-zodExampleIntegrity==' },
  },
};

/** A hub in a temp folder. The registry folder has a short name so the unix socket paths below it stay far under the OS limit. */
export function createHubFixture(): HubFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rnr-'));
  const packageRoot = path.join(root, 'pkg');
  fs.mkdirSync(path.join(packageRoot, 'dist', 'runners'), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, 'dist', '__tests__'), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, 'remoteRun'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), `${JSON.stringify(fixturePackageJson, null, 2)}\n`);
  fs.writeFileSync(path.join(packageRoot, 'remoteRun', 'runner-package-lock.json'), `${JSON.stringify(fixtureRunnerLock, null, 2)}\n`);
  fs.writeFileSync(path.join(packageRoot, 'remoteRun', 'runner.sh'), '#!/usr/bin/env bash\necho runner\n', { mode: 0o755 });
  fs.writeFileSync(path.join(packageRoot, 'dist', 'cli.js'), 'console.log("cli");\n', { mode: 0o755 });
  fs.writeFileSync(path.join(packageRoot, 'dist', 'runners', 'example.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(packageRoot, 'dist', 'runners', 'example.d.ts'), 'export {};\n');
  fs.writeFileSync(path.join(packageRoot, 'dist', 'runners', 'example.js.map'), '{}\n');
  fs.writeFileSync(path.join(packageRoot, 'dist', '__tests__', 'skipped.js'), 'module.exports = 2;\n');
  const ctx = createHubContext({
    dir: path.join(root, 'r'),
    authorizedKeysPath: path.join(root, 'home', '.ssh', 'authorized_keys'),
    nodePath: process.execPath,
    cliPath: path.join(packageRoot, 'dist', 'cli.js'),
    packageRoot,
  });
  return { root, ctx, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

export interface RedeemFixture {
  /** What goes over the wire. */
  request: RedeemRequest;
  clientKey: SshKeyPair;
  serverKey: SshKeyPair;
}

/** What a runner sends to `redeem`, with keys of its own. */
export function createRedeemFixture(overrides: Partial<RedeemRequest> = {}): RedeemFixture {
  const clientKey = generateEd25519KeyPair('runner-client');
  const serverKey = generateEd25519KeyPair('runner-server');
  return {
    request: {
      suggestedName: 'Mac Mini',
      publicKey: clientKey.publicKey,
      hostKey: serverKey.publicKey,
      workDir: '/home/runner/.charness-runner/work',
      os: 'macOS 15.1',
      arch: 'arm64',
      version: '3.7.0',
      serviceKind: 'foreground',
      ...overrides,
    },
    clientKey,
    serverKey,
  };
}

/** A pair-code payload with real keys. */
export function createPairCodePayload(overrides: Partial<PairCodePayload> = {}): PairCodePayload {
  const temporary = generateEd25519KeyPair('temporary');
  const hubHost = generateEd25519KeyPair('hub-host');
  return { host: 'host.example', port: 22, user: 'hubuser', hostKey: hubHost.publicKey, privateKey: temporary.privateKey, pairId: 'abcdef012345', ...overrides };
}

export interface Collector {
  stream: Writable;
  getBuffer: () => Buffer;
  getText: () => string;
}

/** A writable that keeps every byte written to it. */
export function createCollector(): Collector {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });
  return { stream, getBuffer: () => Buffer.concat(chunks), getText: () => Buffer.concat(chunks).toString('utf8') };
}

/** Poll `check` until it holds; throws with `description` after `timeoutMs`. */
export async function waitUntil(check: () => boolean | Promise<boolean>, description: string, timeoutMs: number = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${description}`);
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
}

/**
 * Wait for `promise`; reject with `description` if it takes longer than `timeoutMs`. The timer is cleared as soon as either side settles: an
 * uncleared one keeps the test process alive for its whole length after the promise has long been settled.
 */
export async function settleWithin<T>(promise: Promise<T>, description: string, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`timed out: ${description}`)), timeoutMs); });
  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

export { injectStreamIntoSshServer };
