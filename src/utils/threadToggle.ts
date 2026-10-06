/**
 * @description The resolution rule shared by every per-thread toggle with an
 * instance-wide default (`/compact_on_idle`, `/auto_continue_limits`,
 * `/compact_summary`): a per-thread override always wins, otherwise the
 * instance-wide default applies, and an unset default means the setting's own
 * fallback — ON for the first two, OFF for `/compact_summary`.
 *
 * Extracted because the same four lines were already written out twice and the
 * third toggle would have made three copies of one rule — the kind of duplication
 * where one copy silently stops matching the others. Each toggle keeps its OWN
 * named wrapper: the name is what documents which setting is being resolved (and
 * why its fallback is the right one), so call sites and tests stay unchanged.
 */

/**
 * @description Resolve a per-thread toggle. `threadOverride` present (true OR
 * false) wins over everything; otherwise `globalDefault`; `undefined` for both
 * means `unsetValue`.
 *
 * Both inputs are `boolean | undefined` on purpose: "never set" must stay
 * distinguishable from an explicit value, or a General «Disable» would be
 * re-enabled by the fallback on the next boot.
 */
export function resolveThreadToggle(
  globalDefault: boolean | undefined,
  threadOverride: boolean | undefined,
  unsetValue: boolean,
): boolean {
  if (threadOverride !== undefined) return threadOverride;
  return globalDefault ?? unsetValue;
}

/**
 * @description {@link resolveThreadToggle} for a toggle that is ON when nothing is
 * set.
 */
export function resolveDefaultOnThreadToggle(
  globalDefault: boolean | undefined,
  threadOverride: boolean | undefined,
): boolean {
  return resolveThreadToggle(globalDefault, threadOverride, true);
}
