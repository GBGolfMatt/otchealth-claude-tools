#!/usr/bin/env node
/**
 * Guarded one-off seed for four verified current-cloud entities and five exact-only aliases.
 *
 * Default is dry-run. All CLI stdout/stderr is captured in memory and discarded. No arbitrary
 * entity value or ledger text is emitted by this process.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadApprovedSharedState } from "./entity-inventory.mjs";
import { CURRENT_CLOUD_ALIASES, CURRENT_CLOUD_ENTITIES, normEntityKey } from "./current-cloud-schema.mjs";

export const ENTITY_SEED = CURRENT_CLOUD_ENTITIES;
export const ALIAS_SEED = CURRENT_CLOUD_ALIASES;

export function planSeed(summary, rows) {
  if (!summary?.ok) return { ok: false, error_category: "unsafe_inventory", operations: [], skipped: [] };
  const operations = [];
  const skipped = [];
  const conflicts = [];
  for (const { key, value, source } of ENTITY_SEED) {
    const current = rows.filter((row) => row.type === "entity" && row.ekey === key)
      .sort((a, b) => (b.ts || "").localeCompare(a.ts || ""))[0];
    if (!current) operations.push({ type: "entity", key, value, source });
    else if (current.evalue === value) skipped.push({ type: "entity", key });
    else conflicts.push({ type: "entity", key, reason: "existing_value_mismatch" });
  }
  for (const { phrase, target, source } of ALIAS_SEED) {
    const key = normEntityKey(phrase);
    const current = rows.filter((row) => row.type === "alias" && row.ekey === key)
      .sort((a, b) => (b.ts || "").localeCompare(a.ts || ""))[0];
    if (!current) operations.push({ type: "alias", key, phrase, target, source });
    else if (current.evalue === target && (current.tags || []).includes("exact-match-only")) {
      skipped.push({ type: "alias", key });
    } else conflicts.push({ type: "alias", key, reason: "existing_alias_mismatch" });
  }
  return { ok: conflicts.length === 0, error_category: conflicts.length ? "existing_fork_or_mismatch" : null, operations, skipped, conflicts };
}

function invokeMemory(operation) {
  const here = dirname(fileURLToPath(import.meta.url));
  const args = operation.type === "entity"
    ? ["entity", "set", operation.key, operation.value, "--agent", "cto", "--tags", "current-value", "--source", operation.source, "--share"]
    : ["entity", "alias", operation.phrase, operation.target, "--agent", "cto", "--tags", "current-value,exact-match-only", "--source", operation.source, "--share"];
  return spawnSync(process.execPath, [resolve(here, "mem.mjs"), ...args], {
    encoding: "utf8",
    timeout: 45000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

export async function runSeed(apply = false) {
  let loaded;
  try { loaded = await loadApprovedSharedState(); }
  catch { return { ok: false, applied: false, error_category: "shared_inventory_failed" }; }
  const plan = planSeed(loaded.summary, loaded.rows);
  if (!plan.ok || !apply) {
    return {
      ok: plan.ok,
      applied: false,
      error_category: plan.error_category,
      planned: plan.operations.map(({ type, key }) => ({ type, key })),
      skipped: plan.skipped,
      conflicts: plan.conflicts,
    };
  }

  const completed = [];
  for (const operation of plan.operations) {
    const result = invokeMemory(operation);
    if (result.error || result.status !== 0) {
      return {
        ok: false,
        applied: completed.length > 0,
        error_category: result.error?.code === "ETIMEDOUT" ? "timeout" : "memory_cli_failed",
        completed,
        failed: { type: operation.type, key: operation.key },
      };
    }
    completed.push({ type: operation.type, key: operation.key });
  }
  let verified;
  try {
    const after = await loadApprovedSharedState();
    const post = planSeed(after.summary, after.rows);
    verified = post.ok && post.operations.length === 0 &&
      post.skipped.length === ENTITY_SEED.length + ALIAS_SEED.length;
  } catch {
    verified = false;
  }
  if (!verified) {
    return { ok: false, applied: true, error_category: "post_write_verification_failed", completed };
  }
  return { ok: true, applied: true, verified: true, completed, skipped: plan.skipped };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.stdout.write(JSON.stringify(await runSeed(process.argv.includes("--apply"))) + "\n");
}
