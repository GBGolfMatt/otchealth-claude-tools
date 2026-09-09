import { appendSharedCas } from "./shared-feed-append.mjs";
import { parseNdjson } from "./blobwrite.mjs";
import { stageOperation, advanceOperation, completeOperation, releaseOperation } from "./operation-outbox.mjs";

function deadlineError() { return new Error("keyed memory operation deadline exceeded; durability is unknown"); }
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
function attachOperation(error, operation) { error.operation = operation; return error; }

export async function commitKeyedMemoryWrite({
  agent, callerLane = agent, targetLane = agent, idempotencyKey, intent, wantsShared,
  buildEntry, privateStore, sharedStore, outboxHome, deadlineMs = 15_000, onOperation = () => {},
}) {
  if (!privateStore?.read || !privateStore?.write) throw new Error("private store read/write are required");
  if (wantsShared && (!sharedStore?.read || !sharedStore?.write)) throw new Error("shared store read/write are required");
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new Error("keyed memory operation deadline must be positive");
  const deadlineAt = Date.now() + deadlineMs;
  let operation = stageOperation({ agent, callerLane, targetLane, idempotencyKey, intent, wantsShared, home: outboxHome });
  onOperation(operation);
  try {
    const initial = await withinDeadline((signal) => privateStore.read(signal), deadlineAt);
    const candidate = buildEntry(parseNdjson(initial.text));
    let privateEntry = await appendSharedCas({
      read: privateStore.read, write: privateStore.write, entry: candidate, agent: targetLane,
      callerLane, idempotencyKey, idempotencyIntent: intent, decorateAgent: false,
      deadlineAt,
    });
    if (privateEntry?.durability === "UNKNOWN") throw Object.assign(new Error(privateEntry.reason), privateEntry);
    const finalPrivate = await withinDeadline((signal) => privateStore.read(signal), deadlineAt);
    const privateRows = parseNdjson(finalPrivate.text);
    operation = advanceOperation(operation, "private_stored", { private_entry_id: privateEntry.id });
    onOperation(operation);

    let shared = false;
    if (wantsShared) {
      const sharedEntry = await appendSharedCas({
        read: sharedStore.read, write: sharedStore.write, entry: privateEntry, agent,
        callerLane, idempotencyKey, idempotencyIntent: intent,
        deadlineAt,
      });
      if (sharedEntry?.durability === "UNKNOWN") {
        operation = advanceOperation(operation, "shared_unknown", { shared_entry_id: privateEntry.id });
        onOperation(operation);
        throw Object.assign(new Error(sharedEntry.reason), sharedEntry);
      }
      operation = advanceOperation(operation, "shared_stored", { shared_entry_id: sharedEntry.id });
      onOperation(operation);
      shared = true;
    }
    completeOperation(operation);
    onOperation(null);
    return { rows: privateRows, entry: privateEntry, shared };
  } catch (error) {
    // Keep the durable outbox record for replay, but never strand its live-process lock.
    try { releaseOperation(operation); } catch {}
    throw attachOperation(error, operation);
  }
}