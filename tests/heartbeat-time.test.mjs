import { test } from "node:test";
import assert from "node:assert/strict";
import { heartbeatAgeMinutes, HEARTBEAT_CLOCK_SKEW_MS } from "../setup/heartbeat.mjs";

const now = Date.parse("2026-09-07T20:00:00.000Z");
test("valid current and past completion times retain their measured age", () => {
  assert.equal(heartbeatAgeMinutes("2026-09-07T20:00:00.000Z", now), 0);
  assert.equal(heartbeatAgeMinutes("2026-09-07T19:55:00.000Z", now), 5);
  assert.equal(heartbeatAgeMinutes("1970-01-01T00:00:00.000Z", now), Math.round(now / 60000));
});
test("unknown, malformed and future completion times are not health evidence", () => {
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
