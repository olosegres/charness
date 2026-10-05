const msPerMinute = 60 * 1000;

/**
 * @description A window set in MINUTES through an environment override for a test
 * or live-test instance (`REQUEST_BACKSTOP_MINUTES`, `AGENT_IDLE_MINUTES`). A
 * missing, blank, non-numeric or non-positive value keeps `defaultMs`.
 */
export function getMinutesOverrideMs(overrideMinutes: string | undefined, defaultMs: number): number {
  if (overrideMinutes === undefined || overrideMinutes.trim() === '') return defaultMs;
  const minutes = Number(overrideMinutes);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * msPerMinute : defaultMs;
}
