// Tests for skills/kb-memory/s3-blob.mjs (the Azure-write-lock fix, 2026-08-18) plus counterfactual
// guards on mem.mjs / semantic.mjs proving the silent-empty-list bug they used to share stays fixed.
// NEVER makes a real network call: every fetch-touching test stubs globalThis.fetch (save/restore),
// mirroring opensearch-write.test.mjs's own withStubbedFetch/withEnv convention in this same directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  s3LocationFor,
  getTextFromS3,
  getTextMetaFromS3,
  putObjectToS3,
  listBlobsFromS3,
  s3Configured,
  _resetCredsCacheForTests,
} from "../s3-blob.mjs";

async function withStubbedFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await run(); } finally { globalThis.fetch = original; }
}
// Resets the module-level AWS-credential cache on both ends: without this, a test that overrides
// AWS_* env vars would observe an EARLIER test's already-cached credentials (the cache has a 60s
// TTL, comfortably longer than this whole suite takes to run) instead of its own, and restoring the
// real env afterward would leave the FAKE creds cached for whatever runs next in the same process.
async function withEnv(vars, run) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k];
  }
  _resetCredsCacheForTests();
  try { return await run(); } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    _resetCredsCacheForTests();
  }
}
const FAKE_CREDS = { AWS_ACCESS_KEY_ID: "AKIAFAKEFAKEFAKEFAKE", AWS_SECRET_ACCESS_KEY: "fakefakefakefakefakefakefakefakefakefake", AWS_SESSION_TOKEN: undefined };

// ---- s3LocationFor: fail-closed mapping --------------------------------------------------------
test("s3LocationFor resolves every room mem.mjs's AGENTS map can target (except clo-personal writes, which stay read-only by IAM elsewhere)", () => {
  for (const [account, container] of [
    ["otchealthcfodata", "cfo-source-docs"],
    ["otchealthlegalstore", "company"],
    ["otchealthlegalstore", "exec"],
    ["otchealthlegalstore", "personal"],
    ["otchealthcommons", "company-journal"],
  ]) {
    const loc = s3LocationFor(account, container);
    assert.ok(loc && loc.bucket && loc.keyPrefix, `${account}/${container} must resolve`);
    assert.equal(loc.keyPrefix, `${account}/${container}/`);
  }
});
test("s3LocationFor refuses (returns null for) an unmapped pair rather than guessing a bucket", () => {
  assert.equal(s3LocationFor("some-random-account", "some-random-container"), null);
  assert.equal(s3LocationFor("", ""), null);
});

// ---- signing shape: the exact bug this file's header calls out (mixed-case condHeaders) ---------
test("PUT with Azure-style mixed-case conditional headers (If-Match/If-None-Match) signs and sends LOWERCASED header names", async () => {
  let captured = null;
  await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async (url, opts) => {
      captured = { url: String(url), headers: opts.headers };
      return { ok: true, status: 200, headers: new Map([["etag", '"abc123"']]), text: async () => "" };
    }, () => putObjectToS3("otchealthcommons", "company-journal", "_MEMORY/_exec/cto.jsonl", "line\n", "application/x-ndjson", { "If-Match": '"prior-etag"' })));
  assert.ok(captured, "fetch must have been called");
  // The commons feed lives in brain-dr, NOT finance-legal-dr. This assertion is incidental to what
  // the test is really about (SigV4 header casing), which is exactly why it is dangerous: an
  // incidental hardcoded bucket defends whatever value it was written with. Routing is pinned
  // deliberately in s3-mirror-table.test.mjs; this line just has to agree with it.
  assert.ok(captured.url.startsWith("https://otchealth-brain-dr-55c84f6b.s3.us-east-1.amazonaws.com/"), "must target the shared-brain DR bucket");
  assert.ok(captured.url.includes("otchealthcommons%2Fcompany-journal%2F_MEMORY%2F_exec%2Fcto.jsonl") || captured.url.includes("otchealthcommons/company-journal/_MEMORY/_exec/cto.jsonl"), `unexpected key in url: ${captured.url}`);
  // The signed Authorization header's SignedHeaders list must contain lowercase "if-match", proving
  // the mixed-case input got normalized before signing (the exact bug fixed in this file).
  const auth = captured.headers.Authorization || captured.headers.authorization;
  assert.match(auth, /SignedHeaders=[^,]*if-match/, "if-match must be present, lowercase, in the signed-headers list");
  assert.doesNotMatch(auth, /SignedHeaders=[^,]*If-Match/, "the mixed-case form must never appear in signed-headers");
  assert.ok(captured.headers["if-match"] === '"prior-etag"' || captured.headers["If-Match"] === '"prior-etag"', "the conditional header value itself must still be sent");
});

// ---- getTextFromS3 / getTextMetaFromS3: 404->null, throw loud on anything else -------------------
test("getTextFromS3 returns null on a genuine 404 (does not throw)", async () => {
  const result = await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async () => ({ ok: false, status: 404, headers: new Map(), text: async () => "" }),
      () => getTextFromS3("otchealthcommons", "company-journal", "_MEMORY/nonexistent.jsonl")));
  assert.equal(result, null);
});
test("getTextFromS3 THROWS on a 403 rather than reporting it as absent -- the exact class of bug this migration exists to close", async () => {
  await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async () => ({ ok: false, status: 403, headers: new Map(), text: async () => "<Error><Code>AccessDenied</Code></Error>" }),
      () => assert.rejects(() => getTextFromS3("otchealthcommons", "company-journal", "_MEMORY/_exec/cto.jsonl"), /s3 get 403/)));
});
test("getTextMetaFromS3 surfaces the ETag from the same GET response (no second round trip)", async () => {
  let calls = 0;
  const { text, etag } = await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async () => { calls++; return { ok: true, status: 200, headers: new Map([["etag", '"xyz"']]), text: async () => "line1\n" }; },
      () => getTextMetaFromS3("otchealthcommons", "company-journal", "_MEMORY/cto.jsonl")));
  assert.equal(text, "line1\n");
  assert.equal(etag, '"xyz"');
  assert.equal(calls, 1, "must be exactly one HTTP call, not a GET plus a separate HEAD");
});

// ---- putObjectToS3: throws on every non-2xx, including a conflict (the caller decides what to do) --
test("putObjectToS3 throws (with .status set) on a 412 precondition failure, it never swallows a conflict", async () => {
  await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async () => ({ ok: false, status: 412, headers: new Map(), text: async () => "<Error><Code>PreconditionFailed</Code></Error>" }), async () => {
      await assert.rejects(
        () => putObjectToS3("otchealthcommons", "company-journal", "_MEMORY/cto.jsonl", "x\n", "application/x-ndjson", { "If-Match": '"stale"' }),
        (e) => { assert.equal(e.status, 412); return true; },
      );
    }));
});

// ---- listBlobsFromS3: throws on a real failure, a clean empty page is NOT an error ---------------
test("listBlobsFromS3 throws loud on a listing failure rather than returning a false-empty result", async () => {
  await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async () => ({ ok: false, status: 403, text: async () => "<Error><Code>AccessDenied</Code></Error>" }),
      () => assert.rejects(() => listBlobsFromS3("otchealthcommons", "company-journal", "_MEMORY/_exec/"), /s3 list 403/)));
});
test("listBlobsFromS3 returns [] for a genuine zero-object prefix (a clean 200 is not a failure)", async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>`;
  const result = await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async () => ({ ok: true, status: 200, text: async () => xml }),
      () => listBlobsFromS3("otchealthcommons", "company-journal", "_MEMORY/_exec/nothing-here/")));
  assert.deepEqual(result, []);
});
test("listBlobsFromS3 returns names relative to the mirror's own keyPrefix, matching Azure's listing shape", async () => {
  const xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>` +
    `<Contents><Key>otchealthcommons/company-journal/_MEMORY/_exec/cto.jsonl</Key></Contents></ListBucketResult>`;
  const result = await withEnv(FAKE_CREDS, () =>
    withStubbedFetch(async () => ({ ok: true, status: 200, text: async () => xml }),
      () => listBlobsFromS3("otchealthcommons", "company-journal", "_MEMORY/_exec/")));
  assert.deepEqual(result, ["_MEMORY/_exec/cto.jsonl"]);
});

// ---- credentials: the "prox" sandbox placeholder must never be treated as real -------------------
test("s3Configured() is false when only a 'prox'-prefixed placeholder key is present (the sandbox proxy injection)", async () => {
  const configured = await withEnv({ AWS_ACCESS_KEY_ID: "proxABCDEFGHIJKL", AWS_SECRET_ACCESS_KEY: "whatever", OTC_AWS_ACCESS_KEY_ID: undefined, OTC_AWS_SECRET_ACCESS_KEY: undefined, AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined }, () => s3Configured());
  assert.equal(configured, false);
});
test("s3Configured() is true with a real-shaped access key", async () => {
  const configured = await withEnv(FAKE_CREDS, () => s3Configured());
  assert.equal(configured, true);
});

// ---- counterfactual guards: the shipped mem.mjs / semantic.mjs must not regress to a bare `break` --
// Mirrors tests/ssm-list-partial.test.mjs's own guard on aws-secret.mjs for the identical bug shape.
// Comments are stripped first so the guard does not match its own doc comment quoting the old line.
function stripComments(src) { return src.replace(/^\s*\/\/.*$/gm, ""); }

test("mem.mjs's Azure shared-feed listing no longer silently `break`s on a failed page", async () => {
  const src = stripComments(await readFile(new URL("../mem.mjs", import.meta.url), "utf8"));
  const start = src.indexOf("async function cListAzureAll(");
  assert.ok(start > -1, "cListAzureAll must exist");
  const body = src.slice(start, src.indexOf("\n}", start));
  assert.doesNotMatch(body, /if\s*\(!r\.ok\)\s*break;/, "must not silently break out of the Azure listing loop on failure");
  assert.match(body, /refusing to report an empty shared feed as success/, "must throw a named, diagnosable error on a real listing failure");
  assert.match(body, /r\.status === 404\) break;/, "a genuine 'container absent' 404 must still be treated as a legitimately empty feed");
});
test("mem.mjs defaults BLOB_BACKEND to 's3' (writes must not silently target the write-locked Azure account by default)", async () => {
  const src = await readFile(new URL("../mem.mjs", import.meta.url), "utf8");
  assert.match(src, /const BLOB_BACKEND = \(process\.env\.BLOB_BACKEND \|\| "s3"\)\.toLowerCase\(\);/);
});
test("semantic.mjs's readExecFeed listing no longer silently `break`s on a failed page", async () => {
  const src = stripComments(await readFile(new URL("../semantic.mjs", import.meta.url), "utf8"));
  const start = src.indexOf("async function listAzureExecFiles(");
  assert.ok(start > -1, "listAzureExecFiles must exist");
  const body = src.slice(start, src.indexOf("\n}", start));
  assert.doesNotMatch(body, /if\s*\(!r\.ok\)\s*break;/, "must not silently break out of the Azure listing loop on failure");
  assert.match(body, /refusing to report an empty shared feed as success/, "must throw a named, diagnosable error on a real listing failure");
});
test("semantic.mjs defaults its blob reads to 's3' too, matching mem.mjs (contradiction-scan.mjs reuses readExecFeed and must get the same fix)", async () => {
  const src = await readFile(new URL("../semantic.mjs", import.meta.url), "utf8");
  assert.match(src, /const BLOB_BACKEND = \(process\.env\.BLOB_BACKEND \|\| "s3"\)\.toLowerCase\(\);/);
});


test("getTextMetaFromS3 forwards the caller AbortSignal to the actual fetch", async () => {
  await withEnv(FAKE_CREDS, async () => {
    const controller = new AbortController();
    let observed;
    await withStubbedFetch(async (_url, init) => {
      observed = init.signal;
      return new Response("row", { status: 200, headers: { etag: '"e"' } });
    }, () => getTextMetaFromS3("otchealthcommons", "company-journal", "_MEMORY/_exec/cto.jsonl", { signal: controller.signal }));
    assert.equal(observed, controller.signal);
  });
});
