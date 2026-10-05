/**
 * @description The pure decision behind `ensureAgentSession` (plan
 * 2026-10-04-claude-process-lifecycle, L-D4): what to do so a conversation has a
 * live agent session. A conversation whose process is gone but whose session id
 * is still persisted is SLEEPING — it is resumed, never replaced by a fresh
 * session; only `/quit`, `/new` and leaving the folder release the id. Every
 * trigger (a message, a Jira request, a limit resume, a wake-up, a schedule) and
 * every command that needs a live agent goes through the one choke point that
 * acts on this plan, so no path can start a fresh conversation over a sleeping one.
 */

import { openCodeAdapterName } from '../adapters/adapterNames';

/** The persisted ids a conversation's agent row carries (one per backend family). */
export interface PersistedSessionIds {
  claudeSessionId?: string;
  opencodeSessionId?: string;
}

export type EnsureSessionPlan =
  /** A live session, or a start already under way (prompts buffer and replay). */
  | { kind: 'ready' }
  /** No folder bound — nothing can start. */
  | { kind: 'unbound' }
  /** Bound, but no adapter resolves and the caller gave no fallback — refuse. */
  | { kind: 'noAdapter' }
  /** A sleeping conversation: resume `sessionId` on `adapterName` (silently). */
  | { kind: 'resume'; adapterName: string; sessionId: string }
  /** Nothing to resume and the caller allows a fresh start. */
  | { kind: 'start'; adapterName: string }
  /** Nothing to resume and the caller allows NO fresh start (a reminder, a topic's wake-up). */
  | { kind: 'nothingToResume' };

export interface EnsureSessionPlanInput {
  isActive: boolean;
  isStarting: boolean;
  hasBinding: boolean;
  /** The adapter the session would run on, already resolved (explicit pick → in-memory → persisted → fallback). */
  adapterName: string | null;
  /** Whether `adapterName` is one of the two Claude backends (they share the on-disk transcript and its id). */
  isClaudeBackend: boolean;
  persistedIds: PersistedSessionIds | null;
  /** Resume a sleeping session but never start a fresh one. */
  isResumeOnly: boolean;
}

/**
 * @description The persisted session id that belongs to `adapterName`: the Claude
 * id for either Claude backend, the OpenCode id for OpenCode, none for a shell or
 * an unknown adapter. Mirrors the id-wiping rule of the adapter switch, so an id
 * of another family is never resumed on the wrong backend.
 */
export function getPersistedSessionIdForAdapter(
  persistedIds: PersistedSessionIds | null,
  adapterName: string,
  isClaudeBackend: boolean,
): string | null {
  if (!persistedIds) return null;
  if (isClaudeBackend) return persistedIds.claudeSessionId ?? null;
  if (adapterName === openCodeAdapterName) return persistedIds.opencodeSessionId ?? null;
  return null;
}

export function getEnsureSessionPlan(input: EnsureSessionPlanInput): EnsureSessionPlan {
  if (input.isActive || input.isStarting) return { kind: 'ready' };
  if (!input.hasBinding) return { kind: 'unbound' };
  if (!input.adapterName) return { kind: 'noAdapter' };
  const sessionId = getPersistedSessionIdForAdapter(input.persistedIds, input.adapterName, input.isClaudeBackend);
  if (sessionId) return { kind: 'resume', adapterName: input.adapterName, sessionId };
  if (input.isResumeOnly) return { kind: 'nothingToResume' };
  return { kind: 'start', adapterName: input.adapterName };
}

/**
 * @description What follows a resume that FAILED (the CLI refused the id, the
 * process did not come up): a caller that may start fresh does — the conversation
 * is told its previous one could not be resumed; a resume-only caller stops.
 */
export function getResumeFailureAction(isResumeOnly: boolean): 'startFresh' | 'fail' {
  return isResumeOnly ? 'fail' : 'startFresh';
}
