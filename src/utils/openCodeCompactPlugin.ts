/**
 * @description The OpenCode plugin the bot installs so that a compaction OpenCode
 * runs ON ITS OWN when the context overflows also tells the next session which
 * skills to load again.
 *
 * WHY this exists: the loaded-skills guidance rides the bot's per-invocation
 * `instruction` (`POST /session/:id/summarize`), which an overflow compaction
 * never receives, and unlike D3 it is not baked into the fork's prompt. OpenCode
 * runs the plugin hook `experimental.session.compacting` before EVERY compaction
 * (manual and overflow) and appends the strings a plugin pushes into
 * `output.context` to the compaction prompt. A plugin needs no fork rebuild.
 *
 * WHERE it lives: OpenCode's global plugin folder
 * (`$XDG_CONFIG_HOME/opencode/plugins/`, scanned for `*.{ts,js}` whenever a
 * project-folder instance is created), so every OpenCode on this account loads it
 * — one the bot started, one it adopted, one run by hand. The bot owns that one
 * file and rewrites it only when its content changed; the user's `opencode.json`
 * is never touched.
 *
 * A RUNNING instance does not rescan: OpenCode loads plugins once per project
 * folder. `POST /instance/dispose?directory=` makes the next request recreate the
 * folder's instance, which then loads the plugin — no server restart, sessions
 * stay on disk. Measured on the fork build: a plugin file added to a live folder
 * did not load until that dispose, and its `server()` ran right after. Recreating
 * drops the folder's runtime MCP registrations, so the bot reconciles its own MCP
 * server right after. It only recreates an idle folder
 * ({@link getCompactPluginActivation}).
 *
 * The hook only sees the session id, never the bot's per-invocation instruction,
 * so it cannot skip a compaction that already carries the guidance. The bot
 * therefore leaves the skills guidance out of its instruction when the folder's
 * instance has this plugin ({@link checkHasOpenCodeCompactPlugin} over
 * `GET /config`), and keeps it otherwise.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { compactionSkillsGuidance } from './compactOnIdle';

/** File name of the plugin in OpenCode's plugin folder; also how the bot recognises it in `GET /config`. */
export const openCodeCompactPluginFileName = 'telegramcode-compaction.js';

/** OpenCode requires a path plugin to export an id. */
export const openCodeCompactPluginId = 'telegramcode-compaction';

/**
 * @description The text the plugin adds to every compaction prompt. OpenCode
 * appends it AFTER the bot's per-invocation instruction, which may end with the
 * F2 closing-section directive ("write nothing after the end marker"), so the text
 * says outright that the skills list belongs inside the summary.
 */
export function getOpenCodeCompactPluginContext(): string {
  return `Additional instruction for the summary itself (put it inside the summary, never after a closing section the instructions above require): ${compactionSkillsGuidance}`;
}

/** @description The plugin module source: a v1 plugin (`default` export with `id` + `server`). */
export function buildOpenCodeCompactPluginSource(context: string): string {
  return [
    '// Installed by TelegramCode, which rewrites it when its content changes. Do not edit.',
    `const context = ${JSON.stringify(context)};`,
    'export default {',
    `  id: ${JSON.stringify(openCodeCompactPluginId)},`,
    '  server: async () => ({',
    '    "experimental.session.compacting": async (_input, output) => {',
    '      output.context.push(context);',
    '    },',
    '  }),',
    '};',
    '',
  ].join('\n');
}

/** @description OpenCode's global plugin folder, resolved the way OpenCode resolves it (XDG config home). */
export function resolveOpenCodeGlobalPluginDir(env: NodeJS.ProcessEnv): string {
  const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'opencode', 'plugins');
}

/**
 * @description Whether a `GET /config` `plugin` list contains the bot's plugin. A
 * spec is a string or a `[spec, options]` tuple; OpenCode reports a path plugin as
 * a `file://` URL.
 */
export function checkHasOpenCodeCompactPlugin(pluginSpecs: unknown): boolean {
  if (!Array.isArray(pluginSpecs)) return false;
  return pluginSpecs.some((entry) => {
    const spec = Array.isArray(entry) ? entry[0] : entry;
    return typeof spec === 'string' && spec.endsWith(`/${openCodeCompactPluginFileName}`);
  });
}

/**
 * Boot decision for one project folder: its instance already has the plugin, it
 * should be recreated to load it, or it is working and must not be disturbed.
 */
export type CompactPluginActivation = 'loaded' | 'recreate' | 'busy';

/**
 * @description Decide what to do with a folder's instance from its `GET /config`
 * plugin list and its `GET /session/status` map. Recreating aborts whatever the
 * folder is running, so ANY session that is not `idle` makes it `busy` — and so
 * does a status the bot cannot read: never recreate on a guess.
 */
export function getCompactPluginActivation(input: {
  pluginSpecs: unknown;
  sessionStatus: unknown;
}): CompactPluginActivation {
  if (checkHasOpenCodeCompactPlugin(input.pluginSpecs)) return 'loaded';
  const status = input.sessionStatus;
  if (!status || typeof status !== 'object' || Array.isArray(status)) return 'busy';
  const isAnyBusy = Object.values(status).some(
    (entry) => !entry || typeof entry !== 'object' || (entry as { type?: unknown }).type !== 'idle',
  );
  return isAnyBusy ? 'busy' : 'recreate';
}

/** Outcome of {@link installOpenCodeCompactPlugin}. */
export type CompactPluginInstallResult = 'written' | 'unchanged' | 'failed';

/**
 * @description Put the plugin into OpenCode's global plugin folder. Idempotent:
 * an identical file is left alone, a stale one is replaced atomically (a folder
 * instance being created concurrently never reads half a file). Any failure is
 * logged and returned — the plugin improves a summary, it must never block an
 * OpenCode start or the bot's boot.
 */
export function installOpenCodeCompactPlugin(
  pluginDir: string = resolveOpenCodeGlobalPluginDir(process.env),
): CompactPluginInstallResult {
  const pluginPath = path.join(pluginDir, openCodeCompactPluginFileName);
  const source = buildOpenCodeCompactPluginSource(getOpenCodeCompactPluginContext());
  try {
    if (fs.readFileSync(pluginPath, 'utf-8') === source) return 'unchanged';
  } catch {
    // Missing or unreadable: (re)write below.
  }
  const tmpPath = `${pluginPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(tmpPath, source);
    fs.renameSync(tmpPath, pluginPath);
  } catch (e) {
    console.warn(`[compact-plugin] cannot write ${pluginPath}:`, e);
    try { fs.unlinkSync(tmpPath); } catch { /* never written */ }
    return 'failed';
  }
  return 'written';
}
