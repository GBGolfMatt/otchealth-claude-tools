import test from 'node:test';
import assert from 'node:assert/strict';
import { runScan } from '../skills/signal-radar/radar.mjs';
const now = Date.parse('2026-09-09T01:00:00Z');
const signal = { id: 'race-fixture::synthetic', detector: 'race-fixture', owner: 'cto', subject: 'synthetic',
  severity: 'high', why: 'synthetic', suggested_action: 'synthetic', ts: new Date(now).toISOString(), mnpi: false };
const detectors = [{ NAME: signal.detector, OWNER: signal.owner, run: async () => ({ signals: [signal], notes: [] }) }];
function journal() {
  const docs = new Map(); let version = 0;
  const copy = x => x ? structuredClone(x) : null;
  const io = {
    cosmosConfig: async () => ({ backend: 'synthetic' }),
    cosmosQuerySignals: async () => [],
    cosmosCreateSignal: async doc => {
      const key = `${doc.owner}/${doc.id}`;
      if (docs.has(key)) return { ok: false, status: 409 };
      const etag = String(++version); docs.set(key, { doc: copy(doc), etag }); return { ok: true, etag };
    },
    cosmosReadSignal: async (owner, id) => copy(docs.get(`${owner}/${id}`)),
    cosmosReplaceSignal: async (owner, id, doc, etag) => {
      const key = `${owner}/${id}`;
      if (!etag || docs.get(key)?.etag !== etag) return { ok: false, status: 412 };
      const next = String(++version); docs.set(key, { doc: copy(doc), etag: next }); return { ok: true, etag: next };
    },
    cosmosQueryDispatchSignals: async (owner, detector, state) => [...docs.values()].map(x => copy(x.doc))
      .filter(x => x.owner === owner && x.detector === detector && x.dispatch_state === state),
    posthogEmit: async () => true,
  };
  return { io, docs };
}
const scan = (io, dispatch, extra = {}) => runScan({ io, dispatch, detectors, now, emitting: true, asJson: true, ...extra });
test('scan with stale history cannot resend after another scan finishes', async () => {
  const exit = process.exitCode; const { io } = journal(); const sends = [];
  let release, reached;
  const waiting = new Promise(r => { reached = r; });
  const gate = new Promise(r => { release = r; });
  const staleIo = { ...io, cosmosQuerySignals: async () => { reached(); await gate; return []; } };
  try {
    const delayed = scan(staleIo, async () => sends.push('stale'));
    await waiting;
    await scan(io, async () => sends.push('first'));
    release(); const second = await delayed;
    assert.deepEqual(sends, ['first']);
    assert.equal(second.persisted, 0);
    assert.equal(second.unresolved.length, 0);
  } finally { release(); process.exitCode = exit; }
});
test('two initial writers race without overwriting the winning dispatch claim', async () => {
  const exit = process.exitCode; const { io, docs } = journal(); const sends = [];
  let reads = 0, release;
  const gate = new Promise(r => { release = r; });
  const read = io.cosmosReadSignal;
  io.cosmosReadSignal = async (...args) => {
    if (reads++ < 2) { if (reads === 2) release(); await gate; return null; }
    return read(...args);
  };
  try {
    await Promise.all([scan(io, async () => sends.push(1)), scan(io, async () => sends.push(2))]);
    assert.equal(sends.length, 1);
    assert.equal(docs.get(`cto/${signal.id}`).doc.dispatch_state, 'sent');
  } finally { process.exitCode = exit; }
});
test('history failure suppresses persistence, telemetry and dispatch', async () => {
  const exit = process.exitCode; const { io, docs } = journal(); let effects = 0;
  io.cosmosQuerySignals = async () => { throw new Error('synthetic unavailable'); };
  io.posthogEmit = async () => { effects++; };
  try {
    const result = await scan(io, async () => { effects++; });
    assert.equal(effects, 0); assert.equal(docs.size, 0);
    assert.equal(process.exitCode, 1); assert.ok(result.unresolved.length);
  } finally { process.exitCode = exit; }
});
test('accepted claim without returned etag never invokes dispatch', async () => {
  const exit = process.exitCode; const { io, docs } = journal(); let sends = 0;
  const replace = io.cosmosReplaceSignal;
  io.cosmosReplaceSignal = async (...args) => {
    const result = await replace(...args);
    return args[2].dispatch_state === 'dispatching' ? { ok: true } : result;
  };
  try {
    const result = await scan(io, async () => { sends++; });
    assert.equal(sends, 0); assert.equal(process.exitCode, 1);
    assert.equal(docs.get(`cto/${signal.id}`).doc.dispatch_state, 'dispatching');
    assert.ok(result.unresolved.length);
  } finally { process.exitCode = exit; }
});
test('accepted sent receipt with lost response is not blindly resent by a fresh scan', async () => {
  const exit = process.exitCode; const { io, docs } = journal(); let sends = 0;
  const replace = io.cosmosReplaceSignal;
  io.cosmosReplaceSignal = async (...args) => {
    const result = await replace(...args);
    if (args[2].dispatch_state === 'sent') throw new Error('synthetic receipt response lost');
    return result;
  };
  try {
    await assert.rejects(scan(io, async () => { sends++; }));
    io.cosmosReplaceSignal = replace;
    await scan(io, async () => { sends++; });
    assert.equal(sends, 1);
    assert.equal(docs.get(`cto/${signal.id}`).doc.dispatch_state, 'sent');
  } finally { process.exitCode = exit; }
});
