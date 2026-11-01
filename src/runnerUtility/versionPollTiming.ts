/**
 * @description How often a LINKED runner asks the hub which package it has now (the `version` request, over the connection it already
 * holds). A link that stays healthy for days would otherwise never learn of a hub update: the `link` answer names the package once, when
 * the link starts. In a module of its own so the runner utility reads it without loading the bot.
 *
 * The test seam `CHARNESS_TEST_TIMINGS` (`testTimings.ts`) may only SHORTEN it (key `runnerVersionPollMs`); like the remote-run lease it
 * is read tolerantly here, because this module cannot import `testTimings.ts` (its graph reaches the bot) — the boot of an instance that
 * carries a bad value is what refuses it by name.
 */

/** Production: ask every five minutes. */
export const runnerVersionPollMs = 5 * 60 * 1000;
/** A shorter poll than this is a request loop, not a check. */
export const runnerVersionPollMinMs = 1000;

const testTimingsVariableName = 'CHARNESS_TEST_TIMINGS';

/** @description The poll interval in force: the production one, or the seam's shorter `runnerVersionPollMs` when it is a whole number of ms within [min, production]. */
export function readRunnerVersionPollMs(env: NodeJS.ProcessEnv): number {
  const rawTestTimings = env[testTimingsVariableName];
  if (rawTestTimings === undefined || rawTestTimings.trim() === '') return runnerVersionPollMs;
  let overrides: { runnerVersionPollMs?: number } | null;
  try {
    overrides = JSON.parse(rawTestTimings);
  } catch {
    return runnerVersionPollMs;
  }
  const overrideMs = overrides?.runnerVersionPollMs;
  if (overrideMs === undefined || !Number.isInteger(overrideMs)) return runnerVersionPollMs;
  return overrideMs >= runnerVersionPollMinMs && overrideMs <= runnerVersionPollMs ? overrideMs : runnerVersionPollMs;
}
