/**
 * A throwaway program for `selfUpdateRestart.test.ts`: the first image records what it is, switches to the second image through
 * the REAL `process.execve` (via `reexecProcess`), and the second prints what survived. Not a test itself.
 */
import { createDefaultReexecDeps, reexecProcess } from '../../selfUpdate/restart';

const [, , stage, tsxLoaderUrl] = process.argv;

if (stage === 'second') {
  process.stdout.write(`${JSON.stringify({ stage, pid: process.pid, cwd: process.cwd(), probe: process.env.REEXEC_PROBE ?? null, stale: process.env.REEXEC_STALE ?? null, args: process.argv.slice(2) })}\n`);
} else {
  // The environment the new image must get is NOT the live one: a value loaded into process.env after launch must not survive.
  process.env.REEXEC_STALE = 'loaded after launch';
  process.on('exit', () => process.stdout.write('first image exit handler ran\n'));
  process.stdout.write(`${JSON.stringify({ stage: 'first', pid: process.pid })}\n`);
  reexecProcess(
    { file: process.execPath, args: [process.execPath, '--import', tsxLoaderUrl, __filename, 'second', tsxLoaderUrl] },
    { PATH: process.env.PATH, REEXEC_PROBE: 'from the launch environment' },
    createDefaultReexecDeps(),
  );
}
