import { keyToSlug, tryKeyFromString, type SessionKey } from '../sessionKey';

/**
 * @description Separator between the serialized key's own two halves inside a
 * tmux session name. `keyToString` joins them with `:`, which tmux treats as a
 * window/pane address separator, so the name swaps it for `-`.
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
 * Carefully handles negative chat ids: `claude--1001234-42` parses to
 * `-1001234:42`. We split from the right on the last `-` so the trailing token
 * is always the thread half regardless of the space half's sign.
 *
 * Strictness lives in the codec (audit S1 / #22): plain `Number(...)` accepts
 * `1e5`, `0x10`, `1.5`, `" 42 "`. Such values come from a foreign tmux session
 * whose name happens to share our prefix; treating them as ours would cause an
 * adopt path to attach to an unrelated session.
 */
export function parseTmuxSessionName(prefix: string, name: string): SessionKey | null {
  const head = `${prefix}-`;
  if (!name.startsWith(head)) return null;
  const rest = name.slice(head.length);
  const lastSeparator = rest.lastIndexOf(tmuxKeySeparator);
  if (lastSeparator <= 0) return null;
  return tryKeyFromString(`${rest.slice(0, lastSeparator)}:${rest.slice(lastSeparator + 1)}`);
}
