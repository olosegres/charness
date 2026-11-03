/**
 * @description A request's prompt is stored when the request opens (R21), and may be delivered hours later — behind a
 * running turn, through a usage-limit wait, in a wake-up's resend. A connector whose prompt says something that can
 * change in the meantime (the Jira mention note names the hand-over requests that are open) registers ONE refresher: it
 * gets a stored prompt as it is about to be delivered and returns the text to deliver instead — the same text when it
 * knows nothing better, which is every prompt it did not build itself. Every place that turns a stored prompt into
 * delivered text goes through {@link refreshStoredPrompt}.
 */

export type StoredPromptRefresher = (promptText: string) => string;

let currentRefresher: StoredPromptRefresher | null = null;

/** @description Register `refresher`, replacing the previous one (a process has one connector that needs it). */
export function setStoredPromptRefresher(refresher: StoredPromptRefresher): void {
  currentRefresher = refresher;
}

/** @description Drop `refresher` — only when it is still the registered one, so a stopped older connector never removes a newer one's. */
export function clearStoredPromptRefresher(refresher: StoredPromptRefresher): void {
  if (currentRefresher === refresher) currentRefresher = null;
}

/** @description `promptText` as it should be delivered now. Never throws: a refresher that fails leaves the stored text. */
export function refreshStoredPrompt(promptText: string): string {
  if (!currentRefresher) return promptText;
  try {
    return currentRefresher(promptText);
  } catch (error) {
    console.warn(`[storedPromptRefresh] kept the stored prompt: ${error instanceof Error ? error.message : String(error)}`);
    return promptText;
  }
}
