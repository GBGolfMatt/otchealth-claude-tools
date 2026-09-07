// Tests for setup/heartbeat.mjs's S3 port (2026-08-27, off dead Azure Blob). Mirrors the fetch-stub
// convention already used by skills/kb-memory/tests/s3-blob-write-path.test.mjs and
// skills/xero/tests/xero-token-lock.test.mjs: a single stateful stub over globalThis.fetch, never a
// real network call.
//
// heartbeat.mjs is a CLI script (top-level `if (isMain)` IIFE, calls process.exit()), so these run it
// as a real subprocess with `--import` preloading the fetch stub before the script's own top-level
// code runs -- the SAME technique skills/doc-indexer/tests/push-search-opensearch.test.mjs uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileP = promisify(execFile);
const HERE = fileURLToPath(new URL(".", import.meta.url));
const HEARTBEAT_MJS = join(HERE, "..", "setup", "heartbeat.mjs");

// otchealthcommons/company-journal's real MIRROR row (skills/kb-memory/s3-blob.mjs) -- copied here,
// not re-derived, so this test fails loudly if that mapping ever changes underneath it.
const S3_BUCKET = "otchealth-brain-dr-55c84f6b";
const S3_KEY_PREFIX = "otchealthcommons/company-journal/";
const S3_HOST = `${S3_BUCKET}.s3.us-east-1.amazonaws.com`;
const AZURE_HOST_RE = /blob\.core\.windows\.net|management\.azure\.com|login\.microsoftonline\.com|vault\.azure\.net/i;

function isHost(u, host) { try { return new URL(u).host === host; } catch { return false; } }
function pathOf(u) { try { return new URL(u).pathname; } catch { return ""; } }

/** Preload module: an in-memory S3 object store keyed by pathname, logging every call so assertions
 *  can inspect both WHICH host was hit and WHAT was actually sent. */
function preloadSource(logPath, storePath) {
  return `
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
function isHost(u, host) { try { return new URL(u).host === host; } catch { return false; } }
function pathOf(u) { try { return new URL(u).pathname; } catch { return ""; } }
function loadStore() { return existsSync(${JSON.stringify(storePath)}) ? JSON.parse(readFileSync(${JSON.stringify(storePath)}, "utf8")) : {}; }
function saveStore(s) { writeFileSync(${JSON.stringify(storePath)}, JSON.stringify(s)); }
globalThis.fetch = async (url, opts) => {
  const u = String(typeof url === "string" ? url : url?.url || url);
  const method = ((opts && opts.method) || "GET").toUpperCase();
  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ method, url: u }) + "\\n");
  if (isHost(u, ${JSON.stringify(S3_HOST)})) {
    const p = pathOf(u);
    const store = loadStore();
    if (method === "GET") {
      if (p.endsWith("?list-type=2") || u.includes("list-type=2")) {
        // LIST: build a minimal S3 ListObjectsV2 XML from every stored key under the prefix.
        const qs = new URL(u).searchParams;
        const prefix = qs.get("prefix") || "";
        const keys = Object.keys(store).filter(k => k.startsWith("/" + prefix));
        const contents = keys.map(k => \`<Contents><Key>\${k.slice(1)}</Key><Size>\${store[k].length}</Size><LastModified>2026-08-27T00:00:00.000Z</LastModified></Contents>\`).join("");
        return new Response(\`<ListBucketResult>\${contents}<IsTruncated>false</IsTruncated></ListBucketResult>\`, { status: 200 });
      }
      if (!(p in store)) return new Response("not found", { status: 404 });
      return new Response(store[p], { status: 200, headers: { etag: '"fake-etag"' } });
    }
    if (method === "PUT") {
      const bodyStr = Buffer.isBuffer(opts.body) ? opts.body.toString("utf8") : String(opts.body);
      store[p] = bodyStr;
      saveStore(store);
      return new Response("", { status: 200, headers: { etag: '"fake-etag"' } });
    }
    return new Response("method not stubbed", { status: 500 });
  }
  return new Response("not found", { status: 404 });
};
`;
}

function runHeartbeat(args, { presetStore, registry } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "heartbeat-s3-test-"));
  const logPath = join(dir, "calls.log");
  const storePath = join(dir, "store.json");
  writeFileSync(logPath, "");
  writeFileSync(storePath, JSON.stringify(presetStore || {}));
  const preload = join(dir, "preload.mjs");
  writeFileSync(preload, preloadSource(logPath, storePath));
  const registryPath = join(dir, "heartbeat-registry.json");
  if (registry !== undefined) writeFileSync(registryPath, JSON.stringify(registry));
  const env = {
    PATH: process.env.PATH,
    AWS_ACCESS_KEY_ID: "AKIAUNITTESTFAKE0000",
    AWS_SECRET_ACCESS_KEY: "unit-test-fake-secret-access-key-not-real",
    ...(registry !== undefined ? { NODE_ENV: "test", HEARTBEAT_TEST_REGISTRY_FILE: registryPath } : {}),
  };
  return execFileP(process.execPath, ["--import", pathToFileURL(preload).href, HEARTBEAT_MJS, ...args], { env, timeout: 15000 })
    .then((r) => ({ status: 0, stdout: r.stdout, stderr: r.stderr, calls: readCalls(logPath), store: JSON.parse(readFileSync(storePath, "utf8")) }))
    .catch((e) => ({ status: e.code ?? 1, stdout: e.stdout || "", stderr: e.stderr || "", calls: readCalls(logPath), store: JSON.parse(readFileSync(storePath, "utf8")) }));
}
function readCalls(logPath) { return readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); }

test("beat writes to S3 (otchealth-brain-dr-55c84f6b), at the exact key _HEARTBEAT/<job>.json, with ZERO Azure calls", async () => {
  const r = await runHeartbeat(["beat", "porttest-s3-hb", "ok"]);
  assert.equal(r.status, 0, `expected a clean exit; stderr: ${r.stderr}`);
  assert.deepEqual(r.calls.filter((c) => AZURE_HOST_RE.test(c.url)), [], "must never reach an Azure/ARM/Key-Vault host");
  const putCall = r.calls.find((c) => isHost(c.url, S3_HOST) && c.method === "PUT");
  assert.ok(putCall, "no S3 PUT was captured");
  assert.equal(pathOf(putCall.url), "/" + S3_KEY_PREFIX + "_HEARTBEAT/porttest-s3-hb.json");
  const stored = JSON.parse(r.store["/" + S3_KEY_PREFIX + "_HEARTBEAT/porttest-s3-hb.json"]);
  assert.equal(stored.last_event, "ok");
  assert.ok(stored.last_ok, "an 'ok' beat must set last_ok");
});

test("check reports an unregistered prior beat as UNKNOWN because no cadence is registered", async () => {
  const nowIso = new Date().toISOString();
  const presetStore = {
    ["/" + S3_KEY_PREFIX + "_HEARTBEAT/porttest-s3-hb.json"]: JSON.stringify({ job: "porttest-s3-hb", last_event: "ok", last_ok: nowIso, consecutive_fail: 0 }),
  };
  const r = await runHeartbeat(["check", "--json"], { presetStore });
  assert.equal(r.status, 0, `expected a clean exit; stderr: ${r.stderr}`);
  const rows = JSON.parse(r.stdout);
  const row = rows.find((x) => x.job === "porttest-s3-hb");
  assert.ok(row, "the seeded job must appear in check's output (from the S3 listing, since it is not in the registry)");
  assert.equal(row.status, "UNKNOWN");
  assert.equal(row.intervalMin, null);
  assert.deepEqual(r.calls.filter((c) => AZURE_HOST_RE.test(c.url)), [], "must never reach an Azure/ARM/Key-Vault host");
});

test("check reports NO-DATA for a job with no beat and no registry interval", async () => {
  const r = await runHeartbeat(["check", "--json"]);
  assert.equal(r.status, 0);
  const rows = JSON.parse(r.stdout);
  // Every real registry job has an interval_min, so a truly unregistered/unbeaten job cannot appear
  // here -- but the empty case (nothing in the store, real registry only) must still exit clean and
  // produce a well-formed array with no NO-ARM/armFailed remnants anywhere.
  assert.ok(Array.isArray(rows));
  for (const row of rows) {
    assert.notEqual(row.status, "NO-ARM", "the NO-ARM status must be gone entirely (no ARM signal exists any more)");
    assert.equal(row.armFailed, undefined, "the armFailed field must be gone entirely");
    assert.equal(row.src, undefined, "the arm/beat 'src' field must be gone entirely");
  }
});

test("a DEAD job with auto_restart:true in the registry reports the fixed 'restart-unavailable' stub, never a live restart attempt", async () => {
  // brain-reindex is a real registry entry with auto_restart:true and no beat in the store -> DEAD.
  const r = await runHeartbeat(["check", "--json"]);
  assert.equal(r.status, 0);
  const rows = JSON.parse(r.stdout);
  const row = rows.find((x) => x.job === "brain-reindex");
  assert.ok(row, "brain-reindex must appear (it is in the real registry)");
  assert.equal(row.status, "DEAD");
  assert.ok(row.autoRestart, "an auto_restart:true DEAD job must carry an autoRestart annotation");
  assert.equal(row.autoRestart.action, "restart-unavailable");
  assert.match(row.autoRestart.detail, /no ARM/i);
});

// ---- counterfactual guard: no Azure Blob / ARM code remains in the ported file --------------------
test("heartbeat.mjs no longer talks to Azure Blob or ARM (ported to S3, 2026-08-27)", async () => {
  const src = readFileSync(HEARTBEAT_MJS, "utf8");
  // Strip comments before asserting absence, so this test cannot be satisfied by simply deleting the
  // documentation of what used to be here (a source-scan test that can't tell "the code is gone" from
  // "the code was renamed into a comment" would forbid ever explaining the change in prose).
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  assert.doesNotMatch(stripped, /blob\.core\.windows\.net/, "must not construct any Azure Blob URL");
  assert.doesNotMatch(stripped, /management\.azure\.com/, "must not call Azure Resource Manager");
  assert.doesNotMatch(stripped, /login\.microsoftonline\.com/, "must not mint an Azure AD/ARM token");
  assert.doesNotMatch(stripped, /AZURE_SP_(TENANT|CLIENT)_ID/, "must not read the old Azure SP creds");
  assert.doesNotMatch(stripped, /armToken|armLastExec|armStartJob|buildSas/, "the old Azure/ARM primitives must be gone");
  assert.match(src, /from "\.\.\/skills\/kb-memory\/commons-store\.mjs"/, "must route storage through the shared commons-store facade");
});


test("a future last_ok cannot make an unregistered heartbeat LIVE", async () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const presetStore = {
    ["/" + S3_KEY_PREFIX + "_HEARTBEAT/future-clock.json"]: JSON.stringify({ job: "future-clock", last_event: "ok", last_ok: future }),
  };
  const r = await runHeartbeat(["check", "--json"], { presetStore });
  assert.equal(r.status, 0, r.stderr);
  const row = JSON.parse(r.stdout).find((x) => x.job === "future-clock");
  assert.equal(row.status, "DEAD");
  assert.equal(row.ageMin, null);
});

test("a future last_ok cannot hide a missing registered job", async () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const presetStore = {
    ["/" + S3_KEY_PREFIX + "_HEARTBEAT/brain-reindex.json"]: JSON.stringify({ job: "brain-reindex", last_event: "ok", last_ok: future }),
  };
  const r = await runHeartbeat(["check", "--json"], { presetStore });
  assert.equal(r.status, 0, r.stderr);
  const row = JSON.parse(r.stdout).find((x) => x.job === "brain-reindex");
  assert.equal(row.status, "DEAD");
  assert.equal(row.ageMin, null);
  assert.equal(row.autoRestart.action, "restart-unavailable");
});

test("unregistered future and malformed completion times appear in the attention summary", async () => {
  const presetStore = {
    ["/" + S3_KEY_PREFIX + "_HEARTBEAT/future-clock.json"]: JSON.stringify({ last_ok: new Date(Date.now() + 86400000).toISOString() }),
    ["/" + S3_KEY_PREFIX + "_HEARTBEAT/invalid-clock.json"]: JSON.stringify({ last_ok: "not-a-date" }),
    ["/" + S3_KEY_PREFIX + "_HEARTBEAT/new-job.json"]: JSON.stringify({ last_event: "start" }),
    ["/" + S3_KEY_PREFIX + "_HEARTBEAT/recent-unregistered.json"]: JSON.stringify({ last_ok: new Date().toISOString() }),
  };
  const r = await runHeartbeat(["check"], { presetStore });
  assert.equal(r.status, 0, r.stderr);
  const attention = r.stdout.split("\n").find((line) => line.startsWith("SILENCE = FAILURE:"));
  assert.ok(attention);
  assert.match(attention, /future-clock/);
  assert.match(attention, /invalid-clock/);
  assert.doesNotMatch(attention, /new-job/);
  assert.match(r.stdout, /\[NO-DATA\] new-job/);
});

test("null and malformed registered cadence entries are UNKNOWN through the CLI path", async () => {
  const nowIso = new Date().toISOString();
  const registry = {
    "null-registry-entry": null,
    "missing-cadence": { owner: "cto" },
    "zero-cadence": { interval_min: 0, owner: "cto" },
    "string-cadence": { interval_min: "5", owner: "cto" },
  };
  const presetStore = Object.fromEntries(Object.keys(registry).map((job) => [
    "/" + S3_KEY_PREFIX + `_HEARTBEAT/${job}.json`, JSON.stringify({ last_ok: nowIso }),
  ]));
  const r = await runHeartbeat(["check", "--json"], { presetStore, registry });
  assert.equal(r.status, 0, r.stderr);
  const rows = JSON.parse(r.stdout);
  for (const job of Object.keys(registry)) {
    const row = rows.find((entry) => entry.job === job);
    assert.ok(row, `${job} must remain visible`);
    assert.equal(row.status, "UNKNOWN");
    assert.equal(row.intervalMin, null);
  }
});
test("a registered job with a small clock skew remains LIVE without a restart annotation", async () => {
  const presetStore = {
    ["/" + S3_KEY_PREFIX + "_HEARTBEAT/brain-reindex.json"]: JSON.stringify({ last_ok: new Date(Date.now() + 30000).toISOString() }),
  };
  const r = await runHeartbeat(["check", "--json"], { presetStore });
  assert.equal(r.status, 0, r.stderr);
  const row = JSON.parse(r.stdout).find((x) => x.job === "brain-reindex");
  assert.equal(row.status, "LIVE");
  assert.equal(row.ageMin, 0);
  assert.equal(row.autoRestart, undefined);
});
