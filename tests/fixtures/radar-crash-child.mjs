// Synthetic filesystem journal, never uses company state or dispatch.
import { readFileSync, writeFileSync, renameSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { runScan } from '../../skills/signal-radar/radar.mjs';
const [directory, mode] = process.argv.slice(2);
const statePath = join(directory, 'state.json');
const inboxPath = join(directory, 'inbox.jsonl');
const snapshot = () => existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { version: 0, rows: {} };
function save(db) {
  const next = statePath + '.tmp';
  writeFileSync(next, JSON.stringify(db)); renameSync(next, statePath);
}
async function halt(boundary) {
  process.send({ boundary });
  await new Promise(() => { setInterval(() => {}, 1000); });
}
const signal = { id: 'crash-fixture::synthetic', detector: 'crash-fixture', owner: 'cto', severity: 'high',
  subject: 'synthetic', why: 'synthetic fixture', suggested_action: 'synthetic action', ts: '2026-09-09T00:00:00.000Z', mnpi: false };
const io = {
  cosmosConfig: async () => ({ backend: 'synthetic' }),
  cosmosQuerySignals: async (owner, query, parameters) => {
    const row = snapshot().rows[`${owner}/${parameters[0].value}`];
    return row ? [{ ts: row.doc.ts }] : [];
  },
  cosmosCreateSignal: async doc => {
    const db = snapshot(), key = `${doc.owner}/${doc.id}`;
    if (db.rows[key]) return { ok: false, status: 409 };
    const etag = String(++db.version); db.rows[key] = { doc, etag }; save(db);
    return { ok: true, status: 201, etag, body: doc };
  },
  cosmosReadSignal: async (owner, id) => snapshot().rows[`${owner}/${id}`] || null,
  cosmosReplaceSignal: async (owner, id, doc, etag) => {
    const db = snapshot(), key = `${owner}/${id}`;
    if (!etag || db.rows[key]?.etag !== etag) return { ok: false, status: 412 };
    const nextEtag = String(++db.version); db.rows[key] = { doc, etag: nextEtag }; save(db);
    if (doc.dispatch_state === 'dispatching' && mode === 'kill-dispatching') await halt('dispatching');
    return { ok: true, status: 200, etag: nextEtag, body: doc };
  },
  cosmosQueryDispatchSignals: async (owner, detector, state) => Object.values(snapshot().rows)
    .map(x => x.doc).filter(x => x.owner === owner && x.detector === detector && x.dispatch_state === state),
  posthogEmit: async () => true,
};
try {
  const result = await runScan({ emitting: true, asJson: true, now: Date.parse('2026-09-09T00:00:00Z'), io,
    detectors: [{ NAME: 'crash-fixture', OWNER: 'cto', run: async () => ({ signals: mode === 'restart' ? [] : [signal], notes: [] }) }],
    beforeDispatch: mode === 'kill-pending' ? () => halt('pending') : undefined,
    dispatch: async () => {
      appendFileSync(inboxPath, JSON.stringify({ accepted: true, signal: signal.id }) + '\n');
      if (mode === 'kill-accepted') await halt('accepted');
      if (mode === 'lost-response') throw new Error('synthetic accepted response lost');
    },
  });
  process.send({ result });
} catch {
  process.exitCode = 1;
  process.send({ failed: true });
} finally {
  process.disconnect();
}
