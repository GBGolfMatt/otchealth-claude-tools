// Tests for redact.mjs -- the credential scrubber applied to error strings that mem.mjs prints AND
// that local-fallback.mjs persists into rows a recovery pass replays into the ledger.
//
// Two halves, and the SECOND half is the load-bearing one. Proving a scrubber redacts secrets is
// easy and half a test; the failure mode that actually costs an operator is an over-eager scrubber
// eating the diagnosis on a fail-loud path, which is exactly what these errors exist to deliver.
// So every redaction assertion is paired with a counterfactual that the surrounding message, and
// the diagnostic identifiers that look secret-ish but are not (request ids, ETags, SHAs, ARNs),
// survive untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { redactSecrets } from "../redact.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- half 1: real credential shapes are removed ----

test("redactSecrets removes AWS access key ids of every prefix, keeping the surrounding message", () => {
  const out = redactSecrets("SSM GetParameter denied for key AKIAIOSFODNN7EXAMPLE in us-east-1");
  assert.doesNotMatch(out, /AKIAIOSFODNN7EXAMPLE/, "the key id must be gone");
  assert.match(out, /\[REDACTED-AWS-KEY-ID\]/);
  assert.match(out, /SSM GetParameter denied/, "the diagnosis must survive");
  assert.match(out, /us-east-1/, "the region is diagnostic, not secret");
  for (const p of ["ASIA", "AIDA", "AROA"]) {
    assert.doesNotMatch(redactSecrets(`id ${p}IOSFODNN7EXAMPLE here`), new RegExp(`${p}IOSFODNN7EXAMPLE`), `${p} prefix must redact too`);
  }
});

test("redactSecrets removes SigV4 Authorization material but keeps the algorithm name", () => {
  const raw = "403 from s3: Authorization: AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260818/us-east-1/s3/aws4_request, "
    + "SignedHeaders=host;x-amz-date, Signature=" + "a".repeat(64);
  const out = redactSecrets(raw);
  assert.doesNotMatch(out, /aws4_request/, "the credential scope must be gone");
  assert.doesNotMatch(out, /a{64}/, "the signature must be gone");
  assert.match(out, /AWS4-HMAC-SHA256/, "the algorithm is diagnostic and must remain");
  assert.match(out, /403 from s3/, "the status is the diagnosis and must remain");
  assert.match(out, /SignedHeaders=host;x-amz-date/, "which headers were signed is diagnostic, not secret");
});

test("redactSecrets removes presigned-URL signatures and Azure SAS sig, keeping host and path", () => {
  const out = redactSecrets("fetch failed: https://bucket.s3.amazonaws.com/a/b.pdf?X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20260818&X-Amz-Signature=deadbeef123&X-Amz-Expires=900");
  assert.doesNotMatch(out, /deadbeef123/, "the presigned signature must be gone");
  assert.match(out, /X-Amz-Signature=\[REDACTED\]/, "the key is kept so the reader knows WHAT was redacted");
  assert.match(out, /bucket\.s3\.amazonaws\.com\/a\/b\.pdf/, "host and object path are the diagnosis");
  assert.match(out, /X-Amz-Expires=900/, "non-secret query params must survive");

  const sas = redactSecrets("blob 403: https://acct.blob.core.windows.net/c/x.txt?sp=r&se=2026-08-18T19:34:04Z&sig=yd%2FmJETE1Lmp%3D");
  assert.doesNotMatch(sas, /yd%2FmJETE1Lmp/, "the Azure SAS signature must be gone");
  assert.match(sas, /sig=\[REDACTED\]/);
  assert.match(sas, /se=2026-08-18T19:34:04Z/, "the SAS expiry is diagnostic (it explains a 403) and must survive");
});

test("redactSecrets removes bearer tokens and bare JWTs", () => {
  const out = redactSecrets("401 Unauthorized, sent Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjdG8ifQ.sIgNaTuRe");
  assert.doesNotMatch(out, /eyJhbGciOiJIUzI1NiJ9/, "the token must be gone");
  assert.match(out, /401 Unauthorized/, "the status is the diagnosis");

  const bare = redactSecrets("gateway rejected token eyJhbGciOiJIUzI1NiJ9.eyJsYW5lIjoiY3RvIn0.abcDEF123 for lane cto");
  assert.doesNotMatch(bare, /eyJsYW5lIjoiY3RvIn0/, "a bare JWT with no Bearer prefix must redact too");
  assert.match(bare, /\[REDACTED-JWT\]/);
  assert.match(bare, /for lane cto/, "the lane is diagnostic and must survive");
});

test("redactSecrets removes the password from a DSN but keeps scheme, user, host and database", () => {
  const out = redactSecrets("connection failed: postgres://otcadmin:sup3rS3cret@db.cluster-x.us-east-1.rds.amazonaws.com:5432/agentstate");
  assert.doesNotMatch(out, /sup3rS3cret/, "the password must be gone");
  assert.match(out, /postgres:\/\/otcadmin:\[REDACTED\]@/);
  assert.match(out, /db\.cluster-x\.us-east-1\.rds\.amazonaws\.com:5432\/agentstate/, "host/port/database are the entire diagnosis for a connection failure");
});

test("redactSecrets removes explicit key=value secrets in prose and query strings", () => {
  for (const [raw, gone] of [
    ["az login failed: client_secret=abc~123.def-456", "abc~123.def-456"],
    ["request had api_key: sk-live-9f8e7d6c5b4a", "sk-live-9f8e7d6c5b4a"],
    ['config {"password": "hunter2"}', "hunter2"],
    ["refresh_token=1//0gXyZ-abcdef&grant_type=refresh_token", "1//0gXyZ-abcdef"],
  ]) {
    const out = redactSecrets(raw);
    assert.doesNotMatch(out, new RegExp(gone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `must redact the value in: ${raw}`);
    assert.match(out, /\[REDACTED\]/);
  }
});

// ---- half 2: the counterfactual -- ordinary diagnostic text is NOT eaten ----

test("redactSecrets leaves the fleet's real error messages completely untouched", () => {
  // These are verbatim shapes this fleet actually emits. If redaction ever mangles one of them, the
  // fail-loud path stops being useful and this test is the thing that catches it.
  const untouched = [
    "AWS credentials unavailable: set OTC_AWS_ACCESS_KEY_ID + OTC_AWS_SECRET_ACCESS_KEY (NOT the plain AWS_ names)",
    "state-sync failed: 412",
    "state-sync: too many concurrent-write conflicts, give up after 4 attempts",
    "[kv-secret] READ failed for \"cio-fly-service-account-token\" via all auth paths: identity:no-token, sp:no-token, azcli:no-token",
    "getaddrinfo ENOTFOUND automation.otchealth.app",
    "ENOTEMPTY: directory not empty, rmdir '/tmp/mem-credboot-test-n3TcZH/.azure'",
  ];
  for (const s of untouched) assert.equal(redactSecrets(s), s, `must pass through unchanged: ${s}`);
});

test("redactSecrets does not eat secret-LOOKING diagnostic identifiers", () => {
  // Every one of these is high-entropy and none is a credential. An entropy-based scrubber would
  // destroy all of them, which is precisely why redact.mjs matches shapes rather than randomness.
  const keep = [
    "commit 636b8b433b6b3f54ae15ed47cbe2328c328a7405 is not deployed",
    "image digest sha256:140abad856cccc3b7f194026c9884d3ea75308b3e9b0c240ec1beaa8c722114c",
    "ETag mismatch: \"0x8DC1F2A3B4C5D6E\" vs \"0x8DC1F2A3B4C5D7F\"",
    "x-amz-request-id: N3TCZHQ9WK2XJ4M7, x-amz-id-2: kAbCdEf123456789",
    "arn:aws:iam::900915535335:role/otchealth-job-task-role denied ssm:GetParameter",
    "operation family_matt_v5_owner_20260810_01 request a30208e2e394b60077da11dd72b095c2e4d4a55f95e67513c627741aa2b5f2fc",
  ];
  for (const s of keep) assert.equal(redactSecrets(s), s, `diagnostic identifier must survive: ${s}`);
});

test("redactSecrets is idempotent, so double-redaction through the local-fallback choke point is safe", () => {
  const once = redactSecrets("Bearer eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.sig and AKIAIOSFODNN7EXAMPLE");
  assert.equal(redactSecrets(once), once, "redacting an already-redacted string must be a no-op");
});

test("redactSecrets never throws and always returns a string, whatever it is handed", () => {
  for (const v of [undefined, null, 42, {}, [], Symbol("x") ? "sym-safe" : ""]) {
    const out = redactSecrets(v);
    assert.equal(typeof out, "string", `must return a string for ${String(v)}`);
  }
  assert.equal(redactSecrets(undefined), "", "undefined becomes empty, not the literal 'undefined'");
});

// ---- the wiring: prove it is actually APPLIED, not merely available ----

test("mem.mjs and local-fallback.mjs both actually call redactSecrets (wiring, not just availability)", () => {
  const mem = readFileSync(join(HERE, "..", "mem.mjs"), "utf8");
  assert.match(mem, /import \{ redactSecrets \} from "\.\/redact\.mjs"/, "mem.mjs must import the redactor");
  assert.match(mem, /const safeMessage = redactSecrets\(e\.message\)/, "mem.mjs's top-level catch must redact before use");
  assert.doesNotMatch(mem, /console\.error\("ERROR: " \+ e\.message\)/, "the raw-message print must be gone, not merely shadowed");
  assert.match(mem, /appendFailedWriteFallback\(AGENT, item, safeMessage, "mem\.mjs", \{ cacheDir: CACHE_DIR \}\)/, "the PERSISTED error must be the redacted one and use the selected cache");

  const lf = readFileSync(join(HERE, "..", "local-fallback.mjs"), "utf8");
  assert.match(lf, /error: redactSecrets\(error\)/, "the choke point must redact so reflect.mjs's caller is covered too");
  assert.match(lf, /text: item\.text/, "item.text must NOT be redacted -- it is the operator content the fallback exists to preserve");
});

test("a real fallback row written through the choke point carries a redacted error and an intact text", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "redact-fallback-"));
  try {
    const { appendFailedWriteFallback, FAILED_WRITE_FILE } = await import("../local-fallback.mjs");
    const file = FAILED_WRITE_FILE("zzz-redact-test", cacheDir);
    assert.ok(file.startsWith(cacheDir), `the row must be written under the explicit temp cache, got ${file}`);
    const operatorText = "a checkpoint whose content must survive byte for byte";
    appendFailedWriteFallback("zzz-redact-test", { type: "status", text: operatorText, share: true }, "denied for AKIAIOSFODNN7EXAMPLE", "mem.mjs", { cacheDir });
    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 1, "exactly one row was written to the explicit temp cache");
    const row = JSON.parse(lines[0]);
    assert.doesNotMatch(row.error, /AKIAIOSFODNN7EXAMPLE/, "the persisted error must be redacted -- this row gets replayed into a share:true ledger entry");
    assert.match(row.error, /\[REDACTED-AWS-KEY-ID\]/);
    assert.equal(row.text, operatorText, "the operator content must be preserved exactly");
    assert.equal(row.share, true);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
