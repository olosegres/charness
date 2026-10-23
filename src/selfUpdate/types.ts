/** What the last check of the update engine saw — the raw observation `/update` and the policy are computed from. */
export type UpdateObservation =
  | { kind: 'npm'; latestVersion: string; engines: string | null; isDeprecated: boolean }
  | {
      kind: 'git';
      status: GitCheckStatus;
      reason: GitSkipReason | null;
      from: string;
      to: string;
      behind: number;
      migrationGuides: string[];
    }
  | { kind: 'error'; reason: string };

export type GitCheckStatus = 'upToDate' | 'behind' | 'skip';

/** Why `self-update.sh --check` leaves a checkout alone. */
export type GitSkipReason = 'dirty' | 'diverged' | 'noUpstream' | 'inProgress' | 'fetchFailed';

export interface SelfUpdateLastResult {
  /** Epoch ms of the check. */
  at: number;
  observation: UpdateObservation;
}

/**
 * The update engine's bookkeeping, persisted in `state.json` (`selfUpdate`). Targets are an npm version or a
 * checkout's target commit.
 */
export interface SelfUpdateRecord {
  /** When the last check ran, so a restart does not multiply checks. */
  lastCheckAt?: number;
  /** npm: when this bot FIRST saw each version — the hold counts from it. */
  firstSeenAt?: Record<string, number>;
  /** Targets whose install failed: never retried by itself, a newer target is tried. */
  failedTargets?: string[];
  /** Targets already announced (notify, offer, "needs Node"): one message per target. */
  notifiedTargets?: string[];
  lastResult?: SelfUpdateLastResult;
  /** True after a check failed and until one succeeds — so a failing registry is announced once. */
  isCheckFailing?: boolean;
  /** The one-time "Automatic updates are on" message was posted. */
  isFeatureAnnounced?: boolean;
}

/** The version (and, for a checkout, the commit) the bot ran at its previous boot. */
export interface LastRunVersion {
  version: string;
  commit: string | null;
}
