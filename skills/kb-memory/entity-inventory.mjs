#!/usr/bin/env node
/**
 * Read-only, redacted inventory for the four approved current-cloud entity keys.
 *
 * The supported memory CLI still owns storage access. Its stdout is captured in memory and parsed;
 * entity values and unrelated aliases are never written to this process's stdout or stderr.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const APPROVED_KEYS = Object.freeze([
  "otchealth_primary_cloud",
  "otchealth_gateway_runtime",
  "otchealth_brain_backend",
  "otchealth_agent_state_backend",
]);

export function summarizeEntityList(stdout) {
  const allowed = new Set(APPROVED_KEYS);
  const entities = [];
  let totalEntityCount = null;
  let totalAliasCount = 0;
  let inAliases = false;

  for (const line of String(stdout || "").split(/\r?\n/)) {
    const header = line.match(/^# CURRENT VALUES \(cto ledger\) - (\d+) entities$/);
    if (header) {
      totalEntityCount = Number(header[1]);
      continue;
    }
    if (line === "## aliases") {
      inAliases = true;
      continue;
    }
    if (inAliases) {
      if (/^[a-z0-9_]+ -> [a-z0-9_]+$/.test(line)) totalAliasCount += 1;
      continue;
    }
    const row = line.match(/^([a-z0-9_]+) = .*\s+\[\d{4}-\d{2}-\d{2}\s+([^\]\s]+)\]$/);
    if (row && allowed.has(row[1])) {
      entities.push({ key: row[1], source_row_id: row[2] });
    }
  }

  entities.sort((a, b) => a.key.localeCompare(b.key));
  const present = new Set(entities.map((row) => row.key));
  return {
    owner: "cto",
    total_entity_count: totalEntityCount,
    total_alias_count: totalAliasCount,
    approved_entity_count: APPROVED_KEYS.length,
    present_approved_count: entities.length,
    missing_approved_keys: APPROVED_KEYS.filter((key) => !present.has(key)),
    entities,
  };
}

export function runInventory() {
  const here = dirname(fileURLToPath(import.meta.url));
  const result = spawnSync(
    process.execPath,
    [resolve(here, "mem.mjs"), "entity", "list", "--agent", "cto"],
    { encoding: "utf8", timeout: 45000, maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0) {
    return {
      owner: "cto",
      ok: false,
      error_category: result.error?.code === "ETIMEDOUT" ? "timeout" : "entity_list_failed",
    };
  }
  return { ok: true, ...summarizeEntityList(result.stdout) };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.stdout.write(JSON.stringify(runInventory()) + "\n");
}
