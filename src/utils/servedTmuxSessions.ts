import type { PlatformId, SessionKey } from '../sessionKey';

/**
 * @description The tmux sessions found at boot that belong to a platform this
 * instance serves (Jira connector plan J3, the J1 review note). The boot scan
 * adopts a session it owns and KILLS every other one it can parse — so a session
 * of a platform it does not serve is neither: a Telegram instance must not kill
 * a Jira instance's `*-jira-*` sessions on a shared server, nor a Jira instance
 * Telegram ones.
 */
export function getServedTmuxSessions<T extends { key: SessionKey }>(
  sessions: readonly T[],
  servedPlatforms: ReadonlySet<PlatformId>,
): T[] {
  return sessions.filter(({ key }) => servedPlatforms.has(key.platform));
}
