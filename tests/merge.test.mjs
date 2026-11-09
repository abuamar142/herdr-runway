import assert from "node:assert/strict";
import test from "node:test";
import {
  hasReading,
  mergeCcusage,
  mergeReading,
} from "../runway/mods/runway/merge.js";

const old = {
  id: "claude",
  name: "Claude",
  plan: "pro",
  windows: [{ key: "five_hour", percent: 54 }],
  money: null,
  updated: "2026-11-09T01:00:00.000Z",
  last_success_at: "2026-11-09T01:00:00.000Z",
  error: null,
};
const failure = {
  id: "claude",
  name: "Claude",
  windows: [],
  money: null,
  error: "quota-axi timed out",
  code: "timeout",
  action: "Try again later.",
  failure: "No answer within 20 seconds.",
};

test("success replaces data and clears stale", () => {
  const stale = { ...old, stale: true, stale_error: "old failure" };
  const next = { ...old, windows: [{ key: "five_hour", percent: 60 }] };
  const merged = mergeReading(stale, next, "2026-11-09T01:05:00.000Z");
  assert.equal(merged.windows[0].percent, 60);
  assert.equal(merged.stale, false);
  assert.equal(merged.stale_error, null);
  assert.equal(merged.last_success_at, "2026-11-09T01:05:00.000Z");
});

test("failure keeps the previous reading and marks it stale", () => {
  const merged = mergeReading(old, failure, "2026-11-09T01:05:00.000Z");
  assert.equal(merged.error, null);
  assert.equal(merged.stale, true);
  assert.equal(merged.stale_error, "quota-axi timed out");
  assert.equal(merged.stale_code, "timeout");
  assert.deepEqual(merged.windows, old.windows);
  assert.equal(merged.last_success_at, old.last_success_at);
});

test("failure without a reading stays an error", () => {
  const merged = mergeReading(
    { id: "claude", windows: [], error: null },
    failure,
    0,
  );
  assert.equal(merged.error, "quota-axi timed out");
  assert.equal(merged.stale, false);
  assert.deepEqual(merged.windows, []);
});

test("a second failure keeps the original last success", () => {
  const stale = mergeReading(old, failure, "2026-11-09T01:05:00.000Z");
  const merged = mergeReading(stale, failure, "2026-11-09T01:10:00.000Z");
  assert.equal(merged.last_success_at, old.last_success_at);
  assert.equal(merged.stale_at, "2026-11-09T01:10:00.000Z");
  assert.deepEqual(merged.windows, old.windows);
});

test("hasReading rejects errors and empty records", () => {
  assert.equal(hasReading(old), true);
  assert.equal(hasReading(failure), false);
  assert.equal(hasReading({ id: "claude", windows: [] }), false);
  assert.equal(hasReading({ id: "claude", windows: [], plan: "pro" }), true);
});

test("ccusage failure keeps the old agents", () => {
  const previous = {
    fetched_at: "2026-11-09T01:00:00.000Z",
    agents: { claude: { today: { tokens: 10 } } },
  };
  const merged = mergeCcusage(previous, {
    ...failure,
    fetched_at: "2026-11-09T01:05:00.000Z",
  }, "2026-11-09T01:05:00.000Z");
  assert.equal(merged.stale, true);
  assert.equal(merged.fetched_at, previous.fetched_at);
  assert.deepEqual(merged.agents, previous.agents);
});

test("ccusage success clears stale", () => {
  const stale = {
    ...mergeCcusage({ agents: { claude: {} } }, failure, 0),
    stale: true,
  };
  const merged = mergeCcusage(stale, {
    fetched_at: "2026-11-09T01:05:00.000Z",
    agents: { codex: {} },
  }, 0);
  assert.equal(merged.stale, false);
  assert.equal(merged.stale_error, null);
  assert.deepEqual(merged.agents, { codex: {} });
});
