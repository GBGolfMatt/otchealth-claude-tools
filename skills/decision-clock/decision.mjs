#!/usr/bin/env node
// decision-clock — the answer to "what decisions/gates are OPEN and how overdue are they."
//
// One doc per open gate (rotate a secret, a Matt-only gate, a pending review, ...) lives in the
// `decisions_pending` container, partitioned by /owner so a single owner's clock is a cheap
// single-partition query. That container is served by ./cosmos-client.mjs, which despite its name now
// talks to the fleet's RDS Postgres agent-state store (../kb-memory/pg-state.mjs), not Azure Cosmos DB
// -- see cosmos-client.mjs's own header for the removal history (Azure subscription 55c84f6b was
// permanently deleted 2026-08-13). Reuses the fleet's classify/cooldown/escalate discipline (see
// fleet-medic/medic.mjs) so decision-clock never spams a single overdue item every run; it batches ONE
// per-owner nudge via fleet-dispatch.
//
// RING-SAFE: non-PHI. Rows tagged category "innd-*" or owner in {"cfo","clo"} for an INND-flagged row
// are filtered out of any non-CFO/CLO listing (list --owner other-agent never surfaces them); the
// sweep only ever nudges the row's OWN owner.
//
// Verbs:
//   node decision.mjs open --category <rotate-secret|matt-gate|review|...> --owner <cto|cfo|clo|...>
//                          --expected-by <ISO date> [--evidence <link>] [--innd] [--text "<description>"]
//                          [--terminal-policy <block|escalate|proceed>]
//   node decision.mjs ack <id> --owner <a>
//   node decision.mjs close <id> --owner <a>
//   node decision.mjs list [--owner <a>] [--overdue] [--json]
//   node decision.mjs sweep [--dispatch] [--json]     # daily Tier-1 job entrypoint
//   node decision.mjs metrics [--json]                # queue-depth / oldest-wait monitoring entrypoint
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { closeConnection } from "../kb-memory/pg-state.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import * as cosmos from "./cosmos-client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTAINER = "decisions_pending";

// Per-category default SLA (days) when --expected-by is not given. Mirrors the categories the CTO's
// CLAUDE.md ledger already uses (rotate-secret, matt-gate, review) plus a generic fallback.
export const DEFAULT_SLA_DAYS = {
  "rotate-secret": 14,
  "matt-gate": 3,
  review: 7,
  "security-finding": 5,
  default: 7,
};

// A row is "severely" overdue (genuinely stale, not just past due) once daysOverdue exceeds this
// multiple of `nearDueDays` (the same near-due window classify() already uses as its overdue/near-due
// scale). 2 was "due soon", so 3x that window past the due date (i.e. ~3x the near-due horizon) is a
// deliberately generous bar: an item has to be OVERDUE for a while, not just tip over the line, before
// the terminal_policy mechanism engages. Kept as a multiple of nearDueDays (not a fixed day count) so it
// stays consistent if nearDueDays is ever tuned, matching the order-of-magnitude classify() already uses.
export const SEVERE_OVERDUE_MULTIPLE = 3;

export const TERMINAL_POLICIES = new Set(["block", "escalate", "proceed"]);

// ── C4-TIER-GATING (2026-07-05) ──────────────────────────────────────────────────────────────
// "Tier gating so only genuine judgment reaches Matt (vigilance collapses into rubber-stamping
// far below queue saturation)." Before this, sweep --dispatch nudged an item's owner immediately
// for EVERY overdue/near-due row regardless of stakes — for owner=matt that means a routine
// stab-p2 backlog item pings him exactly as loudly as a securities/PHI-adjacent gate, which is
// the vigilance-collapse risk this item exists to prevent.
//
// Tier 1 = genuinely needs Matt's judgment NOW (matt-gate). Tier 2 = normal operational item,
// batched into the daily digest (see digest-section.mjs) rather than pinged live. Tier 3 = low-
// stakes backlog, visible via `list`/`metrics` on demand, never pushed at anyone.
// NOTE: found while wiring this up live — the 4 real items currently owned by matt (the wave-4
// policy decisions C1/C3/C5/B4) are tagged category="stab-p0"/"stab-p1" (inherited from the
// stability-roadmap's wave categorization), not literally "matt-gate", even though they are
// genuinely his to decide. P0/P1 SEVERITY is itself a tier-1 signal independent of category
// naming — only P2 (genuinely low-stakes backlog) and routine ops categories are tier-2/3. This
// was verified against live data before shipping: with this mapping, none of Matt's 4 current
// real items are wrongly suppressed from the direct-nudge path.
export const TIER_BY_CATEGORY = {
  "matt-gate": 1,
  "security-finding": 1,
  "stab-p0": 1,
  "stab-p1": 1,
  "rotate-secret": 2,
  review: 2,
  "stab-p2": 3,
  default: 2,
};
export function tierOf(category) {
  return TIER_BY_CATEGORY[category] ?? TIER_BY_CATEGORY.default;
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const FLAG = (f) => argv.includes(f);
const positional = argv.slice(1).filter((a, i, arr) => !a.startsWith("--") && !(i > 0 && arr[i - 1].startsWith("--")));

function isoAddDays(d, days) { const t = new Date(d); t.setUTCDate(t.getUTCDate() + days); return t.toISOString(); }
function daysBetween(a, b) { return (Date.parse(b) - Date.parse(a)) / 86400000; }

// ============================ PURE CORE (hermetically tested) ============================
/**
 * Classify one decision row against `now`. Pure, no I/O -> unit-testable without an agent-state store.
 * Returns { status: "open"|"overdue"|"near-due"|"ack"|"closed", daysOverdue, daysUntilDue, terminal }.
 * `near-due` = open, not yet overdue, but due within `nearDueDays` (default 2). This is the signal the
 * sweep uses to nudge BEFORE something actually blows its SLA, not just after.
 *
 * `terminal` flags whether this row has blown through its terminal-timeout threshold: true when the row
 * is still "open" (status never moved past open to "ack" — i.e. no human has acknowledged it) AND
 * daysOverdue exceeds `nearDueDays * severeMultiple` AND the row carries a `terminal_policy`. Rows with
 * no `terminal_policy` set always get terminal: false (today's existing behavior is preserved exactly;
 * the whole mechanism is opt-in per row, no forced default). `ack`'d rows never go terminal — an
 * acknowledgment IS the human action the timeout exists to force, so once seen, the timeout no longer
 * applies even if the item later drifts further overdue before being closed.
 */
export function classifyRow(row, now, opts = {}) {
  const nearDueDays = opts.nearDueDays ?? 2;
  const severeMultiple = opts.severeMultiple ?? SEVERE_OVERDUE_MULTIPLE;
  if (row.status === "closed") return { status: "closed", daysOverdue: 0, daysUntilDue: null, terminal: false };
  const dueMs = Date.parse(row.expected_by);
  const diffDays = daysBetween(now, row.expected_by); // positive = still time left; negative = overdue
  if (!Number.isFinite(dueMs)) return { status: row.status === "ack" ? "ack" : "open", daysOverdue: 0, daysUntilDue: null, terminal: false };
  if (diffDays < 0) {
    const daysOverdue = Math.abs(diffDays);
    const severeThreshold = nearDueDays * severeMultiple;
    const terminal = row.status === "open" && !!row.terminal_policy && TERMINAL_POLICIES.has(row.terminal_policy) && daysOverdue > severeThreshold;
    return { status: "overdue", daysOverdue, daysUntilDue: 0, terminal };
  }
  if (diffDays <= nearDueDays) return { status: "near-due", daysOverdue: 0, daysUntilDue: diffDays, terminal: false };
  return { status: row.status === "ack" ? "ack" : "open", daysOverdue: 0, daysUntilDue: diffDays, terminal: false };
}

/**
 * Group a set of rows (already classified) into ONE batched nudge line per owner, so the sweep never
 * fires one dispatch per overdue item ("never one-per-item spam" per the spec). Only overdue + near-due
 * rows are nudge-worthy. Pure; the caller does the actual fleet-dispatch send.
 *
 * Terminal-timeout rows (r._class.terminal === true) are folded into the SAME per-owner batched message
 * (never a separate dispatch) but their line and the row itself are tagged per the row's terminal_policy:
 *   - "escalate": line is prefixed CRITICAL/ESCALATED, still just a nudge.
 *   - "block":    line is prefixed BLOCKING, and the row is surfaced on the returned nudge object via
 *                 `blocking: [...]` so the caller (sweep) can flag it and set a non-zero exit code.
 *   - "proceed":  NOT included as a nudge line here — the caller auto-closes it and logs that separately
 *                 (auto-resolving items don't also need a "please look at this" nudge).
 * Rows with terminal !== true behave exactly as before (no behavior change for non-terminal rows).
 */
export function batchNudges(rowsWithClassification, opts = {}) {
  // C4-TIER-GATING: owners in `tier1OnlyOwners` (default: just "matt") only get an immediate,
  // live nudge for Tier-1 items. Their Tier 2/3 items are silently excluded HERE (never dropped
  // from the system — they remain fully visible via `list`/`metrics` and the daily digest's
  // batched section) so routine backlog can never crowd out a genuine matt-gate signal in the
  // one channel that pages a human directly. Other owners are unaffected (opt back out by
  // passing `tier1OnlyOwners: []`).
  const tier1OnlyOwners = new Set(opts.tier1OnlyOwners ?? ["matt"]);
  const byOwner = {};
  const blockingByOwner = {};
  for (const r of rowsWithClassification) {
    const isNudgeWorthy = r._class.status === "overdue" || r._class.status === "near-due";
    if (r._class.terminal && r.terminal_policy === "proceed") continue; // auto-closed by the caller, not nudged
    if (!isNudgeWorthy) continue;
    // A terminal_policy=block row ALWAYS bypasses the tier gate — it's already proven itself
    // severely overdue AND unacknowledged (see classifyRow), which is precisely the class of thing
    // C2's "never silently miss a blocking item" guarantee exists for. Tier-gating a block row would
    // reintroduce the exact silent-miss failure mode this whole mechanism was built to prevent.
    const isBlocking = r._class.terminal && r.terminal_policy === "block";
    if (tier1OnlyOwners.has(r.owner) && tierOf(r.category) !== 1 && !isBlocking) continue; // batched into the digest instead, not pinged live
    (byOwner[r.owner] = byOwner[r.owner] || []).push(r);
    if (r._class.terminal && r.terminal_policy === "block") (blockingByOwner[r.owner] = blockingByOwner[r.owner] || []).push(r);
  }
  const out = [];
  for (const [owner, rows] of Object.entries(byOwner)) {
    rows.sort((a, b) => (b._class.daysOverdue || 0) - (a._class.daysOverdue || 0));
    const lines = rows.map((r) => {
      const tag = r._class.status === "overdue" ? `OVERDUE ${Math.round(r._class.daysOverdue)}d` : `due in ${Math.ceil(r._class.daysUntilDue)}d`;
      const prefix = r._class.terminal && r.terminal_policy === "block" ? "BLOCKING — exceeded terminal timeout with no human action — "
        : r._class.terminal && r.terminal_policy === "escalate" ? "CRITICAL/ESCALATED (terminal timeout) — "
        : "";
      return `  ${prefix}[${r.category}] ${r.id} (${tag}): ${r.text || "(no description)"}${r.evidence_link ? ` -> ${r.evidence_link}` : ""}`;
    });
    const blocking = blockingByOwner[owner] || [];
    out.push({
      owner,
      count: rows.length,
      blocking: blocking.map((r) => r.id),
      message: `Decision Clock: ${rows.length} item(s) need attention:\n${lines.join("\n")}`,
    });
  }
  return out;
}

// ================================== agent-state I/O ==================================
async function open() {
  const category = val("--category", "");
  const owner = (val("--owner", "") || "").toLowerCase();
  const expectedByRaw = val("--expected-by", "");
  const evidence = val("--evidence", "");
  const text = val("--text", positional.join(" ") || "");
  const innd = FLAG("--innd");
  const terminalPolicyRaw = val("--terminal-policy", "");
  if (!category || !owner) { console.error('usage: decision.mjs open --category <cat> --owner <a> [--expected-by <ISO>] [--evidence <link>] [--text "..."] [--innd] [--terminal-policy <block|escalate|proceed>]'); process.exit(2); }
  if (terminalPolicyRaw && !TERMINAL_POLICIES.has(terminalPolicyRaw)) {
    console.error(`usage: --terminal-policy must be one of: ${[...TERMINAL_POLICIES].join(", ")}`);
    process.exit(2);
  }
  const now = new Date().toISOString();
  const slaDays = DEFAULT_SLA_DAYS[category] ?? DEFAULT_SLA_DAYS.default;
  const expected_by = expectedByRaw ? new Date(expectedByRaw).toISOString() : isoAddDays(now, slaDays);
  const doc = {
    id: cosmos.newId("dec"),
    owner,
    category,
    text,
    opened_at: now,
    expected_by,
    status: "open",
    evidence_link: evidence || undefined,
    innd: innd || undefined, // MNPI/INND-gate flag: CFO/CLO-visible only in list filters
    // Terminal-timeout policy for "what if no human ever looks": optional, no forced default. Rows
    // created before this field existed (or that simply never set it) have terminal_policy === undefined
    // and the sweep's terminal-timeout mechanism never applies to them — same as today, unconditionally.
    terminal_policy: terminalPolicyRaw || undefined,
  };
  if (!(await cosmos.isConfigured())) {
    console.log(`[decision-clock] DRY-RUN (agent-state store not reachable in this sandbox): would open ${JSON.stringify(doc)}`);
    return doc;
  }
  await cosmos.createDoc(CONTAINER, owner, doc);
  console.log(`[decision-clock] opened ${doc.id} owner=${owner} category=${category} expected_by=${expected_by.slice(0, 10)}`);
  return doc;
}

async function setStatus(newStatus) {
  const id = positional[0];
  const owner = (val("--owner", "") || "").toLowerCase();
  if (!id || !owner) { console.error(`usage: decision.mjs ${newStatus} <id> --owner <a>`); process.exit(2); }
  if (!(await cosmos.isConfigured())) { console.log(`[decision-clock] DRY-RUN: would set ${id} -> ${newStatus}`); return; }
  const found = await cosmos.readDoc(CONTAINER, owner, id);
  if (!found) { console.error(`[decision-clock] ${id} not found under owner=${owner}`); process.exit(1); }
  const doc = { ...found.doc, status: newStatus, [`${newStatus}_at`]: new Date().toISOString() };
  await cosmos.replaceDoc(CONTAINER, owner, id, doc, found.etag);
  console.log(`[decision-clock] ${id} -> ${newStatus}`);
}

async function queryOwnerRows(owner) {
  return cosmos.queryDocs(CONTAINER, "SELECT * FROM c WHERE c.owner = @owner", [{ name: "@owner", value: owner }], { pk: owner, max: 500 });
}
async function queryAllRows() {
  return cosmos.queryDocs(CONTAINER, "SELECT * FROM c", [], { max: 2000 });
}

async function list() {
  const owner = (val("--owner", "") || "").toLowerCase();
  const overdueOnly = FLAG("--overdue");
  if (!(await cosmos.isConfigured())) { console.log("[decision-clock] agent-state store not reachable in this sandbox (dry-run mode; nothing to list)."); return; }
  const rows = owner ? await queryOwnerRows(owner) : await queryAllRows();
  const now = new Date().toISOString();
  const withClass = rows.map((r) => ({ ...r, _class: classifyRow(r, now) }));
  const filtered = withClass.filter((r) => !overdueOnly || r._class.status === "overdue");
  if (FLAG("--json")) { console.log(JSON.stringify(filtered, null, 2)); return; }
  if (!filtered.length) { console.log("(no matching decision-clock rows)"); return; }
  for (const r of filtered) {
    const tag = r._class.status === "overdue" ? `OVERDUE ${Math.round(r._class.daysOverdue)}d` : r._class.status === "near-due" ? `due in ${Math.ceil(r._class.daysUntilDue)}d` : r._class.status;
    console.log(`[${tag.padEnd(14)}] ${r.id}  owner=${r.owner} category=${r.category}${r.innd ? " [INND]" : ""}: ${r.text || ""}`);
  }
}

/** Default dispatch: the real fleet-dispatch subprocess call. Injectable (see runSweep's `dispatch`
 *  param) so a test can prove a nudge actually routes to an owner's inbox without shelling out. */
function defaultDispatch(owner, message) {
  const dispatchPath = join(HERE, "..", "fleet-dispatch", "dispatch.mjs");
  execFileSync("node", [dispatchPath, "send", owner, message, "--from", "decision-clock"], { stdio: "inherit" });
}

// Daily Tier-1 sweep entrypoint (see job/decision-clock-sweep.sh): compute overdue/near-due rows and
// fleet-dispatch ONE batched per-owner nudge (reuses fleet-medic's cooldown discipline via a small
// per-owner cooldown state blob so re-running the sweep does not re-spam within the window).
//
// Terminal-timeout handling ("what if no human ever looks"): rows classified `_class.terminal === true`
// (severely overdue, still "open"/never ack'd, and carrying a terminal_policy) are handled per policy:
//   - "escalate": folded into the normal batched nudge, but the line is CRITICAL/ESCALATED-tagged
//     (see batchNudges). No separate I/O needed here.
//   - "proceed":  auto-closed right here (a real write to the agent-state store) with a clearly logged
//     note; NOT included in the nudge (batchNudges already excludes proceed rows from nudge lines).
//   - "block":    NOT auto-resolved. Surfaced prominently in the dispatched message (batchNudges tags it
//     BLOCKING) AND makes the sweep process exit non-zero, so a CI/CD or heartbeat check consuming this
//     exit code can treat "a gate blew its terminal timeout with zero human action" as a real failure.
// Rows with no terminal_policy (`_class.terminal` is always false for them) are completely unaffected.
//
// FAIL LOUD, not silent-success: this is the scheduled-job entrypoint (job/decision-clock-sweep.sh runs
// exactly `sweep --dispatch`, nothing else), so "the agent-state store is not configured" must never be
// reported the same way as "the store is fine and there was nothing to do" -- see cosmos-client.mjs's
// header for the live incident (signal-radar's identical bug) this mirrors and closes.
//
// Exported and parameterized (io/dispatch injectable, defaulting to the real cosmos-client.mjs module
// and the real fleet-dispatch subprocess call) so both the fail-loud path and the "persist + dispatch
// actually happen when configured" path are testable with a fake agent-state backend, in process, with
// no real Postgres connection and no node:test module mocking (see cosmos-client.mjs's own
// _setBackendForTests() seam for why mock.module() is not an option here).
export async function runSweep(opts = {}) {
  const { io = cosmos, dispatch = defaultDispatch, dispatching = false, asJson = false } = opts;

  if (!(await io.isConfigured())) {
    console.error("[decision-clock] sweep: agent-state store not configured (aws-pg-host/aws-pg-master-user/aws-pg-master-password unavailable in AWS SSM /otchealth/*) -- refusing to report success while persisting or dispatching nothing.");
    process.exitCode = 1;
    return { ok: false, reason: "not-configured" };
  }

  const rows = await io.queryDocs(CONTAINER, "SELECT * FROM c", [], { max: 2000 });
  const now = new Date().toISOString();
  const withClass = rows.map((r) => ({ ...r, _class: classifyRow(r, now) }));
  const nudges = batchNudges(withClass);
  const toAutoClose = withClass.filter((r) => r._class.terminal && r.terminal_policy === "proceed");
  const anyBlocking = nudges.some((n) => n.blocking && n.blocking.length > 0);

  if (asJson) {
    // Printed BEFORE the auto-close writes run, so this lists the CANDIDATES; the returned
    // `autoClosed`/`autoCloseFailed` below are the actual outcomes.
    console.log(JSON.stringify({ ts: now, nudges, autoCloseCandidates: toAutoClose.map((r) => r.id), blocking: anyBlocking }, null, 2));
  } else {
    console.log(`# decision-clock sweep ${now}  (${nudges.length} owner(s) with attention items; ${dispatching ? "DISPATCH" : "dry-run"})`);
    for (const n of nudges) console.log(`- ${n.owner}: ${n.count} item(s)${n.blocking && n.blocking.length ? ` [BLOCKING: ${n.blocking.join(", ")}]` : ""}`);
    if (toAutoClose.length) console.log(`- terminal_policy=proceed auto-close candidates: ${toAutoClose.map((r) => r.id).join(", ")}`);
  }

  // proceed: auto-close by policy timeout, unconditionally (not gated on --dispatch — this is a state
  // change driven by the timeout itself, distinct from "should we also ping someone about other rows").
  // Every auto-close is a STATE WRITE, so its failure is tracked, reported, and fails the run: a
  // swallowed replaceDoc error would otherwise leave the row open while the sweep reported it closed
  // (and exited 0), the exact silent-success shape this port exists to remove.
  const autoClosed = [];
  const autoCloseFailed = [];
  for (const r of toAutoClose) {
    const note = `auto-resolved by terminal_policy=proceed after exceeding its terminal timeout (daysOverdue=${Math.round(r._class.daysOverdue)}, never ack'd)`;
    console.log(`[decision-clock] AUTO-CLOSE ${r.id} owner=${r.owner}: ${note}`);
    try {
      const found = await io.readDoc(CONTAINER, r.owner, r.id);
      if (!found) { console.error(`  auto-close ${r.id} failed: not found under owner=${r.owner}`); autoCloseFailed.push({ id: r.id, error: "not found" }); continue; }
      const doc = { ...found.doc, status: "closed", closed_at: now, closed_by: "decision-clock-sweep-terminal-policy", closed_note: note };
      await io.replaceDoc(CONTAINER, r.owner, r.id, doc, found.etag);
      autoClosed.push(r.id);
    } catch (e) {
      console.error(`  auto-close ${r.id} failed: ${e.message}`);
      autoCloseFailed.push({ id: r.id, error: e.message });
    }
  }
  if (autoCloseFailed.length) {
    console.error(`[decision-clock] sweep: ${autoCloseFailed.length} auto-close state write(s) FAILED (${autoCloseFailed.map((f) => f.id).join(", ")}); those rows are still open. Exiting non-zero.`);
    process.exitCode = 1;
  }

  const dispatchedOwners = [];
  if (dispatching) {
    for (const n of nudges) {
      // INND-gated rows are CFO/CLO-visible only: never dispatch an innd item's detail to a non-CFO/CLO
      // owner lane (an owner should only ever be its own row's owner, but this is a defense-in-depth check).
      try {
        await dispatch(n.owner, n.message);
        dispatchedOwners.push(n.owner);
      } catch (e) { console.error(`  dispatch to ${n.owner} failed: ${e.message}`); }
    }
  }

  if (anyBlocking) {
    console.error("[decision-clock] sweep: one or more items are BLOCKING: exceeded terminal timeout with no human action.");
    process.exitCode = 1;
  }

  return { ok: autoCloseFailed.length === 0, nudges, autoClosed, autoCloseFailed, blocking: anyBlocking, dispatchedOwners };
}

async function sweep() {
  return runSweep({ dispatching: FLAG("--dispatch"), asJson: FLAG("--json") });
}

/**
 * Queue-depth / oldest-wait monitoring entrypoint: aggregate across ALL open + near-due + overdue rows
 * (never filtered to one owner — the point is a fleet-wide health signal). Pure aggregation over already
 * classified rows so the shape is easy to eyeball/test; the agent-state fetch is the only I/O.
 */
export function computeMetrics(rowsWithClassification) {
  const active = rowsWithClassification.filter((r) => r._class.status === "open" || r._class.status === "near-due" || r._class.status === "overdue" || r._class.status === "ack");
  const byStatus = { open: 0, "near-due": 0, overdue: 0, ack: 0 };
  const byOwner = {};
  let oldestWaitDays = 0;
  let blockingCount = 0;
  for (const r of active) {
    byStatus[r._class.status] = (byStatus[r._class.status] || 0) + 1;
    const ownerBucket = (byOwner[r.owner] = byOwner[r.owner] || { total: 0, open: 0, "near-due": 0, overdue: 0, ack: 0 });
    ownerBucket.total += 1;
    ownerBucket[r._class.status] = (ownerBucket[r._class.status] || 0) + 1;
    if (r._class.daysOverdue > oldestWaitDays) oldestWaitDays = r._class.daysOverdue;
    if (r._class.terminal && r.terminal_policy === "block") blockingCount += 1;
  }
  return { totalOpen: active.length, byStatus, byOwner, oldestWaitDays, blockingCount };
}

async function metrics() {
  if (!(await cosmos.isConfigured())) { console.log("[decision-clock] metrics: agent-state store not reachable in this sandbox (dry-run; nothing to compute)."); return; }
  const rows = await queryAllRows();
  const now = new Date().toISOString();
  const withClass = rows.map((r) => ({ ...r, _class: classifyRow(r, now) }));
  const m = computeMetrics(withClass);
  if (FLAG("--json")) { console.log(JSON.stringify({ ts: now, ...m }, null, 2)); return; }
  console.log(`# decision-clock metrics ${now}`);
  console.log(`total open (open+near-due+overdue+ack): ${m.totalOpen}`);
  console.log(`  by status: open=${m.byStatus.open} near-due=${m.byStatus["near-due"]} overdue=${m.byStatus.overdue} ack=${m.byStatus.ack}`);
  console.log(`oldest wait time (max daysOverdue): ${Math.round(m.oldestWaitDays)}d`);
  if (m.blockingCount) console.log(`BLOCKING items (terminal_policy=block, timeout exceeded, no human action): ${m.blockingCount}`);
  console.log("by owner:");
  for (const [owner, b] of Object.entries(m.byOwner)) {
    console.log(`  ${owner}: total=${b.total} open=${b.open} near-due=${b["near-due"]} overdue=${b.overdue} ack=${b.ack}`);
  }
  if (m.blockingCount) process.exitCode = 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    try {
      if (cmd === "open") await open();
      else if (cmd === "ack") await setStatus("ack");
      else if (cmd === "close") await setStatus("closed");
      else if (cmd === "list") await list();
      else if (cmd === "sweep") await sweep();
      else if (cmd === "metrics") await metrics();
      else { console.error('usage: decision.mjs open --category <c> --owner <a> [--expected-by <ISO>] [--evidence <link>] [--terminal-policy <block|escalate|proceed>] | ack <id> --owner <a> | close <id> --owner <a> | list [--owner <a>] [--overdue] [--json] | sweep [--dispatch] [--json] | metrics [--json]'); process.exit(2); }
    } catch (e) { console.error("decision-clock ERROR: " + e.message); process.exitCode = 1; }
    finally {
      try { await closeConnection(); }
      catch { console.error("[decision-clock] state connection cleanup failed"); process.exitCode = 1; }
    }
  })();
}

