/**
 * @description The cap on tracker task agents (`/task_agents`): how many tracker conversations may hold an open hand-over
 * request at once, for the WHOLE bot — every project of every tracker connector. `0` = no limit.
 *
 * One value decides it, read in this order — the first that is set wins:
 *
 *  1. the General value (`/task_agents` in General, kept in `state.json`),
 *  2. `settings.json`'s `taskAgents.maxConcurrent` — the way an instance without General (Jira only) sets it,
 *  3. {@link defaultTaskAgentsMaxConcurrent}.
 *
 * Kept free of `instanceSettings.ts` imports: that module needs these constants for its schema.
 */

/** What an instance gets when neither General nor `settings.json` says. */
export const defaultTaskAgentsMaxConcurrent = 5;

/** The stored and typed value for «no limit». */
export const taskAgentsNoLimit = 0;

/** The most a number typed into `/task_agents` or written in `settings.json` may name: a bot runs far fewer agents than this at once. */
export const taskAgentsMaxConcurrentUpperBound = 100;

/** The picker's numbers, besides «No limit». */
export const taskAgentsPickerValues: readonly number[] = [5, 10, 15, 20, 30];

/** The word of `/task_agents <word>` that means «no limit», beside `0`. */
export const taskAgentsNoLimitWord = 'off';

/** Where the value in force comes from: General's own choice, `settings.json`'s seed, or the built-in default. */
export type TaskAgentLimitSource = 'general' | 'settingsFile' | 'builtInDefault';

/** @name TaskAgentLimit @description The value in force and the layer that gave it. */
export interface TaskAgentLimit {
  maxConcurrent: number;
  source: TaskAgentLimitSource;
}

/** Where the layers of the precedence above are read from; the bot wires `state.json` and `settings.json`. */
export interface TaskAgentLimitSources {
  /** The General value; `undefined` = General never chose. */
  getGeneralValue: () => number | undefined;
  /** `settings.json`'s `taskAgents.maxConcurrent`; `null` = the file does not say. */
  getSettingsValue: () => number | null;
}

/** @description The value in force: General's, else `settings.json`'s (read only when General never chose), else the default. */
export function readTaskAgentLimit(sources: TaskAgentLimitSources): TaskAgentLimit {
  const generalValue = sources.getGeneralValue();
  if (generalValue !== undefined) return { maxConcurrent: generalValue, source: 'general' };
  const settingsValue = sources.getSettingsValue();
  if (settingsValue !== null) return { maxConcurrent: settingsValue, source: 'settingsFile' };
  return { maxConcurrent: defaultTaskAgentsMaxConcurrent, source: 'builtInDefault' };
}

/** @description Whether `value` is a number the setting may hold: a whole number from 0 up to {@link taskAgentsMaxConcurrentUpperBound}. */
export function checkIsTaskAgentsMaxConcurrent(value: number): boolean {
  return Number.isInteger(value) && value >= taskAgentsNoLimit && value <= taskAgentsMaxConcurrentUpperBound;
}

/**
 * @name TaskAgentLimitArgument
 * @description What `/task_agents <argument>` names: `number` — a valid value (`0` = no limit); `invalid` — it is neither a
 * whole number in range nor the word for «no limit»; `none` — nothing was typed.
 */
export type TaskAgentLimitArgument = { kind: 'number'; value: number } | { kind: 'invalid' } | { kind: 'none' };

/** @description Read the argument of `/task_agents`: digits only (no sign, no decimals), in range; `off` is `0`. */
export function parseTaskAgentLimitArgument(argument: string): TaskAgentLimitArgument {
  const text = argument.trim().toLowerCase();
  if (text === '') return { kind: 'none' };
  if (text === taskAgentsNoLimitWord) return { kind: 'number', value: taskAgentsNoLimit };
  if (!/^\d+$/.test(text)) return { kind: 'invalid' };
  const value = Number.parseInt(text, 10);
  return checkIsTaskAgentsMaxConcurrent(value) ? { kind: 'number', value } : { kind: 'invalid' };
}
