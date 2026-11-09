import assert from "node:assert/strict";
import test from "node:test";
import { sameReset } from "../runway/mods/runway/alerts.js";

test("accepts sub-minute reset jitter", () => {
  assert.equal(
    sameReset(
      "2026-11-09T05:39:59.680071+00:00",
      "2026-11-09T05:40:00.299568+00:00",
    ),
    true,
  );
});

test("accepts an exact reset", () => {
  assert.equal(
    sameReset("2026-11-16T00:00:00.000Z", "2026-11-16T00:00:00.000Z"),
    true,
  );
});

test("rejects a real reset change", () => {
  assert.equal(
    sameReset("2026-11-09T05:40:00.000Z", "2026-11-09T10:40:00.000Z"),
    false,
  );
  assert.equal(
    sameReset("2026-11-15T18:00:00.000Z", "2026-11-22T18:00:00.000Z"),
    false,
  );
});

test("falls back to exact matching for unparsable values", () => {
  assert.equal(sameReset("soon", "soon"), true);
  assert.equal(sameReset("soon", "later"), false);
});
