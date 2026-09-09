import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { appendSharedCas, compareSharedRows } from "../shared-feed-append.mjs";

test("mem.mjs routes shared publication through the CAS helper", async () => {
  const source = await readFile(new URL("../mem.mjs", import.meta.url), "utf8");
  assert.match(source, /import \{ appendSharedCas, compareSharedRows \} from "\.\/shared-feed-append\.mjs"/);
  assert.match(source, /await appendSharedCas\(\{/);
  assert.match(source, /\.sort\(compareSharedRows\)/);
  assert.match(source, /callerLane: AGENT/);
  assert.match(source, /idempotencyKey: IDEMPOTENCY_KEY \|\| undefined/);
});

function versionedStore(initial = "") {
  let text = initial;
  let version = 1;
  let firstPair = 0;
  let releasePair;
  const pairReady = new Promise((resolve) => { releasePair = resolve; });
  return {
    async read() {
      const snapshot = { text: text || null, etag: text ? `\"v${version}\"` : null };
      if (++firstPair === 2) releasePair();
      if (firstPair <= 2) await pairReady;
      return snapshot;
    },
    async write(body, etag) {
      const expected = text ? `\"v${version}\"` : null;
      if (etag !== expected) {
        const error = new Error("conflict");
        error.status = 412;
        throw error;
      }
      text = body;
      version++;
    },
    rows() { return text.trim().split("\n").filter(Boolean).map(JSON.parse); },
  };
}

test("two simultaneous shared-feed writers retain both records and their stable IDs", async () => {
  const store = versionedStore();
  const a = { id: "20260907-a", ts: "2026-09-07T00:00:00.000Z", type: "fact", text: "a", tags: [] };
  const b = { id: "20260907-b", ts: "2026-09-07T00:00:00.001Z", type: "status", text: "b", tags: [] };
  await Promise.all([
    appendSharedCas({ read: store.read, write: store.write, entry: a, agent: "cto", delay: async () => {} }),
    appendSharedCas({ read: store.read, write: store.write, entry: b, agent: "cto", delay: async () => {} }),
  ]);
  assert.deepEqual(store.rows().map((row) => row.id).sort(), [a.id, b.id]);
});

test("accepted write with an ambiguous error is recognized by stable ID and not duplicated", async () => {
  let text = "";
  let writes = 0;
  const entry = { id: "20260907-ambiguous", ts: "2026-09-07T00:00:00.000Z", type: "fact", text: "once", tags: [] };
  const result = await appendSharedCas({
    read: async () => ({ text: text || null, etag: text ? "\"v2\"" : null }),
    write: async (body) => {
      writes++;
      text = body;
      throw new TypeError("response lost after accept");
    },
    entry,
    agent: "cto",
    delay: async () => {},
  });
  assert.equal(result.id, entry.id);
  assert.equal(writes, 1);
  assert.equal(text.trim().split("\n").length, 1);
});

test("one total deadline bounds a read that never settles", async () => {
  let clock = 5_000;
  const scheduled = [];
  const timers = new Set();
  await assert.rejects(
    appendSharedCas({
      read: () => new Promise(() => {}),
      write: async () => {},
      entry: { id: "20260907-deadline", ts: "2026-09-07T00:00:00.000Z", type: "fact", text: "x", tags: [] },
      agent: "cto",
      deadlineMs: 325,
      now: () => clock,
      setTimer: (callback, ms) => {
        scheduled.push(ms);
        const token = {};
        timers.add(token);
        queueMicrotask(() => {
          if (!timers.has(token)) return;
          clock += ms;
          callback();
        });
        return token;
      },
      clearTimer: (timer) => timers.delete(timer),
    }),
    /append deadline exceeded; durability is unknown/,
  );
  assert.deepEqual(scheduled, [325]);
  assert.equal(clock, 5_325);
});

test("same-day random IDs are ordered by timestamp, with ID only breaking ties", () => {
  const rows = [
    { id: "20260907-000000000001", ts: "2026-09-07T20:00:00.000Z" },
    { id: "20260907-ffffffffffff", ts: "2026-09-07T08:00:00.000Z" },
    { id: "20260907-bbbbbbbbbbbb", ts: "2026-09-07T08:00:00.000Z" },
  ].sort(compareSharedRows);
  assert.deepEqual(rows.map((row) => row.id), [
    "20260907-bbbbbbbbbbbb",
    "20260907-ffffffffffff",
    "20260907-000000000001",
  ]);
});


function sequentialStore(initial = "") {
  let text = initial; let version = 1;
  return {
    async read() { return { text: text || null, etag: text ? `"v${version}"` : null }; },
    async write(body, etag) { const expected = text ? `"v${version}"` : null; if (etag !== expected) { const error = new Error("conflict"); error.status = 412; throw error; } text = body; version++; },
    rows() { return text.trim().split("\n").filter(Boolean).map(JSON.parse); },
  };
}

test("caller-scoped idempotency key replays the original row and rejects different intent", async () => {
  const store = sequentialStore();
  const firstEntry = { id: "private-1", ts: "2026-09-07T01:00:00.000Z", type: "fact", text: "stable", tags: [] };
  const replayEntry = { ...firstEntry, id: "private-2", ts: "2026-09-07T02:00:00.000Z" };
  const options = { read: store.read, write: store.write, agent: "cto", callerLane: "cto", idempotencyKey: "retry-key-0001", delay: async () => {} };
  const first = await appendSharedCas({ ...options, entry: firstEntry });
  const replay = await appendSharedCas({ ...options, entry: replayEntry });
  assert.equal(replay.id, first.id);
  assert.equal(store.rows().length, 1);
  assert.doesNotMatch(JSON.stringify(store.rows()), /retry-key-0001/);
  await assert.rejects(
    appendSharedCas({ ...options, entry: { ...replayEntry, text: "different" } }),
    /idempotency key conflict/,
  );
});

test("same raw key on different caller lanes has different stored fingerprints", async () => {
  const store = sequentialStore();
  const base = { id: "p1", ts: "2026-09-07T01:00:00.000Z", type: "fact", text: "same", tags: [] };
  await appendSharedCas({ read: store.read, write: store.write, entry: base, agent: "cto", callerLane: "cto", idempotencyKey: "same-key", delay: async () => {} });
  await appendSharedCas({ read: store.read, write: store.write, entry: { ...base, id: "p2" }, agent: "cto", callerLane: "cro", idempotencyKey: "same-key", delay: async () => {} });
  const rows = store.rows();
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].write_intent, rows[1].write_intent);
});

test("ambiguous PUT followed by explicit 403 read stays UNKNOWN and same-key replay resolves the accepted row", async () => {
  let text = "";
  let reads = 0;
  const key = "sticky-unknown-key";
  const entry = { id: "private-first-403", ts: "2026-09-07T01:00:00.000Z", type: "fact", text: "accepted before read failure", tags: [] };
  const first = await appendSharedCas({
    read: async () => {
      reads++;
      if (reads === 1) return { text: null, etag: null };
      const error = new Error("read forbidden");
      error.status = 403;
      throw error;
    },
    write: async (body) => {
      text = body;
      throw new TypeError("response lost after accept");
    },
    entry,
    agent: "cto",
    callerLane: "cto",
    idempotencyKey: key,
    delay: async () => {},
  });
  assert.equal(first.durability, "UNKNOWN");
  assert.equal(first.retry_with_same_key, true);

  const replay = await appendSharedCas({
    read: async () => ({ text, etag: '"stored"' }),
    write: async () => { throw new Error("replay must not write"); },
    entry: { ...entry, id: "private-retry-403", ts: "2026-09-07T02:00:00.000Z" },
    agent: "cto",
    callerLane: "cto",
    idempotencyKey: key,
  });
  assert.equal(replay.id, entry.id);
  assert.equal(text.trim().split("\n").length, 1);
});
test("accepted write aborted at deadline returns UNKNOWN and same-key retry finds one row", async () => {
  let text = "";
  let aborted = false;
  const entry = { id: "private-first", ts: "2026-09-07T01:00:00.000Z", type: "fact", text: "accepted", tags: [] };
  const first = await appendSharedCas({
    read: async () => ({ text: text || null, etag: null }),
    write: async (body, _etag, signal) => {
      text = body;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
      });
    },
    entry,
    agent: "cto",
    callerLane: "cto",
    idempotencyKey: "accepted-lost-key",
    deadlineMs: 20,
  });
  assert.equal(first.durability, "UNKNOWN");
  assert.equal(first.retry_with_same_key, true);
  assert.equal(aborted, true);
  const retry = await appendSharedCas({
    read: async () => ({ text, etag: '"stored"' }),
    write: async () => { throw new Error("retry must not write"); },
    entry: { ...entry, id: "private-retry", ts: "2026-09-07T02:00:00.000Z" },
    agent: "cto",
    callerLane: "cto",
    idempotencyKey: "accepted-lost-key",
  });
  assert.equal(retry.id, entry.id);
  assert.equal(text.trim().split("\n").length, 1);
});

test("keyed private CAS replays the original row without adding shared-only agent metadata", async () => {
  const store = sequentialStore();
  const options = {
    read: store.read, write: store.write, agent: "cto", callerLane: "cto",
    idempotencyKey: "private-key-001", idempotencyIntent: { type: "fact", text: "one" },
    decorateAgent: false, delay: async () => {},
  };
  const first = await appendSharedCas({
    ...options,
    entry: { id: "private-original", ts: "2026-09-07T01:00:00.000Z", type: "fact", text: "one" },
  });
  const retry = await appendSharedCas({
    ...options,
    entry: { id: "private-regenerated", ts: "2026-09-07T02:00:00.000Z", type: "fact", text: "one" },
  });
  assert.equal(retry.id, first.id);
  assert.equal(store.rows().length, 1);
  assert.equal("agent" in store.rows()[0], false);
});
