#!/usr/bin/env node
// heartbeat.mjs — fleet dead-man's-switch (P0 stability, 2026-07-04). Every scheduled job/agent
// emits a 'start' + 'ok' (or 'fail') beat to durable storage; a single watcher treats SILENCE as
// failure. Storage: otchealthcommons/company-journal/_HEARTBEAT/<job>.json (non-PHI, shared ops
// plane), via the shared commons-store.mjs facade (S3, see below). Dependency-free (node builtins +
// fetch, transitively through s3-blob.mjs).
//
// PORTED TO S3 (2026-08-27). The Azure subscription holding this file's Key Vault (AZURE_SP_*) and
// the `otchealthcommons` Blob storage account was permanently deleted 2026-08-13; every SAS-signed
// request this file used to make now fails against a dead endpoint. Ported storage to the fleet's S3
// DR mirror via skills/kb-memory/commons-store.mjs (the same MIRROR-table-backed adapter
// fleet-dispatch/fleet-medic/sunset-protocol/fleet-search now share) -- a preflight read-only listing
// confirmed the `_HEARTBEAT/` prefix is present and populated on the mirror before this port shipped.
//
// The OLD "control-plane liveness" half of this file is GONE, not ported: it queried Azure Resource
// Manager (ARM) for a job's own Container Apps Job execution history (a stronger signal than a
// self-beat, since it could see a job that couldn't even start) and, opt-in per registry entry, could
// POST an ARM "start job" call to auto-restart a DEAD job. ARM for that subscription is unreachable
// forever. There is no AWS ECS equivalent wired up yet (an ECS RunTask restart needs its OWN SigV4
// caller for the `ecs` service -- do NOT reuse s3-blob.mjs's signer for it: S3 is AWS's one
// single-encode-path exception, per that file's own canonicalUri() comment, and an `ecs` caller needs
// the normal double-encode behavior). Until that lands:
//   - every job's `rg` field in heartbeat-registry.json is now INERT (it named an Azure resource
//     group; there is nothing left to query there). Left in place rather than stripped out --  it
//     still documents which jobs were considered safe/unsafe to auto-restart, which is exactly the
//     judgment call an eventual ECS restart executor will need to re-make.
//   - `check` reports LIVE/LATE/DEAD/NO-DATA from the self-beat alone. A job that cannot even start
//     now shows the SAME "DEAD (never)" as a job that started and then silently stopped beating --
//     that distinction (the whole point of the old ARM-liveness half) is a real regression until an
//     ECS-based equivalent exists; it is called out here rather than left to be discovered.
//   - `planAutoRestart()` (the pure cooldown/escalate decision core) is UNCHANGED and stays exported +
//     hermetically tested (tests/heartbeat-autorestart.test.mjs) -- its cooldown/escalate judgment
//     will be the right thing to reuse once a real ECS executor exists. `maybeAutoRestart()` (the I/O
//     wrapper that used to call ARM) is now a stub that reports the executor is unavailable, for any
//     job the registry has opted into auto_restart, WITHOUT ever calling planAutoRestart or touching
//     any restart-state blob -- there is no attempt to track/cool down/escalate an action that never
//     happens.
//
// Usage:
//   node setup/heartbeat.mjs beat <job> <start|ok|fail> [--detail "..."]
//   node setup/heartbeat.mjs check [--json] [--dry-run]
//     --dry-run: accepted for backward compatibility with existing callers/cron steps. No live
//     auto-restart executor exists right now, so every auto-restart-eligible DEAD job already reports
//     "restart-unavailable" regardless of this flag; kept as a recognized no-op rather than an error.
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { cGet, cPut, cListMeta, commonsConfigured } from "../skills/kb-memory/commons-store.mjs";
const HERE = dirname(fileURLToPath(import.meta.url));
const PREFIX = "_HEARTBEAT/";
const argv = process.argv.slice(2);
const cmd = argv[0];
const takeVal = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

async function ensureConfigured() {
  if (!(await commonsConfigured())) {
    console.error("[heartbeat][FATAL] AWS credentials unavailable for the commons S3 mirror (checked the ECS task role, AWS_ACCESS_KEY_ID/SECRET, and OTC_AWS_ACCESS_KEY_ID/SECRET).");
    process.exit(78);
  }
}
async function getJson(file) {
  let text;
  try { text = await cGet(`${PREFIX}${file}`); } catch (e) { throw new Error("get " + e.message); }
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}
async function putJson(file, obj) {
  await cPut(`${PREFIX}${file}`, JSON.stringify(obj), "application/json");
}
async function listBeats() {
  const rows = await cListMeta(PREFIX);
  return rows.filter((r) => r.name.endsWith(".json")).map((r) => r.name.slice(PREFIX.length));
}
// RETIRED-JOB CONVENTION (2026-09-01). A registry key beginning with "_" is documentation, not a
// job to watch. Retiring a job by DELETING its row loses the reason it was retired; leaving a live
// row is worse -- a DISABLED or deleted job can never beat, so `check` reports it DEAD forever and
// every sentinel run pages on a job nobody intends to run, which trains the reader to ignore the
// pager. claude-tools#487 hit exactly this when azure-canary's workflow was deleted while its
// registry row stayed. So retire by renaming the key to "_retired_<name>" and recording why.
// Note this filters the REGISTRY only: `check` also watches every job a beat file names, so a
// retired job that somehow still beats stays visible instead of being silently ignored.
export function isWatchedJobKey(key) { return !String(key).startsWith("_"); }
// Allow at most one minute of producer/observer clock skew, clamped to age zero. A timestamp
// farther ahead cannot demonstrate health. Read the observation clock after each beat fetch.
export const HEARTBEAT_CLOCK_SKEW_MS = 60_000;
export function heartbeatAgeMinutes(lastOk, now) {
  if (typeof lastOk !== "string" || !Number.isFinite(now)) return null;
  const parsed = Date.parse(lastOk);
  if (!Number.isFinite(parsed) || parsed - now > HEARTBEAT_CLOCK_SKEW_MS) return null;
  return Math.max(0, Math.round((now - parsed) / 60000));
}

function loadRegistry() {
  try {
    const raw = JSON.parse(readFileSync(join(HERE, "heartbeat-registry.json"), "utf8"));
    return Object.fromEntries(Object.entries(raw).filter(([k]) => isWatchedJobKey(k)));
  } catch { return {}; }
}

const DRY_RUN = argv.includes("--dry-run") || process.env.HEARTBEAT_RESTART_DRY_RUN === "1";
// Kept only so a future real executor has the same knobs it had before; unused by the stub below.
const RESTART_COOLDOWN_MIN = parseInt(process.env.HEARTBEAT_RESTART_COOLDOWN_MIN || "360", 10) || 360;   // 6h, mirrors fleet-medic MEDIC_COOLDOWN_MIN
const RESTART_ESCALATE_AFTER = parseInt(process.env.HEARTBEAT_RESTART_ESCALATE_AFTER || "3", 10) || 3;   // 3x, mirrors fleet-medic MEDIC_ESCALATE_AFTER
void DRY_RUN; // recognized flag, no live behavior differs on it right now (see the header note)

// ============================ PURE CORE (hermetically tested) ============================
// planAutoRestart(): given prior per-job restart state + now, decide what SHOULD happen — restart,
// hold in cooldown, or escalate-and-pause — with no I/O. UNCHANGED by the S3 port (see the header
// note): kept as the pure decision core a future ECS-based executor can reuse verbatim, and its
// existing hermetic test suite (tests/heartbeat-autorestart.test.mjs) must keep passing unmodified.
//   prior: { last_restart_ts, consecutive_restarts, paused } (defaults applied if absent)
//   opts:  { cooldownMin, escalateAfter } (defaults to the module constants; overridable for tests)
// returns: { plan: "paused"|"cooldown"|"escalate"|"restart", detail, attempt, nextState }
export function planAutoRestart(job, prior, now, opts = {}) {
  const cooldownMin = opts.cooldownMin ?? RESTART_COOLDOWN_MIN;
  const escalateAfter = opts.escalateAfter ?? RESTART_ESCALATE_AFTER;
  const st = prior || { last_restart_ts: 0, consecutive_restarts: 0, paused: false };

  if (st.paused) return { plan: "paused", detail: "auto-restart previously escalated + paused for this job; human clear required", attempt: st.consecutive_restarts || 0, nextState: st };

  const sinceMs = st.last_restart_ts ? now - Date.parse(st.last_restart_ts) : Infinity;
  if (sinceMs < cooldownMin * 60000) {
    return { plan: "cooldown", detail: `last restart ${Math.round(sinceMs / 60000)}m ago, cooldown is ${cooldownMin}m`, attempt: st.consecutive_restarts || 0, nextState: st };
  }

  const attempt = (st.consecutive_restarts || 0) + 1;
  if (attempt > escalateAfter) {
    // Already past the escalate threshold and still DEAD -> stop retrying forever, pause, escalate once.
    return { plan: "escalate", detail: `${st.consecutive_restarts} prior auto-restart attempt(s) did not bring it back to LIVE`, attempt: st.consecutive_restarts || 0, nextState: { ...st, paused: true } };
  }

  return { plan: "restart", detail: `attempt ${attempt}/${escalateAfter}`, attempt, nextState: null /* caller fills in on ARM success */ };
}

// maybeAutoRestart(): the I/O wrapper. Before the S3 port this called ARM (or, in --dry-run, reported
// the plan) and fleet-dispatch for escalation, driven by planAutoRestart()'s cooldown/escalate state
// machine. There is no restart executor left to call (see header note), so this is now a pure stub:
// it reports the SAME fixed outcome every time, for every eligible job, and deliberately does NOT
// invoke planAutoRestart or read/write any restart-state blob -- there is nothing to cool down or
// escalate when no attempt is ever actually made. Never throws.
async function maybeAutoRestart(job, entry) {
  void job; void entry;
  return { action: "restart-unavailable", detail: "no ARM; ECS restart TBD (the Azure Container Apps control plane this used is permanently gone; a replacement AWS ECS RunTask executor has not been built yet)" };
}

// isMain guard: the pure planAutoRestart() export above needs to be importable from a hermetic test
// file (tests/heartbeat-autorestart.test.mjs) without the CLI body firing process.exit() on import.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain)
(async () => {
  if (cmd === "beat") {
    const job = argv[1], event = argv[2];
    if (!job || !["start", "ok", "fail"].includes(event)) { console.error("usage: heartbeat.mjs beat <job> <start|ok|fail> [--detail ...]"); process.exit(2); }
    await ensureConfigured();
    const now = new Date().toISOString();
    const cur = (await getJson(`${job}.json`)) || { job };
    cur.last_event = event; cur.updated = now; cur.detail = takeVal("--detail") || cur.detail || "";
    if (event === "start") cur.last_start = now;
    if (event === "ok") { cur.last_ok = now; cur.consecutive_fail = 0; }
    if (event === "fail") { cur.last_fail = now; cur.consecutive_fail = (cur.consecutive_fail || 0) + 1; }
    await putJson(`${job}.json`, cur);
    console.log(`[heartbeat] ${job} <- ${event} @ ${now}`);
    return;
  }
  if (cmd === "check") {
    await ensureConfigured();
    const reg = loadRegistry();          // { job: { interval_min, owner, rg (inert), auto_restart } }
    const files = await listBeats();
    const seen = new Set(files.map((f) => f.replace(/\.json$/, "")));
    const jobs = [...new Set([...Object.keys(reg), ...seen])].sort();
    const rows = [];
    for (const job of jobs) {
      const hb = (await getJson(`${job}.json`)) || {};
      const intervalMin = (reg[job] && reg[job].interval_min) || null;
      const ageMin = heartbeatAgeMinutes(hb.last_ok, Date.now());
      // No ARM/control-plane signal any more (see header note): status is derived from the self-beat
      // alone. A job that never even started now reads identically to one that started and stopped
      // beating -- both are "DEAD (never)" / "NO-DATA" -- where the pre-port ARM path could once tell
      // those apart. Flagged, not silently narrowed.
      let status;
      // A present but unusable completion timestamp is actionable even without a registry row.
      const hasLastOk = hb.last_ok !== undefined && hb.last_ok !== null;
      if (!intervalMin && ageMin === null && !hasLastOk) status = "NO-DATA";
      else if (ageMin === null) status = "DEAD";
      else if (intervalMin && ageMin > intervalMin * 3) status = "DEAD"; // 3x = alert
      else if (intervalMin && ageMin > intervalMin) status = "LATE";     // 1x = missing
      else status = "LIVE";
      const row = { job, status, ageMin, intervalMin, owner: (reg[job] || {}).owner || "", last_event: hb.last_event || "", consecutive_fail: hb.consecutive_fail || 0 };

      // Auto-restart eligibility is unchanged in SHAPE (still gated on the registry's own
      // auto_restart:true, still only surfaced for a DEAD job) even though `rg` no longer drives a
      // live ARM check -- it is kept as the same "this job was judged safe to auto-restart" signal
      // for whatever real executor eventually replaces the stub.
      if (status === "DEAD" && reg[job] && reg[job].auto_restart === true) {
        row.autoRestart = await maybeAutoRestart(job, reg[job]);
      }
      rows.push(row);
    }
    if (argv.includes("--json")) { console.log(JSON.stringify(rows, null, 2)); return; }
    const bad = rows.filter((r) => r.status === "DEAD" || r.status === "LATE" || r.consecutive_fail > 0);
    console.log(`# FLEET HEARTBEAT — ${rows.length} job(s); ${bad.length} needing attention`);
    for (const r of rows) {
      const age = r.ageMin == null ? "never" : r.ageMin < 60 ? `${r.ageMin}m` : `${Math.round(r.ageMin / 60)}h`;
      const ar = r.autoRestart ? `  AUTO-RESTART[${r.autoRestart.action}${r.autoRestart.detail ? ": " + r.autoRestart.detail : ""}]` : "";
      console.log(`[${r.status.padEnd(7)}] ${r.job.padEnd(26)} last-ok ${age.padEnd(6)} ${r.intervalMin ? "(expect ≤" + r.intervalMin + "m)" : ""}${r.consecutive_fail ? "  FAILS×" + r.consecutive_fail : ""}${r.owner ? "  -> " + r.owner : ""}${ar}`);
    }
    if (bad.length) console.log(`\nSILENCE = FAILURE: ${bad.map((r) => r.job).join(", ")} need attention.`);
    return;
  }
  console.error("usage: heartbeat.mjs beat <job> <start|ok|fail> | check [--json] [--dry-run]");
  process.exit(2);
})().catch((e) => { console.error("[heartbeat] ERROR: " + e.message); process.exit(1); });
