// Pure helpers for the history card. Kept separate so they can be tested
// without a Herdr runtime.

export function currentWindowPoints(points, resetAt, span) {
  if (!resetAt || !span) return points;
  const start = resetAt - span;
  return points.filter((point) => point.t >= start);
}

export function burnRate(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const hours = (last.t - first.t) / 3600000;
  return hours > 0.05 ? (last.p - first.p) / hours : null;
}

export function projectedEnd(lastPercent, rate, resetAt, now) {
  if (typeof lastPercent !== "number" || rate === null || !resetAt) return null;
  const left = (resetAt - now) / 3600000;
  if (!(left > 0)) return null;
  return Math.max(0, lastPercent + rate * left);
}
