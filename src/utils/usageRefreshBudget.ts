/**
 * @description How long a screen that shows usage waits for the usage refresh when it OPENS. One poll is ~0.5 s; a
 * slower one — a hung endpoint runs into the fetch's own 15 s timeout — keeps going in the background and the next
 * render shows its result. Shared by `/limits`, `/limits_autoswitch` and a pick made while a limit wait is armed (`bot.ts`), so
 * none is held by a slow endpoint.
 */
import { claudeUsageOnDemandMaxAgeMs } from './claudeUsageRefresher';

export const limitsUsageRefreshBudgetMs = 2_000;

/**
 * Refresh the usage snapshots (a snapshot younger than a minute is kept — the `/accounts` freshness), waiting at most
 * {@link limitsUsageRefreshBudgetMs}: the screen is never held by a slow usage endpoint.
 */
export async function refreshUsageWithinBudget(refresh: (options: { maxAgeMs?: number }) => Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<void>((resolve) => { timer = setTimeout(resolve, limitsUsageRefreshBudgetMs); });
  try {
    await Promise.race([refresh({ maxAgeMs: claudeUsageOnDemandMaxAgeMs }), budget]);
  } finally {
    clearTimeout(timer);
  }
}
