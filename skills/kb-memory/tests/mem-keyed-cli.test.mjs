import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { operationIdentity, operationIntentHash } from "../operation-outbox.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const MEM = join(HERE, "..", "mem.mjs");
const S3_HOST = "otchealth-brain-dr-55c84f6b.s3.us-east-1.amazonaws.com";

function preloadSource(storePath) {
  return `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const storePath = ${JSON.stringify(storePath)};
const load = () => existsSync(storePath) ? JSON.parse(readFileSync(storePath, "utf8")) : { objects: {} };
const save = (value) => writeFileSync(storePath, JSON.stringify(value));
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  const method = (options.method || "GET").toUpperCase();
  const key = url.hostname + url.pathname;
  const state = load();
  if (method === "POST") {
    return new Response(JSON.stringify({ Parameter: { Value: "dW5pdC1maXh0dXJlLWtleQ==" } }), { status: 200 });
  }
  if (method === "GET") {
    const shared = url.pathname.includes("/_MEMORY/_exec/");
    if (state.fail_shared_read && state.shared_put_accepted && shared) {
      return new Response("synthetic shared read refusal", { status: 418 });
    }
    if (state.fail_private_read && state.private_put_accepted && !shared && url.pathname.endsWith("/_MEMORY/cto.jsonl")) {
      return new Response("synthetic private read refusal", { status: 418 });
    }
    const stored = state.objects[key];
    if (!stored) return new Response("", { status: 404 });
    return new Response(stored.body, { status: 200, headers: { etag: stored.etag } });
  }
  if (method === "PUT") {
    const prior = state.objects[key];
    const conditional = options.headers?.["If-Match"] || options.headers?.["if-match"];
    if (conditional && (!prior || conditional !== prior.etag)) return new Response("conflict", { status: 412 });
    const etag = '\"v' + (prior ? Number(prior.version) + 1 : 1) + '\"';
    state.objects[key] = { body: String(options.body || ""), etag, version: prior ? Number(prior.version) + 1 : 1 };
    const shared = url.pathname.includes("/_MEMORY/_exec/");
    const privateLedger = !shared && url.pathname.endsWith("/_MEMORY/cto.jsonl");
    if (state.lose_shared_put && shared) state.shared_put_accepted = true;
    if (state.lose_private_put && privateLedger) state.private_put_accepted = true;
    save(state);
    if (state.lose_shared_put && shared) {
      throw new TypeError("synthetic response lost after accepted shared PUT");
    }
    if (state.lose_private_put && privateLedger) throw new TypeError("synthetic response lost after accepted private PUT");
    return new Response("", { status: 201, headers: { etag } });
  }
  throw new Error("unexpected synthetic method " + method);
};
`;
}

function runMem(args, initialStore = {}, prior = null) {
  const home = prior?.home || mkdtempSync(join(tmpdir(), "mem-keyed-cli-"));
  const cacheDir = join(home, "cache");
  const storePath = join(home, "store.json");
  const preload = join(home, "fetch-preload.mjs");
  const previous = existsSync(storePath) ? JSON.parse(readFileSync(storePath, "utf8")) : { objects: {} };
  writeFileSync(storePath, JSON.stringify({ ...previous, ...initialStore, objects: initialStore.objects || previous.objects }));
  writeFileSync(preload, preloadSource(storePath));
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, MEM, ...args, "--cache-dir", cacheDir], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      BLOB_BACKEND: "s3",
      KB_ACCOUNT: "otchealthcommons",
      KB_KEY: "dW5pdC1maXh0dXJlLWtleQ==",
      KB_COMMONS_ACCOUNT: "otchealthcommons",
      AWS_ACCESS_KEY_ID: "AKIAUNITTESTFAKE0000",
      AWS_SECRET_ACCESS_KEY: "unit-test-fake-secret-access-key-not-real",
      KB_DD_EMIT: "0",
      NODE_USE_ENV_PROXY: "",
    },
  });
  return { home, cacheDir, result, store: JSON.parse(readFileSync(storePath, "utf8")) };
}

function rows(store, host, path) {
  const stored = store.objects[host + path];
  return stored ? stored.body.trim().split("\n").filter(Boolean).map(JSON.parse) : [];
}

test("actual mem CLI keyed write reaches the coordinator and completes its private outbox operation", () => {
  const run = runMem([
    "remember", "synthetic keyed CLI record", "--agent", "cto", "--idempotency-key", "cli-keyed-write-001",
  ]);
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.doesNotMatch(run.result.stderr, /stageOperation is not defined/);
    const privateRows = rows(run.store, S3_HOST, "/otchealthcommons/company-journal/_MEMORY/cto.jsonl");
    assert.equal(privateRows.length, 1);
    assert.match(privateRows[0].write_intent, /^[a-f0-9]{64}$/);
    const outbox = join(run.cacheDir, "_write-outbox-cto");
    const retained = existsSync(outbox) ? readdirSync(outbox).filter((name) => name.endsWith(".json")) : [];
    assert.deepEqual(retained, [], "completed keyed write must not leave an outbox record");
  } finally {
    rmSync(run.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("actual non-keyed shared response loss resumes the original operation without duplicate rows", () => {
  const args = [
    "status", "synthetic shared response loss", "--agent", "cto",
  ];
  const run = runMem(args, { lose_shared_put: true, fail_shared_read: true });
  try {
    assert.equal(run.result.status, 1, run.result.stderr);
    assert.match(run.result.stderr, /SHARED DURABILITY UNKNOWN/);
    assert.match(run.result.stderr, /Do not issue a fresh replacement write/);
    assert.doesNotMatch(run.result.stderr, /Re-run this same command/);
    const [fallback] = readFileSync(join(run.cacheDir, "_failed_writes-cto.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(fallback.shared_durability, "UNKNOWN");
    assert.equal(fallback.reconciliation_lane, "shared");
    assert.match(fallback.reconciliation_entry_id, /^[A-Za-z0-9._:-]{1,200}$/);
    const outbox = join(run.cacheDir, "_write-outbox-cto");
    const [pending] = readdirSync(outbox).filter((name) => name.endsWith(".json"));
    const pendingRecord = JSON.parse(readFileSync(join(outbox, pending), "utf8"));
    assert.equal(pendingRecord.idempotency_key, fallback.idempotency_key);
    assert.equal(pendingRecord.intent_hash, operationIntentHash({ command: "status", text: "synthetic shared response loss", tags: [], source: "", was: "", supersedes: "", target: "cto", share: true }));
    assert.equal(pendingRecord.operation_id, operationIdentity("cto", "cto", pendingRecord.idempotency_key));
    const privateRows = rows(run.store, S3_HOST, "/otchealthcommons/company-journal/_MEMORY/cto.jsonl");
    const sharedRows = rows(run.store, S3_HOST, "/otchealthcommons/company-journal/_MEMORY/_exec/cto.jsonl");
    assert.equal(privateRows.length, 1);
    assert.equal(sharedRows.length, 1);
    assert.equal(fallback.reconciliation_entry_id, privateRows[0].id);
    assert.equal(fallback.reconciliation_entry_id, sharedRows[0].id);
    const replay = runMem(args, { lose_shared_put: false, fail_shared_read: false }, run);
    assert.equal(replay.result.status, 0, replay.result.stderr);
    assert.deepEqual(rows(replay.store, S3_HOST, "/otchealthcommons/company-journal/_MEMORY/cto.jsonl").map((row) => row.id), [fallback.reconciliation_entry_id]);
    assert.deepEqual(rows(replay.store, S3_HOST, "/otchealthcommons/company-journal/_MEMORY/_exec/cto.jsonl").map((row) => row.id), [fallback.reconciliation_entry_id]);
    assert.deepEqual(readdirSync(outbox).filter((name) => name.endsWith(".json") || name.endsWith(".lock")), [], "resolved recovery must clear its durable outbox record");
    const later = runMem(args, {}, replay);
    assert.equal(later.result.status, 0, later.result.stderr);
    assert.equal(rows(later.store, S3_HOST, "/otchealthcommons/company-journal/_MEMORY/cto.jsonl").length, 2, "a completed recovery must not consume a later intentional write");
  } finally {
    rmSync(run.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("actual non-keyed private response loss resumes the original private row without a replacement", () => {
  const args = ["remember", "synthetic private response loss", "--agent", "cto"];
  const run = runMem(args, { lose_private_put: true, fail_private_read: true });
  try {
    assert.equal(run.result.status, 1, run.result.stderr);
    assert.match(run.result.stderr, /PRIVATE DURABILITY UNKNOWN/);
    const [fallback] = readFileSync(join(run.cacheDir, "_failed_writes-cto.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(fallback.reconciliation_lane, "private");
    const outbox = join(run.cacheDir, "_write-outbox-cto");
    const [pending] = readdirSync(outbox).filter((name) => name.endsWith(".json"));
    const pendingRecord = JSON.parse(readFileSync(join(outbox, pending), "utf8"));
    assert.equal(pendingRecord.idempotency_key, fallback.idempotency_key);
    assert.equal(pendingRecord.intent_hash, operationIntentHash({ command: "fact", text: "synthetic private response loss", tags: [], source: "", was: "", supersedes: "", target: "cto", share: false }), JSON.stringify(pendingRecord));
    assert.equal(pendingRecord.operation_id, operationIdentity("cto", "cto", pendingRecord.idempotency_key));
    const initialRows = rows(run.store, S3_HOST, "/otchealthcommons/company-journal/_MEMORY/cto.jsonl");
    assert.equal(initialRows.length, 1);
    assert.equal(initialRows[0].id, fallback.reconciliation_entry_id);
    const replay = runMem(args, { lose_private_put: false, fail_private_read: false }, run);
    assert.equal(replay.result.status, 0, replay.result.stderr);
    assert.deepEqual(rows(replay.store, S3_HOST, "/otchealthcommons/company-journal/_MEMORY/cto.jsonl").map((row) => row.id), [fallback.reconciliation_entry_id]);
    assert.deepEqual(readdirSync(outbox).filter((name) => name.endsWith(".json") || name.endsWith(".lock")), [], "resolved recovery must clear its durable outbox record");
    const later = runMem(args, {}, replay);
    assert.equal(later.result.status, 0, later.result.stderr);
    assert.equal(rows(later.store, S3_HOST, "/otchealthcommons/company-journal/_MEMORY/cto.jsonl").length, 2, "a completed recovery must not consume a later intentional write");
  } finally {
    rmSync(run.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("actual non-keyed shared recovery refuses a corrupt retained outbox without creating replacement rows", () => {
  const args = ["status", "synthetic corrupt shared recovery", "--agent", "cto"];
  const run = runMem(args, { lose_shared_put: true, fail_shared_read: true });
  try {
    assert.equal(run.result.status, 1, run.result.stderr);
    const outbox = join(run.cacheDir, "_write-outbox-cto");
    const [pending] = readdirSync(outbox).filter((name) => name.endsWith(".json"));
    writeFileSync(join(outbox, pending), "{not-json\n");
    const replay = runMem(args, { lose_shared_put: false, fail_shared_read: false }, run);
    assert.equal(replay.result.status, 1, replay.result.stderr);
    assert.match(replay.result.stderr, /outbox is unreadable or malformed.*refusing automatic retry/);
    assert.equal(rows(replay.store, S3_HOST, "/otchealthcommons/company-journal/_MEMORY/cto.jsonl").length, 1);
    assert.equal(rows(replay.store, S3_HOST, "/otchealthcommons/company-journal/_MEMORY/_exec/cto.jsonl").length, 1);
  } finally {
    rmSync(run.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("actual entity set shared response loss resumes the original entity row", () => {
  const args = ["entity", "set", "synthetic_entity", "shared value", "--agent", "cto", "--share"];
  const run = runMem(args, { lose_shared_put: true, fail_shared_read: true });
  try {
    assert.equal(run.result.status, 1, run.result.stderr);
    assert.match(run.result.stderr, /SHARED DURABILITY UNKNOWN/);
    const [fallback] = readFileSync(join(run.cacheDir, "_failed_writes-cto.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(fallback.type, "entity");
    assert.equal(fallback.reconciliation_lane, "shared");
    assert.match(fallback.operation_id, /^[a-f0-9]{64}$/);
    const privateRows = rows(run.store, S3_HOST, "/otchealthcommons/company-journal/_MEMORY/cto.jsonl");
    const sharedRows = rows(run.store, S3_HOST, "/otchealthcommons/company-journal/_MEMORY/_exec/cto.jsonl");
    assert.equal(privateRows.length, 1);
    assert.equal(sharedRows.length, 1);
    assert.equal(privateRows[0].type, "entity");
    assert.equal(privateRows[0].ekey, "synthetic_entity");
    assert.equal(privateRows[0].id, sharedRows[0].id);
    const replay = runMem(args, { lose_shared_put: false, fail_shared_read: false }, run);
    assert.equal(replay.result.status, 0, replay.result.stderr);
    assert.deepEqual(rows(replay.store, S3_HOST, "/otchealthcommons/company-journal/_MEMORY/cto.jsonl").map((row) => row.id), [privateRows[0].id]);
    assert.deepEqual(rows(replay.store, S3_HOST, "/otchealthcommons/company-journal/_MEMORY/_exec/cto.jsonl").map((row) => row.id), [privateRows[0].id]);
  } finally {
    rmSync(run.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("actual entity link private response loss resumes the original link row", () => {
  const args = ["entity", "link", "synthetic_source", "depends on", "synthetic_target", "--agent", "cto"];
  const run = runMem(args, { lose_private_put: true, fail_private_read: true });
  try {
    assert.equal(run.result.status, 1, run.result.stderr);
    assert.match(run.result.stderr, /PRIVATE DURABILITY UNKNOWN/);
    const [fallback] = readFileSync(join(run.cacheDir, "_failed_writes-cto.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(fallback.type, "entity");
    assert.equal(fallback.reconciliation_lane, "private");
    assert.match(fallback.operation_id, /^[a-f0-9]{64}$/);
    const privateRows = rows(run.store, S3_HOST, "/otchealthcommons/company-journal/_MEMORY/cto.jsonl");
    assert.equal(privateRows.length, 1);
    assert.equal(privateRows[0].type, "entity_link");
    const replay = runMem(args, { lose_private_put: false, fail_private_read: false }, run);
    assert.equal(replay.result.status, 0, replay.result.stderr);
    assert.deepEqual(rows(replay.store, S3_HOST, "/otchealthcommons/company-journal/_MEMORY/cto.jsonl").map((row) => row.id), [privateRows[0].id]);
  } finally {
    rmSync(run.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("actual entity alias shared response loss retains its original alias row", () => {
  const seed = runMem(["entity", "set", "canonical_entity", "seed value", "--agent", "cto"]);
  const args = ["entity", "alias", "synthetic alias", "canonical_entity", "--agent", "cto", "--share"];
  const run = runMem(args, { lose_shared_put: true, fail_shared_read: true }, seed);
  try {
    assert.equal(seed.result.status, 0, seed.result.stderr);
    assert.equal(run.result.status, 1, run.result.stderr);
    const privateRows = rows(run.store, S3_HOST, "/otchealthcommons/company-journal/_MEMORY/cto.jsonl");
    const alias = privateRows.find((row) => row.type === "alias");
    assert.ok(alias);
    const replay = runMem(args, { lose_shared_put: false, fail_shared_read: false }, run);
    assert.equal(replay.result.status, 0, replay.result.stderr);
    assert.equal(rows(replay.store, S3_HOST, "/otchealthcommons/company-journal/_MEMORY/cto.jsonl").filter((row) => row.type === "alias").length, 1);
    assert.equal(rows(replay.store, S3_HOST, "/otchealthcommons/company-journal/_MEMORY/_exec/cto.jsonl").filter((row) => row.type === "alias")[0].id, alias.id);
  } finally {
    rmSync(seed.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("actual entity write rejects a changed intent under an explicit operation key", () => {
  const first = runMem(["entity", "set", "synthetic_entity", "first value", "--agent", "cto", "--idempotency-key", "entity-intent-key-001"]);
  try {
    assert.equal(first.result.status, 0, first.result.stderr);
    const conflict = runMem(["entity", "set", "synthetic_entity", "second value", "--agent", "cto", "--idempotency-key", "entity-intent-key-001"], {}, first);
    assert.equal(conflict.result.status, 1, conflict.result.stderr);
    assert.match(conflict.result.stderr, /idempotency key conflict/);
    const privateRows = rows(conflict.store, S3_HOST, "/otchealthcommons/company-journal/_MEMORY/cto.jsonl");
    assert.equal(privateRows.length, 1);
    assert.equal(privateRows[0].evalue, "first value");
  } finally {
    rmSync(first.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
