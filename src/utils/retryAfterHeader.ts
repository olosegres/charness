const msPerSecond = 1_000;

/**
 * @description An HTTP `Retry-After` header as a wait in ms: delay-seconds or an
 * HTTP date (RFC 9110 §10.2.3), never negative; `null` when absent or
 * unreadable, so the caller falls back to its own backoff. Callers cap it.
 */
export function getRetryAfterHeaderMs(headerValue: string | null | undefined, nowMs: number): number | null {
  if (headerValue === null || headerValue === undefined || headerValue.trim() === '') return null;
  const seconds = Number(headerValue);
  const waitMs = Number.isFinite(seconds) ? seconds * msPerSecond : Date.parse(headerValue) - nowMs;
  return Number.isFinite(waitMs) ? Math.max(waitMs, 0) : null;
}
