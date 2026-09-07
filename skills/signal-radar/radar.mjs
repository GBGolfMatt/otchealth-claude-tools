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
//   - Fail-open: one detector throwing NEVER aborts the scan or crashes the process (exit 0 always,
//     except a bad CLI usage which exits 2).
//   - Cooldown + consecutive-escalate (schema.shouldFire) stop a flapping metric from spamming an inbox.
import { execFileSync } from "node:child_process";
import { closeConnection } from "../kb-memory/pg-state.mjs";
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
  execFileSync("node", [DISPATCH_PATH, "send", owner, text, "--from", "signal-radar"], { stdio: ["ignore", "pipe", "pipe"] });
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
    io = { cosmosConfig, cosmosPutSignal, cosmosQuerySignals, posthogEmit },
    dispatch = defaultDispatch,
    detectors = DETECTORS,
    now = Date.now(),
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
  for (const s of allSignals) {
    let history = [];
    if (cosmosCfg) {
      try { history = await io.cosmosQuerySignals(s.owner, "SELECT c.ts FROM c WHERE c.id = @id", [{ name: "@id", value: s.id }]); }
      catch { /* fail-open: treat as no history */ }
    }
    const cooldownMin = COOLDOWN_MIN_BY_SEVERITY[s.severity] ?? 720;
    const decision = shouldFire(history, now, { cooldownMin, escalateAfter: ESCALATE_AFTER });
    decisions.push({ signal: s, ...decision });
  }

  const firing = decisions.filter((d) => d.fire);
  firing.sort((a, b) => (SEVERITY_RANK[a.signal.severity] ?? 9) - (SEVERITY_RANK[b.signal.severity] ?? 9));

  if (asJson) {
    console.log(JSON.stringify({ ts: new Date(now).toISOString(), emitting, detectors: perDetector.map((r) => ({ name: r.name, count: r.signals.length, error: r.error, notes: r.notes })), firing: firing.map((d) => d.signal), suppressed: decisions.length - firing.length }, null, 2));
  } else {
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

  if (!emitting) return { firing: firing.map((d) => d.signal), configured: !!cosmosCfg, persisted: null, dispatched: null };

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
    return { firing: firing.map((d) => d.signal), configured: false, persisted: 0, dispatched: [] };
  }

  const dispatched = [];
  let persisted = 0;
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
    try {
      const put = await io.cosmosPutSignal({ id: s.id, owner: s.owner, ...s, escalate: d.escalate, consecutive: d.consecutive });
      // cosmosPutSignal reports "not-configured" as a value, not a throw; a write that did not happen
      // must never count as persisted, whichever way it says so.
      if (put && put.ok === false) throw new Error(`put refused: ${put.reason || "unknown"}`);
      persisted++;
    }
    catch (e) { console.error(`  [warn] could not persist signal ${s.id}: ${e.message}`); }

    await io.posthogEmit("signal_detected", s.owner, { detector: s.detector, subject: s.subject, severity: s.severity, mnpi: s.mnpi, escalate: d.escalate, consecutive: d.consecutive });

    // Route to the owning agent's inbox. Only high severity or an escalated finding actually pages an
    // agent (a "low" or first-time "medium" is left in the agent-state store for the operator/
    // company-brain to query, not pushed into an inbox) - this is the never-cry-wolf discipline applied
    // to routing, not just cooldown.
    if (s.severity === "high" || d.escalate) {
      const text = `[signal-radar] ${s.severity.toUpperCase()} ${s.detector}: ${s.why} Action: ${s.suggested_action}`;
      try {
        await dispatch(s.owner, text);
        dispatched.push(s.id);
      } catch (e) { console.error(`  [warn] dispatch to ${s.owner} failed for ${s.id}: ${e.message}`); }
    }
  }
  // Narration only, never part of the structured contract: in --json mode this MUST go to stderr so
  // stdout stays pure, parseable JSON for a machine caller (e.g. the Container Apps Job wrapper).
  const summaryLine =
    persisted === firing.length
      ? `[signal-radar] persisted ${persisted} signal(s); dispatched ${dispatched.length} to owner inbox(es).`
      : `[signal-radar] persisted ${persisted}/${firing.length} signal(s) (${firing.length - persisted} FAILED, see [warn] lines above); dispatched ${dispatched.length} to owner inbox(es).`;
  if (asJson) console.error(summaryLine); else console.log(`\n${summaryLine}`);

  // FAIL LOUD on a partial or total persist failure too: the store answered "configured" but a real
  // write still failed (unreachable/permission/auth), the second half of "unconfigured or unreachable"
  // this whole change exists to make loud. Only firing.length > 0 can trip this -- a quiet fleet with
  // nothing to persist is a genuine, honest success, not this failure class.
  if (persisted < firing.length) process.exitCode = 1;

  return { firing: firing.map((d) => d.signal), configured: true, persisted, dispatched };
}

async function scan() {
  return runScan({ only: val("--only", ""), emitting: FLAG("--emit"), asJson: FLAG("--json") });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    try {
      if (cmd === "scan") await scan();
      else { console.error("usage: radar.mjs scan [--emit] [--json] [--only <detector-name>]"); process.exit(2); }
    } catch (e) { console.error("signal-radar ERROR: " + e.message); process.exitCode = 0; } // preserve the existing fail-open policy
    finally {
      try { await closeConnection(); }
      catch { console.error("[signal-radar] state connection cleanup failed"); process.exitCode = 1; }
    }
  })();
}

