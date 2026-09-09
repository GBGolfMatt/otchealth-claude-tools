import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  advanceOperation, completeOperation, operationIdentity, operationOutboxFile, releaseOperation, stageOperation,
} from "../operation-outbox.mjs";
import { commitKeyedMemoryWrite } from "../keyed-memory-write.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));

test("mem.mjs delegates keyed private and shared storage to the production coordinator", async () => {
  const source = await readFile(new URL("../mem.mjs", import.meta.url), "utf8");
  assert.match(source, /commitKeyedMemoryWrite\(\{/);
  assert.match(source, /read: \(signal\) => getTextMeta\(JSONL, signal\)/);
  assert.match(source, /putTextCond\(JSONL, body, "application\/x-ndjson", etag, signal\)/);
  assert.match(source, /sharedStore: wantsShared/);
});

test("outbox rejects unsafe retry keys before writing", () => {
  assert.throws(() => stageOperation({
    agent: "cto", callerLane: "cto", targetLane: "cto", idempotencyKey: "bad key with spaces",
    intent: { text: "synthetic" }, wantsShared: true, home: tmpdir(),
  }), /safe characters/);
});

test("outbox is content-free, monotonic from disk, and clears only after durable stages", async () => {
  const home = await mkdtemp(join(tmpdir(), "memory-outbox-"));
  try {
    const staged = stageOperation({
      agent: "cto", callerLane: "cto", targetLane: "cto", idempotencyKey: "synthetic-key-001",
      intent: { text: "sensitive synthetic fixture content", type: "fact" }, wantsShared: true, home,
    });
    const raw = await readFile(staged._file, "utf8");
    assert.match(raw, /synthetic-key-001/);
    assert.doesNotMatch(raw, /sensitive synthetic fixture content/);
    assert.throws(() => completeOperation(staged), /before shared storage/);
    const privateStored = advanceOperation(staged, "private_stored", { private_entry_id: "private-original" });
    const staleAdvance = advanceOperation(staged, "staged");
    assert.equal(staleAdvance.stage, "private_stored");
    const sharedStored = advanceOperation(privateStored, "shared_stored", { shared_entry_id: "private-original" });
    completeOperation(sharedStored);
    assert.equal(existsSync(operationOutboxFile("cto", staged.operation_id, home)), false);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("an unkeyed pending operation reuses only its exact lane and intent, then releases that identity after completion", async () => {
  const home = await mkdtemp(join(tmpdir(), "memory-auto-outbox-"));
  const intent = { type: "fact", text: "synthetic unkeyed recovery", share: false };
  try {
    const explicit = stageOperation({ agent: "cto", callerLane: "cto", targetLane: "cto", idempotencyKey: "explicit-audit-key-001", intent, wantsShared: false, home });
    releaseOperation(explicit);
    const first = stageOperation({ agent: "cto", callerLane: "cto", targetLane: "cto", intent, wantsShared: false, home });
    assert.equal(first.auto_generated_key, true);
    assert.notEqual(first.idempotency_key, explicit.idempotency_key, "an unkeyed invocation must never replay an explicit operation key");
    releaseOperation(first);
    const replay = stageOperation({ agent: "cto", callerLane: "cto", targetLane: "cto", intent, wantsShared: false, home });
    assert.equal(replay.idempotency_key, first.idempotency_key, "an exact restart must retain the pending operation identity");
    releaseOperation(replay);
    const otherLane = stageOperation({ agent: "cto", callerLane: "cto", targetLane: "coo", intent, wantsShared: false, home });
    assert.notEqual(otherLane.idempotency_key, first.idempotency_key, "an operation cannot replay across target lanes");
    releaseOperation(otherLane);
    const otherIntent = stageOperation({ agent: "cto", callerLane: "cto", targetLane: "cto", intent: { ...intent, text: "different synthetic intent" }, wantsShared: false, home });
    assert.notEqual(otherIntent.idempotency_key, first.idempotency_key, "an operation cannot replay a different intent");
    releaseOperation(otherIntent);
    completeOperation(advanceOperation(stageOperation({ agent: "cto", callerLane: "cto", targetLane: "cto", intent, wantsShared: false, home }), "private_stored", { private_entry_id: "original" }));
    const later = stageOperation({ agent: "cto", callerLane: "cto", targetLane: "cto", intent, wantsShared: false, home });
    assert.notEqual(later.idempotency_key, first.idempotency_key, "a completed operation must not deduplicate a later intentional write");
    completeOperation(advanceOperation(later, "private_stored", { private_entry_id: "later" }));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("an unkeyed retry refuses malformed and filename-mismatched own-lane outbox records", async () => {
  const intent = { type: "fact", text: "synthetic corrupt recovery", share: false };
  const malformedHome = await mkdtemp(join(tmpdir(), "memory-malformed-outbox-"));
  const mismatchHome = await mkdtemp(join(tmpdir(), "memory-mismatched-outbox-"));
  const unreadableHome = await mkdtemp(join(tmpdir(), "memory-unreadable-outbox-"));
  try {
    const malformed = stageOperation({ agent: "cto", callerLane: "cto", targetLane: "cto", intent, wantsShared: false, home: malformedHome });
    releaseOperation(malformed);
    await writeFile(malformed._file, "{not-json\n");
    assert.throws(
      () => stageOperation({ agent: "cto", callerLane: "cto", targetLane: "cto", intent, wantsShared: false, home: malformedHome }),
      /outbox is unreadable or malformed.*refusing automatic retry/,
    );

    const mismatched = stageOperation({ agent: "cto", callerLane: "cto", targetLane: "cto", intent, wantsShared: false, home: mismatchHome });
    releaseOperation(mismatched);
    await rename(mismatched._file, join(dirname(mismatched._file), "f".repeat(64) + ".json"));
    assert.throws(
      () => stageOperation({ agent: "cto", callerLane: "cto", targetLane: "cto", intent, wantsShared: false, home: mismatchHome }),
      /outbox has an invalid identity.*refusing automatic retry/,
    );

    const unreadable = stageOperation({ agent: "cto", callerLane: "cto", targetLane: "cto", intent, wantsShared: false, home: unreadableHome });
    releaseOperation(unreadable);
    await rm(unreadable._file, { force: true });
    await mkdir(unreadable._file);
    assert.throws(
      () => stageOperation({ agent: "cto", callerLane: "cto", targetLane: "cto", intent, wantsShared: false, home: unreadableHome }),
      /outbox is unreadable or malformed.*refusing automatic retry/,
    );
  } finally {
    await rm(malformedHome, { recursive: true, force: true });
    await rm(mismatchHome, { recursive: true, force: true });
    await rm(unreadableHome, { recursive: true, force: true });
  }
});

test("an explicit key cannot be replayed with a different intent", async () => {
  const home = await mkdtemp(join(tmpdir(), "memory-explicit-conflict-"));
  try {
    const first = stageOperation({
      agent: "cto", callerLane: "cto", targetLane: "cto", idempotencyKey: "intent-conflict-001",
      intent: { type: "fact", text: "first synthetic intent" }, wantsShared: false, home,
    });
    releaseOperation(first);
    assert.throws(() => stageOperation({
      agent: "cto", callerLane: "cto", targetLane: "cto", idempotencyKey: "intent-conflict-001",
      intent: { type: "fact", text: "changed synthetic intent" }, wantsShared: false, home,
    }), /intent differs/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("an explicit-key replay rejects a corrupt outbox record even when its user intent fields match", async () => {
  const home = await mkdtemp(join(tmpdir(), "memory-explicit-corrupt-"));
  const intent = { type: "fact", text: "synthetic explicit corruption", share: false };
  try {
    const first = stageOperation({
      agent: "cto", callerLane: "cto", targetLane: "cto", idempotencyKey: "explicit-corrupt-key-001", intent, wantsShared: false, home,
    });
    releaseOperation(first);
    const corrupt = JSON.parse(await readFile(first._file, "utf8"));
    corrupt.operation_id = "different-safe-operation-id";
    await writeFile(first._file, JSON.stringify(corrupt) + "\n");
    assert.throws(
      () => stageOperation({
        agent: "cto", callerLane: "cto", targetLane: "cto", idempotencyKey: "explicit-corrupt-key-001", intent, wantsShared: false, home,
      }),
      /outbox record is malformed or differs/,
    );
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("an active operation lock rejects a competing process for the same scoped key", async () => {
  const home = await mkdtemp(join(tmpdir(), "memory-lock-"));
  const runner = join(home, "contender.mjs");
  const outboxUrl = new URL("../operation-outbox.mjs", import.meta.url).href;
  const operation = stageOperation({
    agent: "cto", callerLane: "cto", targetLane: "cto", idempotencyKey: "concurrent-key-001",
    intent: { type: "fact", text: "synthetic lock fixture" }, wantsShared: false, home,
  });
  await writeFile(runner, String.raw`
const { stageOperation } = await import(process.argv[2]);
try {
  stageOperation({ agent: "cto", callerLane: "cto", targetLane: "cto", idempotencyKey: "concurrent-key-001", intent: { type: "fact", text: "synthetic lock fixture" }, wantsShared: false, home: process.argv[3] });
  process.exit(2);
} catch (error) {
  if (!String(error.message).includes("already active")) { console.error(error); process.exit(3); }
}
`);
  try {
    const contender = spawnSync(process.execPath, [runner, outboxUrl, home], { encoding: "utf8", timeout: 5000 });
    assert.equal(contender.status, 0, contender.stderr);
    completeOperation(advanceOperation(operation, "private_stored", { private_entry_id: "private-original" }));
  } finally { await rm(home, { recursive: true, force: true }); }
});
test("fresh process retries the real coordinator after a lost shared response without duplicate private rows", async () => {
  const home = await mkdtemp(join(tmpdir(), "memory-production-retry-"));
  const runner = join(home, "runner.mjs");
  const coordinatorUrl = new URL("../keyed-memory-write.mjs", import.meta.url).href;
  const runnerBody = String.raw`
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const { commitKeyedMemoryWrite } = await import(process.argv[2]);
const home = process.argv[3];
const first = process.argv[4] === "first";
function makeStore(name, loseResponse = false) {
  const file = join(home, name + ".jsonl");
  const meta = join(home, name + ".version");
  const version = () => existsSync(meta) ? Number(readFileSync(meta, "utf8")) : 0;
  return {
    async read(signal) {
      if (!(signal instanceof AbortSignal)) throw new Error(name + " read missing AbortSignal");
      if (signal.aborted) throw signal.reason;
      return { text: existsSync(file) ? readFileSync(file, "utf8") : null, etag: version() ? String(version()) : null };
    },
    async write(body, etag, signal) {
      if (!(signal instanceof AbortSignal)) throw new Error(name + " write missing AbortSignal");
      if (signal.aborted) throw signal.reason;
      const current = version();
      if ((etag ?? null) !== (current ? String(current) : null)) { const error = new Error("conflict"); error.status = 412; throw error; }
      writeFileSync(file, body);
      writeFileSync(meta, String(current + 1));
      if (loseResponse) await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  };
}
try {
  const result = await commitKeyedMemoryWrite({
    agent: "cto", callerLane: "cto", targetLane: "cto", idempotencyKey: "restart-key-001",
    intent: { type: "fact", text: "synthetic durable lesson", share: true }, wantsShared: true,
    buildEntry: () => ({ id: "private-original", ts: "2026-09-07T00:00:00.000Z", type: "fact", text: "synthetic durable lesson", tags: [], by: "cto" }),
    privateStore: makeStore("private"), sharedStore: makeStore("shared", first), outboxHome: home, deadlineMs: 180,
  });
  if (first) throw new Error("first process unexpectedly received shared acknowledgement");
  if (result.entry.id !== "private-original" || !result.shared) throw new Error("retry did not resolve original operation");
} catch (error) {
  if (!first || error?.durability !== "UNKNOWN" || error?.operation?.stage !== "shared_unknown") {
    console.error(error?.stack || error); process.exit(2);
  }
  process.exit(23);
}
`;
  await writeFile(runner, runnerBody);
  try {
    const first = spawnSync(process.execPath, [runner, coordinatorUrl, home, "first"], { encoding: "utf8", timeout: 5000 });
    assert.equal(first.status, 23, first.stderr);
    const outboxDir = join(home, ".claude", "kb-cache", "_write-outbox-cto");
    const [outboxName] = (await readdir(outboxDir)).filter((name) => name.endsWith(".json"));
    assert.ok(outboxName);
    assert.equal(JSON.parse(await readFile(join(outboxDir, outboxName), "utf8")).stage, "shared_unknown");
    const second = spawnSync(process.execPath, [runner, coordinatorUrl, home, "retry"], { encoding: "utf8", timeout: 5000 });
    assert.equal(second.status, 0, second.stderr);
    const privateRows = (await readFile(join(home, "private.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    const sharedRows = (await readFile(join(home, "shared.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(privateRows.length, 1);
    assert.equal(sharedRows.length, 1);
    assert.equal(privateRows[0].id, "private-original");
    assert.equal(sharedRows[0].id, "private-original");
    assert.deepEqual((await readdir(outboxDir)).filter((name) => name.endsWith(".json") || name.endsWith(".lock")), []);
  } finally { await rm(home, { recursive: true, force: true }); }
});
function waitForPath(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (existsSync(path)) return resolve();
      if (Date.now() >= deadline) return reject(new Error("timed out waiting for " + path));
      setTimeout(poll, 10);
    };
    poll();
  });
}

test("two processes that observed one dead owner cannot reclaim a later live lock", async () => {
  const home = await mkdtemp(join(tmpdir(), "memory-reclaim-race-"));
  const runner = fileURLToPath(new URL("./fixtures/outbox-reclaimer-runner.mjs", import.meta.url));
  const outboxUrl = new URL("../operation-outbox.mjs", import.meta.url).href;
  const operationId = operationIdentity("cto", "cto", "reclaim-race-key-001");
  const file = operationOutboxFile("cto", operationId, home);
  const lockDir = file + ".lock";
  await mkdir(lockDir, { recursive: true });
  await writeFile(join(lockDir, "owner.json"), JSON.stringify({
    pid: 2_147_483_647,
    token: "d".repeat(32),
    created_at: "2026-09-07T00:00:00.000Z",
  }));
  const children = ["a", "b"].map((label) => {
    const child = spawn(process.execPath, [runner, outboxUrl, home, label], { stdio: ["ignore", "pipe", "pipe"] });
    const done = new Promise((resolve) => {
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (code) => resolve({ code, stderr }));
    });
    return { child, done, label };
  });
  try {
    await Promise.all(children.map(({ label }) => waitForPath(join(home, "ready-" + label))));
    await writeFile(join(home, "release"), "");
    await Promise.all(children.map(({ label }) => waitForPath(join(home, "result-" + label + ".json"))));
    const results = await Promise.all(children.map(async ({ label }) => JSON.parse(
      await readFile(join(home, "result-" + label + ".json"), "utf8"),
    )));
    assert.equal(results.filter((result) => result.status === "acquired").length, 1);
    assert.equal(results.filter((result) => result.status === "blocked").length, 1);
    assert.match(results.find((result) => result.status === "blocked").reason, /active|reclamation/);
    const winner = results.find((result) => result.status === "acquired");
    const owner = JSON.parse(await readFile(join(lockDir, "owner.json"), "utf8"));
    assert.equal(owner.pid, winner.pid, "the winning live lock must still own the canonical lock path");
    await writeFile(join(home, "finish"), "");
    const exits = await Promise.all(children.map(({ done }) => done));
    assert.deepEqual(exits.map(({ code }) => code), [0, 0], exits.map(({ stderr }) => stderr).join("\n"));
    assert.equal(existsSync(lockDir), false);
  } finally {
    for (const { child } of children) if (child.exitCode === null) child.kill();
    await rm(home, { recursive: true, force: true });
  }
});

test("a fresh lock directory without an owner is not reclaimed during initialization", async () => {
  const home = await mkdtemp(join(tmpdir(), "memory-lock-initializing-"));
  const operationId = operationIdentity("cto", "cto", "initializing-key-001");
  const file = operationOutboxFile("cto", operationId, home);
  const lockDir = file + ".lock";
  try {
    await mkdir(lockDir, { recursive: true });
    assert.throws(() => stageOperation({
      agent: "cto",
      callerLane: "cto",
      targetLane: "cto",
      idempotencyKey: "initializing-key-001",
      intent: { type: "fact", text: "synthetic initializing fixture" },
      wantsShared: false,
      home,
    }), /missing or malformed; refusing automatic reclaim/);
    assert.equal(existsSync(lockDir), true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("advance validates the current on-disk lock token before replacing the record", async () => {
  const home = await mkdtemp(join(tmpdir(), "memory-lock-token-"));
  const operation = stageOperation({
    agent: "cto",
    callerLane: "cto",
    targetLane: "cto",
    idempotencyKey: "lock-token-key-001",
    intent: { type: "fact", text: "synthetic token fixture" },
    wantsShared: false,
    home,
  });
  try {
    await writeFile(operation._lock.ownerFile, JSON.stringify({ pid: process.pid, token: "0".repeat(32) }));
    assert.throws(
      () => advanceOperation(operation, "private_stored", { private_entry_id: "must-not-write" }),
      /ownership changed/,
    );
    assert.equal(JSON.parse(await readFile(operation._file, "utf8")).stage, "staged");
    await writeFile(operation._lock.ownerFile, JSON.stringify({
      pid: process.pid,
      token: operation._lock.token,
    }));
    completeOperation(advanceOperation(operation, "private_stored", { private_entry_id: "synthetic" }));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("same-process retry after an unknown shared write releases the live lock and does not duplicate rows", async () => {
  const home = await mkdtemp(join(tmpdir(), "memory-same-process-retry-"));
  function store(loseFirstWrite = false) {
    let text = null;
    let version = 0;
    let lose = loseFirstWrite;
    let writes = 0;
    return {
      get text() { return text; },
      get writes() { return writes; },
      async read(signal) {
        if (!(signal instanceof AbortSignal)) throw new Error("read missing AbortSignal");
        if (signal.aborted) throw signal.reason;
        return { text, etag: version ? String(version) : null };
      },
      async write(body, etag, signal) {
        if (!(signal instanceof AbortSignal)) throw new Error("write missing AbortSignal");
        if (signal.aborted) throw signal.reason;
        if ((etag ?? null) !== (version ? String(version) : null)) {
          const error = new Error("conflict");
          error.status = 412;
          throw error;
        }
        text = body;
        version += 1;
        writes += 1;
        if (lose) {
          lose = false;
          await new Promise((_resolve, reject) => signal.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true },
          ));
        }
      },
    };
  }
  const privateStore = store();
  const sharedStore = store(true);
  const options = {
    agent: "cto",
    callerLane: "cto",
    targetLane: "cto",
    idempotencyKey: "same-process-key-001",
    intent: { type: "fact", text: "synthetic same-process fixture", share: true },
    wantsShared: true,
    buildEntry: () => ({
      id: "private-original",
      ts: "2026-09-07T00:00:00.000Z",
      type: "fact",
      text: "synthetic same-process fixture",
      tags: [],
      by: "cto",
    }),
    privateStore,
    sharedStore,
    outboxHome: home,
    deadlineMs: 80,
  };
  try {
    await assert.rejects(
      commitKeyedMemoryWrite(options),
      (error) => error?.durability === "UNKNOWN" && error?.operation?.stage === "shared_unknown",
    );
    const result = await commitKeyedMemoryWrite(options);
    assert.equal(result.shared, true);
    assert.equal(result.entry.id, "private-original");
    assert.equal(privateStore.writes, 1);
    assert.equal(sharedStore.writes, 1);
    assert.equal(privateStore.text.trim().split("\n").length, 1);
    assert.equal(sharedStore.text.trim().split("\n").length, 1);
  } finally { await rm(home, { recursive: true, force: true }); }
});
test("a delayed initializer retains the ownerless lock and validates its physical token before returning", async () => {
  const home = await mkdtemp(join(tmpdir(), "memory-delayed-initializer-"));
  const runner = fileURLToPath(new URL("./fixtures/outbox-delayed-initializer-runner.mjs", import.meta.url));
  const outboxUrl = new URL("../operation-outbox.mjs", import.meta.url).href;
  const child = spawn(process.execPath, [runner, outboxUrl, home], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolve) => child.on("close", (code) => resolve(code)));
  const operationId = operationIdentity("cto", "cto", "delayed-initializer-key-001");
  const lockDir = operationOutboxFile("cto", operationId, home) + ".lock";
  try {
    await waitForPath(join(home, "initializer-ready"));
    assert.throws(() => stageOperation({
      agent: "cto",
      callerLane: "cto",
      targetLane: "cto",
      idempotencyKey: "delayed-initializer-key-001",
      intent: { type: "fact", text: "synthetic delayed initializer" },
      wantsShared: false,
      home,
    }), /missing or malformed; refusing automatic reclaim/);
    assert.equal(existsSync(lockDir), true, "the contender must not rename the initializer's directory");
    await writeFile(join(home, "initializer-release"), "");
    await waitForPath(join(home, "initializer-acquired"));
    const childPid = Number(await readFile(join(home, "initializer-acquired"), "utf8"));
    const owner = JSON.parse(await readFile(join(lockDir, "owner.json"), "utf8"));
    assert.equal(owner.pid, childPid, "stageOperation returned only after its physical owner was verified");
    await writeFile(join(home, "initializer-finish"), "");
    assert.equal(await done, 0, stderr);
    assert.equal(existsSync(lockDir), false);
  } finally {
    if (child.exitCode === null) child.kill();
    await rm(home, { recursive: true, force: true });
  }
});
