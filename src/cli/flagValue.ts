/**
 * @description Reading a flag spelled `--name value` or `--name=value` out of an argument list, for the small
 * subcommands of the `charness` binary (`claude-profiles` and its `credit`).
 */

/** The value of a flag spelled `--name value` or `--name=value`; `null` when argument `index` is not that flag, `undefined` when it has no value. */
export function readFlagValue(argv: readonly string[], index: number, name: string): { value: string | undefined; consumed: number } | null {
  const arg = argv[index];
  if (arg === name) {
    const value = argv[index + 1];
    return value === undefined || value.startsWith('--') ? { value: undefined, consumed: 0 } : { value, consumed: 1 };
  }
  return arg.startsWith(`${name}=`) ? { value: arg.slice(name.length + 1), consumed: 0 } : null;
}
