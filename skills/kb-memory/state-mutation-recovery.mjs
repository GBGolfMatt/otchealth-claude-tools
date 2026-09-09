import crypto from "node:crypto";

const RECEIPTS_FIELD = "state_mutation_receipts";
const MAX_RECEIPTS = 64;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
function digest(value) { return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex"); }
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function stateVersion(state) { return Number.isSafeInteger(state?.version) && state.version >= 0 ? state.version : 0; }
function etagHash(etag) { return digest({ etag: etag ?? null }); }
function receiptShape(receipt) {
  return receipt && typeof receipt === "object" && receipt.version === 1 &&
    typeof receipt.operation_id === "string" && /^[A-Za-z0-9._:-]{8,200}$/.test(receipt.operation_id) &&
    typeof receipt.agent === "string" && receipt.agent.length > 0 &&
    Number.isSafeInteger(receipt.expected_version) && receipt.expected_version >= 0 &&
    Number.isSafeInteger(receipt.attempt) && receipt.attempt >= 1 &&
    typeof receipt.mutation_hash === "string" && /^[a-f0-9]{64}$/.test(receipt.mutation_hash) &&
    typeof receipt.expected_etag_hash === "string" && /^[a-f0-9]{64}$/.test(receipt.expected_etag_hash) &&
    typeof receipt.applied_at === "string" && typeof receipt.updated_by === "string";
}
function sameReceipt(a, b) {
  return a.operation_id === b.operation_id && a.agent === b.agent && a.mutation_hash === b.mutation_hash &&
    a.expected_version === b.expected_version && a.attempt === b.attempt && a.applied_at === b.applied_at &&
    a.updated_by === b.updated_by && a.expected_etag_hash === b.expected_etag_hash;
}
function receiptsFrom(state) {
  const receipts = state?.[RECEIPTS_FIELD];
  return Array.isArray(receipts) ? receipts.filter(receiptShape) : [];
}
function withReceipt(state, receipt) {
  const prior = receiptsFrom(state).filter((item) => item.operation_id !== receipt.operation_id);
  return [...prior, receipt].slice(-MAX_RECEIPTS);
}

export class StateMutationUnknownError extends Error {
  constructor(message, receipt) {
    super(message);
    this.name = "StateMutationUnknownError";
    this.durability = "UNKNOWN";
    this.receipt = receipt;
  }
}

export class StateMutationConflictError extends Error {
  constructor(message) { super(message); this.name = "StateMutationConflictError"; }
}

/**
 * A caller supplies only user-intent fields. The timestamp is intentionally absent from the
 * canonical intent and is pinned in a receipt when the conditional write is first attempted.
 */
export function stateMutationIntent(mutation) {
  if (!mutation || typeof mutation !== "object" || !["set", "sync"].includes(mutation.kind)) {
    throw new Error("state mutation kind must be set or sync");
  }
  if (mutation.kind === "set") {
    const fields = mutation.fields || {};
    const allowed = ["goal", "constraints", "open_decisions", "last_state"];
    for (const key of Object.keys(fields)) if (!allowed.includes(key)) throw new Error(`unsupported state set field: ${key}`);
    return { kind: "set", fields: copy(fields), updated_by: String(mutation.updated_by || "cli") };
  }
  if (!Array.isArray(mutation.facts) || mutation.facts.some((fact) => typeof fact !== "string")) {
    throw new Error("state sync facts must be a string array");
  }
  return {
    kind: "sync", facts: mutation.facts.map((fact) => fact.trim()).filter(Boolean),
    source: String(mutation.source || "periodic"), session_id: String(mutation.session_id || ""),
    updated_by: String(mutation.updated_by || `hook:${mutation.source || "periodic"}`),
  };
}

export function stateMutationIntentHash(mutation) { return digest(stateMutationIntent(mutation)); }

function applyMutation(state, receipt, mutation) {
  const next = copy(state);
  if (mutation.kind === "set") {
    for (const [key, value] of Object.entries(mutation.fields)) next[key] = copy(value);
  } else {
    const existing = Array.isArray(next.session_facts) ? next.session_facts : [];
    const seen = new Set(existing.map((fact) => String(fact).slice(0, 64).toLowerCase()));
    const toAdd = [];
    for (const fact of mutation.facts) {
      const key = fact.slice(0, 64).toLowerCase();
      if (!seen.has(key)) { seen.add(key); toAdd.push(fact); }
    }
    next.session_facts = [...toAdd.reverse(), ...existing].slice(0, 10);
    next.checkpoint = { as_of: receipt.applied_at, source: mutation.source, session_id: mutation.session_id };
  }
  next.updated_at = receipt.applied_at;
  next.updated_by = receipt.updated_by;
  next.version = stateVersion(state) + 1;
  next[RECEIPTS_FIELD] = withReceipt(state, receipt);
  return next;
}

function makeReceipt({ operationId, agent, expectedVersion, expectedEtag, attempt, intentHash, mutation, now }) {
  return Object.freeze({
    version: 1, operation_id: operationId, agent, expected_version: expectedVersion,
    expected_etag_hash: etagHash(expectedEtag), attempt, mutation_hash: intentHash,
    applied_at: now(), updated_by: mutation.updated_by,
  });
}

function deadlineError() { return new Error("state mutation I/O deadline exceeded; durability is unknown"); }
async function withinDeadline(operation, deadlineAt) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw deadlineError();
  const controller = new AbortController();
  let timer;
  const expired = new Promise((_resolve, reject) => {
    timer = setTimeout(() => { const error = deadlineError(); controller.abort(error); reject(error); }, remaining);
  });
  try { return await Promise.race([operation(controller.signal), expired]); }
  finally { clearTimeout(timer); }
}

/**
 * Apply a state mutation through an ETag conditional store. `read` returns `{ state, etag }` and
 * `write` returns `{ ok, status }`. A caller persists `error.receipt` after UNKNOWN and passes it
 * back unchanged on recovery. A retry never writes over a newer document unless that document
 * contains the exact immutable receipt proving the original mutation is already durable.
 */
export async function commitStateMutation({
  agent, operationId, mutation, read, write, receipt = null, now = () => new Date().toISOString(), maxAttempts = 4, deadlineMs = 15_000,
}) {
  if (typeof read !== "function" || typeof write !== "function") throw new Error("state mutation requires read and write functions");
  if (typeof agent !== "string" || !agent) throw new Error("state mutation requires agent");
  if (typeof operationId !== "string" || !/^[A-Za-z0-9._:-]{8,200}$/.test(operationId)) throw new Error("state mutation requires a safe operation id");
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new Error("state mutation deadline must be positive");
  const intent = stateMutationIntent(mutation);
  const intentHash = digest(intent);
  const deadlineAt = Date.now() + deadlineMs;
  let currentReceipt = receipt ? Object.freeze(copy(receipt)) : null;
  if (currentReceipt && (!receiptShape(currentReceipt) || currentReceipt.agent !== agent ||
      currentReceipt.operation_id !== operationId || currentReceipt.mutation_hash !== intentHash ||
      currentReceipt.updated_by !== intent.updated_by)) {
    throw new Error("state mutation receipt does not bind this operation intent");
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let snapshot;
    try { snapshot = await withinDeadline((signal) => read(signal), deadlineAt); }
    catch (error) {
      if (currentReceipt) {
        throw new StateMutationUnknownError("state mutation recovery cannot read the original state; durability remains unknown", currentReceipt);
      }
      throw error;
    }
    const state = snapshot?.state;
    if (!state || typeof state !== "object") throw new Error("state mutation read returned no state object");
    if (state.agent !== agent) throw new Error("state mutation read returned a different agent state");
    const durable = receiptsFrom(state).find((item) => item.operation_id === operationId);
    if (durable) {
      if (durable.agent !== agent || durable.mutation_hash !== intentHash) throw new Error("state mutation operation id conflicts with durable receipt");
      if (currentReceipt && !sameReceipt(durable, currentReceipt)) throw new Error("state mutation durable receipt differs from pending receipt");
      return { state, receipt: durable, recovered: true };
    }

    const currentVersion = stateVersion(state);
    if (currentReceipt) {
      // A caller only resumes this path after an ambiguous result. Any newer state without the
      // receipt makes the old write unprovable, so replacing it could erase another writer's work.
      if (currentVersion !== currentReceipt.expected_version) {
        throw new StateMutationUnknownError("state mutation durability cannot be proven against newer state", currentReceipt);
      }
    } else {
      currentReceipt = makeReceipt({ operationId, agent, expectedVersion: currentVersion, expectedEtag: snapshot.etag, attempt: attempt + 1, intentHash, mutation: intent, now });
    }
    if (currentReceipt && (currentVersion !== currentReceipt.expected_version || etagHash(snapshot.etag) !== currentReceipt.expected_etag_hash)) {
      throw new StateMutationUnknownError("state mutation durability cannot be proven against a changed state version or ETag", currentReceipt);
    }

    const candidate = applyMutation(state, currentReceipt, intent);
    let result;
    try { result = await withinDeadline((signal) => write(candidate, snapshot.etag, signal), deadlineAt); }
    catch (error) { throw new StateMutationUnknownError("state mutation write response was lost; durability is unknown", currentReceipt); }
    if (result?.ok) return { state: candidate, receipt: currentReceipt, recovered: false };
    if (result?.status === 409 || result?.status === 412) {
      // A conditional conflict is proof this attempt was not accepted. It is safe to create a new
      // immutable attempt receipt against the next version on the next loop.
      currentReceipt = null;
      continue;
    }
    throw new StateMutationUnknownError(`state mutation write returned ambiguous status ${result?.status ?? "unknown"}`, currentReceipt);
  }
  throw new StateMutationConflictError("state mutation exceeded conditional-write conflict budget");
}

export const STATE_MUTATION_RECEIPTS_FIELD = RECEIPTS_FIELD;
