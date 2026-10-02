import { keyToSlug, tryKeyFromSlug, type SessionKey } from '../sessionKey';

/**
 * @description What every `:` of the serialized key becomes inside a tmux
 * session name. `keyToString` joins the key's parts with `:`, which tmux treats
 * as a window/pane address separator, so the name swaps it for `-`.
 */
const tmuxKeySeparator = '-';

/**
 * @description Tmux session name for a `SessionKey`, namespaced by a backend
 * `prefix` so different adapters (Claude `claude-…`, terminal `term-…`) never
 * collide on one tmux server.
 *
 * Format: `<prefix>-<serializedKey with ':' → '-'>`, which for Telegram is the
 * historical `<prefix>-<chatId>-<threadId>`. Negative chat ids (forum
 * supergroups are negative) keep their minus sign — tmux session names accept
 * it. The format is `parse`-able back to `SessionKey` via
 * {@link parseTmuxSessionName} with the SAME prefix.
 *
 * The connector's codec owns the serialized halves, so this helper never looks
 * at platform-specific fields and the on-disk names stay byte-identical.
 */
export function buildTmuxSessionName(prefix: string, key: SessionKey): string {
  return `${prefix}-${keyToSlug(key, tmuxKeySeparator)}`;
}

/**
 * @description Inverse of {@link buildTmuxSessionName} for a given `prefix`.
 * Returns `null` for names that don't parse back to a key (e.g. an unrelated
 * tmux session a user started by hand, or one owned by a different backend's
 * prefix).
 *
 * The slug after the prefix is read back by the codec that owns it
 * ({@link tryKeyFromSlug}): Telegram's `claude--1001234-42` parses to
 * `-1001234:42` (split on the last `-`, whatever the chat id's sign), Jira's
 * `claude-jira-PROJ-PROJ-12` to `jira:PROJ:PROJ-12`.
 *
 * Strictness lives in the codec (audit S1 / #22): plain `Number(...)` accepts
 * `1e5`, `0x10`, `1.5`, `" 42 "`. Such values come from a foreign tmux session
 * whose name happens to share our prefix; treating them as ours would cause an
 * adopt path to attach to an unrelated session.
 */
export function parseTmuxSessionName(prefix: string, name: string): SessionKey | null {
  const head = `${prefix}-`;
  if (!name.startsWith(head)) return null;
  return tryKeyFromSlug(name.slice(head.length), tmuxKeySeparator);
}
