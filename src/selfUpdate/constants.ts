const minuteMs = 60 * 1000;
const hourMs = 60 * minuteMs;

/** How often the engine checks for a new version once it has started checking. */
export const checkIntervalMs = hourMs;
/** How long after the bot starts the first check runs (a restart storm must not hammer the registry or the remote). */
export const firstCheckDelayMs = 10 * minuteMs;
/** npm: how long after the bot first saw a version it waits before installing, notifying or offering it. */
export const npmHoldMs = 4 * hourMs;
/** No human message for this long before an automatic install may restart the bot. */
export const quietPeriodMs = 10 * minuteMs;
/** How often a waiting install re-checks whether the bot has become idle. */
export const idlePollIntervalMs = 30 * 1000;
export const npmInstallTimeoutMs = 10 * minuteMs;
export const selfCheckTimeoutMs = 60 * 1000;
/** Hot mode: a pull that has not produced a new worker after this long is a failed build. */
export const hotBuildDeadlineMs = 10 * minuteMs;
/** A boot counts as confirmed this long after Telegram launched. */
export const bootConfirmMs = 60 * 1000;
/** A new version that boots this many times without being confirmed is rolled back. */
export const maxUnconfirmedBoots = 2;
/** The most items a "what's new" summary lists before "…and N more". */
export const whatsNewItemLimit = 8;
