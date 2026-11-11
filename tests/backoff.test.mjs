import assert from "node:assert/strict";
import test from "node:test";
import { backoffActive, nextBackoff } from "../runway/mods/runway/backoff.js";

test("backoff doubles and caps at an hour", () => {
  let previous = null;
  const delays = [];
  for (let index = 0; index < 5; index += 1) {
    previous = nextBackoff(previous, 0);
    delays.push(previous.delay);
  }
  assert.deepEqual(delays, [900000, 1800000, 3600000, 3600000, 3600000]);
});

test("an active backoff suppresses reads until its deadline", () => {
  const backoff = nextBackoff(null, 1000);
  assert.equal(backoffActive(backoff, 1000), true);
  assert.equal(backoffActive(backoff, backoff.until - 1), true);
  assert.equal(backoffActive(backoff, backoff.until), false);
});
