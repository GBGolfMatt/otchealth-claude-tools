import { test } from "node:test";
import assert from "node:assert/strict";
import { planSeed, ENTITY_SEED, ALIAS_SEED } from "../skills/kb-memory/seed-current-cloud.mjs";

const normKey = (value) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

test("seed plan is idempotent when every approved row is identical", () => {
  const entities = ENTITY_SEED.map(({ key, value }, i) => ({ type: "entity", ekey: key, evalue: value, id: `e${i}`, ts: "1", agent: "cto" }));
  const aliases = ALIAS_SEED.map(({ phrase, target }, i) => ({ type: "alias", ekey: normKey(phrase), evalue: target, id: `a${i}`, ts: "1", agent: "cto", tags: ["current-value", "exact-match-only"] }));
  const plan = planSeed({ ok: true }, [...entities, ...aliases]);
  assert.equal(plan.ok, true);
  assert.equal(plan.operations.length, 0);
  assert.equal(plan.skipped.length, ENTITY_SEED.length + ALIAS_SEED.length);
});

test("seed plan refuses unsafe inventory or a differing existing value", () => {
  assert.equal(planSeed({ ok: false }, []).error_category, "unsafe_inventory");
  const { key } = ENTITY_SEED[0];
  const plan = planSeed({ ok: true }, [{ type: "entity", ekey: key, evalue: "different", id: "x", ts: "1", agent: "cto" }]);
  assert.equal(plan.ok, false);
  assert.equal(plan.conflicts[0].key, key);
  assert.equal(JSON.stringify(plan).includes("different"), false);
});

// Prevent a malicious near-match from being accepted as the gateway safety contract.
test("seed plan requires an exact tag token, not a substring", () => {
  const { phrase, target } = ALIAS_SEED[0];
  const plan = planSeed({ ok: true }, [{
    type: "alias",
    ekey: normKey(phrase),
    evalue: target,
    id: "bad-tag",
    ts: "1",
    agent: "cto",
    tags: "not-exact-match-only",
  }]);
  assert.equal(plan.ok, false);
  assert.equal(plan.conflicts.some((item) => item.key === normKey(phrase)), true);
});
