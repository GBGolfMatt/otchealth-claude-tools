// local-fallback.mjs — durable local fallback for a kb-memory entry that could not reach its ledger.
//
// ORIGIN (2026-08-18): this lived inline inside reflect.mjs, written for exactly one caller (its own
// --commit loop, which spawns mem.mjs as a child process and catches a non-zero exit). Extracted here
// (2026-08-18, same day, the agent-seat credential bootstrap fix) so mem.mjs's OWN direct CLI writes
// can use the IDENTICAL safety net -- a human or agent typing `mem.mjs status "..." --agent cro`
// straight into a shell got NO fallback at all before this: only content that happened to route
// through reflect.mjs's LLM-distillation loop was ever protected. Both callers now import from here;
// reflect.mjs re-exports both names unchanged so its own already-shipped tests (which import them
// `from "../reflect.mjs"`) keep passing without modification.
//
// Same directory mem.mjs's own local write-through cache already uses (~/.claude/kb-cache), so a
// human or a recovery script has one place to look, not a new ad hoc path per failure class. One file
// per agent so a recovery pass can be run per-agent without cross-agent interference.
import { mkdirSync, appendFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactSecrets } from "./redact.mjs";

const defaultCacheDir = () => join(homedir(), ".claude", "kb-cache");

export const FAILED_WRITE_FILE = (agent, cacheDir = defaultCacheDir()) =>
  join(cacheDir, `_failed_writes-${agent || "unknown"}.jsonl`);

/**
 * Record an entry that failed to persist to its real ledger, so it is recoverable rather than gone.
 * `item` is `{ type, text, share?, tags?, _fallback? }`; `source` (default "reflect.mjs", preserving
 * the exact behavior every existing caller/test already depends on) names WHICH caller lost the write,
 * so a recovery pass and a human reading the file both know where to look for the reason. Never throws
 * -- if even the local fallback file cannot be written (e.g. a read-only home dir), that is reported
 * to stderr rather than swallowed a second time; there is nowhere further to degrade to.
 */
export function appendFailedWriteFallback(agent, item, error, source = "reflect.mjs", { cacheDir = defaultCacheDir() } = {}) {
  try {
    mkdirSync(cacheDir, { recursive: true });
    const file = FAILED_WRITE_FILE(agent, cacheDir);
    const tags = item._fallback ? ["auto-extract-fallback"] : (Array.isArray(item.tags) && item.tags.length ? item.tags : ["auto-reflect"]);
    // `error` is redacted at THIS choke point, not only at each call site, because every caller
    // (mem.mjs's direct-CLI catch and reflect.mjs's --commit loop alike) funnels through here, and
    // these rows are not transient: a recovery pass replays them into the ledger, where a row can be
    // share:true and therefore visible across lanes. Redaction is idempotent, so a caller that has
    // already redacted (mem.mjs does, to print the same string) loses nothing by passing through
    // twice. `text` is deliberately NOT redacted: it is the operator's own content, the entire
    // reason this file exists, and mangling it would defeat the guarantee the fallback makes.
    const row = { ts: new Date().toISOString(), agent, type: item.type, text: item.text, share: !!item.share, tags, error: redactSecrets(error), source };
    // OPTIONAL, ADDITIVE fields: a direct `mem.mjs correct` (or a cross-lane `--on` write) carries
    // context a bare {type,text} would lose on recovery. Only set when the caller actually supplied
    // them, so reflect.mjs's own calls (which never pass these) produce byte-identical rows to before.
    if (item.was) row.was = item.was;
    if (item.on) row.on = item.on;
    for (const field of ["idempotency_key", "operation_id", "operation_stage", "intent_hash", "private_entry_id"]) {
      if (item[field]) row[field] = item[field];
    }
    appendFileSync(file, JSON.stringify(row) + "\n");
    try { chmodSync(file, 0o600); } catch {} // cheap + idempotent; matches the 0600 posture the rest of kb-cache uses for anything sensitive
  } catch (e) {
    console.error(`[kb-memory] FALLBACK WRITE ALSO FAILED for agent '${agent}': ${e.message}. The item above is genuinely unrecoverable from this run.`);
  }
}
