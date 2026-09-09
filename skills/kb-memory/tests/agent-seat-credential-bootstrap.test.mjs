// Tests for the agent-seat credential bootstrap fix (2026-08-18): (1) aws-secret.mjs's awsCreds()
// resolution ORDER is pinned so a future edit cannot quietly reintroduce an Azure-first path or drop
// the OTC_AWS_* fallback; (2) a DIRECT `mem.mjs <verb> ... --agent <a>` invocation that cannot write
// (no AWS creds resolvable, matching the real Hyperagent CRO-seat failure this fix responds to)
// produces a loud, named failure AND saves the attempted content to the durable local fallback file
// instead of losing it silently -- the same guarantee reflect.mjs's own --commit loop has always had,
// now extended to a bare shell invocation of mem.mjs itself.
//
// mem.mjs has NO isMain guard (its whole CLI runs unconditionally at module load), so its behavior can
// only be exercised by spawning it as a REAL subprocess -- this is deliberate: these tests prove the
// actual end-to-end CLI contract, not an internal function in isolation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { awsCredsPresent } from "../aws-secret.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MEM_MJS = join(HERE, "..", "mem.mjs");

// ---- credential-order pinning (awsCreds() itself) ------------------------------------------------
// aws-secret.mjs has NO module-level cache on awsCreds() (only s3-blob.mjs's creds() wrapper caches,
// with its own _resetCredsCacheForTests()), so these tests stub fetch and mutate env directly with no
// cache-reset step needed.
async function withStubbedFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await run(); } finally { globalThis.fetch = original; }
}
async function withEnv(vars, run) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k];
  }
  try { return await run(); } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
const NO_CREDS = {
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined, AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined,
  AWS_CONTAINER_AUTHORIZATION_TOKEN: undefined,
  AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined, AWS_SESSION_TOKEN: undefined,
  OTC_AWS_ACCESS_KEY_ID: undefined, OTC_AWS_SECRET_ACCESS_KEY: undefined, OTC_AWS_SESSION_TOKEN: undefined,
};

test("awsCreds(): with nothing set, resolves to null (not a throw, not a guess)", async () => {
  const { awsCreds } = await import("../aws-secret.mjs");
  const creds = await withEnv(NO_CREDS, () => awsCreds());
  assert.equal(creds, null);
});

test("awsCreds(): ECS container-credentials endpoint wins even when AWS_* and OTC_AWS_* are ALSO present", async () => {
  const { awsCreds } = await import("../aws-secret.mjs");
  let calledUrl = null;
  const creds = await withEnv(
    { ...NO_CREDS, AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/fake-ecs-role",
      AWS_ACCESS_KEY_ID: "AKIAENVWINSIFECSMISSING", AWS_SECRET_ACCESS_KEY: "env-secret",
      OTC_AWS_ACCESS_KEY_ID: "AKIAOTCSHOULDNOTWIN", OTC_AWS_SECRET_ACCESS_KEY: "otc-secret" },
    () => withStubbedFetch(async (url) => {
      calledUrl = String(url);
      return { ok: true, json: async () => ({ AccessKeyId: "ECS-AK", SecretAccessKey: "ECS-SK", Token: "ECS-TOK" }) };
    }, () => awsCreds()),
  );
  assert.ok(calledUrl && calledUrl.includes("/v2/credentials/fake-ecs-role"), "must hit the ECS metadata endpoint");
  assert.deepEqual(creds, { ak: "ECS-AK", sk: "ECS-SK", st: "ECS-TOK" }, "ECS role creds must win over both env forms");
});

test("awsCreds(): plain AWS_ACCESS_KEY_ID/SECRET wins over OTC_AWS_* when both are present and no ECS role exists", async () => {
  const { awsCreds } = await import("../aws-secret.mjs");
  const creds = await withEnv(
    { ...NO_CREDS, AWS_ACCESS_KEY_ID: "AKIAREALENVKEY", AWS_SECRET_ACCESS_KEY: "real-env-secret",
      OTC_AWS_ACCESS_KEY_ID: "AKIAOTCSHOULDNOTWIN", OTC_AWS_SECRET_ACCESS_KEY: "otc-secret" },
    () => awsCreds(),
  );
  assert.deepEqual(creds, { ak: "AKIAREALENVKEY", sk: "real-env-secret", st: null });
});

test("awsCreds(): OTC_AWS_* is used ONLY when the standard AWS_* names are absent (or placeholder) -- the CRO-seat-fix path", async () => {
  const { awsCreds } = await import("../aws-secret.mjs");
  const creds = await withEnv(
    { ...NO_CREDS, OTC_AWS_ACCESS_KEY_ID: "AKIAOTCONLYKEY", OTC_AWS_SECRET_ACCESS_KEY: "otc-only-secret" },
    () => awsCreds(),
  );
  assert.deepEqual(creds, { ak: "AKIAOTCONLYKEY", sk: "otc-only-secret", st: null });
});

test("awsCreds(): a 'prox'-placeholder AWS_ACCESS_KEY_ID is skipped in favor of a real OTC_AWS_* value -- the exact reason OTC_AWS_* exists", async () => {
  const { awsCreds } = await import("../aws-secret.mjs");
  const creds = await withEnv(
    { ...NO_CREDS, AWS_ACCESS_KEY_ID: "proxABCDEFGHIJKLM", AWS_SECRET_ACCESS_KEY: "sandbox-placeholder-secret",
      OTC_AWS_ACCESS_KEY_ID: "AKIATHEREALONE", OTC_AWS_SECRET_ACCESS_KEY: "the-real-secret" },
    () => awsCreds(),
  );
  assert.deepEqual(creds, { ak: "AKIATHEREALONE", sk: "the-real-secret", st: null });
});

test("awsCreds(): a 'prox'-placeholder OTC_AWS_ACCESS_KEY_ID is ALSO rejected (the guard is not name-specific)", async () => {
  const { awsCreds } = await import("../aws-secret.mjs");
  const creds = await withEnv(
    { ...NO_CREDS, OTC_AWS_ACCESS_KEY_ID: "PROXPLACEHOLDERISH", OTC_AWS_SECRET_ACCESS_KEY: "whatever" },
    () => awsCreds(),
  );
  assert.equal(creds, null, "a prox-prefixed OTC_AWS_ACCESS_KEY_ID must not be accepted either, case-insensitively");
});

// ---- awsCredsPresent(): the cheap sync diagnostic must agree with the real (async) resolver --------
test("awsCredsPresent() reports .any=false with nothing set, and .otc=true / .any=true with only OTC_AWS_* set", async () => {
  await withEnv(NO_CREDS, () => { assert.deepEqual(awsCredsPresent(), { ecs: false, env: false, otc: false, any: false }); });
  await withEnv({ ...NO_CREDS, OTC_AWS_ACCESS_KEY_ID: "AKIAX", OTC_AWS_SECRET_ACCESS_KEY: "y" }, () => {
    const r = awsCredsPresent();
    assert.equal(r.otc, true); assert.equal(r.any, true); assert.equal(r.ecs, false); assert.equal(r.env, false);
  });
});

// ---- counterfactual source-order guard: pins the LITERAL order in awsCreds() so a future edit that ---
// ---- silently reorders the checks (e.g. re-introducing an Azure-first lookup, or checking OTC_AWS_* --
// ---- before the plain AWS_ names) is caught even if some specific behavioral combination above is ---
// ---- accidentally left untested. Comments stripped first, mirroring s3-blob-write-path.test.mjs's ---
// ---- own stripComments() convention for the identical purpose. ---------------------------------------
function stripComments(src) { return src.replace(/^\s*\/\/.*$/gm, ""); }
test("aws-secret.mjs's awsCreds() checks paths in the documented order: ECS role, then AWS_*, then OTC_AWS_* -- never Azure", async () => {
  const raw = await readFile(join(HERE, "..", "aws-secret.mjs"), "utf8");
  const src = stripComments(raw);
  const start = src.indexOf("export async function awsCreds()");
  assert.ok(start > -1, "awsCreds must exist and be exported");
  const body = src.slice(start, src.indexOf("\nexport async function ssmCall", start) > -1 ? src.indexOf("\nexport async function ssmCall", start) : src.indexOf("\nasync function ssmCall", start));
  const iEcs = body.indexOf("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI");
  const iEnv = body.indexOf("process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY");
  const iOtc = body.indexOf("OTC_AWS_ACCESS_KEY_ID");
  assert.ok(iEcs > -1 && iEnv > -1 && iOtc > -1, "all three checks must be present in awsCreds()'s body");
  assert.ok(iEcs < iEnv, "the ECS container-credentials check must come before the plain AWS_* check");
  assert.ok(iEnv < iOtc, "the plain AWS_* check must come before the OTC_AWS_* fallback");
  assert.doesNotMatch(body, /vault\.azure\.net|AZURE_SP_|kvSecret/i, "awsCreds() must never gain an Azure dependency of its own");
});

// ---- mem.mjs DIRECT CLI: fail-loud + durable local fallback (spawn-based, real end-to-end proof) ---
function spawnMem(args, { cacheDir, env: extraEnv = {} } = {}) {
  const env = {
    ...process.env,
    ...NO_CREDS,
    AZURE_SP_CLIENT_ID: undefined, AZURE_SP_CLIENT_SECRET: undefined, AZURE_SP_TENANT_ID: undefined,
    IDENTITY_ENDPOINT: undefined, IDENTITY_HEADER: undefined,
    GCP_CLAUDE_DRIVER_SA_JSON: undefined,
    // Silence the Azure CLI's telemetry uploader. mem.mjs's credential chain tries `az account
    // get-access-token` (azure-secret.mjs azCliToken) as one of its four auth paths, and on a FRESH
    // $HOME the real Azure CLI both creates $HOME/.azure and spawns a DETACHED python uploader that
    // keeps writing into it after the az process itself has exited. That async writer raced
    // withTempCache()'s teardown, which is why CI failed with ENOTEMPTY on rmdir '<tmp>/.azure'.
    // TWO pieces of evidence from run 32175770849, not inference: the rmdir error names .azure
    // specifically, and the job's own cleanup reports orphaned `python3` processes still alive at
    // job end (the real az CLI is Python).
    //
    // WHY IT NEVER REPRODUCES IN THE CLOUD SANDBOX, which cost real debugging time and is worth
    // recording: `which az` there resolves, so "az is missing" is NOT the explanation. It resolves
    // to a hand-written BASH SHIM at /usr/local/bin/az that only fakes `az account show` and exits
    // 1 for everything else. A shim creates no ~/.azure and forks no uploader, so the race is
    // structurally impossible locally and structurally likely on GitHub's ubuntu-latest, which
    // ships the genuine CLI. Do not "fix" a future flake here by trusting a green local run.
    AZURE_CORE_COLLECT_TELEMETRY: "0",
    ...extraEnv,
  };
  // Actually strip the `undefined` markers -- spawnSync's `env` object does not support deleting a
  // key by setting it to undefined the way process.env assignment does; a present key with value
  // "undefined" (the string) is NOT the same as an absent one, and several of these guards check
  // presence via `-n`/truthiness, so a stray literal "undefined" string would be misread as "set".
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return spawnSync(process.execPath, [MEM_MJS, ...args, "--cache-dir", cacheDir], { encoding: "utf8", env, timeout: 30_000 });
}
async function withTempCache(run) {
  const dir = await mkdtemp(join(tmpdir(), "mem-credboot-test-"));
  // `force: true` only swallows ENOENT -- it does NOT help when a directory is repopulated mid-walk.
  // maxRetries/retryDelay are the documented remedy for exactly the EBUSY/ENOTEMPTY/EPERM class this
  // hit (a detached process still writing into the tree being removed). Cheap insurance: on the
  // normal path the first attempt succeeds and neither option costs anything.
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}
const fallbackFile = (cacheDir, agent) => join(cacheDir, `_failed_writes-${agent}.jsonl`);

test("mem.mjs status: with zero resolvable credentials, exits non-zero with a NAMED AWS-credential error (not a bare 'Command failed')", async () => {
  await withTempCache(async (cacheDir) => {
    const r = spawnMem(["status", "a real checkpoint that must not be lost", "--agent", "zzz-test-status"], { cacheDir });
    assert.notEqual(r.status, 0, "must fail (no credentials can possibly succeed here)");
    assert.match(r.stderr, /ERROR:.*AWS credentials unavailable/, "the failure must name the actual cause, not a generic error");
    assert.match(r.stderr, /OTC_AWS_ACCESS_KEY_ID/, "the failure must name the specific env var that would fix it");
  });
});

test("mem.mjs status: the SAME failure saves the lost content to the durable local fallback file, not just to stderr", async () => {
  await withTempCache(async (cacheDir) => {
    const text = "smoke-test checkpoint content that proves nothing is lost";
    const r = spawnMem(["status", text, "--agent", "zzz-test-status"], { cacheDir });
    assert.notEqual(r.status, 0);
    const file = fallbackFile(cacheDir, "zzz-test-status");
    assert.ok(existsSync(file), `fallback file must exist at ${file}`);
    const rows = (await readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].agent, "zzz-test-status");
    assert.equal(rows[0].type, "status");
    assert.equal(rows[0].text, text, "the FULL original text must be recoverable byte-for-byte");
    assert.equal(rows[0].share, true, "status is always share:true, and that must survive into the fallback row too");
    assert.equal(rows[0].source, "mem.mjs", "attributed to the direct-CLI path, distinct from reflect.mjs's own fallback rows");
    assert.match(rows[0].error, /AWS credentials unavailable/);
    assert.ok(rows[0].ts, "must carry a timestamp for a recovery pass to order by");
    assert.ok(r.stderr.includes(file), "stderr must print the fallback file's path so a human knows where to look");
    assert.match(r.stderr, /NOT LOST/i);
  });
});

test("mem.mjs remember/decision/pitfall/correct all reach the same fallback net, not just status", async () => {
  await withTempCache(async (cacheDir) => {
    const cases = [
      { args: ["remember", "a fact that must survive", "--agent", "zzz-test-multi"], type: "remember" },
      { args: ["decision", "a decision that must survive", "--agent", "zzz-test-multi"], type: "decision" },
      { args: ["pitfall", "a pitfall that must survive", "--agent", "zzz-test-multi"], type: "pitfall" },
      { args: ["correct", "the corrected fact", "--agent", "zzz-test-multi", "--was", "the wrong prior belief"], type: "correct" },
    ];
    for (const c of cases) {
      const r = spawnMem(c.args, { cacheDir });
      assert.notEqual(r.status, 0, `${c.type} must fail with no credentials`);
    }
    const rows = (await readFile(fallbackFile(cacheDir, "zzz-test-multi"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rows.length, cases.length, "every one of the 4 failed writes must be preserved, none dropped");
    assert.deepEqual(rows.map((r) => r.type), cases.map((c) => c.type));
    const correctRow = rows.find((r) => r.type === "correct");
    assert.equal(correctRow.was, "the wrong prior belief", "the --was context must ride along, not just the bare text");
  });
});

test("mem.mjs whoami (a READ-only diagnostic verb): failing with no credentials does NOT write a fallback file -- there is no content to lose", async () => {
  await withTempCache(async (cacheDir) => {
    spawnMem(["whoami", "--agent", "zzz-test-readonly"], { cacheDir });
    assert.equal(existsSync(fallbackFile(cacheDir, "zzz-test-readonly")), false, "a read-only verb must never create a fallback entry");
  });
});

test("mem.mjs status: multiple failures for the SAME agent APPEND to the fallback file (never overwrite), mirroring reflect.mjs's own guarantee", async () => {
  await withTempCache(async (cacheDir) => {
    spawnMem(["status", "first lost checkpoint", "--agent", "zzz-test-append"], { cacheDir });
    spawnMem(["status", "second lost checkpoint", "--agent", "zzz-test-append"], { cacheDir });
    const rows = (await readFile(fallbackFile(cacheDir, "zzz-test-append"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].text, "first lost checkpoint");
    assert.equal(rows[1].text, "second lost checkpoint");
  });
});

test("mem.mjs: a plain USAGE error (no text supplied) exits non-zero but does NOT spuriously create a fallback file -- there is nothing lost, only a typo", async () => {
  await withTempCache(async (cacheDir) => {
    const r = spawnMem(["status", "--agent", "zzz-test-usage"], { cacheDir }); // no text at all
    assert.notEqual(r.status, 0);
    assert.equal(existsSync(fallbackFile(cacheDir, "zzz-test-usage")), false, "a usage error must not be confused with a lost write");
  });
});

// ---- counterfactual guard: pins the WIRING itself, not just the observed behavior, so a refactor that -
// ---- silently drops the appendFailedWriteFallback() call (while somehow keeping the tests above green -
// ---- by accident) cannot happen unnoticed. -----------------------------------------------------------
test("mem.mjs's top-level catch is wired to appendFailedWriteFallback for the direct-CLI write verbs", async () => {
  const src = await readFile(join(HERE, "..", "mem.mjs"), "utf8");
  assert.match(src, /import \{ FAILED_WRITE_FILE, appendFailedWriteFallback \} from "\.\/local-fallback\.mjs";/);
  const catchStart = src.indexOf("})().catch((e) => {");
  assert.ok(catchStart > -1, "the top-level IIFE catch must exist");
  const tail = src.slice(catchStart);
  // The persisted error is `safeMessage` (redactSecrets(e.message)), NOT the raw message. These rows
  // are replayed into the ledger by a recovery pass and a row can be share:true, so a credential in
  // an error string would become durable cross-lane content. Pinning BOTH directions -- redacted is
  // passed, raw is not -- is what keeps a future refactor from quietly reverting it.
  assert.match(tail, /appendFailedWriteFallback\(AGENT, item, safeMessage, "mem\.mjs", \{ cacheDir: CACHE_DIR \}\)/);
  assert.match(tail, /const safeMessage = redactSecrets\(e\.message\)/, "the redaction must happen inside this catch");
  assert.doesNotMatch(tail, /appendFailedWriteFallback\([^)]*e\.message/, "the RAW message must never be what gets persisted");
  assert.match(tail, /WRITE_VERBS = new Set\(\["remember", "fact", "decision", "pitfall", "status", "correct"\]\)/);
});
