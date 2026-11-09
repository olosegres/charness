/**
 * @description The «Bot skills» switch (`/bot_skills`): whether the skills the bot ships with its agents (`agent-plugin/`,
 * loaded by `utils/agentPlugin.ts`) and the hint to load `charness-orchestration` (the bot MCP instructions) reach an agent.
 *
 * One value decides it, read in this order — the first that is set wins:
 *
 *  1. the topic's own choice (`/bot_skills` in the topic; a Jira conversation has none),
 *  2. the General value (`/bot_skills` in General, kept in `state.json`),
 *  3. `settings.json`'s `botSkills` — the way an instance without General (Jira only) sets it,
 *  4. ON.
 *
 * Read by the layers that start an agent (both Claude adapters, the OpenCode server's start, the bot MCP's instructions),
 * which must not reach `state.ts` or `bot.ts`: the composition root registers the reader once at boot. Until then — the hot
 * supervisor starts the OpenCode server before any state is loaded — the reader knows only `settings.json`.
 */
import type { SessionKey } from '../sessionKey';
import { createBotSkillsSettingsReader, getInstanceSettingsPath } from '../instanceSettings';
import type { BotSkillsSetting } from './botSkillsSetting';
import { resolveDefaultOnThreadToggle } from './threadToggle';

export type { BotSkillsSetting };

/**
 * @description Resolve the switch from the topic's choice and the instance default. A topic choice (true OR false) wins;
 * otherwise the default; nothing set ⇒ ON — the skills shipped unconditionally before the switch existed.
 */
export function resolveBotSkillsEnabled(globalDefault: boolean | undefined, threadOverride: boolean | undefined): boolean {
  return resolveDefaultOnThreadToggle(globalDefault, threadOverride);
}

/** Where the layers of the precedence above are read from; the bot wires `state.json` and `settings.json`. */
export interface BotSkillsSources {
  /** The General value; `undefined` = General never chose. */
  getGeneralValue: () => boolean | undefined;
  /** The topic's own choice; `undefined` = it follows General. */
  getTopicOverride: (key: SessionKey) => boolean | undefined;
  /** `settings.json`'s `botSkills`; `null` = the file does not say. */
  getSettingsValue: () => BotSkillsSetting | null;
}

/**
 * @name BotSkillsReader
 * @description Whether the bot's skills are on for a conversation; `null` asks for the instance value (what a conversation
 * without a choice of its own gets, and what the one OpenCode server follows).
 */
export type BotSkillsReader = (key: SessionKey | null) => boolean;

/** Where the instance value comes from: General's own choice, `settings.json`'s seed, or the built-in ON. */
export type BotSkillsInstanceSource = 'general' | 'settingsFile' | 'builtInDefault';

/** @name BotSkillsInstanceValue @description The instance value and the layer that gave it. */
export interface BotSkillsInstanceValue {
  isEnabled: boolean;
  source: BotSkillsInstanceSource;
}

/**
 * @description The instance value — what a conversation without a choice of its own gets: General's value, else
 * `settings.json`'s (read only when General never chose), else ON.
 */
export function readBotSkillsInstanceValue(sources: Pick<BotSkillsSources, 'getGeneralValue' | 'getSettingsValue'>): BotSkillsInstanceValue {
  const generalValue = sources.getGeneralValue();
  if (generalValue !== undefined) return { isEnabled: generalValue, source: 'general' };
  const settingsValue = sources.getSettingsValue();
  if (settingsValue !== null) return { isEnabled: settingsValue === 'on', source: 'settingsFile' };
  return { isEnabled: true, source: 'builtInDefault' };
}

/** @description The reader over the layers of {@link BotSkillsSources}: topic choice → General → `settings.json` → ON. */
export function createBotSkillsReader(sources: BotSkillsSources): BotSkillsReader {
  return (key) => resolveBotSkillsEnabled(readBotSkillsInstanceValue(sources).isEnabled, key === null ? undefined : sources.getTopicOverride(key));
}

/**
 * @description The reader in force before the bot registers its own: `settings.json` alone (it needs no state), so a start
 * that comes first — the hot supervisor's pre-start of the OpenCode server — already follows the file.
 */
export const settingsOnlyBotSkillsReader: BotSkillsReader = createBotSkillsReader({
  getGeneralValue: () => undefined,
  getTopicOverride: () => undefined,
  getSettingsValue: createBotSkillsSettingsReader(() => getInstanceSettingsPath(), (line) => console.error(line)),
});

let botSkillsReader: BotSkillsReader = settingsOnlyBotSkillsReader;

/** @description Register where {@link checkIsBotSkillsEnabled} reads from (the bot, once, at start-up). Until then {@link settingsOnlyBotSkillsReader} answers. */
export function setBotSkillsReader(reader: BotSkillsReader): void {
  botSkillsReader = reader;
}

/** @description Whether the bot's skills are on for `key`'s agent; `null`: the instance value. */
export function checkIsBotSkillsEnabled(key: SessionKey | null): boolean {
  return botSkillsReader(key);
}
