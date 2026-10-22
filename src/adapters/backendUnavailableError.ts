/**
 * @description An agent backend whose server could not be brought up within the adapter's own retries (OpenCode:
 * `opencode serve` would not start, its binary missing or the server never ready). The conversation itself is
 * intact, so a resume that fails this way must not be taken for a lost conversation and replaced by a fresh one;
 * the message is for the log only — the topic is told in one localized line (`agent.serverUnavailableNotice`).
 */
export class AgentBackendUnavailableError extends Error {
  constructor(readonly backendLabel: string, lastAttemptError: unknown) {
    super(`${backendLabel} server unavailable: ${lastAttemptError instanceof Error ? lastAttemptError.message : String(lastAttemptError)}`);
    this.name = 'AgentBackendUnavailableError';
  }
}
