/**
 * Side-effect-only setup for `installToolLookup.test.ts`: `installManager.ts` reads `$HOME/.npm-global` (where
 * `installTool` installs) at MODULE-IMPORT time, so the throwaway HOME — with one tool copy installed only there —
 * must exist before that import. Import order is preserved among hoisted imports, so importing this module first
 * is enough. Exports the paths the test asserts on.
 *
 * Matches neither the `*.test.ts` nor `*.e2e.ts` runner globs, so it is never executed as a test itself.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** A tool name nothing on a real PATH is called. */
export const npmGlobalOnlyToolName = 'charness-lookup-test-tool';
export const lookupTestHome = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-tool-lookup-'));
export const npmGlobalOnlyToolPath = path.join(lookupTestHome, '.npm-global', 'bin', npmGlobalOnlyToolName);

fs.mkdirSync(path.dirname(npmGlobalOnlyToolPath), { recursive: true });
fs.writeFileSync(npmGlobalOnlyToolPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
process.env.HOME = lookupTestHome;
