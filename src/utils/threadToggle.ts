/**
 * @description The resolution rule shared by every DEFAULT-ON per-thread toggle
 * (`/compact_on_idle`, `/auto_continue_limits`, `/compact_summary`): a per-thread
 * override always wins, otherwise the instance-wide default applies, and an unset
 * default means ON.
 *
 * Extracted because the same four lines were already written out twice and the
 * third toggle would have made three copies of one rule — the kind of duplication
 * where one copy silently stops matching the others. Each toggle keeps its OWN
 * named wrapper: the name is what documents which setting is being resolved (and
 * why ON is the right default for it), so call sites and tests stay unchanged.
 */

/**
 * @description Resolve a default-ON per-thread toggle. `threadOverride` present
 * (true OR false) wins over everything; otherwise `globalDefault`; `undefined`
 * for both means ON.
 *
 * Both inputs are `boolean | undefined` on purpose: "never set" must stay
 * distinguishable from an explicit `false`, or a General «Disable» would be
 * re-enabled by the default on the next boot.
 */
export function resolveDefaultOnThreadToggle(
  globalDefault: boolean | undefined,
  threadOverride: boolean | undefined,
): boolean {
  if (threadOverride !== undefined) return threadOverride;
  return globalDefault ?? true;
}
