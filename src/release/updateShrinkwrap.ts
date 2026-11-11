/**
 * `yarn shrinkwrap`: write `npm-shrinkwrap.json`, the lock the hub's npm package ships (`hubShrinkwrap.ts`), from `yarn.lock` and
 * `package.json` of the CURRENT directory (the repository root). What `yarn.lock` does not hold — each package's integrity and whether it
 * has install scripts — the file keeps for a package at the same version; the rest is asked of the npm registry (the one step that needs
 * the network, with a deadline). Run it after every dependency change, beside `yarn runner-lock`; a unit test fails while the committed
 * file does not match `yarn.lock`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { getIntegrityKey, parseRootPackageJson, parseRunnerLock, registryUrl } from '../runners/runnerLock';
import {
  buildHubShrinkwrap,
  listUnknownPackageVersions,
  readShrinkwrapFacts,
  renderHubShrinkwrap,
  shrinkwrapFileName,
  type PackageVersionFacts,
} from './hubShrinkwrap';

const registryTimeoutMs = 30_000;
const integrityPrefix = 'sha512-';
/** The scripts npm runs when it installs a package (`prepare` runs only for a git or folder dependency). */
const installScriptNames = ['preinstall', 'install', 'postinstall'] as const;
const registryVersionSchema = z.object({
  dist: z.object({ integrity: z.string() }),
  scripts: z.record(z.string(), z.string()).optional(),
});

/** What the registry holds for `name@version`: its sha512 integrity and whether it has install scripts. */
async function fetchVersionFacts(name: string, version: string): Promise<PackageVersionFacts> {
  const response = await fetch(`${registryUrl}/${name.replace('/', '%2F')}/${version}`, { signal: AbortSignal.timeout(registryTimeoutMs), headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`the registry answered ${response.status} for ${name}@${version}`);
  const metadata = registryVersionSchema.safeParse(await response.json());
  if (!metadata.success || !metadata.data.dist.integrity.startsWith(integrityPrefix)) throw new Error(`the registry gave no sha512 integrity for ${name}@${version}`);
  const scripts = metadata.data.scripts ?? {};
  return { integrity: metadata.data.dist.integrity, hasInstallScript: installScriptNames.some((scriptName) => scripts[scriptName] !== undefined) };
}

async function main(): Promise<void> {
  const root = process.cwd();
  const shrinkwrapPath = path.join(root, shrinkwrapFileName);
  const rootPackageJson = parseRootPackageJson(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const yarnLockText = fs.readFileSync(path.join(root, 'yarn.lock'), 'utf8');
  const facts = fs.existsSync(shrinkwrapPath) ? readShrinkwrapFacts(parseRunnerLock(fs.readFileSync(shrinkwrapPath, 'utf8'))) : {};
  for (const { name, version } of listUnknownPackageVersions(buildHubShrinkwrap({ yarnLockText, rootPackageJson, facts }))) {
    facts[getIntegrityKey(name, version)] = await fetchVersionFacts(name, version);
    process.stdout.write(`asked the registry about ${name}@${version}\n`);
  }
  const text = renderHubShrinkwrap(buildHubShrinkwrap({ yarnLockText, rootPackageJson, facts }));
  const isChanged = !fs.existsSync(shrinkwrapPath) || fs.readFileSync(shrinkwrapPath, 'utf8') !== text;
  if (isChanged) fs.writeFileSync(shrinkwrapPath, text);
  process.stdout.write(isChanged ? `wrote ${shrinkwrapFileName}\n` : `${shrinkwrapFileName} is up to date\n`);
}

main().catch((error: Error) => {
  process.stderr.write(`shrinkwrap: ${error.message}\n`);
  process.exit(1);
});
