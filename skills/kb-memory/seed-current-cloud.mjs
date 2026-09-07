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

export const ENTITY_SEED = Object.freeze([
  ["otchealth_primary_cloud", "AWS is the active company cloud estate.", "Live AWS metadata verification, 2026-09-07"],
  ["otchealth_gateway_runtime", "AWS ECS on Fargate in us-east-1 at mcp.otchealth.app.", "Live ECS task definition 53 verification, 2026-09-07"],
  ["otchealth_brain_backend", "Amazon OpenSearch Service domain otchealth-brain on AWS, federated by brain_search.", "Live OpenSearch and gateway verification, 2026-09-07"],
  ["otchealth_agent_state_backend", "Amazon RDS for PostgreSQL database otchealth-pg on AWS.", "Live RDS and gateway task definition 53 verification, 2026-09-07"],
]);

export const ALIAS_SEED = Object.freeze([
  ["what cloud platform is the company brain running on now and is azure still active", "otchealth_brain_backend", "bounded-fast-eval current-cloud, 2026-09-07"],
  ["what is the current search backend and live index architecture for brain_search", "otchealth_brain_backend", "bounded-fast-eval current-backend, 2026-09-07"],
  ["what is otchealth's current primary cloud", "otchealth_primary_cloud", "current cloud natural-query alias, 2026-09-07"],
  ["where is the otchealth gateway running now", "otchealth_gateway_runtime", "current gateway natural-query alias, 2026-09-07"],
  ["what is the current otchealth agent state backend", "otchealth_agent_state_backend", "current state natural-query alias, 2026-09-07"],
]);

const normKey = (value) => String(value || "").toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

export function planSeed(summary, rows) {
  if (!summary?.ok) return { ok: false, error_category: "unsafe_inventory", operations: [], skipped: [] };
  const operations = [];
  const skipped = [];
  const conflicts = [];
  for (const [key, value, source] of ENTITY_SEED) {
    const current = rows.filter((row) => row.type === "entity" && row.ekey === key)
      .sort((a, b) => (b.ts || "").localeCompare(a.ts || ""))[0];
    if (!current) operations.push({ type: "entity", key, value, source });
    else if (current.evalue === value) skipped.push({ type: "entity", key });
    else conflicts.push({ type: "entity", key, reason: "existing_value_mismatch" });
  }
  for (const [phrase, target, source] of ALIAS_SEED) {
    const key = normKey(phrase);
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
  return { ok: true, applied: true, completed, skipped: plan.skipped };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.stdout.write(JSON.stringify(await runSeed(process.argv.includes("--apply"))) + "\n");
}
