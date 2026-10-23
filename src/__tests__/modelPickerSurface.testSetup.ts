/**
 * Side-effect-only setup for `modelPickerSurface.test.ts`.
 *
 * `bot.ts` validates the boot environment at MODULE-IMPORT time (`parseEnv()`
 * runs as a top-level `const`, `process.exit(1)` on a missing `BOT_TOKEN`), and
 * ESM hoisting runs imports before any assignment in the test body. Importing
 * this module BEFORE the `bot` import guarantees the env is set first, so the
 * exported picker helpers can be exercised in isolation.
 *
 * Matches neither the `*.test.ts` nor `*.e2e.ts` runner globs, so it is never
 * executed as a test itself.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tempWorkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-picker-'));
process.env.TELEGRAM_BOT_TOKEN = '123456:test-token';
process.env.WORK_ROOT = tempWorkRoot;
