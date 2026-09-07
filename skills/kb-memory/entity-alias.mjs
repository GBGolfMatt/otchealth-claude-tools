/**
 * Pure construction helpers for entity alias ledger rows.
 *
 * The caller resolves and validates both keys against fresh ledger rows before calling this module.
 * Keeping row construction pure makes the latest-same-key supersession contract testable without
 * storage credentials or network calls.
 */

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
    was: input.supersedePrevious && previous ? previous.evalue : undefined,
    supersedes: input.supersedePrevious && previous ? previous.id : undefined,
  };
  return { entry, previous };
}
