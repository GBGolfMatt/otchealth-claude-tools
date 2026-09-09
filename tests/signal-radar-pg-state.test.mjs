// Wiring gate for signal-radar's pg-state (RDS Postgres) agent-state backend
// (skills/kb-memory/pg-state.mjs), which sat built-but-unconnected since PR #437 (2026-08-16) until
// 2026-09-03. This is the file that caught the LIVE production incident: radar.mjs's own `--emit` path
// ran every 30 minutes, exited 0 every time, and printed "cosmos NOT configured ... nothing persisted
// or dispatched" -- a scheduled job that looked perfectly healthy (fresh CloudWatch logs, RunTask
// succeeding, every detector printing [ok]) while silently doing nothing since at least the
// 2026-08-28 SSM cleanup that removed the dead cosmos-endpoint secret. Two things pinned here, with a
// fake backend so nothing here ever touches a real Postgres connection or needs AWS credentials:
//
//   1. common.mjs's cosmosConfig/cosmosPutSignal/cosmosQuerySignals really delegate to whatever
//      backend is currently swapped in (container "signals", partitioned by owner).
//   2. radar.mjs's runScan() -- the scheduled job's ONLY entrypoint (job/radar.sh runs exactly
//      `node radar.mjs scan --emit`) -- actually persists and dispatches a firing signal when the
//      backend reports configured, and FAILS LOUD (a non-zero exit code) rather than silently
//      succeeding when it does not, or when persistence fails outright once "configured".
//
// Every test that exercises a fail-loud path saves + restores process.exitCode around itself:
// process.exitCode is a process-global, and leaving it at 1 would poison node --test's own final exit
// code for the WHOLE run (every other test file included), not just this one assertion.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as common from "../skills/signal-radar/common.mjs";
import { runScan } from "../skills/signal-radar/radar.mjs";
import { makeSignal } from "../skills/signal-radar/schema.mjs";

/** A fake pg-state.mjs: the same shape common.mjs delegates to (isConfigured/upsertDoc/queryDocs).
 *  Every real-network call path pg-state.mjs would take (SSM secret resolution, a TCP/TLS connection
 *  to RDS) is absent by construction -- this object never touches the network. */
function fakeBackend(overrides = {}) {
  return {
    isConfigured: async () => true,
    upsertDoc: async () => ({ status: 200, ok: true }),
    queryDocs: async () => [],
    ...overrides,
  };
}

/** A detector module (the { NAME, run() } shape radar.mjs expects) that unconditionally fires the
 *  given signal, so a test can drive runScan() straight to its persist/dispatch logic without needing
 *  a real Sentry/PostHog/etc. call. */
function firingDetector(signal) {
  return { NAME: "fake-detector", OWNER: signal.owner, run: async () => ({ signals: [signal], notes: [] }) };
}

// ------------------------------------------------ common.mjs delegation ------------------------------------------------

test("common.mjs: cosmosConfig/cosmosPutSignal/cosmosQuerySignals delegate to the swapped backend, not a real Postgres connection", async () => {
  const calls = [];
  common._setStateBackendForTests(fakeBackend({
    isConfigured: async () => true,
    upsertDoc: async (coll, pk, doc) => { calls.push(["upsertDoc", coll, pk, doc]); return { status: 200, ok: true }; },
    queryDocs: async (coll, query, params, opts) => { calls.push(["queryDocs", coll, query, params, opts]); return [{ ts: "2026-01-01T00:00:00Z" }]; },
  }));
  try {
    assert.deepEqual(await common.cosmosConfig(), { backend: "postgres" });

    const putResult = await common.cosmosPutSignal({ id: "fake-detector::x", owner: "cto" });
    assert.deepEqual(putResult, { ok: true });

    const rows = await common.cosmosQuerySignals("cto", "SELECT c.ts FROM c WHERE c.id = @id", [{ name: "@id", value: "fake-detector::x" }]);
    assert.deepEqual(rows, [{ ts: "2026-01-01T00:00:00Z" }]);

    assert.equal(calls[0][0], "upsertDoc");
    assert.equal(calls[0][1], "signals");
    assert.equal(calls[0][2], "cto", "the partition key must be the signal's own owner");
    assert.equal(calls[1][0], "queryDocs");
    assert.equal(calls[1][1], "signals");
    assert.deepEqual(calls[1][4], { pk: "cto" });
  } finally {
    common._resetStateBackendForTests();
  }
});

test("common.mjs: cosmosConfig/cosmosQuerySignals/cosmosPutSignal all report unconfigured cleanly, without ever calling the backend's write path", async () => {
  const upsertCalls = [];
  common._setStateBackendForTests(fakeBackend({
    isConfigured: async () => false,
    upsertDoc: async () => { upsertCalls.push("called"); return { status: 200, ok: true }; },
  }));
  try {
    assert.equal(await common.cosmosConfig(), null);
    assert.deepEqual(await common.cosmosQuerySignals("cto", "SELECT c.ts FROM c"), []);
    assert.deepEqual(await common.cosmosPutSignal({ id: "x", owner: "cto" }), { ok: false, reason: "not-configured" });
    assert.equal(upsertCalls.length, 0, "an unconfigured backend must never receive a write attempt");
  } finally {
    common._resetStateBackendForTests();
  }
});

// ------------------------------------------------ radar.mjs runScan() ------------------------------------------------

test("runScan(): --emit with the agent-state store NOT configured -> fails loud (non-zero exit code), never the silent 'nothing persisted' success this was caught from", async () => {
  const savedExitCode = process.exitCode;
  try {
    const signal = makeSignal({ detector: "fake-detector", owner: "cto", subject: "test-subject-unconfigured", severity: "high", why: "test", suggested_action: "n/a" });
    const dispatchCalls = [];
    const result = await runScan({
      emitting: true,
      detectors: [firingDetector(signal)],
      io: {
        cosmosConfig: async () => null,
        cosmosPutSignal: async () => { throw new Error("must not be called when unconfigured"); },
        cosmosQuerySignals: async () => [],
      },
      dispatch: async (owner, text) => dispatchCalls.push([owner, text]),
    });
    assert.equal(result.configured, false);
    assert.equal(result.persisted, 0);
    assert.equal(process.exitCode, 1, "an unconfigured agent-state store must set a non-zero exit code");
    assert.equal(dispatchCalls.length, 0, "nothing should be dispatched when persistence never even ran");
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("runScan(): --emit with the store configured and a firing HIGH signal -> persist AND dispatch BOTH actually happen", async () => {
  const savedExitCode = process.exitCode;
  try {
    const signal = makeSignal({ detector: "fake-detector", owner: "cto", subject: "test-subject-configured", severity: "high", why: "something is wrong", suggested_action: "go fix it" });
    const putCalls = [];
    const dispatchCalls = [];
    const result = await runScan({
      emitting: true,
      detectors: [firingDetector(signal)],
      io: {
        cosmosConfig: async () => ({ backend: "postgres" }),
        cosmosPutSignal: async (doc) => { putCalls.push(doc); return { ok: true }; },
        cosmosQuerySignals: async () => [],
        posthogEmit: async () => true, // never the real network call in a test
      },
      dispatch: async (owner, text) => dispatchCalls.push({ owner, text }),
    });

    assert.equal(result.configured, true);
    assert.equal(result.persisted, 1, "the firing signal must actually be persisted, not just classified");
    assert.deepEqual(result.dispatched, [signal.id]);
    assert.notEqual(process.exitCode, 1, "a fully successful emit must not fail loud");

    assert.equal(putCalls.length, 1);
    assert.equal(putCalls[0].id, signal.id);
    assert.equal(putCalls[0].owner, "cto");

    assert.equal(dispatchCalls.length, 1, "a HIGH severity firing signal must actually reach fleet-dispatch");
    assert.equal(dispatchCalls[0].owner, "cto");
    assert.match(dispatchCalls[0].text, /something is wrong/);
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("runScan(): --emit with the store reporting configured but the write itself failing (unreachable) -> still fails loud", async () => {
  const savedExitCode = process.exitCode;
  try {
    const signal = makeSignal({ detector: "fake-detector", owner: "cto", subject: "test-subject-unreachable", severity: "high", why: "x", suggested_action: "y" });
    const result = await runScan({
      emitting: true,
      detectors: [firingDetector(signal)],
      io: {
        cosmosConfig: async () => ({ backend: "postgres" }),
        cosmosPutSignal: async () => { throw new Error("connection refused"); },
        cosmosQuerySignals: async () => [],
        posthogEmit: async () => true, // never the real network call in a test
      },
      dispatch: async () => {},
    });
    assert.equal(result.persisted, 0, "the failed write must not be counted as persisted");
    assert.equal(process.exitCode, 1, "'configured but the real write failed' must still fail loud, exactly like the unconfigured case");
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("runScan(): a quiet fleet (nothing fires) with --emit and the store configured is a genuine, honest success -- not this failure class", async () => {
  const savedExitCode = process.exitCode;
  try {
    const result = await runScan({
      emitting: true,
      detectors: [{ NAME: "quiet-detector", OWNER: "cto", run: async () => ({ signals: [], notes: [] }) }],
      io: {
        cosmosConfig: async () => ({ backend: "postgres" }),
        cosmosPutSignal: async () => { throw new Error("must not be called: nothing fired"); },
        cosmosQuerySignals: async () => [],
      },
      dispatch: async () => { throw new Error("must not be called: nothing fired"); },
    });
    assert.equal(result.persisted, 0);
    assert.deepEqual(result.dispatched, []);
    assert.notEqual(process.exitCode, 1, "a quiet fleet with nothing to persist must not be treated as a failure");
  } finally {
    process.exitCode = savedExitCode;
  }
});

function durableIo() {
  const docs = new Map(); let version = 0;
  return {
    docs,
    cosmosConfig: async () => ({ backend: "postgres" }),
    cosmosQuerySignals: async () => [],
    posthogEmit: async () => true,
    cosmosPutSignal: async (doc) => { docs.set(`${doc.owner}/${doc.id}`, { doc, etag: String(++version) }); return { ok: true }; },
    cosmosReadSignal: async (owner, id) => docs.get(`${owner}/${id}`) || null,
    cosmosReplaceSignal: async (owner, id, doc, etag) => {
      const key = `${owner}/${id}`, current = docs.get(key);
      if (!current || current.etag !== etag) return { ok: false, status: 412 };
      const next = { doc, etag: String(++version) }; docs.set(key, next); return { ok: true, etag: next.etag };
    },
    cosmosQueryDispatchSignals: async (state) => [...docs.values()].map((x) => x.doc).filter((doc) => doc.dispatch_state === state),
  };
}

test("runScan(): a crash after durable pending persistence replays once on the next scan", async () => {
  const io = durableIo(); const calls = [];
  const signal = makeSignal({ detector: "fake-detector", owner: "cto", subject: "crash-pending", severity: "high", why: "x", suggested_action: "y" });
  await assert.rejects(() => runScan({ emitting: true, detectors: [firingDetector(signal)], io, dispatch: async () => calls.push("send"), beforeDispatch: async () => { throw new Error("synthetic process crash"); } }));
  assert.equal(io.docs.get(`cto/${signal.id}`).doc.dispatch_state, "pending");
  const replay = await runScan({ emitting: true, detectors: [{ NAME: "quiet", OWNER: "cto", run: async () => ({ signals: [], notes: [] }) }], io, dispatch: async () => calls.push("send") });
  assert.deepEqual(replay.dispatched, [signal.id]);
  assert.deepEqual(calls, ["send"]);
  assert.equal(io.docs.get(`cto/${signal.id}`).doc.dispatch_state, "sent");
});

test("runScan(): accepted-but-response-lost dispatch remains ambiguous and is never blindly replayed", async () => {
  const savedExitCode = process.exitCode; const io = durableIo(); const calls = [];
  try {
    const signal = makeSignal({ detector: "fake-detector", owner: "cto", subject: "lost-response", severity: "high", why: "x", suggested_action: "y" });
    await runScan({ emitting: true, detectors: [firingDetector(signal)], io, dispatch: async () => { calls.push("accepted"); throw new Error("response lost"); } });
    assert.equal(io.docs.get(`cto/${signal.id}`).doc.dispatch_state, "ambiguous");
    const replay = await runScan({ emitting: true, detectors: [{ NAME: "quiet", OWNER: "cto", run: async () => ({ signals: [], notes: [] }) }], io, dispatch: async () => calls.push("retry") });
    assert.equal(calls.filter((x) => x === "retry").length, 0);
    assert.equal(replay.unresolved.length, 1);
    assert.equal(process.exitCode, 1);
  } finally { process.exitCode = savedExitCode; }
});

test("runScan(): a conditional claim conflict fails loud without dispatching", async () => {
  const savedExitCode = process.exitCode; const io = durableIo(); const calls = [];
  const originalReplace = io.cosmosReplaceSignal;
  io.cosmosReplaceSignal = async () => ({ ok: false, status: 412 });
  try {
    const signal = makeSignal({ detector: "fake-detector", owner: "cto", subject: "claim-conflict", severity: "high", why: "x", suggested_action: "y" });
    const result = await runScan({ emitting: true, detectors: [firingDetector(signal)], io, dispatch: async () => calls.push("send") });
    assert.equal(calls.length, 0);
    assert.equal(result.unresolved.length, 1);
    assert.equal(process.exitCode, 1);
  } finally { io.cosmosReplaceSignal = originalReplace; process.exitCode = savedExitCode; }
});
