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
