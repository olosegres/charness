/**
 * @description The OpenCode plugin the bot installs so that a compaction OpenCode
 * runs ON ITS OWN when the context overflows also gets the resume guidance — the
 * skills to load again, the agent-mistakes section the bot posts to the topic and the
 * next-steps checklist that ends the summary (`compactionResumeGuidance`).
 *
 * WHY this exists: the resume guidance rides the bot's per-invocation
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
 * The file name carries a hash of the plugin's content. `GET /config` reports a
 * loaded plugin only by that name, so a name that is the same for every version
 * would make an instance that loaded an OLDER text read as up to date: it would
 * never be recreated, and the bot would leave the guidance out of its own
 * instruction on the strength of a plugin that carries less than the current
 * one. With the hash only an instance that loaded the current text counts
 * ({@link checkHasOpenCodeCompactPlugin}); an older copy of the file is removed on
 * install, so a new instance never loads two.
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
 * therefore leaves the resume guidance out of its instruction when the folder's
 * instance has the CURRENT plugin ({@link checkHasOpenCodeCompactPlugin} over
 * `GET /config`), and keeps it otherwise.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getCompactionResumeGuidance } from './compactOnIdle';
import { flagSessionIdPattern, openCodeCompactMistakesOffDirName } from './compactMistakesFlags';
import { formatDeprecation, warnLegacyNameOnce } from '../legacyNames';

/** OpenCode requires a path plugin to export an id. */
export const openCodeCompactPluginId = 'charness-compaction';

/** The part of the plugin's file name before the content hash. */
const openCodeCompactPluginFileStem = 'charness-compaction';

/** Hex digits of the content hash in the file name: enough that two texts never share one, short enough to read. */
const openCodeCompactPluginHashLength = 8;

/** The file name of any version of the plugin: the stem, an optional content hash (the first release had none). */
const openCodeCompactPluginFileNamePattern = new RegExp(`^${openCodeCompactPluginFileStem}(?:-[0-9a-f]{${openCodeCompactPluginHashLength}})?\\.js$`);

/**
 * The file and id the same plugin had before the rename. The file is removed on
 * install so a new instance does not load both; an instance that loaded it carries
 * an older text, so it no longer counts as "has the plugin".
 */
export const legacyOpenCodeCompactPluginFileName = 'telegramcode-compaction.js';
export const legacyOpenCodeCompactPluginId = 'telegramcode-compaction';

/**
 * @description The text the plugin adds to every compaction prompt, with the agent-mistakes section (`isWithInstructionGaps`)
 * or without it. OpenCode appends it AFTER the bot's per-invocation instruction, which may end with the
 * F2 closing-section directive ("write nothing after the end marker"), so the text
 * says outright that the skills list and the checklist belong inside the summary.
 */
export function getOpenCodeCompactPluginContext(isWithInstructionGaps: boolean): string {
  return `Additional instruction for the summary itself (put it inside the summary, never after a closing section the instructions above require): ${getCompactionResumeGuidance(isWithInstructionGaps)}`;
}

/**
 * How many sessions up the plugin follows `parentID` from the compacting one to find the topic's session. A sub-agent's
 * session hangs directly under it, and one that starts sub-agents of its own a level lower; the bound only keeps a broken
 * chain (a loop) from being followed for ever.
 */
const maxSessionAncestryDepth = 8;

/**
 * How long the plugin waits for the server to tell one session's parent. OpenCode does not start the compaction until the
 * hook returns, and the lookup is a request to the server the plugin runs in — one that never settles (the server going down
 * mid-compaction, a proxy that holds the connection) would hold the compaction for ever. A lookup that is not answered in
 * time means ON, like one that fails: the section is asked for, as before the switch.
 */
export const openCodeAncestryLookupTimeoutMs = 2000;

/**
 * @description The plugin module source: a v1 plugin (`default` export with `id` + `server`). Before a compaction it looks for
 * the flag the bot keeps for the session (`utils/compactMistakesFlags.ts`): present ⇒ `/compact_mistakes` is off for the
 * session's topic and the text without the agent-mistakes section goes in. The flag folder sits next to the plugin folder,
 * found from the plugin's own location — the plugin is shared by every OpenCode of the account and knows no `DATA_DIR`.
 *
 * A sub-agent (Task) session has an id of its own that no flag names, so when the compacting session has none the plugin asks
 * the server for its `parentID` (`client.session.get`, which the server hands every plugin) and looks at the parent's, up to
 * {@link maxSessionAncestryDepth} levels: a topic's sub-agents follow the topic. A folder with no flag in it at all costs no
 * request. A session id that is not a plain id, a lookup that fails or is not answered within
 * {@link openCodeAncestryLookupTimeoutMs}, or any read failure means ON: the section is asked for, as before the switch.
 */
export function buildOpenCodeCompactPluginSource(input: { context: string; contextWithoutInstructionGaps: string }): string {
  return [
    '// Installed by Charness, which rewrites it when its content changes. Do not edit.',
    'import fs from "node:fs";',
    'import path from "node:path";',
    'import { fileURLToPath } from "node:url";',
    `const context = ${JSON.stringify(input.context)};`,
    `const contextWithoutInstructionGaps = ${JSON.stringify(input.contextWithoutInstructionGaps)};`,
    `const maxAncestryDepth = ${maxSessionAncestryDepth};`,
    `const lookupTimeoutMs = ${openCodeAncestryLookupTimeoutMs};`,
    `const offFlagDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), ${JSON.stringify(openCodeCompactMistakesOffDirName)});`,
    `const checkIsPlainID = (sessionID) => typeof sessionID === "string" && new RegExp(${JSON.stringify(flagSessionIdPattern.source)}).test(sessionID);`,
    'const checkHasAnyFlag = () => { try { return fs.readdirSync(offFlagDir).length > 0; } catch { return false; } };',
    'const checkHasFlag = (sessionID) => { try { return fs.existsSync(path.join(offFlagDir, sessionID)); } catch { return false; } };',
    // The server's answer, or a rejection when it does not come in time (the timer is always cleared; a late answer is ignored).
    'const lookupParentID = async (client, sessionID) => {',
    '  let timer;',
    '  try {',
    '    const timeout = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("the parent lookup timed out")), lookupTimeoutMs); });',
    '    return (await Promise.race([client.session.get({ path: { id: sessionID } }), timeout])).data?.parentID;',
    '  } finally {',
    '    clearTimeout(timer);',
    '  }',
    '};',
    'const checkIsMistakesOff = async (client, sessionID) => {',
    '  if (!checkHasAnyFlag()) return false;',
    '  let currentID = sessionID;',
    '  for (let depth = 0; depth < maxAncestryDepth; depth += 1) {',
    '    if (!checkIsPlainID(currentID)) return false;',
    '    if (checkHasFlag(currentID)) return true;',
    '    let parentID;',
    '    try { parentID = await lookupParentID(client, currentID); } catch { return false; }',
    '    if (!parentID) return false;',
    '    currentID = parentID;',
    '  }',
    '  return false;',
    '};',
    'export default {',
    `  id: ${JSON.stringify(openCodeCompactPluginId)},`,
    '  server: async (pluginContext) => ({',
    '    "experimental.session.compacting": async (input, output) => {',
    '      output.context.push((await checkIsMistakesOff(pluginContext?.client, input?.sessionID)) ? contextWithoutInstructionGaps : context);',
    '    },',
    '  }),',
    '};',
    '',
  ].join('\n');
}

/** The source of the CURRENT plugin: both texts, the way the installed file holds them. */
function buildCurrentOpenCodeCompactPluginSource(): string {
  return buildOpenCodeCompactPluginSource({
    context: getOpenCodeCompactPluginContext(true),
    contextWithoutInstructionGaps: getOpenCodeCompactPluginContext(false),
  });
}

/**
 * @description The plugin's file name for a given source: the stem and a hash of the source. `GET /config` names a
 * loaded plugin by this file name alone, so the name is what tells an instance that loaded this text from one that
 * loaded an older one.
 */
export function getOpenCodeCompactPluginFileName(source: string): string {
  const contentHash = crypto.createHash('sha256').update(source).digest('hex').slice(0, openCodeCompactPluginHashLength);
  return `${openCodeCompactPluginFileStem}-${contentHash}.js`;
}

/** File name of the CURRENT plugin in OpenCode's plugin folder; also how the bot recognises it in `GET /config`. */
export const openCodeCompactPluginFileName = getOpenCodeCompactPluginFileName(buildCurrentOpenCodeCompactPluginSource());

/** @description OpenCode's global plugin folder, resolved the way OpenCode resolves it (XDG config home). */
export function resolveOpenCodeGlobalPluginDir(env: NodeJS.ProcessEnv): string {
  const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'opencode', 'plugins');
}

/**
 * @description Whether a `GET /config` `plugin` list contains the CURRENT bot plugin. A
 * spec is a string or a `[spec, options]` tuple; OpenCode reports a path plugin as
 * a `file://` URL. Only the current file name counts: an instance that loaded an
 * older version of the plugin (another content hash, the unhashed first release, the
 * pre-rename file) keeps the older text in memory, so it must be recreated and the
 * bot must still send the guidance itself.
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
  return checkIsOpenCodeSessionStatusIdle(input.sessionStatus) ? 'recreate' : 'busy';
}

/**
 * @description Whether a `GET /session/status` map says every session of the instance is idle. A status the bot
 * cannot read counts as busy: an instance or a server is never recreated on a guess.
 */
export function checkIsOpenCodeSessionStatusIdle(sessionStatus: unknown): boolean {
  if (!sessionStatus || typeof sessionStatus !== 'object' || Array.isArray(sessionStatus)) return false;
  return Object.values(sessionStatus).every(
    (entry) => typeof entry === 'object' && entry !== null && 'type' in entry && entry.type === 'idle',
  );
}

/** Outcome of {@link installOpenCodeCompactPlugin}. */
export type CompactPluginInstallResult = 'written' | 'unchanged' | 'failed';

/**
 * @description Remove the plugin file a pre-rename release installed, so a folder
 * instance never loads two copies of the guidance. Only a file that is the bot's
 * own (it exports the legacy id) is removed; anything else under that name is
 * the user's and stays. Best-effort: a failure leaves a duplicate guidance, which
 * is harmless.
 */
function removeLegacyOpenCodeCompactPlugin(pluginDir: string): void {
  const legacyPath = path.join(pluginDir, legacyOpenCodeCompactPluginFileName);
  try {
    const source = fs.readFileSync(legacyPath, 'utf-8');
    if (!source.includes(JSON.stringify(legacyOpenCodeCompactPluginId))) return;
    fs.unlinkSync(legacyPath);
  } catch {
    return;
  }
  warnLegacyNameOnce(
    'opencode-compact-plugin',
    `${formatDeprecation(legacyPath, path.join(pluginDir, openCodeCompactPluginFileName))}; the old file was removed`,
  );
}

/**
 * @description Remove every OTHER version of the plugin from the folder, so a new
 * folder instance loads one copy of the guidance, not an older text beside the
 * current one. Only a file that is the bot's own (its name fits the plugin's and it
 * exports the plugin's id) goes; anything else stays. Best-effort: a failure leaves a
 * duplicate guidance, which is harmless.
 */
function removeOutdatedOpenCodeCompactPlugins(pluginDir: string): void {
  let fileNames: string[];
  try {
    fileNames = fs.readdirSync(pluginDir);
  } catch {
    return;
  }
  for (const fileName of fileNames) {
    if (fileName === openCodeCompactPluginFileName || !openCodeCompactPluginFileNamePattern.test(fileName)) continue;
    const outdatedPath = path.join(pluginDir, fileName);
    try {
      if (!fs.readFileSync(outdatedPath, 'utf-8').includes(JSON.stringify(openCodeCompactPluginId))) continue;
      fs.unlinkSync(outdatedPath);
      console.log(`[compact-plugin] removed the outdated plugin file ${outdatedPath}`);
    } catch {
      // Gone already or not ours to read: it stays.
    }
  }
}

/**
 * @description Put the plugin into OpenCode's global plugin folder. Idempotent:
 * an identical file is left alone, a stale one is replaced atomically (a folder
 * instance being created concurrently never reads half a file). Any failure is
 * logged and returned — the plugin improves a summary, it must never block an
 * OpenCode start or the bot's boot. The file a pre-rename release installed is
 * removed first; the older versions of the current name, once the current file is
 * in place (a folder instance created in between loads both, never none).
 */
export function installOpenCodeCompactPlugin(
  pluginDir: string = resolveOpenCodeGlobalPluginDir(process.env),
): CompactPluginInstallResult {
  removeLegacyOpenCodeCompactPlugin(pluginDir);
  const pluginPath = path.join(pluginDir, openCodeCompactPluginFileName);
  const source = buildCurrentOpenCodeCompactPluginSource();
  let isCurrentFileInPlace = false;
  try {
    isCurrentFileInPlace = fs.readFileSync(pluginPath, 'utf-8') === source;
  } catch {
    // Missing or unreadable: (re)write below.
  }
  if (!isCurrentFileInPlace) {
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
  }
  removeOutdatedOpenCodeCompactPlugins(pluginDir);
  return isCurrentFileInPlace ? 'unchanged' : 'written';
}
