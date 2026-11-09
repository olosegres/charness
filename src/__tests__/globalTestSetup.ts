/**
 * Global test setup, loaded via `node --import ./src/__tests__/globalTestSetup.ts`
 * BEFORE any test module.
 *
 * WHY: several modules (notably `diagLog.ts`) resolve a `DATA_DIR`-derived path
 * at MODULE-IMPORT time. Any test that transitively imports them would otherwise
 * write into the operator's REAL `DATA_DIR` (`~/.charness/<instance>/`),
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
 *
 * The same for tmux: `TMUX_TMPDIR` points at a private folder, so the "default" tmux server of the suite (and of every
 * instance and tool it spawns) is its own, never the host's — where a live bot may run its agents.
 *
 * And for OpenCode's config home: `XDG_CONFIG_HOME` points at a private folder, because `ensureOpenCodeServer()` installs the
 * bot's compaction plugin into `$XDG_CONFIG_HOME/opencode/plugins` and removes every other version of it from there — with the
 * variable unset that is the real account's plugin folder, and a suite run would replace the live bot's plugin file with the
 * tree's own (`globalTestSetup.test.ts` pins this).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Arms the Telegram and Jira SessionKeyCodecs for the whole suite: modules that
// only DECODE key strings (`state.ts`, the DATA_DIR janitors) never import a
// connector module, so a test exercising them in isolation would otherwise have
// no registered codec. Safe to hoist above the DATA_DIR redirect below — the
// codec module reads no environment and imports nothing that does.
import '../connectors/telegram/sessionKeyCodec';
import '../connectors/jira/sessionKeyCodec';
import { hotReloadEnvName, openCodeProcessFileEnvName } from '../legacyNames';

// A FRESH dir, never a pid-named one: a pid-named path may already exist, left behind by another
// account's run before a pid wrap, and `mkdirSync({ recursive: true })` would silently adopt that
// foreign (unwritable) dir, so the first `DATA_DIR` write in the test would fail with `EACCES`.
const testDataDir = mkdtempSync(path.join(os.tmpdir(), 'charness-test-'));
process.env.DATA_DIR = testDataDir;

// A FRESH folder for the same reason as above; a test that needs a config home of its own still sets `XDG_CONFIG_HOME` itself.
// Unconditional, like `DATA_DIR`: the shell that runs the suite may export a real one.
const testConfigHome = mkdtempSync(path.join(os.tmpdir(), 'charness-test-config-'));
process.env.XDG_CONFIG_HOME = testConfigHome;

// A suite run from an agent session of a live hot-mode bot inherits that supervisor's handshake: with
// it, `installManager` would treat the test process as the live worker and persist OpenCode ownership
// into the LIVE instance's file. The tests that exercise the handshake set it themselves.
for (const handshakeName of [hotReloadEnvName, openCodeProcessFileEnvName]) {
  delete process.env[handshakeName.current];
  delete process.env[handshakeName.legacy];
}

// The tmux server this process and everything it spawns reaches without a socket of its own: a private one, never the
// host's default server — a live bot may run its agents there, and a suite started from that host's shell would see
// (and could touch) them. A test that needs a server of its own still names its own `TMUX_TMPDIR` or socket.
const testTmuxDir = mkdtempSync(path.join(os.tmpdir(), 'charness-test-tmux-'));
process.env.TMUX_TMPDIR = testTmuxDir;
delete process.env.TMUX;
delete process.env.TMUX_PANE;

// The dir is private to this process and read by nobody once it is gone; left alone it piles up
// in the OS temp dir, one per test process, for good. An `exit` listener runs for a drained event
// loop, `process.exit()` and an uncaught exception alike (a signal kill skips it). Every tmux server
// a test left running in the private folder — the default socket and any named one (`-L`) — is ended
// by its FULL socket path (never a bare `kill-server`) before the folder goes: with its socket file
// removed, a server could no longer be reached at all.
process.on('exit', () => {
  rmSync(testDataDir, { recursive: true, force: true });
  rmSync(testConfigHome, { recursive: true, force: true });
  const testTmuxSocketDir = path.join(testTmuxDir, `tmux-${process.getuid?.() ?? 0}`);
  const socketNames = existsSync(testTmuxSocketDir) ? readdirSync(testTmuxSocketDir) : [];
  for (const socketPath of socketNames.map((name) => path.join(testTmuxSocketDir, name))) {
    if (lstatSync(socketPath).isSocket()) spawnSync('tmux', ['-S', socketPath, 'kill-server'], { stdio: 'ignore' });
  }
  rmSync(testTmuxDir, { recursive: true, force: true });
});
