/**
 * @description Pure routing decision for the bot-owned `/compact` command.
 *
 * `/compact` means three different things depending on the thread's backend, so
 * the bot cannot handle it uniformly — and it must NOT fall through to the
 * "forward un-owned slash commands verbatim" path for every backend: OpenCode's
 * only prompt transport (`POST /session/:id/prompt_async`) does no slash-command
 * parsing, so the literal text reached the model as an ordinary prompt and
 * wasted a full turn without compacting anything. Real compaction there is a
 * separate endpoint, reached through the adapter's `compactContext`.
 *
 * Kept out of `bot.ts` (which cannot be imported by tests — its module-scope
 * `parseEnv()` exits without a bot token) so the three-way decision is
 * unit-testable, mirroring `getLoginCommandRoute` in `claudeAuthLogin.ts`.
 */

/**
 * @name CompactCommandRoute
 * @description How a `/compact` command is handled for a thread.
 *  - `adapterCompact` — the backend exposes a server-side compaction endpoint
 *    (OpenCode `POST /session/:id/summarize`): call `adapter.compactContext`.
 *  - `notSupported` — a raw shell has no context to compact, and typing
 *    `/compact` into it would just run a meaningless command → reply a notice.
 *  - `forwardToAgent` — the backend's own CLI/TUI parses `/compact` natively
 *    (both Claude backends): forward the literal slash command, unchanged.
 */
export type CompactCommandRoute = 'adapterCompact' | 'notSupported' | 'forwardToAgent';

/**
 * @description Route a `/compact` command for a thread. The adapter capability
 * wins: a backend that can really compact always does, whatever its name.
 * Otherwise the terminal backend is singled out as unsupported and every
 * remaining backend keeps the pre-existing verbatim forward — so the Claude
 * backends, whose TUI owns `/compact`, are unaffected.
 *
 * `terminalAdapterName` is injected (like `checkIsJsonStreamBackend` in
 * {@link getLoginCommandRoute}) to keep this helper free of an adapter import.
 */
export function getCompactCommandRoute(input: {
  /** Whether the thread's adapter implements the optional `compactContext`. */
  hasCompactContext: boolean;
  /** `adapter.name` of the thread's backend. */
  adapterName: string;
  /** `adapter.name` of the raw-shell backend. */
  terminalAdapterName: string;
}): CompactCommandRoute {
  if (input.hasCompactContext) return 'adapterCompact';
  if (input.adapterName === input.terminalAdapterName) return 'notSupported';
  return 'forwardToAgent';
}
