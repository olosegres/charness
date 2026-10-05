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
