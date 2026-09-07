import { test } from "node:test";
import assert from "node:assert/strict";
import { assertAliasOwner, buildAliasEntry, currentAlias, resolveAliasTarget } from "../skills/kb-memory/entity-alias.mjs";

const alias = (id, ts, from, to) => ({
  id,
  ts,
  type: "alias",
  ekey: from,
  evalue: to,
  text: `alias ${from} -> ${to}`,
});

test("currentAlias selects only the latest row for the same alias key", () => {
  const rows = [
    alias("a1", "2026-09-01T00:00:00Z", "current_brain_backend", "old_key"),
    alias("a2", "2026-09-02T00:00:00Z", "other_alias", "other_key"),
    alias("a3", "2026-09-03T00:00:00Z", "current_brain_backend", "new_key"),
  ];
  assert.equal(currentAlias(rows, "current_brain_backend")?.id, "a3");
});

test("buildAliasEntry supersedes only the prior same-key alias", () => {
  const rows = [
    alias("a1", "2026-09-01T00:00:00Z", "current_brain_backend", "old_key"),
    alias("a2", "2026-09-04T00:00:00Z", "other_alias", "unrelated_key"),
  ];
  const { entry, previous } = buildAliasEntry(rows, {
    fromKey: "current_brain_backend",
    toKey: "otchealth_brain_backend",
    id: "a3",
    ts: "2026-09-05T00:00:00Z",
    tags: ["current-value"],
    by: "cto",
    source: "bounded fast eval",
  });
  assert.equal(previous?.id, "a1");
  assert.equal(entry.supersedes, "a1");
  assert.equal(entry.was, "old_key");
  assert.equal(entry.source, "bounded fast eval");
  assert.deepEqual(entry.tags, ["current-value"]);
  assert.equal(entry.evalue, "otchealth_brain_backend");
});

test("alias routing rejects cross-lane writers before a row is built", () => {
  assert.doesNotThrow(() => assertAliasOwner("CTO", "cto"));
  assert.throws(
    () => assertAliasOwner("developer", "cto"),
    /target ledger owner/,
  );
  assert.throws(
    () => assertAliasOwner("cto", "clo-personal"),
    /target ledger owner/,
  );
});

test("shared current-value aliases stay scoped and do not use historical or generic keys", () => {
  const aliases = [
    "what_cloud_platform_is_the_company_brain_running_on_now_and_is_azure_still_active",
    "what_is_the_current_search_backend_and_live_index_architecture_for_brain_search",
    "what_is_otchealths_current_primary_cloud",
    "where_is_the_otchealth_gateway_running_now",
    "what_is_the_current_otchealth_agent_state_backend",
  ];
  const generic = new Set(["cloud", "backend", "search", "state", "brain", "azure"]);
  for (const key of aliases) {
    assert.ok(/(?:current|now|live)/.test(key), `alias must be current-only: ${key}`);
    assert.equal(generic.has(key), false);
    assert.equal(/(?:historical|formerly|previous|before|used_to)/.test(key), false);
  }
});

test("currentAlias is independent of input chronology", () => {
  const rows = [
    alias("latest", "2026-09-03T00:00:00Z", "current_brain_backend", "new_key"),
    alias("oldest", "2026-09-01T00:00:00Z", "current_brain_backend", "old_key"),
    alias("middle", "2026-09-02T00:00:00Z", "current_brain_backend", "middle_key"),
  ];
  assert.equal(currentAlias(rows, "current_brain_backend")?.id, "latest");
});

test("resolveAliasTarget accepts an indirect chain ending in a current entity", () => {
  const rows = [
    { type: "entity", ekey: "otchealth_brain_backend", evalue: "safe", ts: "3", id: "e1" },
    alias("a1", "1", "brain_now", "current_brain_backend"),
    alias("a2", "2", "current_brain_backend", "otchealth_brain_backend"),
  ];
  assert.equal(resolveAliasTarget(rows, "Brain Now"), "otchealth_brain_backend");
});

test("resolveAliasTarget rejects missing targets and malformed cycles", () => {
  assert.throws(() => resolveAliasTarget([], "missing"), /does not exist/);
  const cycle = [alias("a1", "1", "x_alias", "y_alias"), alias("a2", "1", "y_alias", "x_alias")];
  assert.throws(() => resolveAliasTarget(cycle, "x alias"), /cycle/);
});
