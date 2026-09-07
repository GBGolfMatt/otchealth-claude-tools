import { test } from "node:test";
import assert from "node:assert/strict";
import { assertCrossLaneAllowed } from "../skills/kb-memory/lane-policy.mjs";

test("personal legal lane rejects cross-lane access in both directions", () => {
  assert.throws(() => assertCrossLaneAllowed("cto", "clo-personal"), /prohibited/);
  assert.throws(() => assertCrossLaneAllowed("clo-personal", "cto"), /prohibited/);
  assert.doesNotThrow(() => assertCrossLaneAllowed("clo-personal", "clo-personal"));
  assert.doesNotThrow(() => assertCrossLaneAllowed("developer", "cto"));
});
