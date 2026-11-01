/**
 * @description A paired runner as the hub's registry holds it (`paired.json`), for the tests of `remoteRun/` that need one: valid keys,
 * the id and work dir a Mac runner reports. Not a test itself.
 */

import type { PairedRunner } from '../runners/hubRegistry';
import { generateEd25519KeyPair } from '../runners/sshKeys';

export const pairedRunnerId = 'a1b2c3d4e5f6';
/** The work dir a runner utility on a Mac reports (`~/.charness-runner/work`). */
export const pairedRunnerWorkDir = '/Users/runner/.charness-runner/work';

export function createPairedRunnerFixture(overrides: Partial<PairedRunner> = {}): PairedRunner {
  return {
    id: pairedRunnerId,
    name: 'mac',
    publicKey: generateEd25519KeyPair('client').publicKey,
    keyFingerprint: 'SHA256:x',
    hostKey: generateEd25519KeyPair('server').publicKey,
    workDir: pairedRunnerWorkDir,
    os: 'macOS 15.1',
    arch: 'arm64',
    version: '3.8.0',
    serviceKind: 'system-service',
    pairedAtMs: 1,
    pairId: '0123456789ab',
    label: '@ExampleBot',
    host: 'host.example',
    port: 22,
    isPaused: false,
    ...overrides,
  };
}
