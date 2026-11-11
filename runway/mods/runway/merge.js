// Keep the last good reading when a scheduled update fails.
//
// A failed record is not merged into the snapshot directly: its `windows` are
// empty, which would erase the numbers the user is still looking at. The old
// record stays usable and the failure moves into `stale_*` fields instead.
// `error` stays null so existing readers keep treating the data as valid.

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function iso(now) {
  const date = new Date(now);
  return Number.isFinite(date.getTime())
    ? date.toISOString()
    : new Date().toISOString();
}

export function hasReading(provider) {
  if (!isRecord(provider) || provider.error) return false;
  const windows = Array.isArray(provider.windows) ? provider.windows : [];
  return (
    windows.length > 0 ||
    provider.money != null ||
    provider.period_ends_at != null ||
    (typeof provider.plan === "string" && provider.plan.length > 0)
  );
}

function clearStale(record) {
  return {
    ...record,
    stale: false,
    stale_at: null,
    stale_error: null,
    stale_code: null,
    stale_action: null,
    stale_failure: null,
    stale_retry_at: null,
  };
}

export function mergeReading(previous, next, now = Date.now()) {
  if (!isRecord(next)) return isRecord(previous) ? previous : null;
  const at = iso(now);
  if (!next.error) {
    return { ...clearStale(next), last_success_at: at };
  }
  if (!hasReading(previous)) {
    return {
      ...clearStale(next),
      last_success_at: previous?.last_success_at ?? null,
    };
  }
  return {
    ...previous,
    error: null,
    code: null,
    action: null,
    failure: null,
    http_status: null,
    credential_expires_at: next.credential_expires_at ?? previous.credential_expires_at ?? null,
    stale: true,
    stale_at: at,
    stale_error: String(next.error),
    stale_code: next.code ? String(next.code) : null,
    stale_action: next.action ? String(next.action) : null,
    stale_failure: next.failure ? String(next.failure) : null,
    stale_retry_at: next.retry_at ? String(next.retry_at) : null,
    last_success_at: previous.last_success_at ?? previous.updated ?? null,
  };
}

export function mergeCcusage(previous, next, now = Date.now()) {
  if (!isRecord(next)) return isRecord(previous) ? previous : null;
  const at = iso(now);
  if (!next.error) return clearStale(next);
  const agents = previous?.agents;
  const hasData = agents && typeof agents === "object" &&
    !Array.isArray(agents) && Object.keys(agents).length > 0;
  if (!hasData) return clearStale(next);
  return {
    ...previous,
    stale: true,
    stale_at: at,
    stale_error: String(next.error),
    stale_code: next.code ? String(next.code) : null,
    stale_failure: next.failure ? String(next.failure) : null,
  };
}
