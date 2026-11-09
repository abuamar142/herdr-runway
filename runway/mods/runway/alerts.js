// Claude reports the same reset window with sub-second jitter on each read.
// Treat small differences as the same reset so a reload does not announce a
// reset that did not happen.
export const RESET_TOLERANCE_MS = 60000;

export function sameReset(left, right) {
  if (left === right) return true;
  const a = Date.parse(left);
  const b = Date.parse(right);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= RESET_TOLERANCE_MS;
}
