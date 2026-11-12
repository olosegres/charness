/**
 * @description Narrow an untyped value (a `JSON.parse` result, a control-channel payload) to a plain object — not `null`, not an
 * array. The parse-boundary guard for data the bot does not control.
 */
export function checkIsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
