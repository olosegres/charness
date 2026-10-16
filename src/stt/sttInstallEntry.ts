import { runSttInstall } from './sttInstall';

/**
 * @description The detached install job — NOT a user command (there is no CLI
 * for voice setup). The bot launches it through `startExternallyParentedProcess`
 * so a hot reload in the middle of a 450 MB download never kills it:
 * `node dist/stt/sttInstallEntry.js <dataDir> [--force]`.
 *
 * Progress is appended to `<dataDir>/stt/install-progress.json` by
 * `runSttInstall` itself; this file only maps the outcome to an exit code:
 * 0 installed (or already was), 1 failed, 2 bad usage, 3 another install holds the lock.
 */

const exitInstalled = 0;
const exitFailed = 1;
const exitUsage = 2;
const exitLocked = 3;

async function main(): Promise<number> {
  const dataDir = process.argv[2];
  if (!dataDir) return exitUsage;
  const result = await runSttInstall(dataDir, { force: process.argv.includes('--force') });
  if (result.ok) return exitInstalled;
  return result.reason === 'locked' ? exitLocked : exitFailed;
}

main().then(
  (exitCode) => process.exit(exitCode),
  (error) => {
    console.error('[STT] install job crashed:', error instanceof Error ? error.message : error);
    process.exit(exitFailed);
  },
);
