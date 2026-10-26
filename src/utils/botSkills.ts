/**
 * @description The «Bot skills» switch (`/bot_skills`): whether the skills the bot ships with its agents (`agent-plugin/`,
 * loaded by `utils/agentPlugin.ts`) and the hint to load `charness-manager` (the bot MCP instructions) reach an agent.
 *
 * One value decides it, read in this order — the first that is set wins:
 *
 *  1. the topic's own choice (`/bot_skills` in the topic; a Jira conversation has none),
 *  2. the General value (`/bot_skills` in General, kept in `state.json`),
 *  3. `settings.json`'s `botSkills` — the way an instance without General (Jira only) sets it,
 *  4. ON.
 *
 * Read by the layers that start an agent (both Claude adapters, the OpenCode server's start, the bot MCP's instructions),
 * which must not reach `state.ts` or `bot.ts`: the composition root registers the reader once at boot.
 */
import type { SessionKey } from '../sessionKey';
import { resolveDefaultOnThreadToggle } from './threadToggle';

/** The values `settings.json`'s `botSkills` takes. */
export const botSkillsSettingValues = ['on', 'off'] as const;
export type BotSkillsSetting = (typeof botSkillsSettingValues)[number];

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

/** The instance default: General's value, else `settings.json`'s (read only when General never chose); `undefined` = neither says. */
function getInstanceDefault(sources: BotSkillsSources): boolean | undefined {
  const generalValue = sources.getGeneralValue();
  if (generalValue !== undefined) return generalValue;
  const settingsValue = sources.getSettingsValue();
  return settingsValue === null ? undefined : settingsValue === 'on';
}

/** @description The reader over the layers of {@link BotSkillsSources}: topic choice → General → `settings.json` → ON. */
export function createBotSkillsReader(sources: BotSkillsSources): BotSkillsReader {
  return (key) => resolveBotSkillsEnabled(getInstanceDefault(sources), key === null ? undefined : sources.getTopicOverride(key));
}

let botSkillsReader: BotSkillsReader = () => true;

/** @description Register where {@link checkIsBotSkillsEnabled} reads from (the bot, once, at start-up). Until then the skills are ON. */
export function setBotSkillsReader(reader: BotSkillsReader): void {
  botSkillsReader = reader;
}

/** @description Whether the bot's skills are on for `key`'s agent; `null`: the instance value. */
export function checkIsBotSkillsEnabled(key: SessionKey | null): boolean {
  return botSkillsReader(key);
}
