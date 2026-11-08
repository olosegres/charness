import * as path from 'path';

/**
 * @description A command that is a script with a `#!/usr/bin/env node` first line (npm, npx, Corepack, a package's own bin) finds its `node` through the
 * PATH of whoever starts it — and the runner's Node.js is on nobody's PATH: it lives in the shared folder (or the account's own), not in `/usr/bin`. The
 * environments the runner is started in do not offer it either: `sudo -u <account>` replaces the PATH (its `secure_path`), a systemd user service gets the
 * manager's default, a fresh machine has no Node at all. So every command of this kind is started with the folder of the Node that runs the utility FIRST on
 * its PATH. BUILTINS ONLY: the install step that needs it runs from a package that has no `node_modules` yet.
 */

/** @description `environment` with `nodeDir` first on its `PATH` (the other folders keep their order; no empty entry, which would mean the current folder). */
export function getEnvironmentWithNode(environment: NodeJS.ProcessEnv, nodeDir: string): NodeJS.ProcessEnv {
  return { ...environment, PATH: [nodeDir, environment.PATH ?? ''].filter((folder) => folder !== '').join(path.delimiter) };
}
