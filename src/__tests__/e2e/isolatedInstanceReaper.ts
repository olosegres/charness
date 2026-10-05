/**
 * @description The detached reaper of one isolated test instance
 * (`isolatedCharness.ts`): started in its own session by
 * `createIsolatedInstanceLayout`, so a SIGKILL of the test's process group —
 * which no `exit` handler of the test ever sees — does not reach it. It polls
 * the instance's owner file: once the owning test process is gone (or its pid
 * was reused by another process), it ends the instance's private tmux servers
 * and removes its folder; a folder removed by the test's own cleanup ends it.
 *
 * Usage: node --import tsx isolatedInstanceReaper.ts <testRoot>
 */

import * as fs from 'fs';
import { checkIsIsolatedInstanceOwnerAlive, readIsolatedInstanceOwner, removeDeadIsolatedInstanceSync } from './isolatedCharness';

const pollIntervalMs = 1000;

function main(): void {
  const testRoot = process.argv[2];
  if (!testRoot) throw new Error('usage: isolatedInstanceReaper.ts <testRoot>');
  const timer = setInterval(() => {
    if (!fs.existsSync(testRoot)) {
      clearInterval(timer);
      return;
    }
    const owner = readIsolatedInstanceOwner(testRoot);
    if (owner === null || checkIsIsolatedInstanceOwnerAlive(owner)) return;
    removeDeadIsolatedInstanceSync(testRoot, owner);
    clearInterval(timer);
  }, pollIntervalMs);
}

main();
