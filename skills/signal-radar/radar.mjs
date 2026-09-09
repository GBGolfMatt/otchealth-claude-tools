#!/usr/bin/env node
// signal-radar — a DETERMINISTIC, detector-based watcher over the fleet's existing telemetry
// (Sentry, PostHog, grant-tracker, Secret Manager, iHEARtest's RELEASE-LEDGER). Report/observe only:
// it never touches prod, never mutates another system, it only surfaces high-precision Signals and
// routes them to the owning agent's inbox (fleet-dispatch). Mirrors fleet-medic's proven discipline:
// classify -> cooldown -> consecutive-escalate -> FAIL-OPEN -> never-cry-wolf-on-idle.
//
// Verbs:
//   node radar.mjs scan [--emit] [--json] [--only <detector-name>]
//     --emit persists each NEW-OR-PAST-COOLDOWN signal to the agent-state `signals` container (RDS
//     Postgres via ../kb-memory/pg-state.mjs, see common.mjs), emits a signal_detected PostHog event,
//     and dispatches high/escalated signals to the owning agent's inbox. Without --emit this is a pure
//     dry-run (prints what WOULD fire; touches no external state). With --emit, an unconfigured or
//     unreachable agent-state store is a hard failure (non-zero exit), never a silent no-op.
//
// GUARDRAILS (see schema.mjs for the pure logic):
//   - MNPI (INND/securities/Xero/Plaid/stock) signals are hard-routed to owner=cfo and NEVER appear in
//     a fleet-wide digest, regardless of what a detector's OWNER constant says.
//   - PHI (MedReview) is never a data source; detectors that touch Sentry hard-exclude those projects.
//   - One detector throwing never aborts the scan, but durable persistence or dispatch uncertainty
//     exits non-zero so the scheduler can surface an actionable recovery.
//   - Cooldown + consecutive-escalate (schema.shouldFire) stop a flapping metric from spamming an inbox.
import { execFileSync } from "node:child_process";
import { closeConnection, createDoc, readDoc, replaceDoc, queryDocs } from "../kb-memory/pg-state.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { cosmosConfig, cosmosPutSignal, cosmosQuerySignals, posthogEmit } from "./common.mjs";
import { shouldFire, isMnpiSubject, SEVERITY_RANK } from "./schema.mjs";

import * as sentryErrorSpike from "./detectors/sentry-error-spike.mjs";
import * as evalRegression from "./detectors/eval-regression.mjs";
import * as grantBurnExpiry from "./detectors/grant-burn-expiry.mjs";
import * as rotateSecretAge from "./detectors/rotate-secret-age.mjs";
import * as markReviewOverdue from "./detectors/mark-review-overdue.mjs";
import * as contradictionStaleness from "./detectors/contradiction-staleness.mjs";
import * as groundedness from "./detectors/groundedness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DISPATCH_PATH = join(HERE, "..", "fleet-dispatch", "dispatch.mjs");

// Every detector module exports { NAME, OWNER, run() }. Adding another detector later is: write the
// module (mirroring any existing one), import it, and add it here - no other file changes needed.
const DETECTORS = [sentryErrorSpike, evalRegression, grantBurnExpiry, rotateSecretAge, markReviewOverdue, contradictionStaleness, groundedness];

const argv = process.argv.slice(2);
const cmd = argv[0];
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const FLAG = (f) => argv.includes(f);

/** Cooldown/escalate config per severity (higher severity re-fires sooner; a "low" finding is allowed
 * to go quiet longer before it is worth re-flagging). Mirrors fleet-medic's single-cooldown-constant
 * pattern but tiers it, since Radar's detectors span very different natural cadences (a Sentry spike
 * can recur hourly; a grant expiry is a once-a-day-at-most fact). */
const COOLDOWN_MIN_BY_SEVERITY = { high: 240, medium: 720, low: 1440 };
const ESCALATE_AFTER = 3;

async function runDetectorSafely(mod) {
  const notes = [];
  try {
    const { signals, notes: n } = await mod.run();
    return { name: mod.NAME, signals: signals || [], notes: (n || []).concat(notes), error: null };
  } catch (e) {
    // FAIL-OPEN: a broken detector produces zero signals and one diagnostic note, never crashes the scan.
    return { name: mod.NAME, signals: [], notes: [`detector threw: ${e.message}`], error: e.message };
  }
}

/** Default dispatch: the real fleet-dispatch subprocess call. Injectable (see runScan's `dispatch`
 *  param) so a test can prove a signal actually routes to an owner's inbox without shelling out. */
function defaultDispatch(owner, text) {
  execFileSync("node", [DISPATCH_PATH, "send", owner, text, "--from", "signal-radar"], { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true });
}

const dispatchText = (s) => `[signal-radar] ${s.severity.toUpperCase()} ${s.detector}: ${s.why} Action: ${s.suggested_action}`;
const hasEtag = (value) => typeof value === "string" && value.length > 0;
const cooldownClock = (doc) => [doc?.ts, doc?.dispatch_started_at, doc?.dispatched_at].filter(Boolean).sort().at(-1) || doc?.ts;

/** A dispatch has no downstream idempotency key or authoritative readback. Claim it with CAS before
 * invoking the writer, then leave any interrupted/failed attempt ambiguous rather than retrying it. */
async function deliverPending(io, dispatch, signal, now) {
  const current = await io.cosmosReadSignal(signal.owner, signal.id);
  if (!current || !hasEtag(current.etag) || current.doc?.owner !== signal.owner || current.doc?.id !== signal.id || current.doc?.detector !== signal.detector || current.doc.dispatch_state !== "pending") return { status: "unresolved", id: signal.id, reason: "pending record changed, missing, or lacks an etag" };
  const claim = { ...current.doc, dispatch_state: "dispatching", dispatch_started_at: new Date(now).toISOString() };
  const claimed = await io.cosmosReplaceSignal(signal.owner, signal.id, claim, current.etag);
  if (claimed?.ok !== true || !hasEtag(claimed.etag)) return { status: "unresolved", id: signal.id, reason: "dispatch claim conflicted or lacks an etag" };
  try {
    await dispatch(current.doc.owner, dispatchText(current.doc));
  } catch (error) {
    const ambiguous = { ...claim, dispatch_state: "ambiguous", dispatch_error_category: "dispatch_response_unconfirmed" };
    await io.cosmosReplaceSignal(signal.owner, signal.id, ambiguous, claimed.etag);
    return { status: "ambiguous", id: signal.id, reason: "dispatch response was not confirmed; inspect inbox before retrying" };
  }
  // fleet-dispatch has no receiver readback. `sent` means only that its bounded subprocess returned.
  const sent = { ...claim, dispatch_state: "sent", dispatch_confirmation: "subprocess_return_only", dispatched_at: new Date(now).toISOString() };
  const recorded = await io.cosmosReplaceSignal(signal.owner, signal.id, sent, claimed.etag);
  if (recorded?.ok !== true) return { status: "ambiguous", id: signal.id, reason: "dispatch may have succeeded but sent receipt was not persisted" };
  return { status: "sent", id: signal.id, confirmation: "subprocess_return_only" };
}

/**
 * The whole scan: run every detector, classify + cooldown-gate the findings, and (with emitting=true)
 * persist + dispatch. Exported and parameterized (io/dispatch/detectors/now all injectable, defaulting
 * to the real module-level implementations) so decision-clock's counterpart FAIL-LOUD requirement and
 * the "persist + dispatch actually happen" requirement are both testable with a fake state backend, in
 * process, with no real Postgres connection and no node:test module mocking (see common.mjs's own
 * backend-swap seam for why mock.module() is not an option here).
 *
 * Returns a small result object so a caller (a test, or a future --json consumer) can inspect exactly
 * what happened without re-parsing console output: { firing, configured, persisted, dispatched }.
 */
export async function runScan(opts = {}) {
  const {
    only = "",
    emitting = false,
    asJson = false,
    io = {
      cosmosConfig, cosmosPutSignal, cosmosQuerySignals, posthogEmit,
      cosmosCreateSignal: (doc) => createDoc("signals", doc.owner, doc),
      cosmosReadSignal: (owner, id) => readDoc("signals", owner, id),
      cosmosReplaceSignal: (owner, id, doc, etag) => replaceDoc("signals", owner, id, doc, etag),
      cosmosQueryDispatchSignals: (owner, detector, state) => queryDocs("signals", "SELECT * FROM c WHERE c.dispatch_state = @state AND c.detector = @detector", [{ name: "@state", value: state }, { name: "@detector", value: detector }], { pk: owner, max: 101 }),
    },
    dispatch = defaultDispatch,
    detectors = DETECTORS,
    now = Date.now(),
    beforeDispatch = null,
  } = opts;
  const targets = only ? detectors.filter((d) => d.NAME === only) : detectors;
  if (only && !targets.length) { console.error(`unknown detector "${only}". known: ${detectors.map((d) => d.NAME).join(", ")}`); process.exit(2); }

  const cosmosCfg = await io.cosmosConfig().catch(() => null);

  const perDetector = [];
  let allSignals = [];
  for (const mod of targets) {
    const result = await runDetectorSafely(mod);
    perDetector.push(result);
    allSignals = allSignals.concat(result.signals);
  }

  // MNPI hard-route: regardless of a detector's default OWNER, any subject that trips the MNPI test
  // is force-routed to cfo and flagged mnpi=true so a digest layer can hard-exclude it.
  for (const s of allSignals) {
    if (isMnpiSubject(s.detector, s.subject)) { s.mnpi = true; s.owner = "cfo"; }
  }

  // cooldown / consecutive-escalate per signal id, using agent-state history when configured. Without
  // it configured, every signal is treated as "fire" (dry-run-safe; --emit still requires the
  // agent-state store to actually persist, so a mis-provisioned store never silently double-dispatches).
  const decisions = [];
  let historyFailure = false;
  for (const s of allSignals) {
    let history = [];
    if (cosmosCfg) {
      try { history = await io.cosmosQuerySignals(s.owner, "SELECT c.ts, c.dispatch_started_at, c.dispatched_at FROM c WHERE c.id = @id", [{ name: "@id", value: s.id }]); history = history.map((doc) => ({ ...doc, ts: cooldownClock(doc) })); }
      catch (error) {
        if (emitting) { console.error(`  [warn] signal history read failed; no dispatch permitted.`); historyFailure = true; continue; }
        // A dry-run remains observationally fail-open.
      }
    }
    const cooldownMin = COOLDOWN_MIN_BY_SEVERITY[s.severity] ?? 720;
    const decision = shouldFire(history, now, { cooldownMin, escalateAfter: ESCALATE_AFTER });
    decisions.push({ signal: s, ...decision });
  }

  const firing = decisions.filter((d) => d.fire);
  firing.sort((a, b) => (SEVERITY_RANK[a.signal.severity] ?? 9) - (SEVERITY_RANK[b.signal.severity] ?? 9));

  if (!asJson) {
    console.log(`# SIGNAL RADAR scan ${new Date(now).toISOString()}  (${emitting ? "EMIT" : "dry-run"}; agent-state ${cosmosCfg ? "configured" : "NOT configured"})`);
    for (const r of perDetector) {
      console.log(`  [${r.error ? "ERR " : "ok  "}] ${r.name.padEnd(22)} ${String(r.signals.length).padStart(2)} signal(s)${r.error ? `  (${r.error})` : ""}`);
      for (const note of r.notes) console.log(`         note: ${note}`);
    }
    console.log("");
    if (!firing.length) console.log("  (nothing above threshold; fleet looks quiet)");
    for (const d of firing) {
      const s = d.signal;
      console.log(`[${s.severity.toUpperCase().padEnd(6)}] ${s.detector} -> ${s.owner}${s.mnpi ? " [MNPI: CFO-ONLY]" : ""}${d.escalate ? " [ESCALATE]" : ""}`);
      console.log(`         ${s.why}`);
      console.log(`         action: ${s.suggested_action}`);
    }
    const suppressed = decisions.length - firing.length;
    if (suppressed) console.log(`\n  (${suppressed} finding(s) suppressed by cooldown; a flapping metric will not spam an inbox)`);
  }

  const report = { ts: new Date(now).toISOString(), emitting, detectors: perDetector.map((r) => ({ name: r.name, count: r.signals.length, error: r.error, notes: r.notes })), firing: firing.map((d) => d.signal), suppressed: decisions.length - firing.length };
  if (!emitting) return { ...report, configured: !!cosmosCfg, persisted: null, dispatched: null, unresolved: [] };

  // FAIL LOUD, not silent-success: this is the exact incident that motivated this whole rewrite (see
  // the header notice above and common.mjs's identical history) -- a scheduled job that ran every 30
  // minutes, exited 0, and printed this same line to stderr, but NEVER a non-zero exit code, so
  // CloudWatch looked perfectly healthy while the job persisted and dispatched nothing. `--emit` means
  // the caller EXPECTS persistence/dispatch to happen; if the agent-state store cannot answer even
  // "am I configured", that expectation was not met and the job must say so with its exit code, not
  // just a log line nobody is watching in real time.
  if (!cosmosCfg) {
    console.error("[signal-radar] --emit requested but the agent-state store is not configured (aws-pg-host/aws-pg-master-user/aws-pg-master-password unavailable in AWS SSM /otchealth/*); nothing persisted or dispatched.");
    process.exitCode = 1;
    return { ...report, configured: false, persisted: 0, dispatched: [], unresolved: [{ state: "blocked", reason: "agent-state store unavailable" }] };
  }

  const durable = ["cosmosCreateSignal", "cosmosReadSignal", "cosmosReplaceSignal", "cosmosQueryDispatchSignals"].every((name) => typeof io[name] === "function");
  if (!durable || historyFailure) {
    console.error(`[signal-radar] durable dispatch journal unavailable or history unreadable; no signals dispatched.`);
    process.exitCode = 1;
    return { ...report, configured: true, persisted: 0, dispatched: [], unresolved: [{ state: "blocked", reason: !durable ? "durable journal API unavailable" : "history read failed" }] };
  }

  const dispatched = [];
  const unresolved = [];
  let persisted = 0;
  let persistFailures = 0;
  const replayedIds = new Set();
  const replayScopes = [...new Map(targets.flatMap((d) => [[`${d.OWNER}/${d.NAME}`, { owner: d.OWNER, detector: d.NAME }], [`cfo/${d.NAME}`, { owner: "cfo", detector: d.NAME }]])).values()];
  for (const scope of replayScopes) for (const state of ["pending", "dispatching", "ambiguous"]) {
      const rows = await io.cosmosQueryDispatchSignals(scope.owner, scope.detector, state);
      if (rows.length > 100) unresolved.push({ state: "backlog", reason: `replay backlog reached 100 ${state} records; rerun after inspection` });
      for (const s of rows.slice(0, 100)) {
        if (s.owner !== scope.owner || s.detector !== scope.detector) { unresolved.push({ state: "invalid_scope", reason: "journal row did not match its owner/detector scope" }); continue; }
        if (state !== "pending") { unresolved.push({ id: s.id, state, reason: "dispatch outcome is ambiguous; inspect inbox before retrying" }); continue; }
        const outcome = await deliverPending(io, dispatch, s, now);
        if (outcome.status === "sent") { dispatched.push(s.id); replayedIds.add(s.id); } else unresolved.push(outcome);
      }
  }
  for (const d of firing) {
    const s = d.signal;
    // 2026-08-18: this catch used to be the ONLY trace of a persist failure (a `[warn]` line), while
    // the summary below unconditionally reported `firing.length` as "persisted" regardless of whether
    // the write actually succeeded. Live production logs from THIS EXACT PATH prove the failure mode:
    // "[warn] could not persist signal ... -> 403: Subscription owning the database account is
    // disabled" immediately followed by "[signal-radar] persisted 1 signal(s)" -- a run that persisted
    // ZERO signals reporting one persisted, silently, every 30 minutes. `persisted` now counts only
    // writes that actually returned success, so the summary line -- and any --json/dispatch consumer
    // reading it -- reflects what happened, not what was attempted.
    let persistedThisSignal = false;
    try {
      if (replayedIds.has(s.id)) continue;
      const existing = await io.cosmosReadSignal(s.owner, s.id);
      if (existing && !hasEtag(existing.etag)) {
        unresolved.push({ id: s.id, state: "invalid_etag", reason: "existing journal record lacks an etag" });
        continue;
      }
      if (["dispatching", "ambiguous"].includes(existing?.doc?.dispatch_state)) {
          unresolved.push({ id: s.id, state: existing.doc.dispatch_state, reason: "existing dispatch outcome is ambiguous; inspect inbox before retrying" });
          continue;
      }
      if (existing?.doc?.dispatch_state === "pending") continue;
      if (existing?.doc && !shouldFire([{ ...existing.doc, ts: cooldownClock(existing.doc) }], now, { cooldownMin: COOLDOWN_MIN_BY_SEVERITY[s.severity] ?? 720, escalateAfter: ESCALATE_AFTER }).fire) continue;
      const needsDispatch = s.severity === "high" || d.escalate;
      const journal = { id: s.id, owner: s.owner, ...s, escalate: d.escalate, consecutive: d.consecutive, dispatch_state: needsDispatch ? "pending" : "not_required" };
      let put;
      if (!existing) put = await io.cosmosCreateSignal(journal);
      else {
        if (!hasEtag(existing.etag)) throw new Error("existing signal lacks etag");
        put = await io.cosmosReplaceSignal(s.owner, s.id, journal, existing.etag);
      }
      // cosmosPutSignal reports "not-configured" as a value, not a throw; a write that did not happen
      // must never count as persisted, whichever way it says so.
      if (put?.ok !== true) throw new Error(`put refused: ${put?.reason || "unknown"}`);
      persisted++;
      persistedThisSignal = true;
    }
    catch { persistFailures++; console.error(`  [warn] signal journal write failed; no dispatch permitted.`); }

    // Dispatch must be causally downstream of a confirmed durable record. A failed write is already
    // a non-zero outcome below, and must never still page an owner with an unjournaled signal.
    if (!persistedThisSignal) continue;

    await io.posthogEmit("signal_detected", s.owner, { detector: s.detector, subject: s.subject, severity: s.severity, mnpi: s.mnpi, escalate: d.escalate, consecutive: d.consecutive });

    // Route to the owning agent's inbox. Only high severity or an escalated finding actually pages an
    // agent (a "low" or first-time "medium" is left in the agent-state store for the operator/
    // company-brain to query, not pushed into an inbox) - this is the never-cry-wolf discipline applied
    // to routing, not just cooldown.
    if (s.severity === "high" || d.escalate) {
      if (beforeDispatch) await beforeDispatch(s);
      const outcome = await deliverPending(io, dispatch, s, now);
      if (outcome.status === "sent") dispatched.push(s.id); else unresolved.push(outcome);
    }
  }
  // Narration only, never part of the structured contract: in --json mode this MUST go to stderr so
  // stdout stays pure, parseable JSON for a machine caller (e.g. the Container Apps Job wrapper).
  const summaryLine =
    persistFailures === 0
      ? `[signal-radar] persisted ${persisted} signal(s); dispatched ${dispatched.length} to owner inbox(es).`
      : `[signal-radar] persisted ${persisted} signal(s) (${persistFailures} FAILED, see [warn] lines above); dispatched ${dispatched.length} to owner inbox(es).`;
  if (asJson) console.error(summaryLine); else console.log(`\n${summaryLine}`);
  if (unresolved.length) console.error(`[signal-radar] ${unresolved.length} unresolved dispatch record(s); inspect the durable journal before retrying.`);

  // FAIL LOUD on a partial or total persist failure too: the store answered "configured" but a real
  // write still failed (unreachable/permission/auth), the second half of "unconfigured or unreachable"
  // this whole change exists to make loud. Only firing.length > 0 can trip this -- a quiet fleet with
  // nothing to persist is a genuine, honest success, not this failure class.
  if (persistFailures || unresolved.length) process.exitCode = 1;

  return { ...report, configured: true, persisted, dispatched, unresolved };
}

async function scan() {
  const result = await runScan({ only: val("--only", ""), emitting: FLAG("--emit"), asJson: FLAG("--json") });
  if (FLAG("--json")) console.log(JSON.stringify(result, null, 2));
  return result;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    try {
      if (cmd === "scan") await scan();
      else { console.error("usage: radar.mjs scan [--emit] [--json] [--only <detector-name>]"); process.exit(2); }
    } catch (e) { console.error("signal-radar ERROR: " + e.message); process.exitCode = 1; }
    finally {
      try { await closeConnection(); }
      catch { console.error("[signal-radar] state connection cleanup failed"); process.exitCode = 1; }
    }
  })();
}

