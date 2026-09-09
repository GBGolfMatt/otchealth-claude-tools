import crypto from "node:crypto";

// Optimistic append for the cross-client shared JSONL feed.
// The raw idempotency key is never persisted. Only a caller and target scoped SHA-256 fingerprint is stored.

function parseRows(text) {
  if (!text) return [];
  return text.split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function sameEntry(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function intentFingerprint(callerLane, targetLane, key) {
  return crypto.createHash("sha256").update("shared-memory-v1\0" + callerLane + "\0" + targetLane + "\0" + key).digest("hex");
}

// Cross-writer retry contract. This intentionally excludes generated row fields (id, ts), writer
// attribution, and lane/key fields (already covered by writeIntent). Keep this byte layout aligned
// with gateway src/memory/store.ts.
function sharedLogicalIntent(entry) {
  return {
    type: entry.type,
    text: entry.text,
    tags: entry.tags ?? [],
    source: entry.source ?? null,
    supersedes: entry.supersedes ?? null,
  };
}

export function compareSharedRows(left, right) {
  return String(left?.ts || "").localeCompare(String(right?.ts || "")) ||
    String(left?.id || "").localeCompare(String(right?.id || ""));
}

function defaultTimer(callback, ms) { return setTimeout(callback, ms); }

async function withinDeadline(operation, deadlineAt, { now, setTimer, clearTimer }) {
  const remainingMs = deadlineAt - now();
  if (remainingMs <= 0) throw new Error("shared feed append deadline exceeded; durability is unknown");
  const controller = new AbortController();
  let timer;
  const expired = new Promise((_resolve, reject) => {
    timer = setTimer(() => {
      controller.abort(new Error("shared feed append deadline exceeded"));
      reject(new Error("shared feed append deadline exceeded; durability is unknown"));
    }, remainingMs);
  });
  try { return await Promise.race([operation(controller.signal), expired]); }
  finally { if (timer !== undefined) clearTimer(timer); }
}

export async function appendSharedCas({
  read,
  write,
  entry,
  agent,
  callerLane = agent,
  idempotencyKey,
  idempotencyIntent,
  decorateAgent = true,
  attempts = 6,
  delay = async (n) => new Promise((resolve) => setTimeout(resolve, 20 * n)),
  deadlineMs = 15_000,
  deadlineAt: suppliedDeadlineAt,
  now = Date.now,
  setTimer = defaultTimer,
  clearTimer = clearTimeout,
}) {
  if (suppliedDeadlineAt === undefined && (!Number.isFinite(deadlineMs) || deadlineMs <= 0)) throw new Error("shared feed append deadline must be positive");
  const deadlineAt = suppliedDeadlineAt === undefined ? now() + deadlineMs : suppliedDeadlineAt;
  if (!Number.isFinite(deadlineAt) || deadlineAt <= now()) throw new Error("shared feed append deadline exceeded; durability is unknown");
  const timing = { now, setTimer, clearTimer };
  const key = idempotencyKey?.trim();
  const writeIntent = key ? intentFingerprint(callerLane, agent, key) : undefined;
  const defaultIntent = (() => { const { id, ts, ...rest } = entry; return rest; })();
  // Shared rows must derive the hash from the durable logical row, never from a client command
  // envelope. Private keyed writes retain their existing caller-supplied intent behavior.
  const contentIntent = writeIntent
    ? crypto.createHash("sha256").update(JSON.stringify(decorateAgent ? sharedLogicalIntent(entry) : (idempotencyIntent ?? defaultIntent))).digest("hex")
    : undefined;
  const candidate = { ...entry, ...(decorateAgent ? { agent } : {}), ...(writeIntent ? { write_intent: writeIntent, write_intent_content: contentIntent } : {}) };
  let lastError;
  let writeStarted = false;
  let ambiguousWriteSeen = false;
  try {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const { text, etag } = await withinDeadline((signal) => read(signal), deadlineAt, timing);
      const rows = parseRows(text);
      const replay = writeIntent ? rows.find((row) => row.write_intent === writeIntent) : undefined;
      if (replay) {
        if (replay.write_intent_content !== candidate.write_intent_content) throw new Error("idempotency key conflict: caller already used this key for a different shared-memory intent");
        return replay;
      }
      const stored = rows.find((row) => row.id === candidate.id);
      if (stored) {
        if (!sameEntry(stored, candidate)) throw new Error("shared feed id collision for " + candidate.id);
        return stored;
      }
      rows.push(candidate);
      try {
        writeStarted = true;
        await withinDeadline(
          (signal) => write(rows.map((row) => JSON.stringify(row)).join("\n") + "\n", etag, signal),
          deadlineAt,
          timing,
        );
        return candidate;
      } catch (error) {
        lastError = error;
        const status = Number(error?.status);
        const uncertainWrite = !Number.isFinite(status) || status === 408 || status === 429 || status >= 500;
        if (uncertainWrite) ambiguousWriteSeen = true;
        if (status !== 409 && status !== 412 && Number.isFinite(status)) throw error;
        await withinDeadline(() => Promise.resolve().then(() => delay(attempt)), deadlineAt, timing);
      }
    }

    const rows = parseRows((await withinDeadline((signal) => read(signal), deadlineAt, timing)).text);
    const stored = writeIntent
      ? rows.find((row) => row.write_intent === writeIntent)
      : rows.find((row) => row.id === candidate.id);
    if (stored) {
      if (stored.write_intent_content !== candidate.write_intent_content) throw new Error("idempotency key conflict: stored intent differs");
      return stored;
    }
    throw new Error("shared feed append lost the concurrency race after " + attempts + " attempts: " + String(lastError));
  } catch (error) {
    const status = Number(error?.status);
    const uncertain = !Number.isFinite(status) || status === 408 || status === 429 || status >= 500;
    // Once any PUT outcome is ambiguous, a later read failure cannot prove that PUT did not commit.
    // Preserve UNKNOWN until a read positively finds the intent or proves a conflict.
    if ((ambiguousWriteSeen || (writeStarted && uncertain)) && !String(error).includes("idempotency key conflict") && !String(error).includes("id collision")) {
      return {
        durability: "UNKNOWN",
        entry: candidate,
        reason: String(error),
        retry_with_same_key: Boolean(key),
      };
    }
    throw error;
  }
}
