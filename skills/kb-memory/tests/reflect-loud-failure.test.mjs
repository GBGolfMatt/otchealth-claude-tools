// Tests for reflect.mjs's fail-loud + durable-local-fallback behavior.
//
// Two SEPARATE failure classes live in this one file, and this test file now covers both:
//
// (1) 2026-08-18: a mem.mjs COMMIT-write failure (during --commit) used to vanish silently.
//     reflect.mjs is Stop-hook-friendly and always resolves to exit 0 for THIS failure class by
//     design (a best-effort memory distiller must never block a session ending over a write it
//     could not make). Before the fix, mem.mjs's own stderr was thrown away (`stdio: "ignore"`),
//     the catch logged one generic line, and on the "stop" hook path even that line is piped to
//     /dev/null by kb-inject.sh's own invocations of this script. So a session could end clean
//     while every distilled lesson silently vanished. These tests pin the fix at the unit level
//     (the fallback file itself); end-to-end proof (a forced Azure write failure producing the
//     loud banner + a populated fallback file, then a clean run with no failure once
//     BLOB_BACKEND=s3 succeeded) is in that PR's description, captured from a real run rather
//     than simulated here.
//
// (2) 2026-08-28: the LLM STEP ITSELF failing (missing/invalid credentials, an unreachable
//     provider, a malformed response) used to be INDISTINGUISHABLE from "the model ran and found
//     no lessons" -- both printed the same "reflect: no new durable lessons." and exited 0. This
//     is a DIFFERENT failure class from (1): it is about the reflection never happening at all,
//     not about a real lesson failing to persist. reflect.mjs now surfaces it via a distinct
//     stderr message and a NON-ZERO exit (see distill()'s own header comment in reflect.mjs for
//     the exact contract). Tested below via distill() directly, with an injected chatFn -- the
//     same dependency-injection convention this skill's nightly-reflection.mjs test file already
//     uses for its own distillAgent() -- so no test here ever touches a network call, a real
//     OpenAI/Azure credential, or a real mem.mjs write.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAILED_WRITE_FILE, appendFailedWriteFallback, distill, LLM_PROVIDER } from "../reflect.mjs";

// Pass the cache path through the fallback API explicitly. HOME overrides do not affect
// os.homedir() consistently on Windows and can send fixtures into the operator's normal cache.
async function withTempCache(run) {
  const cacheDir = await mkdtemp(join(tmpdir(), "reflect-fallback-test-"));
  try { return await run(cacheDir); } finally { await rm(cacheDir, { recursive: true, force: true }); }
}

test("a failed lesson is appended to a per-agent fallback file, not dropped", async () => {
  await withTempCache(async (cacheDir) => {
    const agent = "test-agent-alpha";
    assert.equal(existsSync(FAILED_WRITE_FILE(agent, cacheDir)), false, "must not exist before any failure");
    appendFailedWriteFallback(agent, { type: "pitfall", text: "example lost lesson", share: false }, "ERROR: put 403 AuthorizationPermissionMismatch", undefined, { cacheDir });
    assert.equal(existsSync(FAILED_WRITE_FILE(agent, cacheDir)), true);
    const rows = (await readFile(FAILED_WRITE_FILE(agent, cacheDir), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].agent, agent);
    assert.equal(rows[0].type, "pitfall");
    assert.equal(rows[0].text, "example lost lesson");
    assert.equal(rows[0].share, false);
    assert.match(rows[0].error, /403/, "the real underlying error must be preserved, not summarized away");
    assert.equal(rows[0].source, "reflect.mjs");
    assert.ok(rows[0].ts, "must carry a timestamp so a recovery pass can order lost writes");
  });
});

test("multiple failures for the SAME agent append (never overwrite) so nothing already-lost gets lost again", async () => {
  await withTempCache(async (cacheDir) => {
    const agent = "test-agent-beta";
    appendFailedWriteFallback(agent, { type: "remember", text: "first lost fact" }, "err1", undefined, { cacheDir });
    appendFailedWriteFallback(agent, { type: "decision", text: "second lost fact", share: true }, "err2", undefined, { cacheDir });
    const rows = (await readFile(FAILED_WRITE_FILE(agent, cacheDir), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].text, "first lost fact");
    assert.equal(rows[1].text, "second lost fact");
    assert.equal(rows[1].share, true);
  });
});

test("different agents get different fallback files (no cross-agent clobber, mirrors the real per-agent shared feed)", async () => {
  await withTempCache(async (cacheDir) => {
    appendFailedWriteFallback("agent-one", { type: "remember", text: "x" }, "e", undefined, { cacheDir });
    appendFailedWriteFallback("agent-two", { type: "remember", text: "y" }, "e", undefined, { cacheDir });
    assert.notEqual(FAILED_WRITE_FILE("agent-one", cacheDir), FAILED_WRITE_FILE("agent-two", cacheDir));
    assert.ok(existsSync(FAILED_WRITE_FILE("agent-one", cacheDir)));
    assert.ok(existsSync(FAILED_WRITE_FILE("agent-two", cacheDir)));
    const one = (await readFile(FAILED_WRITE_FILE("agent-one", cacheDir), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(one.length, 1, "agent-one's file must not contain agent-two's entry");
  });
});

// ---- counterfactual guard: the shipped commit loop must capture real stderr and never go back to
// silently discarding it, and must still exit 0 unconditionally (the Stop-hook contract). ----------
test("reflect.mjs's per-item commit no longer discards the child's stderr via stdio:\"ignore\"", async () => {
  const src = (await readFile(new URL("../reflect.mjs", import.meta.url), "utf8")).replace(/^\s*\/\/.*$/gm, "");
  const start = src.indexOf("async function main()");
  assert.ok(start > -1);
  const body = src.slice(start);
  assert.doesNotMatch(body, /execFileSync\("node", a, \{ stdio: "ignore" \}\)/, "the per-item commit call must not silently discard stderr");
  assert.match(body, /stdio:\s*\[\s*"ignore",\s*"ignore",\s*"pipe"\s*\]/, "stderr must be piped so a real failure's cause is captured");
  assert.match(body, /appendFailedWriteFallback\(/, "a failed commit must write to the durable local fallback");
  assert.match(body, /LOST WRITE/, "a failed commit must print an unmistakable, greppable banner");
});
// NARROWED (2026-08-28): this test previously asserted reflect.mjs "still exits 0 unconditionally".
// That is no longer literally true -- an LLM-step failure now exits non-zero on purpose (see the
// "FAIL LOUD (2)" tests below) -- so the blanket claim is corrected here to what remains true: every
// SKIP condition (no agent / no transcript / session below --min-tools) is unaffected by this port
// and still exits 0 with a LITERAL code, a truly uncaught error in main() still degrades to a
// graceful process.exit(0) rather than crashing the Stop hook, and a mem.mjs COMMIT-write failure
// (failure class (1) above) still resolves the run's exit code purely from whether the LLM step
// itself succeeded -- it never turns a real LLM failure into a false "success" or vice versa.
test("reflect.mjs's skip-conditions and the uncaught-error fallback still exit 0 with a LITERAL code (unaffected by the LLM fail-loud port)", async () => {
  const src = await readFile(new URL("../reflect.mjs", import.meta.url), "utf8");
  // Every LITERAL-digit `process.exit(N)` anywhere in the file (the pre-LLM skip conditions: no
  // agent / no transcript / condense failure / below --min-tools, plus the outer uncaught-error
  // catch) must still read 0. The two NEW llmError-conditional exits added by the 2026-08-28 port
  // are ternary expressions (`process.exit(llmError ? 1 : 0)`), which this digit-only regex does
  // not match at all -- so their presence elsewhere in the file cannot hide a regression here, and
  // this assertion needs no fragile "where does main() end" boundary to stay correct.
  const literalExits = [...src.matchAll(/process\.exit\((\d+)\)/g)];
  assert.ok(literalExits.length >= 5, "expected the 4 pre-LLM skip-condition exits plus the outer catch's exit");
  for (const m of literalExits) assert.equal(m[1], "0", "every remaining LITERAL exit code must still be 0");
  assert.match(src, /main\(\)\.catch\(\(e\) => \{ console\.error\("reflect ERROR: " \+ e\.message\); process\.exit\(0\); \}\);/, "an uncaught error in main() must still exit 0, not crash the Stop hook");
});

// ---- FAIL LOUD (2): the LLM step itself failing must never look like "no lessons" (2026-08-28) ----
// Ground rule for every test below: distill() takes an INJECTED chatFn (mirroring
// nightly-reflection.mjs's own distillAgent({ ask }) convention in this same skill), so none of
// these ever touch fetch, kvSecret, a real credential, or a real mem.mjs write.

test("LLM_PROVIDER defaults to openai (the 2026-08-28 port; Azure Foundry is opt-in only now)", () => {
  assert.equal(LLM_PROVIDER, "openai");
});

test("distill(): a successful chatFn call extracts real lessons with llmError null", async () => {
  let seenSystem = "", seenUser = "";
  const chatFn = async (system, user) => {
    seenSystem = system; seenUser = user;
    return JSON.stringify([
      { type: "pitfall", text: "Azure Foundry returns HTTP 401 forever; call OpenAI direct instead.", share: true },
      { type: "bogus", text: "must be dropped, not a real type" },
    ]);
  };
  const { items, llmError } = await distill({ agent: "cto", toolCount: 15, body: "ASSISTANT: shipped it", known: "", chatFn });
  assert.equal(llmError, null, "a successful call must report no error");
  assert.equal(items.length, 1, "the malformed-type item must be filtered out, only the real one kept");
  assert.equal(items[0].type, "pitfall");
  assert.equal(items[0].share, true);
  assert.match(seenSystem, /agent "cto"/);
  assert.match(seenUser, /15 tool calls/);
});

test("distill(): a legitimate empty result ([]) is NOT an error -- llmError stays null", async () => {
  const { items, llmError } = await distill({ agent: "cto", body: "ASSISTANT: nothing durable here", chatFn: async () => "[]" });
  assert.equal(llmError, null, "the model genuinely running and finding nothing must never be reported as a failure");
  assert.deepEqual(items, []);
});

test("distill(): a misconfigured (no-key) provider sets a DISTINCT llmError and never calls chatFn", async () => {
  let called = false;
  const { items, llmError } = await distill({
    agent: "cto", body: "no durable-looking sentences here", chatFn: async () => { called = true; return "[]"; },
    modelConfigured: false, provider: "openai",
  });
  assert.equal(called, false, "a misconfigured provider must fail before ever attempting the call");
  assert.ok(llmError instanceof Error);
  assert.match(llmError.message, /openai-api-key/i);
  assert.deepEqual(items, [], "the fallback salvage found nothing in this body, so items stays empty -- but llmError is still set");
});

test("distill(): the Foundry-provider misconfigured message names the Foundry secrets, not OpenAI's", async () => {
  const { llmError } = await distill({ agent: "cto", body: "", chatFn: async () => "[]", modelConfigured: false, provider: "foundry" });
  assert.match(llmError.message, /azure-foundry/i);
  assert.doesNotMatch(llmError.message, /openai-api-key/i);
});

test("distill(): a thrown/unreachable chatFn sets llmError AND still runs the deterministic salvage belt", async () => {
  const body = "ASSISTANT: we merged to main and it is SHIPPED, CFBundleVersion 44 is now live.\nASSISTANT: unrelated short chatter.";
  const { items, llmError } = await distill({ agent: "cto", body, chatFn: async () => { throw new Error("fetch failed: getaddrinfo ENOTFOUND api.openai.com"); } });
  assert.ok(llmError instanceof Error, "an unreachable provider must set llmError, not silently return []");
  assert.match(llmError.message, /ENOTFOUND|getaddrinfo/, "the real underlying error must be preserved, not summarized away");
  assert.ok(items.length >= 1, "the deterministic fallback should salvage the SHIPPED/CFBundleVersion sentence");
  assert.ok(items.every((it) => it._fallback === true), "salvaged items must be tagged _fallback so mem.mjs/tests can tell them apart from a real LLM answer");
});

test("distill(): a thrown chatFn with NOTHING salvageable in the body still sets llmError with items=[] (never silently 'no lessons')", async () => {
  const { items, llmError } = await distill({ agent: "cto", body: "USER: hi\nASSISTANT: ok", chatFn: async () => { throw new Error("401 Unauthorized"); } });
  assert.ok(llmError instanceof Error);
  assert.deepEqual(items, [], "no SIG-matching sentence in this body, so the salvage legitimately finds nothing");
});

test("distill(): a non-JSON / non-array response is treated as an LLM failure, not a parse-shaped empty result", async () => {
  const nonJson = await distill({ agent: "cto", body: "", chatFn: async () => "Sorry, I cannot help with that." });
  assert.ok(nonJson.llmError instanceof Error, "prose with no JSON array must be a reported failure");

  const notAnArray = await distill({ agent: "cto", body: "", chatFn: async () => JSON.stringify({ type: "pitfall", text: "x" }) });
  assert.ok(notAnArray.llmError instanceof Error, "a bare JSON object (not wrapped in []) must also be a reported failure");
});

test("main()'s wiring: LLM failure and unconfirmed state sync both exit non-zero without changing skip exits", async () => {
  const src = await readFile(new URL("../reflect.mjs", import.meta.url), "utf8");
  assert.match(src, /LLM call FAILED \(provider=\$\{LLM_PROVIDER\}\)/, "the stderr message must name the failure and the active provider");
  assert.match(src, /NOT the same as 'no lessons'/, "the message must explicitly disclaim the legitimate-empty outcome");
  assert.match(src, /process\.exit\(llmError \? 1 : 0\)/, "the early no-items exit must remain LLM-aware");
  assert.match(src, /stateSyncFailed = true/, "a failed state-sync must not look like completed reflection");
  assert.match(src, /process\.exit\(llmError \|\| stateSyncFailed \? 1 : 0\)/, "the final exit must expose unconfirmed state durability");
});
