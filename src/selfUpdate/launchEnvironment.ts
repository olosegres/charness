/**
 * The process environment as it was handed to this process — captured the moment this module first loads, which `cli.ts`
 * makes its FIRST import, before any `.env` file is read into `process.env`. A re-exec (the updater's restart, the hot
 * supervisor's re-exec) launches the new image with THIS, never with the live `process.env`: the new run then loads the
 * `.env` files again, so a hand edit of them is honoured and a key removed from them is gone, instead of the old run's
 * loaded values lingering.
 */
const launchEnvironment: NodeJS.ProcessEnv = { ...process.env };

/** @description A copy of the environment the process was launched with. */
export function getLaunchEnvironment(): NodeJS.ProcessEnv {
  return { ...launchEnvironment };
}
