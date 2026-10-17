/**
 * @description Adapter names (the `state.agents[key].name` value + factory key)
 * that code outside the adapters compares against. Kept apart from the adapter
 * modules so a reader of the name (the Jira config, say) does not load a whole
 * backend.
 */

/** The Claude Code backend driven over `--input-format/--output-format stream-json`. */
export const claudeJsonStreamAdapterName = 'claude-json-stream';

/** The OpenCode backend (a local HTTP server). */
export const openCodeAdapterName = 'opencode';

/**
 * The json-stream host stopped after EVERY turn (lifecycle plan L5, L-D3): the
 * same adapter class as {@link claudeJsonStreamAdapterName} with the per-turn
 * lifecycle, the same tmux session name and host dir per conversation.
 */
export const claudePerTurnAdapterName = 'claude-per-turn';

/** Both backends that run the json-stream host (one process per conversation at a time). */
export function checkIsJsonStreamBackend(name: string): boolean {
  return name === claudeJsonStreamAdapterName || name === claudePerTurnAdapterName;
}

/**
 * @description The three Claude Code backends. All drive the SAME `claude` CLI
 * against the SAME on-disk transcript, so a thread is cross-resumable between
 * them live:
 *  - `'claude'` — the tmux TUI, scraped screen (classic);
 *  - {@link claudeJsonStreamAdapterName} — an EXTERNAL tmux-hosted process
 *    streaming structured stream-json events over a FIFO + stdout file, so it
 *    survives bot restarts; stopped at the idle mark (the DEFAULT, see
 *    `getDefaultClaudeBackendName` (`createAdapter.ts`));
 *  - {@link claudePerTurnAdapterName} — the same host, stopped after each turn (L5).
 * `/claude_mode` flips a thread between them.
 */
export function checkIsClaudeBackend(name: string): boolean {
  return name === 'claude' || checkIsJsonStreamBackend(name);
}
