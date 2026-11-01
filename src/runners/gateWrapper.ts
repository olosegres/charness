import * as fs from 'fs';
import { writeTextFileAtomically } from '../configDirFile';
import { shellSingleQuote } from '../utils/tmuxExec';
import { ensureHubDir } from './hubLock';
import { getHubFilePaths, type HubContext } from './hubPaths';

/**
 * @description The `gate` file every runner key's `authorized_keys` line points at: a two-line `sh` wrapper that runs THIS install's
 * `node` on THIS install's `cli.js`. The lines carry its path (not node's or the checkout's), and the file is rewritten at every
 * start, so a Node upgrade, a moved checkout or a switch from npm to a git checkout never leaves a key line pointing at nothing.
 */

const wrapperMode = 0o700;
const permissionBitsMask = 0o777;

/** @description The text of the wrapper for `ctx`. */
export function renderGateWrapper(ctx: Pick<HubContext, 'nodePath' | 'cliPath'>): string {
  return `#!/bin/sh\nexec ${shellSingleQuote(ctx.nodePath)} ${shellSingleQuote(ctx.cliPath)} runner-gate "$@"\n`;
}

/** @description Write the wrapper (only when it differs from what is there) and return its path. */
export function ensureGateWrapper(ctx: HubContext): string {
  ensureHubDir(ctx.dir);
  const gatePath = getHubFilePaths(ctx.dir).gate;
  const text = renderGateWrapper(ctx);
  let current: string | null = null;
  try {
    current = fs.readFileSync(gatePath, 'utf8');
  } catch {
    current = null;
  }
  if (current !== text || (fs.statSync(gatePath).mode & permissionBitsMask) !== wrapperMode) writeTextFileAtomically(gatePath, text, wrapperMode);
  return gatePath;
}
