import * as fs from 'fs';
import type { RunnerHomePaths } from './runnerHome';

/**
 * @description The runner's own pause: an empty file, `~/.charness-runner/paused`. A paused runner stays linked but says so in its probe
 * (`paused=1`), and `remote-run` never picks it for a job — the operator's way to take a machine out of rotation from the machine itself
 * (the hub has its own pause for the same purpose, set from `/runners`).
 */

export function checkIsRunnerPaused(paths: RunnerHomePaths): boolean {
  return fs.existsSync(paths.pausedFlag);
}

export function setRunnerPaused(paths: RunnerHomePaths, isPaused: boolean): void {
  if (isPaused) fs.writeFileSync(paths.pausedFlag, '', { mode: 0o644 });
  else fs.rmSync(paths.pausedFlag, { force: true });
}
