import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyHeartbeat, heartbeatAgeMinutes, HEARTBEAT_CLOCK_SKEW_MS,
} from "../setup/heartbeat.mjs";

const now = Date.parse("2026-09-07T20:00:00.000Z");
test("valid current and past completion times retain their measured age", () => {
  assert.equal(heartbeatAgeMinutes("2026-09-07T20:00:00.000Z", now), 0);
  assert.equal(heartbeatAgeMinutes("2026-09-07T19:55:00.000Z", now), 5);
  assert.equal(heartbeatAgeMinutes("1970-01-01T00:00:00.000Z", now), Math.round(now / 60000));
});

test("unknown, malformed and materially future completion times are not health evidence", () => {
  for (const value of [undefined, null, "", "not-a-date", 0, {}, "2026-09-07T20:01:00.001Z"]) {
    assert.equal(heartbeatAgeMinutes(value, now), null);
  }
  assert.equal(heartbeatAgeMinutes("2026-09-07T20:00:00.000Z", NaN), null);
});

test("bounded cross-host clock skew is clamped to zero and the limit is inclusive", () => {
  for (const ahead of [1, 30_000, HEARTBEAT_CLOCK_SKEW_MS]) {
    assert.equal(heartbeatAgeMinutes(new Date(now + ahead).toISOString(), now), 0);
  }
  assert.equal(heartbeatAgeMinutes(new Date(now + HEARTBEAT_CLOCK_SKEW_MS + 1).toISOString(), now), null);
});

test("a registered job with missing or invalid cadence is UNKNOWN and never LIVE", () => {
  const lastOk = new Date(now).toISOString();
  for (const intervalMin of [undefined, null, 0, -1, "5", NaN, Infinity]) {
    assert.deepEqual(classifyHeartbeat({ registered: true, intervalMin, lastOk, now }), {
      status: "UNKNOWN", ageMin: 0, intervalMin: null,
    });
  }
});

test("genuinely unregistered observations distinguish UNKNOWN, NO-DATA and invalid DEAD", () => {
  assert.equal(classifyHeartbeat({ registered: false, lastOk: new Date(now).toISOString(), now }).status, "UNKNOWN");
  assert.equal(classifyHeartbeat({ registered: false, lastOk: new Date(now - 365 * 86400000).toISOString(), now }).status, "UNKNOWN");
  assert.equal(classifyHeartbeat({ registered: false, lastOk: undefined, now }).status, "NO-DATA");
  assert.equal(classifyHeartbeat({ registered: false, lastOk: "not-a-date", now }).status, "DEAD");
  assert.equal(classifyHeartbeat({ registered: false, lastOk: new Date(now + HEARTBEAT_CLOCK_SKEW_MS + 1).toISOString(), now }).status, "DEAD");
});

test("valid registered cadence classifies missing, current, late and stale beats", () => {
  const classify = (lastOk) => classifyHeartbeat({ registered: true, intervalMin: 5, lastOk, now }).status;
  assert.equal(classify(undefined), "DEAD");
  assert.equal(classify("not-a-date"), "DEAD");
  assert.equal(classify(new Date(now).toISOString()), "LIVE");
  assert.equal(classify(new Date(now - 5 * 60000).toISOString()), "LIVE");
  assert.equal(classify(new Date(now - 6 * 60000).toISOString()), "LATE");
  assert.equal(classify(new Date(now - 15 * 60000).toISOString()), "LATE");
  assert.equal(classify(new Date(now - 16 * 60000).toISOString()), "DEAD");
});