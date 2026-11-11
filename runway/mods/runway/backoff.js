// Exponential backoff for a source that answered 429.
export const BACKOFF_BASE_MS = 15 * 60000;
export const BACKOFF_MAX_MS = 60 * 60000;

export function nextBackoff(previous, now = Date.now()) {
  const attempt = Math.min((previous?.attempt ?? 0) + 1, 4);
  const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return { attempt, until: now + delay, delay };
}

export function backoffActive(backoff, now = Date.now()) {
  return Boolean(backoff && Number(backoff.until) > now);
}
