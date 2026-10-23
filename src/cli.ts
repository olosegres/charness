#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { applyDnsFix } from './cli/applyDnsFix';
import { runBot } from './cli/bot';
import { runHot } from './cli/hot';

applyDnsFix();

/**
 * @description Print the package version to stdout for `charness --version`.
 *
 * Reads it from the shipped package.json (`__dirname` is `dist/`, so the file
 * sits one level up) — the same idiom the `/version` bot command uses — so the
 * number never drifts from a hardcoded string.
 */
function printVersion(): void {
  let version = 'unknown';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    version = pkg.version || version;
  } catch {
    /* fall through to unknown */
  }
  process.stdout.write(`${version}\n`);
}

/**
 * @description Print top-level usage to stderr.
 *
 * Keeps the message short and copy-pastable. Detailed docs live in README;
 * we surface just enough here for someone running `charness --help`
 * cold to know what to try next.
 */
function printUsage(): void {
  process.stderr.write(
    `Usage:\n` +
      `  charness                  Start the bot (WORK_ROOT defaults to $PWD)\n` +
      `  charness hot              Hot-reload dev mode: tsc -w + nodemon on dist/\n` +
      `                              (rebuilds + restarts the bot on src/ edits;\n` +
      `                               in-flight agent sessions are reattached)\n` +
      `  charness claude-profiles  Claude account profiles + usage from the bot's cache;\n` +
      `                              --best prints the CLAUDE_CONFIG_DIR to launch under\n` +
      `                              (empty = default), --model <name>, --json\n` +
      `  charness --help, -h       Show this help\n` +
      `  charness --version, -v    Print the version\n` +
      `\n` +
      `Environment:\n` +
      `  Loaded from ~/.config/charness/.env (base) then $PWD/.env (override),\n` +
      `  or with ENV_FILE=<absolute path> from that one file only.\n` +
      `  Required to start: TELEGRAM_BOT_TOKEN (unless CONNECTORS leaves out telegram).\n` +
      `  Access = creator + admins of the served forum group (read live; no user list).\n` +
      `  ALLOWED_GROUP_ID is optional — leave it empty to auto-pair with your\n` +
      `  forum supergroup on first contact (or use /pair in the group).\n` +
      `  WORK_ROOT defaults to $PWD if unset.\n`,
  );
}

/**
 * @description Top-level dispatcher.
 *
 * Branches on `argv[2]`:
 *   - missing          → start the Telegram bot
 *   - `hot`            → hot-reload dev mode
 *   - `-h | --help | help` → usage
 *   - `-v | --version | version` → print the package version
 *   - anything else → usage + exit 2
 *
 * The old `cli claude` passthrough is REMOVED: running plain
 * `claude --dangerously-skip-permissions` in the project folder shares
 * sessions with the bot naturally (same `~/.claude/projects/<cwd-slug>/`
 * transcript store), so the wrapper added nothing.
 *
 * Exit 2 (not 1) for unknown commands matches the convention used by most
 * Unix tools to distinguish "bad invocation" from "ran but failed".
 */
async function main(): Promise<void> {
  const [sub] = process.argv.slice(2);

  if (sub === undefined) {
    await runBot();
    return;
  }

  if (sub === 'hot') {
    await runHot();
    return;
  }

  if (sub === '--help' || sub === '-h' || sub === 'help') {
    printUsage();
    return;
  }

  if (sub === '--version' || sub === '-v' || sub === 'version') {
    printVersion();
    return;
  }

  // Which Claude account profile a child process should run on (the `claude_profiles` MCP tool's twin);
  // loaded lazily so the bot's own start path stays as it was.
  if (sub === 'claude-profiles') {
    const { runClaudeProfilesCli } = await import('./cli/claudeProfiles');
    process.exitCode = await runClaudeProfilesCli(process.argv.slice(3));
    return;
  }

  // The updater's pre-switch probe of a new install (hidden: not in --help).
  if (sub === 'self-check') {
    const { runSelfCheckCli } = await import('./selfUpdate/selfCheck');
    process.exitCode = await runSelfCheckCli(process.argv.slice(3), path.resolve(__dirname, '..'));
    return;
  }

  process.stderr.write(`Unknown command: ${sub}\n\n`);
  printUsage();
  process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
