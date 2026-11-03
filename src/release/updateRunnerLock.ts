/**
 * `yarn runner-lock`: write `remoteRun/runner-package-lock.json`, the lockfile the hub's package carries for the runner (`runners/runnerLock.ts`), from
 * `yarn.lock` and `package.json` of the CURRENT directory (the repository root). The integrity hashes are not in `yarn.lock`: those the file already
 * holds for a package at the same version are kept, the missing ones are fetched from the npm registry (the one step that needs the network, with a
 * deadline). Run it after every dependency change; a unit test fails while the committed file does not match `yarn.lock`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import {
  buildRunnerLock,
  getIntegrityKey,
  parseRootPackageJson,
  parseRunnerLock,
  readLockIntegrities,
  registryUrl,
  renderRunnerLock,
  runnerLockRelativePath,
  type NpmLockfile,
} from '../runners/runnerLock';

const registryTimeoutMs = 30_000;
const integrityPrefix = 'sha512-';
const registryMetadataSchema = z.object({ dist: z.object({ integrity: z.string() }) });

/** The integrity (`sha512-…`) the registry holds for `name@version`. */
async function fetchIntegrity(name: string, version: string): Promise<string> {
  const response = await fetch(`${registryUrl}/${name}/${version}`, { signal: AbortSignal.timeout(registryTimeoutMs), headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`the registry answered ${response.status} for ${name}@${version}`);
  const metadata = registryMetadataSchema.safeParse(await response.json());
  if (!metadata.success || !metadata.data.dist.integrity.startsWith(integrityPrefix)) throw new Error(`the registry gave no sha512 integrity for ${name}@${version}`);
  return metadata.data.dist.integrity;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const lockPath = path.join(root, runnerLockRelativePath);
  const rootPackageJson = parseRootPackageJson(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const yarnLockText = fs.readFileSync(path.join(root, 'yarn.lock'), 'utf8');
  const existing: NpmLockfile | null = fs.existsSync(lockPath) ? parseRunnerLock(fs.readFileSync(lockPath, 'utf8')) : null;
  const integrities = existing === null ? {} : readLockIntegrities(existing);
  const draft = buildRunnerLock({ yarnLockText, rootPackageJson, integrities });
  for (const [key, entry] of Object.entries(draft.packages)) {
    if (key === '' || entry.integrity !== undefined || entry.version === undefined) continue;
    const name = key.slice('node_modules/'.length);
    integrities[getIntegrityKey(name, entry.version)] = await fetchIntegrity(name, entry.version);
    process.stdout.write(`fetched the integrity of ${name}@${entry.version}\n`);
  }
  const text = renderRunnerLock(buildRunnerLock({ yarnLockText, rootPackageJson, integrities }));
  const isChanged = !fs.existsSync(lockPath) || fs.readFileSync(lockPath, 'utf8') !== text;
  if (isChanged) fs.writeFileSync(lockPath, text);
  process.stdout.write(isChanged ? `wrote ${runnerLockRelativePath}\n` : `${runnerLockRelativePath} is up to date\n`);
}

main().catch((error: Error) => {
  process.stderr.write(`runner-lock: ${error.message}\n`);
  process.exit(1);
});
