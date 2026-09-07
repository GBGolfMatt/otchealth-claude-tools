#!/usr/bin/env node
/**
 * Read-only, redacted inventory for the four approved current-cloud entity keys and aliases.
 *
 * This reads the authoritative S3 shared feed with the same source-supported functions used by
 * mem.mjs. Arbitrary values stay in memory. Stdout contains only counts, allowed keys, owners,
 * row ids, and structural safety findings.
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { getTextFromS3, listBlobsFromS3 } from "./s3-blob.mjs";

const ACCOUNT = "otchealthcommons";
const CONTAINER = "company-journal";
const PREFIX = "_MEMORY/_exec/";

export const APPROVED_ENTITIES = Object.freeze([
  "otchealth_primary_cloud",
  "otchealth_gateway_runtime",
  "otchealth_brain_backend",
  "otchealth_agent_state_backend",
]);

export const APPROVED_ALIASES = Object.freeze([
  "what_cloud_platform_is_the_company_brain_running_on_now_and_is_azure_still_active",
  "what_is_the_current_search_backend_and_live_index_architecture_for_brain_search",
  "what_is_otchealths_current_primary_cloud",
  "where_is_the_otchealth_gateway_running_now",
  "what_is_the_current_otchealth_agent_state_backend",
]);

const approvedType = (row) =>
  row?.type === "entity" && APPROVED_ENTITIES.includes(row.ekey)
    ? "entity"
    : row?.type === "alias" && APPROVED_ALIASES.includes(row.ekey)
      ? "alias"
      : null;

function latest(rows) {
  return [...rows].sort((a, b) =>
    (b.ts || "").localeCompare(a.ts || "") || (b.id || "").localeCompare(a.id || "")
  )[0] || null;
}

export function summarizeApprovedRows(rows, metadata = {}) {
  const approved = rows.filter((row) => approvedType(row));
  const groups = new Map();
  for (const row of approved) {
    const key = `${row.type}:${row.ekey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const forkedKeys = [];
  const unexpectedOwners = [];
  const entities = [];
  const aliases = [];

  for (const group of groups.values()) {
    group.sort((a, b) =>
      (a.ts || "").localeCompare(b.ts || "") || (a.id || "").localeCompare(b.id || "")
    );
    for (const row of group) {
      const owner = row.agent || row.by || null;
      if (owner !== "cto") unexpectedOwners.push({ key: row.ekey, owner, source_row_id: row.id || null });
    }
    for (let i = 1; i < group.length; i += 1) {
      if (!group[i].supersedes || group[i].supersedes !== group[i - 1].id) {
        forkedKeys.push(group[i].ekey);
        break;
      }
    }
    const current = latest(group);
    const item = {
      key: current.ekey,
      owner: current.agent || current.by || null,
      source_row_id: current.id || null,
    };
    if (current.type === "alias") item.target_key = current.evalue;
    (current.type === "entity" ? entities : aliases).push(item);
  }

  entities.sort((a, b) => a.key.localeCompare(b.key));
  aliases.sort((a, b) => a.key.localeCompare(b.key));
  unexpectedOwners.sort((a, b) => a.key.localeCompare(b.key));
  const entityKeys = new Set(entities.map((row) => row.key));
  const aliasKeys = new Set(aliases.map((row) => row.key));
  const invalidRows = Number(metadata.invalid_rows || 0);
  const scannedFiles = Number(metadata.scanned_files || 0);
  const parsedRows = Number(metadata.parsed_rows || 0);
  const structurallyValid = scannedFiles > 0 && parsedRows > 0 && invalidRows === 0;

  return {
    ok: structurallyValid && unexpectedOwners.length === 0 && forkedKeys.length === 0,
    owner: "cto",
    scanned_shared_files: scannedFiles,
    parsed_shared_rows: parsedRows,
    invalid_shared_rows: invalidRows,
    approved_entity_count: APPROVED_ENTITIES.length,
    present_approved_entity_count: entities.length,
    missing_approved_entities: APPROVED_ENTITIES.filter((key) => !entityKeys.has(key)),
    approved_alias_count: APPROVED_ALIASES.length,
    present_approved_alias_count: aliases.length,
    missing_approved_aliases: APPROVED_ALIASES.filter((key) => !aliasKeys.has(key)),
    forked_keys: [...new Set(forkedKeys)].sort(),
    unexpected_owners: unexpectedOwners,
    entities,
    aliases,
  };
}

export async function loadApprovedSharedState() {
  const names = (await listBlobsFromS3(ACCOUNT, CONTAINER, PREFIX))
    .map((item) => typeof item === "string" ? item : item?.name)
    .filter((name) => typeof name === "string" && name.endsWith(".jsonl"));
  const texts = await Promise.all(names.map((name) => getTextFromS3(ACCOUNT, CONTAINER, name)));
  const rows = [];
  let invalidRows = 0;
  let parsedRows = 0;
  for (const text of texts) {
    for (const line of String(text || "").split(/\r?\n/).filter(Boolean)) {
      try {
        const row = JSON.parse(line);
        parsedRows += 1;
        if (approvedType(row)) rows.push(row);
      } catch {
        invalidRows += 1;
      }
    }
  }
  const summary = summarizeApprovedRows(rows, {
    scanned_files: names.length,
    parsed_rows: parsedRows,
    invalid_rows: invalidRows,
  });
  return { summary, rows };
}

export async function runInventory() {
  try {
    const { summary } = await loadApprovedSharedState();
    return summary;
  } catch {
    return { ok: false, owner: "cto", error_category: "shared_inventory_failed" };
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.stdout.write(JSON.stringify(await runInventory()) + "\n");
}
