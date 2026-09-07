/**
 * Pure validation and construction helpers for entity alias ledger rows.
 *
 * The caller resolves and validates both keys against fresh ledger rows before calling this module.
 * Keeping policy and row construction pure makes the owner and latest-same-key contracts testable
 * without storage credentials or network calls.
 */

export function assertAliasOwner(writer, targetOwner) {
  const actor = String(writer || "").trim().toLowerCase();
  const owner = String(targetOwner || "").trim().toLowerCase();
  if (!actor || !owner || actor !== owner) {
    throw new Error("entity aliases must be written by the target ledger owner");
  }
}

export function currentAlias(rows, fromKey) {
  return rows
    .filter((row) => row.type === "alias" && row.ekey === fromKey)
    .sort((a, b) => (b.ts || "").localeCompare(a.ts || ""))[0] || null;
}

export function buildAliasEntry(rows, input) {
  const previous = currentAlias(rows, input.fromKey);
  const entry = {
    id: input.id,
    ts: input.ts,
    type: "alias",
    ekey: input.fromKey,
    evalue: input.toKey,
    text: `alias ${input.fromKey} -> ${input.toKey}`,
    tags: [...(input.tags || [])],
    by: input.by,
    source: input.source || undefined,
    was: previous ? previous.evalue : undefined,
    supersedes: previous ? previous.id : undefined,
  };
  return { entry, previous };
}

const normKey = (value) => String(value || "").toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** Resolve an alias target from fresh rows and require a real current entity. */
export function resolveAliasTarget(rows, rawTarget) {
  let key = normKey(rawTarget);
  if (!key) throw new Error("entity alias target is required");
  const seen = new Set();
  for (let depth = 0; depth < 8; depth += 1) {
    if (seen.has(key)) throw new Error(`entity alias target cycle: ${key}`);
    seen.add(key);
    const next = currentAlias(rows, key);
    if (!next?.evalue || next.evalue === key) break;
    key = normKey(next.evalue);
  }
  const entity = rows
    .filter((row) => row.type === "entity" && row.ekey === key)
    .sort((a, b) => (b.ts || "").localeCompare(a.ts || ""))[0];
  if (!entity) throw new Error(`entity alias target does not exist: ${key}`);
  return key;
}
