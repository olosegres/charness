import type { PlatformId, SessionKey } from '../sessionKey';

/**
 * @description Which surfaces an instance serves (`CONNECTORS`, Jira connector
 * plan J3) and the ONE filter every scan of conversations goes through (J3b,
 * R10). A neutral module: the CLI preflight reads it to guard a start, the bot
 * to branch its boot — neither imports the other.
 */

export const connectorIds = ['telegram', 'jira'] as const;
export type ConnectorId = (typeof connectorIds)[number];

/** An unset `CONNECTORS` keeps the instance what it always was. */
export const defaultConnectors: readonly ConnectorId[] = ['telegram'];

function checkIsConnectorId(name: string): name is ConnectorId {
  return connectorIds.some((id) => id === name);
}

export type ConnectorsParse = { ok: true; connectors: ConnectorId[] } | { ok: false; error: string };

/** @description `CONNECTORS` as a comma list (`telegram`, `jira`), unset → Telegram only. */
export function parseConnectors(raw: string | undefined): ConnectorsParse {
  if (raw === undefined || raw.trim() === '') return { ok: true, connectors: [...defaultConnectors] };
  const names = raw.split(',').map((name) => name.trim()).filter((name) => name !== '');
  const unknown = names.filter((name) => !checkIsConnectorId(name));
  if (unknown.length > 0) {
    return { ok: false, error: `CONNECTORS has unknown connector(s) ${unknown.join(', ')} (known: ${connectorIds.join(', ')})` };
  }
  if (names.length === 0) return { ok: false, error: 'CONNECTORS names no connector' };
  return { ok: true, connectors: connectorIds.filter((id) => names.includes(id)) };
}

/** @description The platforms whose conversations an instance serving `connectors` owns. */
export function getServedPlatforms(connectors: readonly ConnectorId[]): ReadonlySet<PlatformId> {
  return new Set<PlatformId>(connectors);
}

/**
 * @description Only the entries (tmux sessions found at boot, bindings, …) whose
 * conversation belongs to one of `platforms`. Every boot scan adopts, resumes or
 * KILLS what it is given, so it first keeps what this instance serves: a Telegram
 * instance never touches a Jira conversation's session, nor a Jira instance a
 * Telegram one (the J1 review note).
 */
export function getServedConversations<T extends { key: SessionKey }>(
  entries: readonly T[],
  platforms: ReadonlySet<PlatformId>,
): T[] {
  return entries.filter(({ key }) => platforms.has(key.platform));
}
