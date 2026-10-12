import type { SessionKey } from '../sessionKey';

/**
 * @description The Claude config directory a conversation's NEXT process must start with — the resolved
 * account profile's directory (`utils/claudeProfiles.ts`), or `null` for the default profile (nothing set,
 * the CLI uses `~/.claude`). Read by both Claude adapters at every spawn (start, resume, model/effort
 * re-spawn); registered by the bot at boot through `registerClaudeConfigDirReader` (same late-wiring idiom
 * as the session launch defaults). Until it is registered, every process runs on the default profile.
 */
export type ClaudeConfigDirReader = (key: SessionKey) => string | null;

/** A `rate_limit_event` a json-stream session reported, attributed to the config directory it runs under. */
export interface ClaudeRateLimitEvent {
  /** `allowed` / `allowed_warning` / `rejected` (the CLI's status for the request). */
  status: string | null;
  /** The window the status is about (`five_hour`, `seven_day`, …) and its reset instant. */
  rateLimitType: string | null;
  resetsAtMs: number | null;
  /** `rate_limit_info.unifiedWindows`, every window the frame carried (`utilization` 0..1). */
  windows: Array<{ name: string; utilization: number; resetsAtMs: number | null }>;
}

/**
 * @description Where the json-stream adapter reports a session's `rate_limit_event` frames — the bot folds
 * them into the usage snapshot of the profile that owns `configDir` (`null` = the default profile;
 * `utils/claudeUsageRefresher.ts`). Registered at boot through `registerClaudeRateLimitSink`.
 */
export type ClaudeRateLimitSink = (configDir: string | null, event: ClaudeRateLimitEvent) => void;

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
