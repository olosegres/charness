/**
 * @description Pure reply-decision for the four `/model`-set paths (the
 * `/model <num>` and `/model <name>` commands, the text-handler numeric pick,
 * and the `model_<id>` button callback — all through `applyModelSelection` in
 * `connectors/telegram/commands/modelProviders.ts`). All four asked the adapter to
 * set the model and now must build the SAME user-facing reply — so the branchy
 * decision lives here, unit-testable without the Telegraf machinery (same
 * pattern as `statusFlushDecision.ts`).
 *
 * The no-session decision itself now lives in the adapters (OpenCode persists
 * the pref and returns success; Claude refuses with a notice), so this helper
 * is purely about turning the adapter's outcome into a message — it does NOT
 * gate on session state itself.
 *
 * `isActive` only distinguishes the two SUCCESS copies: a live switch
 * (`model.set_success`) vs a pref saved for the next agent start
 * (`model.saved_for_next_start`). BOTH copies come from i18n, so a `translate`
 * callback is injected (callers pass `t`; tests pass a stub) to keep this module
 * free of the i18n import and trivially testable. The live copy used to be a
 * hardcoded English template literal — once the effort hint below was appended
 * to it, a non-English chat would have read an English headline above a
 * translated hint, so it moved into the catalog too.
 *
 * Both success copies carry the SHARED `effort.current_hint` block (the same key
 * the post-start `agent.ready` notice renders), so the level in force and the
 * "/effort to change it" pointer can never drift between the two messages. The
 * caller must resolve `effort` AFTER `setModel` returned: switching to a model
 * that does not offer the current level clears it (see
 * `effort.cleared_on_model_switch`), so a pre-switch read would name a level
 * that no longer applies.
 *
 * @name ModelSetReplyDecision
 * @description
 * - `unsupported` — the adapter has no `setModel`: nothing was changed.
 * - `error`       — `setModel` returned a non-null error string.
 * - success (`isOk: true`) — live switch or deferred-to-next-start save.
 */
export interface ModelSetReplyDecisionInput {
  /** Does the thread's adapter implement `setModel`? */
  hasSetModel: boolean;
  /** Error string returned by `setModel`, or `null` on success. */
  setModelError: string | null;
  /** Is the thread's agent session live right now? */
  isActive: boolean;
  /** Human-facing agent label (e.g. "Claude Code"), for the unsupported copy. */
  adapterLabel: string;
  /** Resolved model label to show on success (current model or the picked id). */
  displayLabel: string;
  /**
   * Reasoning effort in force AFTER the switch, or `null` when the backend has
   * no effort concept (Claude tmux/terminal) — then no effort block is appended.
   */
  effort: string | null;
}

export interface ModelSetReplyDecision {
  isOk: boolean;
  message: string;
}

/**
 * @description Build the reply for a `/model`-set attempt.
 *
 * @param translate i18n lookup (`t`) — used for both success copies and the
 * shared effort block. The `unsupported` / `error` branches carry no effort
 * hint: nothing was switched, so naming the level would only add noise.
 */
export function getModelSetReplyDecision(
  input: ModelSetReplyDecisionInput,
  translate: (code: string, vars?: Record<string, string | number>) => string,
): ModelSetReplyDecision {
  if (!input.hasSetModel) {
    return { isOk: false, message: `Model switching not supported for ${input.adapterLabel}` };
  }
  if (input.setModelError) {
    return { isOk: false, message: `Error: ${input.setModelError}` };
  }
  const effortSuffix = input.effort === null
    ? ''
    : `\n${translate('effort.current_hint', { effort: input.effort })}`;
  const successKey = input.isActive ? 'model.set_success' : 'model.saved_for_next_start';
  return {
    isOk: true,
    message: translate(successKey, { model: input.displayLabel }) + effortSuffix,
  };
}
