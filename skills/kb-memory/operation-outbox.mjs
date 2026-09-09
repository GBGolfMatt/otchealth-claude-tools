import crypto from "node:crypto";
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, rmdirSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
const stageRank = { staged: 0, private_stored: 1, shared_unknown: 2, shared_stored: 3 };
const safeKey = (key) => /^[A-Za-z0-9._:-]{8,128}$/.test(key);

export function operationIdentity(callerLane, targetLane, key) {
  return hash("memory-dual-write-v1\0" + callerLane + "\0" + targetLane + "\0" + key);
}
export function operationIntentHash(intent) { return hash(JSON.stringify(stable(intent))); }
export function operationOutboxFile(agent, operationId, home = homedir(), cacheDir = null) {
  const directory = cacheDir || join(home, ".claude", "kb-cache");
  return join(directory, "_write-outbox-" + (agent || "unknown"), operationId + ".json");
}
function syncDirectory(path) {
  try { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } } catch {}
}
function durableWriteNew(file, record) {
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(record) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  try { chmodSync(file, 0o600); } catch {}
  syncDirectory(dirname(file));
}
function durableReplace(file, record) {
  const tmp = file + "." + process.pid + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  const fd = openSync(tmp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(record) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch {}
  syncDirectory(dirname(file));
}
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}
function lockSnapshot(dir) {
  let stat;
  try { stat = statSync(dir); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let owner = null;
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8"));
    if (Number.isSafeInteger(parsed.pid) && parsed.pid > 0 && /^[a-f0-9]{32}$/.test(parsed.token)) owner = parsed;
  } catch {}
  const identity = owner
    ? "owned:" + owner.pid + ":" + owner.token
    : "unowned:" + stat.birthtimeMs + ":" + stat.mtimeMs;
  return { owner, identity };
}
function assertLockOwnership(lock) {
  if (!lock?.ownerFile || !lock?.token) throw new Error("operation lock is missing");
  const owner = JSON.parse(readFileSync(lock.ownerFile, "utf8"));
  if (owner.pid !== process.pid || owner.token !== lock.token) {
    throw new Error("operation lock ownership changed");
  }
}
function releaseLock(lock) {
  if (!lock) return;
  try {
    assertLockOwnership(lock);
    unlinkSync(lock.ownerFile);
    rmdirSync(lock.dir);
    syncDirectory(dirname(lock.dir));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
function reclaimStaleLock(dir, observed, testHooks) {
  testHooks?.afterStaleObserved?.(observed);
  // Every process that observed the same stale owner contends on the same claim directory.
  // The winner revalidates under that claim before rename; losers cannot later rename a new live lock.
  const claim = dir + ".reclaim." + hash(observed.identity).slice(0, 24);
  try { mkdirSync(claim); } catch (error) {
    if (error?.code === "EEXIST") throw new Error("stale operation lock reclamation is already active");
    throw error;
  }
  try {
    const current = lockSnapshot(dir);
    if (!current || current.identity !== observed.identity) return false;
    if (!current.owner || processAlive(Number(current.owner.pid))) return false;
    const stale = dir + ".stale." + process.pid + "." + crypto.randomBytes(4).toString("hex");
    renameSync(dir, stale);
    try { unlinkSync(join(stale, "owner.json")); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    rmdirSync(stale);
    syncDirectory(dirname(dir));
    return true;
  } finally {
    try { rmdirSync(claim); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}
function acquireLock(file, testHooks) {
  const dir = file + ".lock";
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = crypto.randomBytes(16).toString("hex");
    try {
      mkdirSync(dir);
      const ownerFile = join(dir, "owner.json");
      const lock = { dir, ownerFile, token };
      try {
        testHooks?.afterDirectoryCreated?.({ dir, ownerFile });
        durableWriteNew(ownerFile, { pid: process.pid, token, created_at: new Date().toISOString() });
        syncDirectory(dirname(dir));
        // Refuse private-store I/O unless this exact physical lock still owns the canonical path.
        assertLockOwnership(lock);
      } catch (error) {
        try { rmdirSync(dir); } catch {}
        throw error;
      }
      return lock;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const observed = lockSnapshot(dir);
      if (!observed) continue;
      if (observed.owner && processAlive(Number(observed.owner.pid))) {
        throw new Error("idempotent memory operation is already active in another process");
      }
      if (!observed.owner) {
        // This can be a stalled initializer. Automatic reclamation cannot distinguish it from an
        // orphan safely, so require verified manual cleanup instead of racing a physical owner write.
        throw new Error("operation lock owner is missing or malformed; refusing automatic reclaim");
      }
      if (!reclaimStaleLock(dir, observed, testHooks)) continue;
    }
  }
  throw new Error("could not acquire idempotent memory operation lock");
}
function storedRecord(operation) {
  assertLockOwnership(operation._lock);
  const current = JSON.parse(readFileSync(operation._file, "utf8"));
  if (current.operation_id !== operation.operation_id || current.intent_hash !== operation.intent_hash) {
    throw new Error("operation outbox identity changed on disk");
  }
  return current;
}
function pendingOperationKey(agent, callerLane, targetLane, intentHash, wantsShared, home, cacheDir) {
  const directory = dirname(operationOutboxFile(agent, "placeholder", home, cacheDir));
  let names;
  try { names = readdirSync(directory); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const matches = [];
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const file = join(directory, name);
    let record;
    try {
      const stat = statSync(file);
      if (!stat.isFile() || stat.size > 65536) throw new Error("not a bounded regular file");
      record = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`pending memory operation outbox is unreadable or malformed (${name}); refusing automatic retry: ${error.message}`);
    }
    const recordIdentity = operationIdentity(record?.caller_lane, record?.target_lane, record?.idempotency_key);
    if (record?.version !== 1 || typeof record?.caller_lane !== "string" || !record.caller_lane ||
        typeof record?.target_lane !== "string" || !record.target_lane || !safeKey(record?.idempotency_key) ||
        !/^[a-f0-9]{64}$/.test(record?.intent_hash || "") || typeof record?.wants_shared !== "boolean" ||
        !(record.auto_generated_key === true || record.auto_generated_key === false || record.auto_generated_key === undefined) ||
        !(record.stage in stageRank) || record.operation_id !== recordIdentity || name !== `${recordIdentity}.json`) {
      throw new Error(`pending memory operation outbox has an invalid identity (${name}); refusing automatic retry`);
    }
    // Records written before automatic recovery, and all caller-supplied keys, are intentionally
    // excluded. An unkeyed invocation must never take authority over an explicit operation key.
    if (record.auto_generated_key !== true) continue;
    if (record.caller_lane !== callerLane || record.target_lane !== targetLane || record.intent_hash !== intentHash ||
        record.wants_shared !== !!wantsShared) continue;
    matches.push(record.idempotency_key);
  }
  if (matches.length > 1) throw new Error("multiple pending memory operations match this unkeyed intent; refusing to guess");
  return matches[0] || null;
}
function assertExistingOperation(prior, expected) {
  const expectedId = operationIdentity(expected.callerLane, expected.targetLane, expected.key);
  if (!prior || typeof prior !== "object" || prior.version !== 1 ||
      prior.operation_id !== expectedId || prior.idempotency_key !== expected.key ||
      prior.caller_lane !== expected.callerLane || prior.target_lane !== expected.targetLane ||
      prior.intent_hash !== expected.intentHash || prior.wants_shared !== !!expected.wantsShared ||
      !(prior.auto_generated_key === true || prior.auto_generated_key === false) ||
      typeof prior.stage !== "string" || !Object.hasOwn(stageRank, prior.stage) ||
      typeof prior.created_at !== "string" || !Number.isFinite(Date.parse(prior.created_at)) ||
      typeof prior.updated_at !== "string" || !Number.isFinite(Date.parse(prior.updated_at))) {
    throw new Error("idempotency key conflict: local outbox record is malformed or differs from the expected operation");
  }
}

export function stageOperation({
  agent, callerLane, targetLane, idempotencyKey, intent, wantsShared, home, cacheDir, _lockTestHooks,
}) {
  const suppliedKey = String(idempotencyKey || "").trim();
  if (suppliedKey && !safeKey(suppliedKey)) throw new Error("idempotency key must be 8-128 safe characters");
  const intent_hash = operationIntentHash(intent);
  // Unkeyed CLI writes still receive a durable, random operation key. A later identical invocation
  // reuses it only while its outbox record remains, so it recovers an ambiguous PUT without turning
  // every future identical note into a permanent dedupe.
  const key = suppliedKey || pendingOperationKey(agent, callerLane, targetLane, intent_hash, wantsShared, home, cacheDir) ||
    "auto-" + crypto.randomBytes(24).toString("hex");
  const operation_id = operationIdentity(callerLane, targetLane, key);
  const file = operationOutboxFile(agent, operation_id, home, cacheDir);
  mkdirSync(dirname(file), { recursive: true });
  const lock = acquireLock(file, _lockTestHooks);
  try {
    if (existsSync(file)) {
      const prior = JSON.parse(readFileSync(file, "utf8"));
      // Keep the caller-visible idempotency conflict distinct from on-disk corruption. Existing
      // clients already use this refusal to explain a changed caller intent.
      if (prior?.intent_hash !== intent_hash) throw new Error("idempotency key conflict: local outbox intent differs");
      assertExistingOperation(prior, { key, callerLane, targetLane, intentHash: intent_hash, wantsShared });
      return { ...prior, _file: file, _lock: lock };
    }
    const now = new Date().toISOString();
    const record = {
      version: 1, operation_id, idempotency_key: key, caller_lane: callerLane, target_lane: targetLane,
      intent_hash, wants_shared: !!wantsShared, auto_generated_key: !suppliedKey,
      stage: "staged", created_at: now, updated_at: now,
    };
    try { durableWriteNew(file, record); }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const prior = JSON.parse(readFileSync(file, "utf8"));
      if (prior.idempotency_key !== key || prior.intent_hash !== intent_hash) throw new Error("idempotency key conflict: concurrent outbox intent differs");
      return { ...prior, _file: file, _lock: lock };
    }
    return { ...record, _file: file, _lock: lock };
  } catch (error) { releaseLock(lock); throw error; }
}
export function advanceOperation(operation, stage, fields = {}) {
  if (!(stage in stageRank)) throw new Error("invalid outbox stage");
  const current = storedRecord(operation);
  const nextStage = stageRank[stage] >= stageRank[current.stage] ? stage : current.stage;
  const next = { ...current, ...fields, stage: nextStage, updated_at: new Date().toISOString() };
  durableReplace(operation._file, next);
  return { ...next, _file: operation._file, _lock: operation._lock };
}
export function completeOperation(operation) {
  const current = storedRecord(operation);
  if (current.wants_shared && current.stage !== "shared_stored") throw new Error("cannot clear outbox before shared storage is confirmed");
  if (!current.wants_shared && current.stage !== "private_stored") throw new Error("cannot clear outbox before private storage is confirmed");
  unlinkSync(operation._file);
  syncDirectory(dirname(operation._file));
  releaseLock(operation._lock);
}
export function releaseOperation(operation) {
  releaseLock(operation?._lock);
}
