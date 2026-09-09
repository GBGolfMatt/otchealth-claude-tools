// Direct unit tests for local-fallback.mjs (extracted 2026-08-18 from reflect.mjs so mem.mjs's own
// direct CLI writes can share the identical durable-fallback safety net; see that file's header).
// reflect-loud-failure.test.mjs already covers the ORIGINAL behavior end to end via reflect.mjs's
// re-export; these cover the module directly plus the two fields added for mem.mjs's use (`was`,
// `on`) that reflect.mjs itself never sets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAILED_WRITE_FILE, appendFailedWriteFallback } from "../local-fallback.mjs";

async function withTempCache(run) {
  const cacheDir = await mkdtemp(join(tmpdir(), "local-fallback-test-"));
  try { return await run(cacheDir); } finally { await rm(cacheDir, { recursive: true, force: true }); }
}

test("appendFailedWriteFallback: default source stays 'reflect.mjs' when the caller passes no 4th argument (backward compat)", async () => {
  await withTempCache(async (cacheDir) => {
    appendFailedWriteFallback("agent-default-source", { type: "pitfall", text: "x" }, "err", undefined, { cacheDir });
    const [row] = (await readFile(FAILED_WRITE_FILE("agent-default-source", cacheDir), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(row.source, "reflect.mjs");
  });
});

test("appendFailedWriteFallback: an explicit source (e.g. 'mem.mjs') overrides the default", async () => {
  await withTempCache(async (cacheDir) => {
    appendFailedWriteFallback("agent-explicit-source", { type: "status", text: "x", share: true }, "err", "mem.mjs", { cacheDir });
    const [row] = (await readFile(FAILED_WRITE_FILE("agent-explicit-source", cacheDir), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(row.source, "mem.mjs");
    assert.equal(row.share, true);
  });
});

test("appendFailedWriteFallback: `was` and `on` are ADDITIVE -- present only when the caller supplies them", async () => {
  await withTempCache(async (cacheDir) => {
    appendFailedWriteFallback("agent-plain", { type: "remember", text: "no extras" }, "err", "mem.mjs", { cacheDir });
    appendFailedWriteFallback("agent-plain", { type: "correct", text: "the right fact", was: "the wrong prior belief" }, "err", "mem.mjs", { cacheDir });
    appendFailedWriteFallback("agent-plain", { type: "remember", text: "cross-lane note", on: "clo" }, "err", "mem.mjs", { cacheDir });
    const rows = (await readFile(FAILED_WRITE_FILE("agent-plain", cacheDir), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rows.length, 3);
    assert.equal("was" in rows[0], false, "a plain remember must not gain a spurious was field");
    assert.equal("on" in rows[0], false);
    assert.equal(rows[1].was, "the wrong prior belief");
    assert.equal("on" in rows[1], false);
    assert.equal(rows[2].on, "clo");
    assert.equal("was" in rows[2], false);
  });
});

test("appendFailedWriteFallback: a falsy `was`/`on` (empty string, absent) is never written as an empty field", async () => {
  await withTempCache(async (cacheDir) => {
    appendFailedWriteFallback("agent-falsy", { type: "remember", text: "x", was: "", on: "" }, "err", "mem.mjs", { cacheDir });
    const [row] = (await readFile(FAILED_WRITE_FILE("agent-falsy", cacheDir), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal("was" in row, false);
    assert.equal("on" in row, false);
  });
});

test("FAILED_WRITE_FILE: unknown/empty agent stays within an explicit cache path", async () => {
  await withTempCache(async (cacheDir) => {
    assert.equal(FAILED_WRITE_FILE("", cacheDir), join(cacheDir, "_failed_writes-unknown.jsonl"));
    assert.equal(FAILED_WRITE_FILE(undefined, cacheDir), join(cacheDir, "_failed_writes-unknown.jsonl"));
  });
});