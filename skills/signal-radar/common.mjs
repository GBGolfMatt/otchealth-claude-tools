// signal-radar/common.mjs — shared I/O helpers for the radar core + detectors.
// Dependency-free (no npm packages), mirrors the fleet-medic / vault-registry style: a single
// claude-driver SA JWT resolves everything else out of otchealth-shared-prod Secret Manager.
// Every helper here fails CLOSED to the CALLER (throws), so each detector's own try/catch decides
// fail-open behavior; this file does not itself hide errors.
import crypto from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { kvSecret } from "../kb-memory/azure-secret.mjs";
import * as pgState from "../kb-memory/pg-state.mjs";

export const SM = "otchealth-shared-prod";

// ---------------------------- GCP Secret Manager (claude-driver SA) ----------------------------
function resolveSaRaw() {
  if (process.env.GCP_CLAUDE_DRIVER_SA_JSON) return process.env.GCP_CLAUDE_DRIVER_SA_JSON;
  try { try { return readFileSync(`${homedir()}/.gcp_claude_driver_sa.json`, "utf8"); } catch { return null; } } catch { return null; }
}
export const SA_RAW = resolveSaRaw();

let _gcpToken = null, _gcpTokenExp = 0;
async function gcpToken() {
  if (_gcpToken && Date.now() < _gcpTokenExp - 30000) return _gcpToken;
  if (!SA_RAW) return null;
  const __r=SA_RAW;if(!__r){return null;}let sa;try{sa=JSON.parse(__r);}catch{return null;}if(!sa||!sa.private_key){return null;}
  const n = Math.floor(Date.now() / 1000);
  const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: n, exp: n + 3600 })}`;
  const jwt = i + "." + crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(jwt)}` });
  const j = await r.json();
  if (!j.access_token) return null;
  _gcpToken = j.access_token; _gcpTokenExp = Date.now() + 3500 * 1000;
  return _gcpToken;
}

const _smCache = new Map();
/** Fetch a secret's latest version. Returns null (not an error) on 404/missing so callers can feature-detect. */
export async function sm(id) { const _kv = await kvSecret(id); if (_kv != null) return _kv;
  if (_smCache.has(id)) return _smCache.get(id);
  const t = await gcpToken(); if(!t)return null;
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: "Bearer " + t } });
  const val = r.ok ? Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim() : null;
  _smCache.set(id, val);
  return val;
}

// ---------------------------- Azure Key Vault enumeration (live secret store) ----------------------------
// GCP Secret Manager is RETIRED (billing off). Enumerate Key Vault kv-otc-55c84f6bef instead, minting a
// vault token via the SAME chain azure-secret.mjs uses (managed identity -> SP client_credentials -> az CLI).
const KV_NAME = process.env.AZURE_KEYVAULT_NAME || "kv-otc-55c84f6bef";
let _kvTok = null, _kvTokExp = 0;
async function kvVaultToken() {
  const now = Date.now();
  if (_kvTok && _kvTokExp - now > 60_000) return _kvTok;
  const ie = process.env.IDENTITY_ENDPOINT, ih = process.env.IDENTITY_HEADER;
  if (ie && ih) {
    try {
      const cq = process.env.AZURE_UAMI_CLIENT_ID ? `&client_id=${encodeURIComponent(process.env.AZURE_UAMI_CLIENT_ID)}` : "";
      const r = await fetch(`${ie}?resource=${encodeURIComponent("https://vault.azure.net")}&api-version=2019-08-01${cq}`, { headers: { "x-identity-header": ih } });
      if (r.ok) { const j = await r.json(); if (j.access_token) { _kvTok = j.access_token; _kvTokExp = now + 3600_000; return _kvTok; } }
    } catch { /* fall through */ }
  }
  const tenant = process.env.AZURE_SP_TENANT_ID, cid = process.env.AZURE_SP_CLIENT_ID, csec = process.env.AZURE_SP_CLIENT_SECRET;
  if (tenant && cid && csec) {
    try {
      const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", client_id: cid, client_secret: csec, scope: "https://vault.azure.net/.default" }) });
      const j = await r.json();
      if (j.access_token) { _kvTok = j.access_token; _kvTokExp = now + 3600_000; return _kvTok; }
    } catch { /* fall through */ }
  }
  try {
    const out = execFileSync("az", ["account", "get-access-token", "--resource", "https://vault.azure.net", "--query", "accessToken", "-o", "tsv"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 });
    const tok = String(out || "").trim();
    if (tok) { _kvTok = tok; _kvTokExp = now + 3000_000; return _kvTok; }
  } catch { /* az absent / not logged in */ }
  return null;
}

/** List every secret id + its created time from Key Vault (for the rotate-age detector). */
export async function listSecrets() {
  const t = await kvVaultToken();
  if (!t) return [];
  const out = [];
  let next = `https://${KV_NAME}.vault.azure.net/secrets?api-version=7.4`;
  while (next) {
    const r = await fetch(next, { headers: { Authorization: "Bearer " + t } });
    if (!r.ok) break;
    const j = await r.json();
    for (const s of (j.value || [])) {
      const id = (s.id || "").split("/secrets/")[1] || (s.id || "");
      const created = s.attributes && s.attributes.created != null ? new Date(s.attributes.created * 1000).toISOString() : null;
      out.push({ id, created });
    }
    next = j.nextLink || "";
  }
  return out;
}

// ------------------------------------- PostHog (Fleet Agents) -------------------------------------
let _phCreds = null;
async function phCreds() {
  if (_phCreds) return _phCreds;
  const key = await sm("posthog-personal-api-key");
  const pid = await sm("posthog-fleet-project-id");
  if (!key || !pid) throw new Error("PostHog fleet creds missing (posthog-personal-api-key / posthog-fleet-project-id)");
  _phCreds = { key, pid };
  return _phCreds;
}

/** Run a HogQL query against the Fleet Agents PostHog project. Returns {columns, results} raw rows. */
export async function posthogQuery(hql) {
  const { key, pid } = await phCreds();
  const r = await fetch(`https://us.posthog.com/api/projects/${pid}/query/`, {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query: hql } }),
  });
  if (!r.ok) throw new Error(`PostHog query ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return { columns: j.columns || [], results: j.results || [] };
}

/** Emit an event into the Fleet Agents PostHog project (best-effort; never throws). */
export async function posthogEmit(event, distinctId, properties) {
  try {
    const ingestKey = await sm("posthog-fleet-ingest-key");
    if (!ingestKey) return false;
    await fetch("https://us.i.posthog.com/capture/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: ingestKey, event, distinct_id: distinctId, timestamp: new Date().toISOString(), properties: { $lib: "signal-radar", ...properties } }),
    });
    return true;
  } catch { return false; }
}

// ----------------------------------------- Sentry (org otchealth-inc) -----------------------------------------
const SENTRY_ORG = "otchealth-inc";
export async function sentryRequest(path) {
  const token = await sm("sentry-auth-token");
  if (!token) throw new Error("sentry-auth-token missing");
  const r = await fetch(`https://sentry.io/api/0${path}`, { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) throw new Error(`Sentry ${path} -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
export const SENTRY_ORG_SLUG = SENTRY_ORG;

// --------------------------------------- Azure ARM (azure-sp, read-only use here) ---------------------------------------
let _armToken = null, _armTokenExp = 0;
export async function armToken() {
  if (_armToken && Date.now() < _armTokenExp - 30000) return _armToken;
  const cid = await sm("azure-sp-client-id"), csec = await sm("azure-sp-client-secret"), tid = await sm("azure-sp-tenant-id");
  if (!cid || !csec || !tid) throw new Error("azure-sp credentials missing");
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: cid, client_secret: csec, scope: "https://management.azure.com/.default" });
  const r = await fetch(`https://login.microsoftonline.com/${tid}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const j = await r.json();
  if (!j.access_token) throw new Error("ARM token exchange failed: " + JSON.stringify(j).slice(0, 200));
  _armToken = j.access_token; _armTokenExp = Date.now() + 3500 * 1000;
  return _armToken;
}

// ------------------------------ agent-state store (`signals` container) ------------------------------
// REMOVAL NOTICE (2026-09-03): this used to be a dependency-free Azure Cosmos DB for NoSQL REST client
// (master-key HMAC auth, same scheme as otchealth-mcp-server's src/agentstate/cosmos.ts) against the
// SAME agent-state account decision-clock used. That account is permanently unreachable: Azure
// subscription 55c84f6b was deleted 2026-08-13, and the cosmos-endpoint SSM mirror was removed in the
// 2026-08-28 cleanup (FND-20260827-acce; its cosmos-key/cosmos-db companions were left behind, useless
// without the endpoint). The live incident this closes: radar.mjs's own `--emit` path has been running
// every 30 minutes since at least that cleanup, exiting 0 every time and printing "cosmos NOT
// configured ... nothing persisted or dispatched" -- a scheduled job that looks perfectly healthy
// (fresh CloudWatch logs, RunTask succeeds every run, every detector prints [ok]) while silently doing
// nothing. See radar.mjs's scan()/runScan() for the paired fail-loud fix.
//
// This section now delegates to ../kb-memory/pg-state.mjs (RDS Postgres, added 2026-08-16 in PR #437,
// never wired in until now) instead of the raw Cosmos REST calls, and was removed rather than kept
// behind a STATE_BACKEND=cosmos switch: this file had no such switch before today, so there was
// nothing to preserve a fallback path for, and a Cosmos default would only reproduce the same silent
// no-op against a permanently dead endpoint. Exported function NAMES and CALL SHAPES
// (cosmosConfig/cosmosPutSignal/cosmosQuerySignals) are unchanged on purpose, so the other two live
// callers of this exact API -- radar.mjs's own cooldown-history lookup, and
// compute-allocator/allocate.mjs's recentSignalsFor() -- need no changes.
const SIGNALS_CONTAINER = "signals";

// Test-only backend swap (see decision-clock/cosmos-client.mjs's identical seam for the rationale:
// node:test's mock.module() needs --experimental-test-module-mocks, which run-tests.sh's `node --test`
// invocation does not pass -- confirmed empirically, not assumed). Never invoked from any real path.
let _stateBackend = pgState;
export function _setStateBackendForTests(fake) { _stateBackend = fake; }
export function _resetStateBackendForTests() { _stateBackend = pgState; }

/** Resolve the agent-state connection config. Returns a truthy value when configured, else null --
 *  the same feature-detect contract the Cosmos implementation always had. Every live caller
 *  (radar.mjs, compute-allocator/allocate.mjs) only ever checks truthiness, never inspects the
 *  returned object's fields, so the shape here is deliberately minimal. */
export async function cosmosConfig() {
  return (await _stateBackend.isConfigured()) ? { backend: "postgres" } : null;
}

/** Write a Signal doc into the `signals` container, partitioned by owner. Idempotent upsert. Throws
 *  on a real failure; radar.mjs wraps every call in a per-signal try/catch (its own 2026-08-18 fix for
 *  the incident where a failed write was miscounted as a success -- see radar.mjs for that history). */
export async function cosmosPutSignal(doc) {
  if (!(await _stateBackend.isConfigured())) return { ok: false, reason: "not-configured" };
  await _stateBackend.upsertDoc(SIGNALS_CONTAINER, doc.owner, doc);
  return { ok: true };
}

/** Query the `signals` container for a single owner partition (used for cooldown/consecutive lookups
 *  and by compute-allocator's recentSignalsFor()). Fails open to "no rows" when not configured, same
 *  as the original Cosmos implementation; a real query failure once configured still throws, and
 *  every caller already wraps this in its own try/catch treating a throw as "no history". */
export async function cosmosQuerySignals(owner, query, parameters = []) {
  if (!(await _stateBackend.isConfigured())) return [];
  return _stateBackend.queryDocs(SIGNALS_CONTAINER, query, parameters, { pk: owner });
}

// ------------------------------------------- fleet-dispatch -------------------------------------------
// Route a signal to its owning agent's inbox via the existing fleet-dispatch skill (subprocess, so this
// file stays dependency-free and does not need to duplicate dispatch.mjs's Azure-commons blob logic).
export async function dispatchToOwner(owner, text, { execFileSync, dispatchPath } = {}) {
  if (!execFileSync || !dispatchPath) return false;
  try {
    execFileSync("node", [dispatchPath, "send", owner, text, "--from", "signal-radar"], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch { return false; }
}
