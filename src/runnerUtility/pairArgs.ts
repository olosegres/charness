/**
 * @description The one option of `charness-runner pair` that the admin line adds. Builtins only: `runnerCli.ts` reads it before any
 * dependency is installed, and the hub (`runners/bootstrapLine.ts`) writes it.
 *
 * `--service-follows` says that the line which started the pairing installs the always-on service right after it, so the pairing does not
 * print the «keep it running» help (its commands would be wrong: the service is already on its way).
 */

export const serviceFollowsFlag = '--service-follows';

export interface SplitPairArgs {
  /** The arguments without the flag, in their order. */
  rest: string[];
  isServiceFollowing: boolean;
}

/** @description Take the flag out of `args` wherever it stands. */
export function splitServiceFollowsFlag(args: readonly string[]): SplitPairArgs {
  return { rest: args.filter((argument) => argument !== serviceFollowsFlag), isServiceFollowing: args.includes(serviceFollowsFlag) };
}
