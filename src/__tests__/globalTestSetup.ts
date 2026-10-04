/**
 * Global test setup, loaded via `node --import ./src/__tests__/globalTestSetup.ts`
 * BEFORE any test module.
 *
 * WHY: several modules (notably `diagLog.ts`) resolve a `DATA_DIR`-derived path
 * at MODULE-IMPORT time. Any test that transitively imports them would otherwise
 * write into the operator's REAL `DATA_DIR` (`~/.telegramCode/<instance>/`),
 * polluting live forensics — `agent-diag.log`, `output-trace.jsonl`. Setting
 * `DATA_DIR` to a throwaway temp dir here, before those modules first load,
 * keeps every `DATA_DIR`-derived write inside temp.
 *
 * This redirect runs UNCONDITIONALLY: the dev shell that runs `yarn test`
 * frequently exports `DATA_DIR` so the operator can launch the live bot from
 * the same shell, so honouring a pre-set value would re-open the very pollution
 * this guards against. A more specific per-file setup (e.g.
 * `openCodeResumeModel.testSetup.ts`) imports AFTER this module and reassigns
 * `process.env.DATA_DIR`, so it still wins. Matches neither the `*.test.ts` nor
 * `*.e2e.ts` runner globs, so it is never executed as a test itself.
 */
import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Arms the Telegram SessionKeyCodec for the whole suite: modules that only
// DECODE key strings (`state.ts`, the DATA_DIR janitors) never import a
// Telegram module, so a test exercising them in isolation would otherwise have
// no registered codec. Safe to hoist above the DATA_DIR redirect below — the
// codec module reads no environment and imports nothing that does.
import '../connectors/telegram/sessionKeyCodec';

const testDataDir = path.join(os.tmpdir(), `telegramcode-test-${process.pid}`);
mkdirSync(testDataDir, { recursive: true });
process.env.DATA_DIR = testDataDir;

// The dir is named after this process and read by nobody once it is gone; left alone it piles up
// in the OS temp dir, one per test process, for good. An `exit` listener runs for a drained event
// loop, `process.exit()` and an uncaught exception alike (a signal kill skips it).
process.on('exit', () => rmSync(testDataDir, { recursive: true, force: true }));
