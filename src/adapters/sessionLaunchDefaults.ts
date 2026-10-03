import type { SessionKey } from '../sessionKey';

/**
 * @description What a conversation's platform wants a NEW Claude session to run
 * with, when nobody picked anything in the conversation itself (Jira connector
 * plan J5, R15): a Jira session loads no user settings, so its model and effort
 * come from `jira.json`. Read by the json-stream adapter at start and resume.
 */

/** @name SessionLaunchDefaults @description `null` fields leave Claude's (or the bot's) default. */
export interface SessionLaunchDefaults {
  model: string | null;
  effort: string | null;
}

/** `null` → the platform sets no defaults for this conversation. */
export type SessionLaunchDefaultsReader = (key: SessionKey) => SessionLaunchDefaults | null;

/**
 * @description The model and effort a session is launched with: an explicit
 * per-conversation effort pick wins, then the platform's default, then the bot's
 * default effort; the model is the platform's default or Claude's own.
 */
export function getSessionLaunchOptions(input: {
  savedEffort: string | null;
  defaults: SessionLaunchDefaults | null;
  botDefaultEffort: string;
}): { model: string | null; effort: string } {
  return {
    model: input.defaults?.model ?? null,
    effort: input.savedEffort ?? input.defaults?.effort ?? input.botDefaultEffort,
  };
}
