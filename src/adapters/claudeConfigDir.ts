import type { SessionKey } from '../sessionKey';

/**
 * @description The Claude config directory a conversation's NEXT process must start with — the resolved
 * account profile's directory (`utils/claudeProfiles.ts`), or `null` for the default profile (nothing set,
 * the CLI uses `~/.claude`). Read by both Claude adapters at every spawn (start, resume, model/effort
 * re-spawn); registered by the bot at boot through `registerClaudeConfigDirReader` (same late-wiring idiom
 * as the session launch defaults). Until it is registered, every process runs on the default profile.
 */
export type ClaudeConfigDirReader = (key: SessionKey) => string | null;

/** What a live Claude session reports about the account it runs on and whether it matches the topic's pick. */
export type ClaudeConfigDirApplyResult =
  /** No live process for the key: the next resume reads the reader by itself. */
  | 'inactive'
  /** The running process already uses the resolved directory. */
  | 'unchanged'
  /** The process was re-spawned (same conversation) under the resolved directory. */
  | 'respawned'
  /** The process works; the switch is applied once its turn ends. */
  | 'deferred';
