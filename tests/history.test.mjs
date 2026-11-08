import assert from "node:assert/strict";
import test from "node:test";
import {
  burnRate,
  currentWindowPoints,
  projectedEnd,
} from "../runway/mods/runway-detail/history.js";

const HOUR = 3600000;

test("currentWindowPoints drops points from earlier windows", () => {
  const points = [
    { t: 1 * HOUR, p: 10 },
    { t: 2 * HOUR, p: 20 },
    { t: 7 * HOUR, p: 5 },
    { t: 8 * HOUR, p: 15 },
  ];
  const current = currentWindowPoints(points, 12 * HOUR, 5 * HOUR);
  assert.deepEqual(current.map((point) => point.p), [5, 15]);
});

test("burnRate uses only the current window", () => {
  const points = [
    { t: 1 * HOUR, p: 10 },
    { t: 2 * HOUR, p: 20 },
    { t: 7 * HOUR, p: 5 },
    { t: 8 * HOUR, p: 15 },
  ];
  const current = currentWindowPoints(points, 12 * HOUR, 5 * HOUR);
  assert.equal(burnRate(current), 10);
});

test("burnRate needs two points", () => {
  assert.equal(burnRate([{ t: 1, p: 10 }]), null);
});

test("projectedEnd projects from the current point", () => {
  assert.equal(projectedEnd(15, 10, 12 * HOUR, 8 * HOUR), 55);
  assert.equal(projectedEnd(15, 10, 7 * HOUR, 8 * HOUR), null);
});
