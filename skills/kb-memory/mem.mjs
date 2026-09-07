#!/usr/bin/env node
// kb-memory — durable, append-only WORKING MEMORY for agents. Defeats context-window compaction:
// facts / decisions / corrections / pitfalls / status are externalized the INSTANT they are stated,
// and re-read on wake, so the chat window is disposable and nothing established is lost or silently
// changed. Per-agent and RING-CORRECT (the private ledger co-locates inside the agent's own store).
// Dependency-free; self-resolves creds from Secret Manager via the claude-driver SA.
//
// THE MODEL: the ledger is the source of truth; recall by READING it, never by trusting in-session
// memory. Append-only + temporal supersession (corrections keep WAS->NOW). PITFALLS capture the
// recurring WRONG beliefs the AI keeps forming.
//
// CONNECTED EXEC MEMORY: each agent keeps a PRIVATE lane (ring-correct). `status` (always) and any
// entry written with `--share` ALSO publish a copy to the broadly-readable EXEC TEAM feed
// (otchealthcommons/company-journal/_MEMORY/_exec/<agent>.jsonl, ONE file per agent = no clobber),
// which every agent's tail / recall / team automatically reads. So the whole exec team shares facts
// and sees each other's project status, while privilege / MNPI DETAIL stays in each private lane
// (only what you explicitly `status` / `--share` ever leaves your lane). The CLO PERSONAL lane is
// HARD-EXCLUDED from sharing (attorney privilege).
//
// Verbs:
//   remember "<fact>"   --agent cfo [--tags a,b] [--source "..."] [--share]
//   decision "<made>"   --agent cfo [...] [--share]
//   correct  "<right>"  --agent cfo --was "<wrong>" [--supersedes id] [--share]
//   pitfall  "<lesson>" --agent cfo [--share]
//   status   "<what I'm working on / project status>" --agent cfo    # ALWAYS shared to the exec team
//   entity   set <key> "<value>" --agent cfo [--source ..] [--share]  # deterministic current-value ("what is X now")
//   entity   get <key> --agent cfo | list | alias "<from>" <to> [--source ..] [--share]  # latest-wins per key; alias many phrasings -> 1 key
//   entity   link <from-key> <relation> <to-key> --agent cfo [--source ..] [--share]  # append a relationship edge (from -relation-> to)
//   entity   graph <key> --agent cfo [--hops 1|2]                     # 1-2 hop neighborhood walk over links, both directions ("what depends on X")
//   recall   "<query>"  --agent cfo [--n 25]    # searches YOUR lane + the shared TEAM feed
//   tail     --agent cfo [--n 40]               # YOUR pitfalls/recent + the TEAM feed (company-wide)
//   team     [--agent x] [--n 60]               # the whole exec team feed: who is working on what
//   render   --agent cfo  |  list-agents
//   state    --get [--json] --agent cfo | --set [--goal ..] [--constraints a;b;c] [--decisions a;b;c] [--last ..]
//   state-sync --agent cfo --facts '["..."]' [--source precompact|stop|periodic] [--session-id id]  # CBP-1 hook path, additive-only
import crypto from "node:crypto";
import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeAdvisory, RING_DENY } from "./dedupe.mjs";
import { parseNdjson, serializeNdjson, nextId, isConflict, condHeaders } from "./blobwrite.mjs";
import { kvSecret } from "./azure-secret.mjs";
import { linkFields, walkGraph, formatEdge } from "./entity-graph.mjs";
import { assertAliasOwner, buildAliasEntry, resolveAliasTarget } from "./entity-alias.mjs";
import { assertCrossLaneAllowed } from "./lane-policy.mjs";
import { getTextFromS3, getTextMetaFromS3, putObjectToS3, listBlobsFromS3, s3Configured } from "./s3-blob.mjs";
import { awsCredsPresent } from "./aws-secret.mjs";
import { FAILED_WRITE_FILE, appendFailedWriteFallback } from "./local-fallback.mjs";
import { redactSecrets } from "./redact.mjs";
const HERE = dirname(fileURLToPath(import.meta.url)); // for spawning sibling scripts (index-one.mjs)

const SM = "otchealth-shared-prod";
const AGENTS = {
  cfo:            { account: "otchealthcfodata",    accountSecret: "azure-cfo-storage-account",    keySecret: "azure-cfo-storage-key",    container: "cfo-source-docs", ring: "finance (MNPI/private)" },
  clo:            { account: "otchealthlegalstore", accountSecret: "azure-legal-storage-account",  keySecret: "azure-legal-storage-key",  container: "company",         ring: "legal company (privileged)" },
  "clo-personal": { account: "otchealthlegalstore", accountSecret: "azure-legal-storage-account",  keySecret: "azure-legal-storage-key",  container: "personal",        ring: "legal PERSONAL (privileged + confidential, segregated)" },
  // exec = the UNIFIED executive identity (CEO direction 2026-07-04): the solo operator wears every
  // C-suite hat, so the chiefs collapse into one 'exec' lane. Its ledger lives in the most-restricted
  // (legal) account under a dedicated 'exec' container — never under-classify unified privileged content.
  exec:           { account: "otchealthlegalstore", accountSecret: "azure-legal-storage-account",  keySecret: "azure-legal-storage-key",  container: "exec",            ring: "executive (unified chief; privileged)" },
  commons:        { account: "otchealthcommons",    accountSecret: "azure-commons-storage-account", keySecret: "azure-commons-storage-key", container: "company-journal", ring: "fleet commons (shared)" },
};
// The executive team: agents whose status + shared facts flow into the connected team feed. Any agent
// can publish/read; this set is documentation + the default `team` roster.
const EXEC = ["exec", "coo", "cfo", "clo", "cto", "capital", "commerce", "compliance", "rainmaker", "growth", "developer"];
const NO_SHARE = new Set(["clo-personal"]); // privilege wall: personal-matter memory never leaves its lane

// ---- BLOB_BACKEND: azure | s3 (2026-08-18, the Azure-write-lock fix) --------------------------
// Every storage account this file targets (otchealthcommons, otchealthcfodata, otchealthlegalstore)
// is now WRITE-BLOCKED: every PUT returns `403 AuthorizationPermissionMismatch` while GET/LIST still
// answer normally (verified live, all three accounts, 2026-08-18 -- see the PR description for the
// probe). This reads like an account-wide read-only lock applied as an Azure-exit step, NOT literal
// resource deletion (a prior note calling it "permanently deleted" overstates what was verified; the
// data is still there and still readable). Whatever the precise mechanism, it is unconditional and
// not expected to reverse, so writes need a real alternate destination, not a wait-and-retry.
//
// otchealth-mcp-server (the gateway) hit the identical wall and ships `BLOB_BACKEND=s3` in its own
// production task definition today, backed by an S3 mirror at the EXACT SAME object paths
// (`<account>/<container>/<blobPath>`) this file already computes -- see s3-blob.mjs's header for
// the full mapping. Two differences from the gateway's own default justify diverging from it here:
//
//   1. The gateway's code DEFAULT stays 'azure' because ops sets BLOB_BACKEND=s3 explicitly in its
//      ONE task definition. kb-memory has no equivalent single deployment point -- it runs on many
//      independent agent seats, most of which will never set this var by hand. Keeping 'azure' as
//      the default here would mean this fix only helps a seat that already knew to opt in, i.e. it
//      would not actually close the reported bug for the general case. So the default here is 's3'.
//   2. Unlike kvSecret()'s "try Azure, fall back to SSM" pattern (right for a maybe-transient
//      credential hiccup), retrying a write against an account that is DURABLY locked burns
//      fetchRetry's full backoff ladder (up to ~4 attempts, several seconds) on every single call,
//      forever, for no chance of success. So this is a hard SELECT, not a try-then-fallback: writes
//      go straight to S3 and never attempt the doomed Azure PUT.
//
// READS are different: S3 only has a COMPLETE mirror for the rooms migrated on 2026-08-15/16 (CFO,
// legal). The otchealthcommons/company-journal mirror ROW was added today and is still nearly empty
// (verified live: one object, the gateway's own just-written proof entry) -- the full multi-year
// shared-team-feed and every private ledger's history live ONLY in Azure right now. Reading S3-only
// would make thousands of existing pitfalls/decisions/status entries vanish from `tail`/`team`/
// `recall` the moment this ships: a smaller, quieter version of the exact "silent memory loss" bug
// this fix exists to close, just moved from writes to reads. So reads MERGE: S3 (authoritative,
// carries every post-fix write) union Azure (best-effort; read-only but not yet gone, so still the
// only copy of the deep history). Azure failing on a read is caught and ignored per-call here, never
// fatal -- the day Azure truly disappears, reads keep working from S3 alone with no code change.
const BLOB_BACKEND = (process.env.BLOB_BACKEND || "s3").toLowerCase(); // 'azure' | 's3'
const S3_WRITES = BLOB_BACKEND !== "azure";

// ---- args ----
const argv = process.argv.slice(2);
const cmd = argv[0];
const takeVal = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const positional = argv.slice(1).filter((a, i, arr) => !a.startsWith("--") && !(i > 0 && arr[i - 1].startsWith("--")));
const TEXT = positional.join(" ").trim();
const AGENT = (takeVal("--agent", "") || "").toLowerCase();        // the WRITER identity (who is acting)
const ON = (takeVal("--on", "") || AGENT).toLowerCase();           // the TARGET ledger (default: self)
const CROSS = Boolean(AGENT && ON && AGENT !== ON);                // writing on ANOTHER exec agent's ledger
const A = AGENTS[ON] || (ON ? { ...AGENTS.commons, _file: ON } : null); // the STORE is the TARGET lane's
// The personal legal lane is segregated in both directions. Enforce this before any store opens.
assertCrossLaneAllowed(AGENT, ON);
const TAGS = (takeVal("--tags", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const SOURCE = takeVal("--source", "");
const WAS = takeVal("--was", "");
const SUPERSEDES = takeVal("--supersedes", "");
const SHARE = argv.includes("--share");
const N = parseInt(takeVal("--n", "40"), 10) || 40;
const QUERY = takeVal("--query", "");

// ---- Secret Manager (claude-driver SA) ----
// Resolve the claude-driver SA from the env var OR, failing that, from disk. This closes the
// silent-failure pitfall: a fresh shell has no env var, JSON.parse(undefined) throws an opaque
// "undefined is not valid JSON", and every write/read vanishes -> the agent silently "forgets".
function resolveSaJson() {
  if (process.env.GCP_CLAUDE_DRIVER_SA_JSON) return process.env.GCP_CLAUDE_DRIVER_SA_JSON;
  // HOME-relative only: this is the canonical hydration path (session-start writes it here, vault-sync
  // reads it here) AND it respects a test's temp HOME, so hermetic tests stay hermetic.
  const p = `${homedir()}/.gcp_claude_driver_sa.json`;
  try { if (existsSync(p)) return readFileSync(p, "utf8"); } catch {}
  return null;
}
// ---- "is the memory backend reachable?" (Azure-native; GCP is fully RETIRED) ----
// The store + shared feed live on Azure (Key Vault -> storage account key -> Blob SAS via sm()/initStore();
// see azure-secret.mjs). So the real availability signal is "can we mint an Azure credential", NOT "is the
// GCP claude-driver SA present". The old resolveSaJson()-only check false-negatived EVERY Azure-native seat
// (no GCP SA) into "MEMORY OFF": whoami printed "service-account: MISSING", sunrise printed "attach FAIL",
// AND the pack silently stopped refreshing + team-awareness went blank + the semantic warm was skipped --
// even though reads and writes were working fine over Azure. Probe the actual write path, not a retired var.
function azureCredsPresent() {
  return !!(
    (process.env.AZURE_SP_CLIENT_ID && process.env.AZURE_SP_CLIENT_SECRET && process.env.AZURE_SP_TENANT_ID) ||
    (process.env.IDENTITY_ENDPOINT && process.env.IDENTITY_HEADER) // Container Apps managed identity
  );
}
// Cheap, SYNCHRONOUS presence check for AWS creds (no network). DELEGATES to aws-secret.mjs's own
// awsCredsPresent() (2026-08-18) rather than keeping a second copy of its resolution-order + "prox"
// placeholder guards here: this file's own comment used to say this mirrors that logic, which is
// exactly the kind of drift risk aws-secret.mjs's header separately warns about ("a fourth
// reimplementation of how does this seat get AWS credentials") -- now there is one implementation.
function s3CredsPresent() { return awsCredsPresent().any; }
// True when SOME credential can reach the ACTIVE memory backend. Once BLOB_BACKEND=s3 (the default,
// see above), that means AWS creds primarily, since S3 is what writes/authoritative-reads target now;
// Azure/GCP are accepted too since they still back the best-effort history-merge leg on reads. This
// replaces an Azure-only check that would otherwise report "MEMORY OFF" on every seat that has AWS
// creds but no Azure creds — which, per the same-day audit that produced this fix, is now most seats.
function memoryBackendPresent() { return (S3_WRITES && s3CredsPresent()) || azureCredsPresent() || !!resolveSaJson(); }
function saJwt(scope) {
  const raw = resolveSaJson();
  if (!raw) { console.error("kb-memory: MEMORY IS OFF - no service account. Set GCP_CLAUDE_DRIVER_SA_JSON, or place ~/.gcp_claude_driver_sa.json (run /tmp/octools/setup/session-start.sh)."); process.exit(3); }
  const sa = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  return i + "." + crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url");
}
async function sm(id) {
  // Azure Key Vault FIRST (fleet secret store; GCP Secret Manager retired). Same secret names.
  const kv = await kvSecret(id);
  if (kv != null) return kv;
  // Legacy GCP fallback ONLY if a claude-driver SA is actually present. Guarded so a missing SA
  // returns null instead of triggering saJwt's hard process.exit — the Azure path is the norm now.
  if (!resolveSaJson()) return null;
  const r0 = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(saJwt("https://www.googleapis.com/auth/cloud-platform"))}` });
  const t = (await r0.json()).access_token;
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${t}` } });
  if (!r.ok) return null;
  return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim();
}

// ---- Azure Blob (account SAS) ----
const encPath = (name) => name.split("/").map(encodeURIComponent).join("/");
function buildSas(acct, key) {
  const sv = "2021-12-02", sp = "rwlc", ss = "b", srt = "co";
  const st = new Date(Date.now() - 5 * 60000).toISOString().slice(0, 19) + "Z";
  const se = new Date(Date.now() + 12 * 3600 * 1000).toISOString().slice(0, 19) + "Z";
  const sts = [acct, sp, ss, srt, st, se, "", "https", sv, ""].join("\n") + "\n";
  const sig = crypto.createHmac("sha256", Buffer.from(key, "base64")).update(sts, "utf8").digest("base64");
  return new URLSearchParams({ sv, ss, srt, sp, st, se, spr: "https", sig }).toString();
}
// --- the agent's own private lane ---
let ACCT, AKEY, AZ_SAS, KEYBASE, JSONL, MD, RECON;
async function initStore() {
  if (!A) { console.error("need --agent <cfo|clo|clo-personal|commons|...>"); process.exit(2); }
  ACCT = process.env.KB_ACCOUNT || A.account || (await sm(A.accountSecret));
  if (!ACCT) { console.error(`Missing storage account for ledger '${ON}' (account secret ${A.accountSecret}).`); process.exit(2); }
  // The Azure key is BEST-EFFORT once S3_WRITES is true: it only backs the merge-on-read Azure leg
  // (still-readable pre-migration history) and the explicit BLOB_BACKEND=azure legacy path. A
  // missing/unreachable key must never hard-exit the command the way it used to, because S3 is the
  // write target and the read authority now — losing Azure entirely degrades history depth, it does
  // not break the tool.
  AKEY = process.env.KB_KEY || (await sm(A.keySecret));
  if (AKEY) { AZ_SAS = buildSas(ACCT, AKEY); }
  else if (!S3_WRITES) { console.error(`Missing storage creds for ledger '${ON}' (account ${A.account}, key secret ${A.keySecret}).`); process.exit(2); }
  else { console.error(`[kb-memory] note: Azure key for '${ON}' unavailable; continuing S3-only (pre-fix Azure-only history for this ledger, if any, will not be visible until Azure is reachable again).`); }
  KEYBASE = A._file || ON;
  JSONL = `_MEMORY/${KEYBASE}.jsonl`; MD = `_MEMORY/${KEYBASE}.md`; RECON = `_MEMORY/${KEYBASE}.reconcile`;
}
const url = (name) => `https://${ACCT}.blob.core.windows.net/${A.container}/${encPath(name)}?${AZ_SAS}`;
// Transient-fault retry for the blob ops. A memory WRITE must not be lost to a transient proxy/SAS 403,
// a 429, or a 5xx: those used to throw straight out, so a `mem.mjs remember` silently failed = the exact
// forgetting this whole program fights (seen live 2026-06-25: "ERROR: get 403", fine on a plain retry).
// Bounded short backoff (~300/600/1200ms); a REAL 403 (bad key) just exhausts the few tries then surfaces.
// 404 is NOT retried - for the GETs it is a valid "absent" answer, not a fault.
const RETRYABLE = new Set([403, 408, 429, 500, 502, 503, 504]);
async function fetchRetry(u, opts, tries = 4) {
  let last;
  for (let a = 0; a < tries; a++) {
    try { const r = await fetch(u, opts); if (r.status === 404 || r.ok || !RETRYABLE.has(r.status) || a === tries - 1) return r; last = r; }
    catch (e) { last = e; if (a === tries - 1) throw e; }
    await new Promise((s) => setTimeout(s, 300 * Math.pow(2, a)));
  }
  return last;
}
// Azure read, BEST-EFFORT: never throws, returns null on ANY failure (including "no key at all",
// a genuine outage, or a non-2xx/404 response). S3_WRITES mode uses this ONLY to merge in history
// that predates the 2026-08-18 write lock; Azure going fully dark someday degrades this to "no old
// history found", never an error the caller has to handle. Two tries only (not the full 4): this is
// a best-effort enrichment on the hot path, not the authoritative read, so it must not multiply
// mem.mjs's latency chasing a store that may never answer.
async function azureGetBestEffort(name) {
  if (!AZ_SAS) return null;
  try { const r = await fetchRetry(url(name), undefined, 2); return r && r.ok ? await r.text() : null; }
  catch { return null; }
}
// Merge two ndjson blobs by entry `id` (S3 wins a same-id collision, since it is the authoritative,
// more-recent copy going forward), then resort by `id` — ids are `YYYYMMDD-NNN[-xxxx]`, lexicographic
// order IS chronological order, so this reconstructs a coherent append-order across two sources
// without needing to trust either source's own on-disk ordering.
function mergeJsonlText(s3Text, azureText) {
  if (!azureText) return s3Text; // the overwhelmingly common case once a ledger has been consolidated

  // Azure is a retired, best-effort history source. Some legacy objects are wrapped/encoded rather
  // than plain NDJSON (observed live as a base64-looking `CiAgInR5cG...` payload). A malformed Azure
  // history object must never poison an otherwise healthy authoritative S3 read or block a write.
  // S3 stays strict: malformed authoritative data still throws loudly instead of being hidden.
  let azureRows;
  try { azureRows = parseNdjson(azureText); }
  catch (e) {
    console.error(`[kb-memory] note: ignoring malformed Azure history for '${ON}' (${String(e?.message || e).slice(0, 120)}); continuing from authoritative S3.`);
    return s3Text;
  }

  if (!s3Text) return serializeNdjson(azureRows);
  const byId = new Map();
  for (const r of azureRows) if (r && r.id) byId.set(r.id, r);
  for (const r of parseNdjson(s3Text)) if (r && r.id) byId.set(r.id, r); // S3 overwrites Azure on collision
  const rows = [...byId.values()].sort((a, b) => (a.id || "").localeCompare(b.id || ""));
  return serializeNdjson(rows);
}
async function getText(name) {
  if (S3_WRITES) {
    const s3Text = await getTextFromS3(ACCT, A.container, name); // authoritative; throws loud on a real S3 failure
    return mergeJsonlText(s3Text, await azureGetBestEffort(name));
  }
  const r = await fetchRetry(url(name)); if (r.status === 404) return null; if (!r.ok) throw new Error("get " + r.status); return await r.text();
}
// ETag-aware read for optimistic concurrency: returns { text, etag } (etag null when the blob is absent).
// The etag is always S3's (never Azure's): S3 is the only PUT target now, so it is the only etag a
// conditional write-back needs to be conditioned on.
async function getTextMeta(name) {
  if (S3_WRITES) {
    const { text: s3Text, etag } = await getTextMetaFromS3(ACCT, A.container, name);
    return { text: mergeJsonlText(s3Text, await azureGetBestEffort(name)), etag };
  }
  const r = await fetchRetry(url(name)); if (r.status === 404) return { text: null, etag: null }; if (!r.ok) throw new Error("get " + r.status); return { text: await r.text(), etag: r.headers.get("etag") };
}
async function putText(name, body, ct) {
  if (S3_WRITES) { await putObjectToS3(ACCT, A.container, name, body, ct); return; }
  const r = await fetchRetry(url(name), { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": ct || "text/plain; charset=utf-8" }, body }); if (!r.ok) throw new Error("put " + r.status + " " + (await r.text()).slice(0, 160));
}
// Conditional PUT for optimistic concurrency: pass the ETag read alongside the body; returns a
// Response-shaped object ({ok,status,text()}) so the caller (commitAppend) can detect a precondition
// failure (isConflict) and reload+retry, unchanged from the Azure-only version of this function.
// condHeaders() names ("If-Match"/"If-None-Match") are Azure-style casing; s3-blob.mjs lowercases
// them itself before signing, so passing the SAME helper through to both backends is safe.
async function putTextCond(name, body, ct, etag) {
  if (S3_WRITES) {
    try { const res = await putObjectToS3(ACCT, A.container, name, body, ct, condHeaders(etag)); return { ok: true, status: 200, etag: res.etag, text: async () => "" }; }
    catch (e) { return { ok: false, status: e.status || 500, text: async () => String(e.message || e) }; }
  }
  return fetchRetry(url(name), { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": ct || "text/plain; charset=utf-8", ...condHeaders(etag) }, body });
}
// Atomically append to the JSONL ledger under optimistic concurrency. `buildEntry(freshRows)` MUST
// recompute everything it needs (id via nextId, supersedes, etc.) from the rows it is handed, because
// on a concurrent-writer conflict we reload the fresh blob and call it again. Returns { rows, entry }
// after a committed write (entry === null if buildEntry opts out). Also refreshes the local cache and
// the rendered MD view (MD is a derived, best-effort last-writer-wins view). Throws only if every
// attempt loses the race (extreme contention) or on a non-conflict error.
async function commitAppend(buildEntry, attempts = 6) {
  let lastConflict;
  for (let a = 0; a < attempts; a++) {
    const { text, etag } = await getTextMeta(JSONL);
    const rows = parseNdjson(text);
    const entry = buildEntry(rows);
    if (!entry) return { rows, entry: null };
    rows.push(entry);
    const r = await putTextCond(JSONL, serializeNdjson(rows), "application/x-ndjson", etag);
    if (r.ok) {
      writeCacheRows(KEYBASE, rows); // write-through: instantly in the local recall cache
      try { await putText(MD, renderMd(rows), "text/markdown; charset=utf-8"); } catch {} // derived view; best-effort
      return { rows, entry };
    }
    if (isConflict(r.status)) { lastConflict = r.status; await new Promise((s) => setTimeout(s, 120 * (a + 1))); continue; }
    throw new Error("put " + r.status + " " + (await r.text()).slice(0, 160));
  }
  throw new Error(`kb-memory: append lost the optimistic-concurrency race after ${attempts} attempts (last ${lastConflict}); no data was clobbered`);
}

// --- the shared EXEC team feed (commons; one file per agent => no cross-agent clobber) ---
const C = AGENTS.commons;
const SHARED_PREFIX = "_MEMORY/_exec/";
let C_ACCT, C_SAS;
async function commonsInit() {
  if (C_ACCT) return;
  C_ACCT = process.env.KB_COMMONS_ACCOUNT || C.account || (await sm(C.accountSecret));
  if (!C_ACCT) throw new Error("commons account missing");
  // Same posture as initStore(): the Azure key backs only the best-effort merge-on-read leg once
  // S3_WRITES is true, so its absence is a degradation (less history visible), never a hard failure.
  const k = await sm(C.keySecret);
  if (k) C_SAS = buildSas(C_ACCT, k);
  else if (!S3_WRITES) throw new Error("commons creds missing");
}
const cUrl = (name) => `https://${C_ACCT}.blob.core.windows.net/${C.container}/${encPath(name)}?${C_SAS}`;
async function cGetAzureBestEffort(name) {
  if (!C_SAS) return null;
  try { const r = await fetchRetry(cUrl(name), undefined, 2); return r && r.ok ? await r.text() : null; }
  catch { return null; }
}
async function cGet(name) {
  if (S3_WRITES) return mergeJsonlText(await getTextFromS3(C_ACCT, C.container, name), await cGetAzureBestEffort(name));
  const r = await fetchRetry(cUrl(name)); if (r.status === 404) return null; if (!r.ok) throw new Error("cget " + r.status); return await r.text();
}
async function cPut(name, body) {
  if (S3_WRITES) { await putObjectToS3(C_ACCT, C.container, name, body, "application/x-ndjson"); return; }
  const r = await fetchRetry(cUrl(name), { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": "application/x-ndjson" }, body }); if (!r.ok) throw new Error("cput " + r.status + " " + (await r.text()).slice(0, 160));
}
// AZURE listing, FIXED (2026-08-18): the original `if (!r.ok) break;` returned whatever had
// accumulated so far (empty, on a first-page failure) as a normal successful result — so an expired
// SAS, a network blip, or (as of today) the account-wide write lock's edges reported "nobody on the
// exec team has shared anything" instead of an error. That is consumed by `team`/`tail`/`recall`/
// the retraction filter, so the failure mode was an agent believing the rest of the fleet had
// recorded nothing and a retracted belief able to resurface as current truth — worse than the
// write-side bug, because a wrong answer reads as a right one. otchealth-mcp-server's own Azure
// listing (src/memory/store.ts's listShared) hit and fixed the identical bug; this is the same fix:
// throw on anything other than a genuine "container does not exist yet" 404.
async function cListAzureAll(prefix) {
  const out = []; let marker = "";
  do {
    let u = `https://${C_ACCT}.blob.core.windows.net/${C.container}?restype=container&comp=list&prefix=${encodeURIComponent(prefix)}&${C_SAS}`;
    if (marker) u += `&marker=${encodeURIComponent(marker)}`;
    const r = await fetch(u);
    if (r.status === 404) break;
    if (!r.ok) throw new Error(`commons list ${r.status} (refusing to report an empty shared feed as success): ${(await r.text()).slice(0, 160)}`);
    const xml = await r.text();
    for (const m of xml.matchAll(/<Name>([^<]+)<\/Name>/g)) out.push(m[1]);
    marker = (xml.match(/<NextMarker>([^<]+)<\/NextMarker>/) || [])[1] || "";
  } while (marker);
  return out;
}
async function cList(prefix) {
  if (S3_WRITES) {
    const s3Names = await listBlobsFromS3(C_ACCT, C.container, prefix); // authoritative; throws loud on a real S3 failure
    let azNames = [];
    if (C_SAS) { try { azNames = await cListAzureAll(prefix); } catch { azNames = []; } } // best-effort merge leg only
    return [...new Set([...s3Names, ...azNames])];
  }
  return cListAzureAll(prefix);
}
const sharedKey = (agent) => `${SHARED_PREFIX}${agent}.jsonl`;
async function publishShared(agent, entry) {
  if (NO_SHARE.has(agent)) { console.error(`[kb-memory] NOTE: ${agent} is privileged; entry kept in the private lane only (NOT shared to the exec team).`); return false; }
  await commonsInit();
  const t = await cGet(sharedKey(agent));
  const rows = t ? t.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  rows.push({ ...entry, agent });
  await cPut(sharedKey(agent), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return true;
}
async function readSharedAll() {
  await commonsInit();
  const blobs = (await cList(SHARED_PREFIX)).filter((n) => n.endsWith(".jsonl"));
  const all = [];
  for (const b of blobs) { const t = await cGet(b); if (!t) continue; for (const l of t.split(/\r?\n/).filter(Boolean)) { try { all.push(JSON.parse(l)); } catch {} } }
  return all.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
}

// ---- local write-through cache: the per-prompt recall hook reads the ledger from a LOCAL file (fast,
//      no network) and refreshes from Blob only on a throttle, so continuous injection never hits Azure
//      on every prompt (the "network on every turn" cost). A mem write updates the cache immediately
//      (write-through), so a just-stated fact is recallable on the very next prompt. Fail-open.
const CACHE_DIR = `${homedir()}/.claude/kb-cache`;
const cacheFile = (kb) => `${CACHE_DIR}/${kb}.jsonl`;
const TEAM_CACHE = `${CACHE_DIR}/_team.jsonl`;
const toNdjson = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const fromNdjson = (t) => t.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
function writeCacheRows(kb, rows) { try { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(cacheFile(kb), toNdjson(rows)); } catch {} }
function readCacheRows(kb) { try { return fromNdjson(readFileSync(cacheFile(kb), "utf8")); } catch { return null; } }
function writeTeamCache(rows) { try { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(TEAM_CACHE, toNdjson(rows)); } catch {} }
function readTeamCache() { try { return fromNdjson(readFileSync(TEAM_CACHE, "utf8")); } catch { return null; } }
function ageMs(p) { try { return Date.now() - statSync(p).mtimeMs; } catch { return Infinity; } }

// ---- READ-SIDE ring wall (defense in depth): when building ONE agent's per-prompt pack, never inject
//      another lane's sensitive content. clo-personal / NO_SHARE agents do not read the shared feed at
//      all; and any CROSS-agent line matching MNPI (INND securities) or PHI markers is dropped even if it
//      was shared. The agent's OWN lane is never filtered (own ring). Can only REFUSE, never widen.
//      RING_DENY is IMPORTED from dedupe.mjs (the one canonical copy, see its own header comment for the
//      full vocabulary and the adversarial-review hardening notes) instead of a local literal, so this
//      file can never silently drift out of sync with the shared wall.
const ringSafeCross = (r) => !RING_DENY.test(`${r.text || ""} ${(r.tags || []).join(" ")} ${r.was || ""}`);

// ---- hot-path SEMANTIC tier: when an agent's LOCAL keyword pack is thin, reach into the shared exec
//      brain (the memory-exec AI Search index) BY MEANING and pull a couple of related entries. Uses
//      ONLY a READ-ONLY query key + the search endpoint (cached locally; refreshed off the hot path) and
//      the server-side SEMANTIC RANKER, so there is NO admin key and NO embedding key on the hot path
//      and NO client-side embed call. ONE bounded call (AbortController), thin-triggered + throttled +
//      ring-filtered + fail-open. The query key only ever reads; the code only ever queries memory-exec
//      (the already-ring-safe shared feed), and cross-agent hits still pass the RING_DENY wall.
const SEM_CRED_FILE = `${CACHE_DIR}/.sem-creds.json`;
const SEM_STAMP = `${CACHE_DIR}/.last-sem`;
function readSemCredsCache() { try { const c = JSON.parse(readFileSync(SEM_CRED_FILE, "utf8")); if (c.searchEp && c.queryKey && Date.now() - (c.ts || 0) < 6 * 3600 * 1000) return c; } catch {} return null; }
function spawnSemRefresh() { try { spawn(process.execPath, [join(HERE, "mem.mjs"), "sem-refresh"], { detached: true, stdio: "ignore" }).unref(); } catch {} }
async function semanticHits(prompt, creds, excludePrefixes) {
  // Shared post-filter for both backends: drop empties, dedupe against the local pack, and hold the
  // cross-agent ring wall regardless of which engine served the hits.
  const sift = (hits) => {
    const out = [];
    for (const h of hits) {
      const text = (h.text || "").trim(); if (!text) continue;
      if (h.retracted) continue;
      if (excludePrefixes.has(text.slice(0, 40).toLowerCase())) continue;                  // already in the local pack
      const tags = Array.isArray(h.tags) ? h.tags : String(h.tags || "").split(", ");
      if (h.agent !== AGENT && !ringSafeCross({ text, tags })) continue;                   // cross-agent ring wall
      out.push({ agent: h.agent, type: h.type, text });
      if (out.length >= 3) break;
    }
    return out;
  };
  // DEFAULT backend is the AWS OpenSearch brain (2026-08-27): Azure AI Search died with subscription
  // 55c84f6b, and until this port the hot-path semantic tier burned its 2s budget against the dead
  // endpoint on every thin prompt, fleet-wide, and returned nothing. hybridSearch (BM25+RRF, no
  // embed call) preserves this path's contract: one bounded read, fail-open to the local pack.
  if ((process.env.SEARCH_BACKEND || "opensearch").toLowerCase() !== "azure") {
    try {
      const os = await import("./opensearch-write.mjs");
      const hits = await Promise.race([
        os.hybridSearch("memory-exec", { queryText: String(prompt).slice(0, 400), top: 6 }),
        new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
      ]);
      return Array.isArray(hits) ? sift(hits) : [];
    } catch { return []; }                                                                 // timeout / error -> fail-open
  }
  // Legacy Azure path, reachable only via explicit SEARCH_BACKEND=azure.
  const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 2000);
  try {
    const r = await fetch(`${creds.searchEp}/indexes/memory-exec/docs/search?api-version=2023-11-01`, { method: "POST", signal: ac.signal, headers: { "api-key": creds.queryKey, "Content-Type": "application/json" }, body: JSON.stringify({ search: String(prompt).slice(0, 400), queryType: "semantic", semanticConfiguration: "sem", top: 6, select: "agent,type,ts,text,tags" }) });
    if (!r.ok) return [];
    return sift((await r.json()).value || []);
  } catch { return []; }                                                                   // timeout / error -> fail-open
  finally { clearTimeout(to); }
}

async function load() { const t = await getText(JSONL); if (!t) return []; return t.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
function newId(rows) { return nextId(rows); } // salted + monotonic, see blobwrite.mjs

// ---- cross-lane INBOUND: entries another agent wrote ON this ledger (r.by !== owner), newer than the
//      owner's last reconcile marker. This is the wake "first duty": read own ledger, then see what other
//      agents left, and reconcile. Marker = _MEMORY/<kb>.reconcile (ISO ts) + a local mirror for the pack.
const RECON_LOCAL = (kb) => `${CACHE_DIR}/.reconcile-${kb}`;
async function readReconMarker() { try { const t = await getText(RECON); return (t || "").trim(); } catch { return ""; } }
function inboundRows(rows, owner, marker) {
  return rows.filter((r) => r.by && r.by !== owner && (!marker || (r.ts || "") > marker))
             .sort((a, b) => (a.ts || "").localeCompare(b.ts || ""));
}

function renderMd(rows) {
  const fmt = (r) => `- [${(r.ts || "").slice(0, 10)}] ${r.text}${r.tags && r.tags.length ? `  _(#${r.tags.join(" #")})_` : ""}${r.source ? `  - ${r.source}` : ""}  \`${r.id}\``;
  const active = rows.filter((r) => !rows.some((x) => x.supersedes === r.id));
  const sortNew = (a, b) => (b.ts || "").localeCompare(a.ts || "");
  const sec = (t) => active.filter((r) => r.type === t).sort(sortNew);
  const pit = sec("pitfall"), dec = sec("decision"), fac = sec("fact"), sta = sec("status"), cor = rows.filter((r) => r.type === "correction").sort(sortNew);
  const ent = active.filter((r) => r.type === "entity").sort((a, b) => (a.ekey || "").localeCompare(b.ekey || "")); // current value per key (superseded dropped)
  let md = `# ${KEYBASE.toUpperCase()} Memory Ledger\n\n`;
  md += `> SOURCE OF TRUTH. Read this; do not trust in-session recall. Append-only, dated, newest-wins.\n`;
  md += `> Updated ${new Date().toISOString()} - ${rows.length} entries (${pit.length} pitfalls, ${dec.length} decisions, ${fac.length} facts, ${ent.length} current-values, ${sta.length} status, ${cor.length} corrections).\n\n`;
  md += `## PITFALLS - common mistakes / incorrect beliefs the AI keeps forming. DO NOT REPEAT.\n` + (pit.length ? pit.map(fmt).join("\n") : "- (none yet)") + "\n\n";
  md += `## CURRENT VALUES (entities - latest wins per key; the deterministic "what is X now")\n` + (ent.length ? ent.map((r) => `- \`${r.ekey}\` = ${r.evalue}${r.source ? `  (src: ${r.source})` : ""}  \`${r.id}\``).join("\n") : "- (none yet)") + "\n\n";
  md += `## STATUS - current projects / what I am working on (shared to the exec team)\n` + (sta.length ? sta.map(fmt).join("\n") : "- (none yet)") + "\n\n";
  md += `## DECISIONS (what we decided, and why)\n` + (dec.length ? dec.map(fmt).join("\n") : "- (none yet)") + "\n\n";
  md += `## FACTS (established, current)\n` + (fac.length ? fac.map(fmt).join("\n") : "- (none yet)") + "\n\n";
  md += `## CORRECTIONS (history - what was wrong vs what is right; old is retained on purpose)\n` + (cor.length ? cor.map((r) => `- [${(r.ts || "").slice(0, 10)}] WAS: ${r.was || "?"}  ->  NOW: ${r.text}${r.source ? `  - ${r.source}` : ""}  \`${r.id}\``).join("\n") : "- (none yet)") + "\n";
  return md;
}

async function append(type, share) {
  if (!TEXT) { console.error(`need text: mem.mjs ${type} "<text>" --agent <a>`); process.exit(2); }
  await initStore();
  // CROSS-LANE (writing ON another agent's ledger): APPEND-ONLY + ATTRIBUTED. A cross write can NEVER
  // supersede/overwrite the owner's (or anyone's) entry — a cross 'correct' is an annotation the OWNER
  // reconciles on wake. Same-lane writes keep full supersede semantics. Every entry carries by=<writer>.
  const supersedes = CROSS ? undefined : (SUPERSEDES || undefined);
  // Optimistic-concurrency append: buildEntry recomputes the id from the FRESH rows on every attempt,
  // so a concurrent writer from the other engine can never be clobbered and ids never collide.
  const { rows, entry } = await commitAppend((freshRows) => {
    // Non-blocking write-time advisory (dedupe/contradiction). Never blocks the write.
    if (!supersedes) writeAdvisory(TEXT, freshRows, type);
    return { id: newId(freshRows), ts: new Date().toISOString(), type, text: TEXT, tags: TAGS, by: AGENT, source: SOURCE || undefined, was: WAS || undefined, supersedes };
  });
  let shared = false;
  if (share || type === "status") shared = await publishShared(AGENT, entry);
  maybeIndex(entry, shared);
  emitFleet(entry, shared); // fleet telemetry (env-gated KB_DD_EMIT=1, throttled, fail-open)
  if (CROSS) console.log(`[kb-memory] ${type} BY ${AGENT} -> ON ${ON}'s ledger (${A.ring}) id=${entry.id} [cross-lane note, append-only, no-supersede]. ${ON} ledger now ${rows.length} entries; ${ON} sees it on next wake/reconcile.`);
  else console.log(`[kb-memory] ${type} -> ${AGENT} (${A.ring}) id=${entry.id}. Private ledger ${rows.length} entries${shared ? "; PUBLISHED to exec team feed" : ""}.`);
}

// write-through SEMANTIC index for a SHARED entry: embed + upsert it into the memory-exec AI Search
// index NOW (detached, fire-and-forget) so it is recallable BY MEANING this minute, not only after the
// next 6h/nightly reindex. RING-SAFE: gated on `shared` being true, so it only ever indexes content
// publishShared() let through (never a private / clo-personal lane). Never blocks the write (unref'd);
// index-one.mjs is fail-open. Shared by append() + entity set.
// Index-retry queue (#1+#2): when a synchronous index attempt fails (timeout / non-zero exit) the entry
// is queued here and DRAINED (idempotent upsert-by-id) on the next shared write + by the `index-catchup`
// verb (wired into the daily memory-sweep). Self-heals any miss between the sync write and the 6h reindex.
// RING-SAFE: only ever holds already-`shared` entries. FAIL-OPEN throughout (never blocks the ledger write).
const INDEX_RETRY_FILE = `${CACHE_DIR}/.index-retry.jsonl`;
function indexOne(entry) {
  try { const r = spawnSync(process.execPath, [join(HERE, "index-one.mjs"), AGENT, JSON.stringify(entry)], { stdio: "ignore", timeout: 25000 }); return !r.error && r.status === 0; } catch { return false; }
}
function queueIndexFailure(entry) {
  try { mkdirSync(CACHE_DIR, { recursive: true }); const prev = existsSync(INDEX_RETRY_FILE) ? readFileSync(INDEX_RETRY_FILE, "utf8") : ""; writeFileSync(INDEX_RETRY_FILE, prev + JSON.stringify({ agent: AGENT, entry }) + "\n"); } catch {}
}
function drainIndexRetry(max = 25) {
  try {
    if (!existsSync(INDEX_RETRY_FILE)) return;
    const lines = readFileSync(INDEX_RETRY_FILE, "utf8").split("\n").filter(Boolean);
    if (!lines.length) return;
    const keep = []; let done = 0;
    for (const ln of lines) {
      if (done >= max) { keep.push(ln); continue; }
      let row; try { row = JSON.parse(ln); } catch { continue; }
      done++; if (!indexOne(row.entry)) keep.push(ln); // still failing -> requeue
    }
    writeFileSync(INDEX_RETRY_FILE, keep.length ? keep.join("\n") + "\n" : "");
  } catch {}
}

function maybeIndex(entry, shared) {
  if (!shared) return;
  // HYPERAGENT FIX (2026-06-26): under RunWithCredentials a detached/unref'd child is KILLED on return,
  // so fire-and-forget never finishes -> shared facts miss memory-exec until the 6h reindex (invisible
  // to semantic recall / per-prompt pack / company-brain / MCP for up to 6h). On that runtime index
  // SYNCHRONOUSLY (bounded, fail-open) AND drain the retry queue (catch-up). Claude Code (long-lived)
  // keeps the non-blocking detached spawn. RING-SAFE: gated on `shared`.
  const syncIndex = process.env.KB_SYNC_INDEX === "1"
    || process.env.NODE_USE_ENV_PROXY === "1"
    || (process.env.HOME || "").startsWith("/agent");
  if (syncIndex) {
    if (!indexOne(entry)) queueIndexFailure(entry); // #2: queue on failure
    drainIndexRetry();                              // #1: catch-up previously-missed shared entries
  } else {
    try { spawn(process.execPath, [join(HERE, "index-one.mjs"), AGENT, JSON.stringify(entry)], { detached: true, stdio: "ignore" }).unref(); } catch {}
  }
}

// FLEET METRIC EMISSION (CEO motto: smarter/faster/cheaper/better-memory/autonomous -> observability).
// Env-gated (KB_DD_EMIT=1, DEFAULT OFF) + throttled (<=1 emit / 5 min / agent) so it adds ZERO latency or
// risk to the fleet's ledger writes unless explicitly enabled. Emits one LOW-CARDINALITY
// otc.fleet.ledger_flush count to Datadog via dd-fleet.mjs (tags: agent/type/ring/engine/shared only).
// FAIL-OPEN: never throws, never affects the ledger write or exit code. Bounded spawnSync (4s) because the
// Hyperagent runtime kills detached children on return (same reason maybeIndex runs sync there).
function emitFleet(entry, shared) {
  try {
    if (process.env.KB_DD_EMIT !== "1") return;
    const stamp = `${CACHE_DIR}/.ddemit-${AGENT}`;
    const now = Date.now();
    try { if (existsSync(stamp) && (now - Number(readFileSync(stamp, "utf8") || 0)) < 300000) return; } catch {}
    try { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(stamp, String(now)); } catch {}
    const engine = ((process.env.HOME || "").startsWith("/agent") || process.env.NODE_USE_ENV_PROXY === "1") ? "hyperagent" : "claude";
    spawnSync(process.execPath, [join(HERE, "..", "datadog", "dd-fleet.mjs"), AGENT, entry.type, (A && A.ring) || "unknown", engine, shared ? "1" : "0"], { stdio: "ignore", timeout: 4000 });
  } catch { /* fail-open: telemetry must never affect a ledger write */ }
}

// ---- typed ENTITY / current-value layer (Wave 3): answer "what is X NOW?" deterministically. An
//      entity is a normal ledger row (type "entity", {ekey, evalue}), so it rides the SAME write-through
//      cache + share + semantic-index plumbing as every other entry; latest row per key WINS (history is
//      retained via supersedes). normKey collapses casing/punctuation so "iHEARtest Build" == "iheartest
//      _build". An optional alias map (type "alias") points many phrasings at one canonical key. This is
//      a thin keyed VIEW over the flat ledger, NOT a knowledge-graph service.
const normKey = (s) => (s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
function resolveAlias(rows, key) {
  let k = normKey(key); const seen = new Set();
  for (let i = 0; i < 8 && !seen.has(k); i++) {
    seen.add(k);
    const a = rows.filter((r) => r.type === "alias" && r.ekey === k).sort((x, y) => (y.ts || "").localeCompare(x.ts || ""))[0];
    if (!a || !a.evalue || a.evalue === k) break;
    k = a.evalue;
  }
  return k;
}
const currentEntity = (rows, k) => rows.filter((r) => r.type === "entity" && r.ekey === k).sort((x, y) => (y.ts || "").localeCompare(x.ts || ""))[0] || null;

async function entityCmd() {
  const sub = (positional[0] || "").toLowerCase();
  // Alias routing controls deterministic recall. Refuse cross-lane alias changes before opening the
  // target store, so a caller cannot read a protected lane or append a row that wins by timestamp.
  if (sub === "alias") assertAliasOwner(AGENT, ON);
  await initStore();
  const rows = await load();
  if (sub === "get") {
    const k = resolveAlias(rows, positional[1] || "");
    if (!k) { console.error('usage: mem.mjs entity get <key> --agent <a>'); process.exit(2); }
    const cur = currentEntity(rows, k);
    if (!cur) { console.log(`(no current value for '${k}' in the ${AGENT} ledger)`); process.exit(0); }
    console.log(`${k} = ${cur.evalue}`);
    console.error(`  [recorded ${(cur.ts || "").slice(0, 10)} id=${cur.id}${cur.source ? ` src=${cur.source}` : ""}${cur.was ? ` was=${cur.was}` : ""}] NB: this is the last RECORDED value; verify against the live source for authoritative state.`);
    return;
  }
  if (sub === "list") {
    const keys = [...new Set(rows.filter((r) => r.type === "entity").map((r) => r.ekey))].sort();
    console.log(`# CURRENT VALUES (${AGENT} ledger) - ${keys.length} entities`);
    for (const k of keys) { const c = currentEntity(rows, k); if (c) console.log(`${k} = ${c.evalue}   [${(c.ts || "").slice(0, 10)} ${c.id}]`); }
    const aliases = rows.filter((r) => r.type === "alias").sort((x, y) => (y.ts || "").localeCompare(x.ts || ""));
    if (aliases.length) { console.log("## aliases"); const seen = new Set(); for (const a of aliases) { if (seen.has(a.ekey)) continue; seen.add(a.ekey); console.log(`${a.ekey} -> ${a.evalue}`); } }
    return;
  }
  if (sub === "alias") {
    const from = normKey(positional[1] || ""), to = normKey(positional[2] || "");
    if (!from || !to) { console.error('usage: mem.mjs entity alias "<from-phrasing>" <to-canonical-key> --agent <a> [--source "..."] [--share]'); process.exit(2); }
    let fromRef, toRef, prevRef;
    const { entry } = await commitAppend((freshRows) => {
      fromRef = normKey(positional[1] || "");
      toRef = resolveAliasTarget(freshRows, positional[2] || "");
      if (fromRef === toRef) throw new Error(`entity alias must not point ${fromRef} to itself`);
      const built = buildAliasEntry(freshRows, {
        fromKey: fromRef,
        toKey: toRef,
        id: newId(freshRows),
        ts: new Date().toISOString(),
        tags: TAGS,
        by: AGENT,
        source: SOURCE || undefined,
      });
      prevRef = built.previous;
      return built.entry;
    });
    let shared = false;
    if (SHARE) shared = await publishShared(AGENT, entry);
    // Alias rows are lookup metadata, not semantic facts. Publishing makes them visible to the
    // gateway's cached shared-feed entity loader without paying for an embedding/index write.
    console.log(`[kb-memory] alias ${fromRef} -> ${toRef} -> ${AGENT} id=${entry.id}${prevRef ? ` (was: ${prevRef.evalue})` : ""}${shared ? "; shared" : ""}.`);
    return;
  }
  if (sub === "set") {
    const k = resolveAlias(rows, positional[1] || "");
    const value = positional.slice(2).join(" ").trim();
    if (!k || !value) { console.error('usage: mem.mjs entity set <key> "<value>" --agent <a> [--source "..."] [--share]'); process.exit(2); }
    // Resolve the alias + prior value from the FRESH rows on each attempt, so a concurrent set of the
    // same key supersedes the right (latest) prior entry rather than a stale snapshot.
    let prevRef, keyRef;
    const { entry } = await commitAppend((freshRows) => {
      keyRef = resolveAlias(freshRows, positional[1] || "");
      const prev = currentEntity(freshRows, keyRef);
      prevRef = prev;
      return { id: newId(freshRows), ts: new Date().toISOString(), type: "entity", ekey: keyRef, evalue: value, text: `${keyRef} = ${value}`, tags: TAGS, by: AGENT, source: SOURCE || undefined, was: (CROSS ? undefined : (prev ? prev.evalue : undefined)), supersedes: (CROSS ? undefined : (prev ? prev.id : undefined)) };
    });
    let shared = false;
    if (SHARE) shared = await publishShared(AGENT, entry);
    maybeIndex(entry, shared);
    console.log(`[kb-memory] entity ${keyRef} = ${value} -> ${AGENT} id=${entry.id}${prevRef ? ` (was: ${prevRef.evalue})` : ""}${shared ? "; shared+indexed" : ""}.`);
    return;
  }
  // ---- entity RELATIONSHIP (edge) layer, Phase 4D: the smallest viable extension so the ledger can
  // answer "what depends on X" with a 1-2 hop walk. A link is just another ledger row (type
  // "entity_link"), so it rides the SAME append/publish/index plumbing as `entity set` above; the walk
  // is a PURE in-memory traversal over rows already loaded by load() (see entity-graph.mjs). No new
  // data store, no graph DB, no index: deliberately the thinnest extension that answers the question.
  if (sub === "link") {
    const fromRaw = positional[1] || "", relRaw = positional[2] || "", toRaw = positional[3] || "";
    if (!fromRaw || !relRaw || !toRaw) { console.error('usage: mem.mjs entity link <from-key> <relation> <to-key> --agent <a> [--source "..."] [--share]'); process.exit(2); }
    // Resolve both endpoint aliases from the FRESH rows on each attempt (same concurrency-safety
    // pattern as `entity set` above), so links work through aliases exactly like get/set do.
    const { entry } = await commitAppend((freshRows) => {
      const fromKey = resolveAlias(freshRows, fromRaw);
      const toKey = resolveAlias(freshRows, toRaw);
      return { id: newId(freshRows), ts: new Date().toISOString(), ...linkFields(fromKey, relRaw, toKey), tags: TAGS, by: AGENT, source: SOURCE || undefined };
    });
    let shared = false;
    if (SHARE) shared = await publishShared(AGENT, entry);
    maybeIndex(entry, shared);
    console.log(`[kb-memory] entity link ${entry.ekey} -${entry.relation}-> ${entry.evalue} -> ${AGENT} id=${entry.id}${shared ? "; shared+indexed" : ""}.`);
    return;
  }
  if (sub === "graph") {
    const k = resolveAlias(rows, positional[1] || "");
    if (!k) { console.error('usage: mem.mjs entity graph <key> --agent <a> [--hops 1|2]'); process.exit(2); }
    const hops = parseInt(takeVal("--hops", "2"), 10) || 2;
    const g = walkGraph(rows, k, { hops });
    console.log(`# entity graph for '${k}' (${g.hops} hop(s), ${AGENT} ledger): ${g.edges.length} edge(s), ${g.nodes.length} node(s)`);
    if (!g.edges.length) { console.log(`(no links found for '${k}' within ${g.hops} hop(s))`); return; }
    for (const e of g.edges.slice().sort((a, b) => a.depth - b.depth)) console.log(`  [hop ${e.depth}] ${formatEdge(e)}`);
    return;
  }
  console.error('usage: mem.mjs entity set <key> "<value>" | get <key> | list | alias "<from>" <to> | link <from-key> <relation> <to-key> | graph <key> [--hops 1|2]   --agent <a> [--source "..."] [--share]');
  process.exit(2);
}

function matchq(r, terms) { const hay = `${r.type} ${r.text} ${r.was || ""} ${(r.tags || []).join(" ")} ${r.source || ""} ${r.agent || ""}`.toLowerCase(); return terms.every((t) => hay.includes(t)); }
function teamLines(shared) {
  // latest status per agent + recent shared facts/decisions
  const latestStatus = {};
  for (const r of shared) { if (r.type === "status" && !latestStatus[r.agent]) latestStatus[r.agent] = r; }
  return { latestStatus };
}

// ---- pack: the per-prompt WORKING-MEMORY block. LLM-free, local-cache-first (no Azure on the hot
//      path), ranked to the prompt, ring-correct, token-budgeted, with a health beacon. This is what
//      the UserPromptSubmit hook injects every turn so a just-compacted agent gets its durable facts
//      back into context with zero action. Reads the prompt from --stdin-json (UserPromptSubmit JSON;
//      NEVER interpolated through a shell) or --query.
async function runPack() {
  if (!A) { process.stdout.write("<<<WORKING-MEMORY>>>\nMEMORY: OFF (no agent) -> echo <role> > ~/.claude/.kb-agent\n<<<END>>>\n"); return; }
  const kb = A._file || AGENT;
  const THROTTLE = (parseInt(process.env.KB_PACK_THROTTLE_S || "120", 10) || 120) * 1000;
  // own ledger: LOCAL cache fast-path; refresh from Blob only when stale AND the SA exists (no hard exit).
  let rows = readCacheRows(kb), refreshed = false;
  if (!rows || ageMs(cacheFile(kb)) > THROTTLE) {
    if (memoryBackendPresent()) { try { await initStore(); rows = await load(); writeCacheRows(kb, rows); refreshed = true; } catch { rows = rows || []; } }
    else { rows = rows || []; } // no memory backend -> stale-local, fail-open (never a hard exit on the hot path)
  }
  // query terms: UserPromptSubmit stdin JSON (safe parse, no shell interpolation) or --query.
  // Score by term-OVERLAP (not strict AND) so a long natural-language prompt still ranks; drop short
  // words + stopwords so the signal terms drive the match.
  const STOP = new Set("the and for that this with you your our can could should would will does how what why are was were from into about".split(" "));
  let terms = [], rawPrompt = "";
  if (argv.includes("--stdin-json")) {
    try { const j = JSON.parse(readFileSync(0, "utf8")); rawPrompt = `${j.prompt || j.user_prompt || j.message || ""}`; terms = rawPrompt.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); } catch {}
  } else if (QUERY) { rawPrompt = QUERY; terms = QUERY.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); }
  terms = [...new Set(terms.filter((t) => t.length >= 3 && !STOP.has(t)))].slice(0, 24);
  const scoreq = (r, ts) => { const hay = `${r.text} ${r.was || ""} ${(r.tags || []).join(" ")} ${r.source || ""}`.toLowerCase(); return ts.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0); }; // NB: exclude r.type so a query word like "status"/"fact" does not inflate every row of that type

  const byNew = (a, b) => (b.ts || "").localeCompare(a.ts || "");
  const active = rows.filter((r) => !rows.some((x) => x.supersedes === r.id)); // drop superseded (newest-wins)
  const pitfalls = active.filter((r) => r.type === "pitfall").sort(byNew).slice(0, 12);
  const decisions = active.filter((r) => r.type === "decision").sort(byNew).slice(0, 6);
  const corrections = rows.filter((r) => r.type === "correction").sort(byNew).slice(0, 5);
  const entities = active.filter((r) => r.type === "entity").sort(byNew).slice(0, 8); // current-values, most-recently-set first
  const always = new Set([...pitfalls, ...decisions, ...corrections, ...entities].map((r) => r.id));
  const ranked = terms.length
    ? active.filter((r) => !always.has(r.id)).map((r) => [r, scoreq(r, terms)]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1] || byNew(a[0], b[0])).slice(0, 6).map(([r]) => r)
    : [];
  const rankedIds = new Set(ranked.map((r) => r.id));
  const recent = active.filter((r) => !always.has(r.id) && !rankedIds.has(r.id)).sort(byNew).slice(0, 4);

  // team awareness: latest status per OTHER exec agent, RING-DENY-filtered. Privileged lanes never read it.
  let team = [];
  if (!NO_SHARE.has(AGENT) && memoryBackendPresent()) {
    let shared = readTeamCache();
    if (!shared || ageMs(TEAM_CACHE) > 300 * 1000) { try { shared = await readSharedAll(); writeTeamCache(shared); } catch { shared = shared || []; } }
    const { latestStatus } = teamLines(shared || []);
    team = Object.keys(latestStatus).filter((a) => a !== AGENT).map((a) => latestStatus[a]).filter(ringSafeCross).slice(0, 8);
  }

  // hot-path SEMANTIC tier: only when the local keyword pack came up THIN (the agent's own ledger did
  // not match the prompt well), reach into the shared exec brain BY MEANING. Thin-triggered + throttled
  // so MOST prompts skip it entirely; ONE bounded read-only call; fail-open to the local pack.
  let semantic = [];
  const SEM_MIN = parseInt(process.env.KB_SEM_MIN || "3", 10) || 3;
  const SEM_THROTTLE = (parseInt(process.env.KB_SEM_THROTTLE_S || "60", 10) || 60) * 1000;
  if (!process.env.KB_SEM_DISABLE && rawPrompt && terms.length >= 2 && ranked.length < SEM_MIN && !NO_SHARE.has(AGENT) && ageMs(SEM_STAMP) > SEM_THROTTLE) {
    // The cached-creds gate only applies to the legacy Azure path: the OpenSearch default signs
    // per-request with the seat's AWS credentials, so there is nothing to pre-cache.
    const backendIsAzure = (process.env.SEARCH_BACKEND || "opensearch").toLowerCase() === "azure";
    const creds = backendIsAzure ? readSemCredsCache() : null;
    if (!backendIsAzure || creds) {
      try { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(SEM_STAMP, String(Date.now())); } catch {} // stamp EARLY so a slow/failed call still respects the window
      const excl = new Set([...ranked, ...recent, ...pitfalls, ...decisions, ...corrections, ...entities].map((r) => (r.text || "").slice(0, 40).toLowerCase()));
      semantic = await semanticHits(rawPrompt, creds, excl);
    } else if (memoryBackendPresent()) spawnSemRefresh(); // azure only: not cached -> warm it off the hot path for next time; skip this turn
  }

  // beacon: LIVE only if the ledger is actually readable + non-empty (proves FUNCTION, not just wiring).
  const tss = rows.map((r) => r.ts).filter(Boolean).sort();
  const lastTs = tss[tss.length - 1] || "";
  const ageMin = lastTs ? Math.round((Date.now() - Date.parse(lastTs)) / 60000) : -1;
  const beacon = rows.length
    ? `MEMORY: LIVE agent=${AGENT} | ledger=${rows.length} | last-write=${ageMin >= 0 ? ageMin + "m" : "?"}${refreshed ? " | refreshed" : " | cached"}`
    : `MEMORY: DARK agent=${AGENT} | ledger empty/unreadable -> check ~/.claude/.kb-agent + the service account`;

  // RELEVANT-to-the-prompt goes FIRST (never starved by the always-set), then current-truth, then the
  // recurring-mistake guardrails, then context. Each line is CLIPPED to a cue (the full text is in the
  // ledger; this block is a pointer, not the record).
  const clip = (s, n = 200) => { s = (s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s; };
  const L = (r) => `[${r.type}] [${(r.ts || "").slice(0, 10)}] ${clip(r.text)}${r.was ? `  (was: ${clip(r.was, 80)})` : ""}`;
  const out = ["<<<WORKING-MEMORY>>>", beacon];
  // WAKE FIRST-DUTY (hot path, cache-only, no network): surface notes OTHER agents wrote on this ledger
  // since the last reconcile, so a fresh/compacted session sees inbound cross-agent input immediately.
  try {
    let marker = ""; try { marker = (readFileSync(RECON_LOCAL(kb), "utf8") || "").trim(); } catch {}
    const inb = rows.filter((r) => r.by && r.by !== AGENT && (!marker || (r.ts || "") > marker)).slice(-6);
    if (inb.length) { out.push(`## 📥 INBOUND (${inb.length}) - other agents wrote on your ledger [review: mem.mjs inbound --agent ${AGENT} | ack: mem.mjs reconcile --agent ${AGENT}]:`); for (const r of inb) out.push(`- [by ${r.by}/${r.type}] ${clip(r.text, 140)}`); }
  } catch {}
  if (ranked.length) { out.push("## RELEVANT TO THIS PROMPT:"); for (const r of ranked) out.push(L(r)); }
  if (entities.length) { out.push("## CURRENT VALUES (latest wins; deterministic):"); for (const r of entities) out.push(`- ${r.ekey} = ${clip(r.evalue, 120)}`); }
  if (corrections.length) { out.push("## CORRECTIONS (NOW, not the old belief):"); for (const r of corrections) out.push(`- NOW: ${clip(r.text)}${r.was ? `  (was: ${clip(r.was, 80)})` : ""}`); }
  if (pitfalls.length) { out.push("## PITFALLS (do not repeat):"); for (const r of pitfalls) out.push(`- ${clip(r.text)}`); }
  if (decisions.length) { out.push("## DECISIONS (current):"); for (const r of decisions) out.push(`- ${clip(r.text)}`); }
  if (recent.length) { out.push("## RECENT:"); for (const r of recent) out.push(L(r)); }
  if (semantic.length) { out.push("## RELATED (shared brain, by meaning):"); for (const r of semantic) out.push(`- [${r.agent}/${r.type}] ${clip(r.text, 140)}`); }
  if (team.length) { out.push("## TEAM (other agents, latest status):"); for (const r of team) out.push(`- [${r.agent}] ${clip(r.text, 120)}`); }

  // hard char budget: keep the front (beacon + pitfalls), trim trailing sections so the block can never
  // itself bloat the freshly-compacted window. ~4800 chars ≈ ~1200 tokens.
  const BUDGET = parseInt(process.env.KB_PACK_BUDGET || "4800", 10) || 4800;
  let body = out.join("\n");
  if (body.length > BUDGET) { const cut = body.lastIndexOf("\n", BUDGET); body = body.slice(0, cut > 0 ? cut : BUDGET); }
  process.stdout.write(body + "\n<<<END>>>\n");
}

(async () => {
  if (["remember", "fact"].includes(cmd)) return append("fact", SHARE);
  if (cmd === "decision") return append("decision", SHARE);
  if (cmd === "pitfall") return append("pitfall", SHARE);
  if (cmd === "status") return append("status", true);
  if (cmd === "correct") { if (!WAS) console.error("(tip: pass --was \"<wrong belief>\" so the correction records what to stop believing)"); return append("correction", SHARE); }
  if (cmd === "index-catchup") { drainIndexRetry(200); console.log("[kb-memory] index-catchup: drained the write-through index retry queue"); return; }
  if (cmd === "entity") return entityCmd();
  if (cmd === "list-agents") { for (const [k, v] of Object.entries(AGENTS)) console.log(`${k.padEnd(14)} ${v.account}/${v.container}  [${v.ring}]`); console.log(`exec team: ${EXEC.join(", ")}`); return; }
  if (cmd === "use") {
    const who = (positional[0] || AGENT || "").toLowerCase();
    if (!who) { console.error("usage: mem.mjs use <role>   (cfo | clo | coo | cto | ...)"); process.exit(2); }
    mkdirSync(`${homedir()}/.claude`, { recursive: true });
    writeFileSync(`${homedir()}/.claude/.kb-agent`, who + "\n");
    console.log(`identity claimed: this session's memory is homed to '${who}'. Verify: node ${process.argv[1]} whoami --agent ${who}`);
    return;
  }
  if (cmd === "whoami") {
    const read1 = (p) => { try { return existsSync(p) ? readFileSync(p, "utf8").trim().split(/\s+/)[0] : ""; } catch { return ""; } };
    const sessMark = read1(`${homedir()}/.claude/.kb-agent`);
    const repoMark = read1(`${process.env.CLAUDE_PROJECT_DIR || "."}/.kb-agent`);
    const envAg = (process.env.KB_AGENT || "").trim();
    const resolved = sessMark || repoMark || envAg;
    const src = sessMark ? "session marker (~/.claude/.kb-agent)" : repoMark ? "repo .kb-agent" : envAg ? "env KB_AGENT" : "(none)";
    // whoami is a diagnostic, not the hot path, so it pays for the real (async) S3-credential probe
    // rather than the cheap sync presence check runPack() uses — accuracy matters more here than the
    // few ms of an ECS-metadata round trip.
    const s3Ok = S3_WRITES && (await s3Configured());
    const azOk = azureCredsPresent() || !!resolveSaJson();
    const saOk = s3Ok || azOk;
    console.log("# kb-memory whoami");
    console.log(`resolved identity (the hooks use this): ${resolved || "(NONE - auto-recall OFF)"}  [via ${src}]`);
    if (sessMark && envAg && sessMark !== envAg) console.log(`note: session marker '${sessMark}' overrides shared env KB_AGENT '${envAg}' (correct when agents share one environment).`);
    console.log(`blob backend: ${BLOB_BACKEND} (writes go here; reads merge this with best-effort Azure history when s3)`);
    console.log(`memory backend: ${saOk ? `present (${s3Ok ? "AWS/S3" : ""}${s3Ok && azOk ? " + " : ""}${azOk ? "Azure Key Vault/Blob, read-merge only" : ""})` : "MISSING - no AWS creds (checked the ECS task role, AWS_ACCESS_KEY_ID/SECRET, OTC_AWS_*) and no Azure creds either; writes will fail"}`);
    if (!AGENT) { console.log(resolved ? `tip: run 'whoami --agent ${resolved}' to probe its ledger, or 'use <role>' to claim.` : "RESULT: FAIL - no identity. Run 'mem.mjs use <role>' then re-run."); return; }
    if (resolved && resolved !== AGENT) console.log(`WARNING: this session resolves to '${resolved}', not '${AGENT}'. Claim it: mem.mjs use ${AGENT}`);
    try {
      await initStore();
      const rows = await load();
      const last = rows[rows.length - 1];
      console.log(`ledger '${AGENT}' (${A.ring}): ${rows.length} entries; latest ${last ? `[${(last.ts || "").slice(0, 10)}] ${last.text.slice(0, 80)}` : "(empty)"}`);
      const ok = saOk && resolved === AGENT;
      console.log(`RESULT: ${ok ? `PASS - memory is ON and homed to '${AGENT}' (${rows.length} entries)` : `NEEDS-FIX (SA=${saOk}, resolved='${resolved || "none"}', expected '${AGENT}')`}`);
    } catch (e) { console.log(`RESULT: FAIL - cannot reach the '${AGENT}' ledger: ${e.message}`); }
    return;
  }
  if (cmd === "pack") return runPack();
  if (cmd === "sem-refresh") {
    // warm the hot-path semantic cred-cache (read-only query key + search endpoint) OFF the prompt path,
    // so the per-prompt semantic tier never resolves Secret Manager inline. Fail-open, mode 0600.
    try {
      const ep = (await sm("azure-search-endpoint") || "").replace(/\/$/, "");
      const qk = await sm("azure-search-query-key");
      if (ep && qk) { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(SEM_CRED_FILE, JSON.stringify({ searchEp: ep, queryKey: qk, ts: Date.now() })); try { chmodSync(SEM_CRED_FILE, 0o600); } catch {} console.error("[kb-memory] semantic cred-cache refreshed"); }
    } catch {}
    return;
  }
  if (cmd === "team-health") {
    // Operator-visible cross-agent memory health: per exec agent, how long since they last shared
    // anything (a proxy for "is this agent's memory live + active"). Feeds the COO daily brief so Matt
    // sees a green/red line per agent. --json for machine consumption (the brief / a PostHog emit).
    let shared = [];
    try { shared = await readSharedAll(); } catch (e) { console.log("team-health: shared feed unavailable (" + e.message + ")"); return; }
    const now = Date.now();
    const lastBy = {}, statusBy = {};
    for (const r of shared) {
      if (!lastBy[r.agent] || (r.ts || "") > lastBy[r.agent]) lastBy[r.agent] = r.ts || "";
      if (r.type === "status" && (!statusBy[r.agent] || (r.ts || "") > (statusBy[r.agent].ts || ""))) statusBy[r.agent] = r;
    }
    const STALE = parseInt(process.env.KB_HEALTH_STALE_MIN || "1440", 10) || 1440; // LIVE if shared within 24h
    const rows = EXEC.map((a) => {
      const ts = lastBy[a];
      const ageMin = ts ? Math.round((now - Date.parse(ts)) / 60000) : null;
      return { agent: a, status: ageMin === null ? "NO-DATA" : ageMin <= STALE ? "LIVE" : "STALE", last_shared_age_min: ageMin, working_on: (statusBy[a]?.text || "").replace(/\s+/g, " ").slice(0, 90) || null };
    });
    if (argv.includes("--json")) { console.log(JSON.stringify(rows)); return; }
    const age = (m) => m === null ? "no shared activity" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
    console.log(`# EXEC MEMORY HEALTH (last shared activity per agent; LIVE = within ${Math.round(STALE / 60)}h)`);
    for (const r of rows) console.log(`[${(r.status === "LIVE" ? "LIVE " : r.status === "STALE" ? "STALE" : "  -  ")}] ${r.agent.padEnd(11)} ${age(r.last_shared_age_min).padEnd(18)}${r.working_on ? "  " + r.working_on : ""}`);
    return;
  }
  if (cmd === "team") {
    const shared = await readSharedAll();
    const { latestStatus } = teamLines(shared);
    console.log(`# EXEC TEAM feed - what every agent is working on + shared facts (${shared.length} shared entries)`);
    console.log("## CURRENT STATUS (latest per agent):");
    for (const ag of Object.keys(latestStatus).sort()) { const r = latestStatus[ag]; console.log(`- [${ag}] [${(r.ts || "").slice(0, 10)}] ${r.text}`); }
    console.log("## RECENT SHARED (facts / decisions / status, newest first):");
    for (const r of shared.slice(0, N)) console.log(`[${r.agent}] [${r.type}] [${(r.ts || "").slice(0, 10)}] ${r.text}`);
    return;
  }
  if (!A) { console.error("need --agent <cfo|clo|clo-personal|commons|...>"); process.exit(2); }
  await initStore();
  const rows = await load();
  if (cmd === "render") { await putText(MD, renderMd(rows), "text/markdown; charset=utf-8"); console.log(`rendered ${MD} (${rows.length} entries)`); return; }
  if (cmd === "inbound") {
    // WAKE FIRST-DUTY (read side): what other agents wrote ON this ledger since the last reconcile.
    const marker = await readReconMarker();
    const inb = inboundRows(rows, ON, marker);
    console.log(`# 📥 INBOUND on ${ON}'s ledger - notes written by OTHER agents${marker ? ` since last reconcile (${marker.slice(0, 16)}Z)` : " (never reconciled)"}: ${inb.length}`);
    for (const r of inb) console.log(`- [by ${r.by}] [${r.type}] [${(r.ts || "").slice(0, 10)}] ${r.text}${r.was ? `  (was: ${r.was})` : ""}  \`${r.id}\``);
    if (!inb.length) console.log("- (nothing new from other agents)");
    else console.log(`\nReview + act on each, then: mem.mjs reconcile --agent ${ON}`);
    return;
  }
  if (cmd === "reconcile") {
    // WAKE FIRST-DUTY (ack side): mark the current inbound as reviewed. Advances the marker to now, so
    // future inbound/tail/pack only surface notes written AFTER this. Does NOT delete anything.
    const marker = await readReconMarker();
    const inb = inboundRows(rows, ON, marker);
    const newMark = new Date().toISOString();
    await putText(RECON, newMark, "text/plain; charset=utf-8");
    try { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(RECON_LOCAL(KEYBASE), newMark); } catch {}
    console.log(`[kb-memory] reconciled ${inb.length} cross-agent note(s) on ${ON}'s ledger; marker -> ${newMark}. Future inbound/tail/pack show only notes newer than this. (Nothing was deleted; the full history stays in the ledger.)`);
    return;
  }
  if (cmd === "recall") {
    // HARD-DEPRECATED 2026-07-10 (Matt directive, following a real fleet incident: CFO agent
    // concluded ~2 weeks of real derivative-valuation work "could not be found" after 3 zero-hit
    // calls here, while the SAME query against the gateway's mcp-otchealth-gateway__memory_recall
    // tool returned 5 direct hits instantly). Root cause: this command did LITERAL KEYWORD
    // substring matching (matchq) against ONLY the local ledger + team feed rows — no
    // semantic/embedding search, so a 0-hit was never actually evidence of absence. A soft stderr
    // warning (shipped first, same day) was upgraded to a hard error on Matt's explicit
    // instruction: the failure mode is expensive enough (an agent wrongly concluding real work
    // doesn't exist) that this command must now REFUSE to run rather than risk being misread as
    // authoritative. No keyword search executes below this point anymore.
    console.error(`[kb-memory] ❌ 'recall' is HARD-DEPRECATED and refuses to run. It only ever did literal keyword matching against your local ledger — no semantic search — and produced a real fleet incident (2026-07-10, CFO agent) by silently missing real work on a 0-hit. Use the gateway's mcp-otchealth-gateway__memory_recall tool (semantic, cross-agent, via ExecuteIntegration) instead. If that gateway tool is genuinely unavailable, grep the local compacted-ledger export directly — do NOT fall back to this command for any reason.`);
    process.exit(1);
  }
  if (cmd === "tail") {
    const pit = rows.filter((r) => r.type === "pitfall");
    const rest = rows.filter((r) => r.type !== "pitfall").sort((a, b) => (b.ts || "").localeCompare(a.ts || "")).slice(0, N);
    console.log(`# ${AGENT} ledger + TEAM view (source of truth)`);
    // WAKE FIRST-DUTY: surface cross-agent notes on YOUR ledger first, so they're reconciled on wake.
    try {
      const marker = await readReconMarker();
      const inb = inboundRows(rows, ON, marker);
      if (inb.length) { console.log(`## 📥 INBOUND (${inb.length}) - other agents wrote on YOUR ledger; review then 'reconcile --agent ${ON}':`); for (const r of inb) console.log(`- [by ${r.by}] [${r.type}] [${(r.ts || "").slice(0, 10)}] ${r.text}${r.was ? `  (was: ${r.was})` : ""}  \`${r.id}\``); }
    } catch {}
    console.log(`## YOUR PITFALLS (${pit.length}, do not repeat):`); for (const r of pit) console.log(`- ${r.text}  \`${r.id}\``);
    console.log("## YOUR RECENT (facts / decisions / status / corrections):"); for (const r of rest.slice().reverse()) console.log(`[${r.type}] [${(r.ts || "").slice(0, 10)}] ${r.text}${r.was ? `  (was: ${r.was})` : ""}`);
    try {
      const shared = await readSharedAll();
      const { latestStatus } = teamLines(shared);
      const others = Object.keys(latestStatus).filter((a) => a !== AGENT).sort();
      console.log("## TEAM - company-wide, what every OTHER exec agent is working on (latest status):");
      if (!others.length) console.log("- (no team status published yet)");
      for (const ag of others) { const r = latestStatus[ag]; console.log(`- [${ag}] [${(r.ts || "").slice(0, 10)}] ${r.text}`); }
      const recentShared = shared.filter((r) => r.agent !== AGENT && r.type !== "status").slice(0, 10);
      if (recentShared.length) { console.log("## TEAM - recent shared facts/decisions:"); for (const r of recentShared) console.log(`[${r.agent}] [${r.type}] ${r.text}`); }
    } catch (e) { console.log("## TEAM - (feed unavailable: " + e.message + ")"); }
    return;
  }
  // ── P0-DURABLE-HANDOFF (2026-07-05): a TYPED current-state doc, distinct from the append-only
  // JSONL ledger above. The ledger is a HISTORY (every remember/decision/status ever written); this
  // is the single, always-current snapshot a fresh cold instance should read FIRST: goal, standing
  // constraints, open decisions awaiting resolution, and a one-line last_state. Sessions are meant to
  // be disposable workers against this doc — the doc, not the chat, is what survives a compaction or
  // a brand-new instance picking up the work. One blob per agent: _STATE/<agent>.json (same
  // account/container as the ledger, via url()). ETag optimistic concurrency (read-modify-write,
  // retry on 412) so two concurrent `state --set` calls never lose one's update to the other's.
  if (cmd === "state") {
    const STATE_KEY = `_STATE/${AGENT}.json`;
    const DEFAULT_STATE = { agent: AGENT, goal: "", constraints: [], open_decisions: [], last_state: "", updated_at: null, updated_by: null, version: 0 };
    const splitList = (s) => (s || "").split(";").map((x) => x.trim()).filter(Boolean);
    if (argv.includes("--get") || argv[1] === "get" || (!argv.includes("--set") && argv[1] !== "set")) {
      const { text } = await getTextMeta(STATE_KEY);
      const st = text ? JSON.parse(text) : DEFAULT_STATE;
      if (argv.includes("--json")) { console.log(JSON.stringify(st, null, 2)); return; }
      console.log(`# ${AGENT} — current state (typed handoff, v${st.version})`);
      console.log(`GOAL: ${st.goal || "(not set)"}`);
      console.log(`CONSTRAINTS:${st.constraints.length ? "" : " (none)"}`); for (const c of st.constraints) console.log(`  - ${c}`);
      console.log(`OPEN DECISIONS:${st.open_decisions.length ? "" : " (none)"}`); for (const d of st.open_decisions) console.log(`  - ${d}`);
      console.log(`LAST STATE: ${st.last_state || "(not set)"}`);
      console.log(`updated ${st.updated_at || "never"} by ${st.updated_by || "-"}`);
      return;
    }
    // --set: read-modify-write with ETag retry. Each field is REPLACED if passed, left as-is otherwise
    // (so `state --set --last "..."` alone doesn't clobber goal/constraints).
    for (let attempt = 0; attempt < 4; attempt++) {
      const { text, etag } = await getTextMeta(STATE_KEY);
      const st = text ? JSON.parse(text) : { ...DEFAULT_STATE };
      if (takeVal("--goal", null) !== null) st.goal = takeVal("--goal", "");
      if (takeVal("--constraints", null) !== null) st.constraints = splitList(takeVal("--constraints", ""));
      if (takeVal("--decisions", null) !== null) st.open_decisions = splitList(takeVal("--decisions", ""));
      if (takeVal("--last", null) !== null) st.last_state = takeVal("--last", "");
      st.updated_at = new Date().toISOString();
      st.updated_by = process.env.KB_ENGINE || "cli";
      st.version = (st.version || 0) + 1;
      const res = await putTextCond(STATE_KEY, JSON.stringify(st, null, 2), "application/json", etag);
      if (isConflict(res.status)) continue; // someone else wrote between our read and write; retry
      if (!res.ok) throw new Error(`state --set failed: ${res.status}`);
      console.log(`[kb-memory] state -> ${AGENT} v${st.version} (goal="${st.goal.slice(0, 60)}")`);
      return;
    }
    throw new Error("state --set: too many concurrent-write conflicts, give up after 4 attempts");
  }
  // ── CBP-1 (Checkpoint Bridge Protocol, 2026-07-05): ADDITIVE-ONLY extension of the same
  // _STATE/<agent>.json doc, written by the PreCompact/Stop/periodic hook path (never by hand).
  // Unlike `state --set`, this NEVER touches goal/constraints/open_decisions — it only appends a
  // capped, deduped `session_facts` list (the last few distilled reflect.mjs items) and stamps a
  // `checkpoint` marker so cold-resume-test.mjs can tell whether the automatic hook sync has ever
  // run for this agent. Same 4-attempt ETag-conditional retry as `state --set`.
  if (cmd === "state-sync") {
    const STATE_KEY = `_STATE/${AGENT}.json`;
    const DEFAULT_STATE = { agent: AGENT, goal: "", constraints: [], open_decisions: [], last_state: "", updated_at: null, updated_by: null, version: 0 };
    const SYNC_SOURCE = takeVal("--source", "periodic");
    const SESSION_ID = takeVal("--session-id", "");
    let newFacts = [];
    try { const parsed = JSON.parse(takeVal("--facts", "[]") || "[]"); if (Array.isArray(parsed)) newFacts = parsed.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()); } catch {}
    for (let attempt = 0; attempt < 4; attempt++) {
      const { text, etag } = await getTextMeta(STATE_KEY);
      const st = text ? JSON.parse(text) : { ...DEFAULT_STATE };
      const existing = Array.isArray(st.session_facts) ? st.session_facts : [];
      const seen = new Set(existing.map((f) => String(f).slice(0, 64).toLowerCase()));
      const toAdd = [];
      for (const f of newFacts) { const k = f.slice(0, 64).toLowerCase(); if (!seen.has(k)) { seen.add(k); toAdd.push(f); } }
      st.session_facts = [...toAdd.reverse(), ...existing].slice(0, 10); // newest unshifted to front, capped 10
      st.checkpoint = { as_of: new Date().toISOString(), source: SYNC_SOURCE, session_id: SESSION_ID };
      st.updated_at = new Date().toISOString();
      st.updated_by = "hook:" + SYNC_SOURCE;
      st.version = (st.version || 0) + 1;
      const res = await putTextCond(STATE_KEY, JSON.stringify(st, null, 2), "application/json", etag);
      if (isConflict(res.status)) continue; // someone else wrote between our read and write; retry
      if (!res.ok) throw new Error(`state-sync failed: ${res.status}`);
      console.log(`[kb-memory] state-sync -> ${AGENT} v${st.version} (source=${SYNC_SOURCE}, facts=${st.session_facts.length})`);
      return;
    }
    throw new Error("state-sync: too many concurrent-write conflicts, give up after 4 attempts");
  }
  console.error("verbs: remember | decision | correct | pitfall | status | entity | recall | tail | team | inbound | reconcile | render | whoami | use | list-agents | state | state-sync\n  cross-lane: add --on <lane> to write on ANOTHER agent's ledger (append-only, attributed by=<--agent>); the owner sees it via 'inbound' / 'tail' on wake and 'reconcile' to ack.\n  state --get [--json] | state --set [--goal \"...\"] [--constraints \"a;b;c\"] [--decisions \"a;b;c\"] [--last \"...\"]  (typed current-state handoff doc)\n  state-sync --agent <a> --facts '[\"...\"]' [--source precompact|stop|periodic] [--session-id <id>]  (CBP-1: additive session_facts + checkpoint, never touches goal/constraints/open_decisions)");
  process.exit(2);
})().catch((e) => {
  // redactSecrets, not raw e.message: this string is both PRINTED here and PERSISTED into the
  // fallback file below, and a recovery pass replays those rows into the ledger where a row can be
  // share:true. The errors that reach this catch come from the credential chain itself, so a token,
  // a signed URL or a DSN is plausibly in scope at throw time. Redaction keeps every key and drops
  // only values, so the fail-loud diagnosis this path exists to deliver survives intact.
  const safeMessage = redactSecrets(e.message);
  console.error("ERROR: " + safeMessage);
  // DURABLE LOCAL FALLBACK for a DIRECT CLI write (2026-08-18, the agent-seat credential bootstrap
  // fix). Before this, only content that happened to route through reflect.mjs's spawn-and-catch
  // --commit loop got saved when its write failed; a human/agent typing `mem.mjs status "..." --agent
  // cro` straight into a shell and hitting exactly the same failure (no AWS creds resolvable, Azure
  // Key Vault permanently gone -- see aws-secret.mjs's header) got NOTHING: the text was gone the
  // instant this process exited, unless someone happened to be watching the terminal and retyped it
  // by hand. This mirrors reflect.mjs's own fallback (same file, same per-agent path, same shape) for
  // the verbs that actually carry recoverable free text. Read-only verbs (recall/tail/whoami/...) and
  // structural writes without a `--was`-shaped WAS/`entity` free-text pair are intentionally NOT
  // covered here -- this is an HONEST, named safety net for the common case (remember/decision/
  // pitfall/status/correct), not a claim that every possible write path is now loss-proof.
  const WRITE_VERBS = new Set(["remember", "fact", "decision", "pitfall", "status", "correct"]);
  if (AGENT && TEXT && WRITE_VERBS.has(cmd)) {
    const item = { type: cmd, text: TEXT, share: SHARE || cmd === "status", tags: ["mem-direct-fallback"] };
    if (cmd === "correct" && WAS) item.was = WAS;
    if (CROSS) item.on = ON;
    appendFailedWriteFallback(AGENT, item, safeMessage, "mem.mjs");
    console.error(`[kb-memory] NOT LOST: saved to the local fallback (${FAILED_WRITE_FILE(AGENT)}). Re-run this same command once credentials are restored, or recover the file by hand.`);
  }
  process.exit(1);
});
