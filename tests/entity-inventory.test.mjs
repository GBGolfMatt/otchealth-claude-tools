import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVED_ALIASES, APPROVED_ENTITIES, summarizeApprovedRows } from "../skills/kb-memory/entity-inventory.mjs";

const row = (type, ekey, evalue, id, extra = {}) => ({
  type, ekey, evalue, id, ts: `2026-09-07T00:00:0${id.length}Z`, agent: "cto", ...extra,
});

test("shared inventory emits only allowlisted metadata and never values", () => {
  const rows = [
    row("entity", "otchealth_primary_cloud", "SECRET-VALUE-MUST-NOT-LEAK", "e1"),
    row("entity", "unrelated_private_key", "ANOTHER-SECRET", "e2"),
    row("alias", "what_is_otchealth_s_current_primary_cloud", "otchealth_primary_cloud", "a1"),
  ];
  const summary = summarizeApprovedRows(rows, { scanned_files: 3, parsed_rows: 99, invalid_rows: 0 });
  assert.equal(summary.ok, true);
  assert.equal(summary.owner, "cto");
  assert.equal(summary.scanned_shared_files, 3);
  assert.equal(summary.parsed_shared_rows, 99);
  assert.deepEqual(summary.entities, [{ key: "otchealth_primary_cloud", owner: "cto", source_row_id: "e1" }]);
  assert.deepEqual(summary.missing_approved_entities, APPROVED_ENTITIES.filter((key) => key !== "otchealth_primary_cloud"));
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes("SECRET-VALUE"), false);
  assert.equal(serialized.includes("unrelated_private_key"), false);
});

test("shared inventory fails closed on malformed or empty source output", () => {
  assert.equal(summarizeApprovedRows([], { scanned_files: 0, parsed_rows: 0, invalid_rows: 0 }).ok, false);
  assert.equal(summarizeApprovedRows([], { scanned_files: 1, parsed_rows: 2, invalid_rows: 1 }).ok, false);
});

test("shared inventory rejects an unexpected owner and an unchained same-key correction", () => {
  const first = row("entity", "otchealth_brain_backend", "one", "one");
  const fork = row("entity", "otchealth_brain_backend", "two", "two", { ts: "2026-09-08", supersedes: undefined });
  const other = row("alias", "what_is_otchealth_s_current_primary_cloud", "otchealth_primary_cloud", "x", { agent: "developer" });
  const summary = summarizeApprovedRows([first, fork, other], { scanned_files: 2, parsed_rows: 3, invalid_rows: 0 });
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.forked_keys, ["otchealth_brain_backend"]);
  assert.equal(summary.unexpected_owners[0].owner, "developer");
});

test("approved apostrophe alias uses the same normalization as the seed writer", () => {
  assert.ok(APPROVED_ALIASES.includes("what_is_otchealth_s_current_primary_cloud"));
  assert.equal(APPROVED_ALIASES.includes("what_is_otchealths_current_primary_cloud"), false);
});

test("invalid alias targets fail closed without exposing the target value", () => {
  const malformed = row("alias", APPROVED_ALIASES[0], "ARBITRARY-PRIVATE-VALUE", "bad");
  const summary = summarizeApprovedRows([malformed], { scanned_files: 1, parsed_rows: 1, invalid_rows: 0 });
  assert.equal(summary.ok, false);
  assert.equal(summary.invalid_alias_targets.length, 1);
  assert.equal(JSON.stringify(summary).includes("ARBITRARY-PRIVATE-VALUE"), false);
  assert.equal(summary.aliases.length, 0);
});
