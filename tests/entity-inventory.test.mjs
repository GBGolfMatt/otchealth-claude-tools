import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVED_KEYS, summarizeEntityList } from "../skills/kb-memory/entity-inventory.mjs";

test("inventory emits only approved names, counts, owner, and row ids", () => {
  const raw = [
    "# CURRENT VALUES (cto ledger) - 6 entities",
    "otchealth_primary_cloud = SECRET-VALUE-MUST-NOT-LEAK   [2026-09-07 cto-row-1]",
    "unrelated_private_key = ANOTHER-SECRET   [2026-09-07 cto-row-2]",
    "otchealth_brain_backend = Amazon OpenSearch Service   [2026-09-07 cto-row-3]",
    "## aliases",
    "what_is_current -> otchealth_brain_backend",
    "private_alias -> unrelated_private_key",
  ].join("\n");

  const summary = summarizeEntityList(raw);
  assert.equal(summary.owner, "cto");
  assert.equal(summary.total_entity_count, 6);
  assert.equal(summary.total_alias_count, 2);
  assert.equal(summary.present_approved_count, 2);
  assert.deepEqual(summary.entities, [
    { key: "otchealth_brain_backend", source_row_id: "cto-row-3" },
    { key: "otchealth_primary_cloud", source_row_id: "cto-row-1" },
  ]);
  assert.deepEqual(summary.missing_approved_keys, APPROVED_KEYS.filter((key) =>
    !new Set(summary.entities.map((row) => row.key)).has(key),
  ));
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes("SECRET-VALUE"), false);
  assert.equal(serialized.includes("unrelated_private_key"), false);
  assert.equal(serialized.includes("private_alias"), false);
});
