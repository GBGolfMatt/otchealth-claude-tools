// pg-state.mjs -- shared RDS Postgres backend for the agent-state containers owned by skills that
// write to Cosmos OUTSIDE the otchealth-mcp-server gateway: skills/decision-clock/cosmos-client.mjs
// (container `decisions_pending`) and skills/signal-radar/common.mjs (container `signals`). Both
// import this module and dispatch to it when STATE_BACKEND=postgres, exactly the same env-flag idiom
// the fleet already uses for SEARCH_BACKEND / BLOB_BACKEND / EMBEDDINGS_PROVIDER (see
// otchealth-mcp-server's src/config/env.ts) and the SAME name (STATE_BACKEND) the gateway itself uses
// for its own agent-state cutover (src/agentstate/store.ts) -- so an operator flipping the whole
// fleet's agent-state plane from Cosmos to Postgres sets ONE env var name consistently everywhere.
//
// WHY THIS FILE EXISTS: the gateway's Postgres backend (src/agentstate/postgres.ts) uses the `pg`
// npm package because that repo has a package.json/build step. otchealth-claude-tools has neither --
// every skill here is dependency-free .mjs (see skills/decision-clock/cosmos-client.mjs and
// skills/signal-radar/common.mjs, both hand-rolled REST clients rather than an Azure SDK). Adding a
// single npm dependency here would break that discipline fleet-wide, not just for this one file. So
// the Postgres wire protocol itself is hand-rolled too, in ./pg-wire.mjs (TCP/TLS + SCRAM-SHA-256/MD5
// auth + the Extended Query protocol, using only node: built-ins), and the Cosmos-SQL translation is
// ./pg-sql-translate.mjs, a line-for-line JS port of the gateway's src/agentstate/pg-sql.ts. This file
// is the third piece: the CRUD surface, a close mirror of the gateway's postgres.ts (same table
// convention, same document model, same replaceDoc present/updated CTE trick for distinguishing
// 404-vs-412 without a race), adapted to call pg-wire.mjs instead of `pg`.
//
// DOCUMENT MODEL (identical to the gateway's Postgres backend): one table per container --
// (pk text, id text, doc jsonb, etag text), primary key (pk, id). See pg-state-schema.sql.
//
// CONFIG: connection details are NEVER hardcoded. They resolve via kvSecret() (Azure Key Vault, with
// its own SSM/managed-identity/SP/az-CLI fallback chain -- see azure-secret.mjs) under the names
// aws-pg-host / aws-pg-master-user / aws-pg-master-password / aws-pg-port, database name "agentstate".
// PG_HOST/PG_PORT/PG_USER/PG_PASSWORD/PG_DATABASE env vars override the secret lookup when set --
// mirrors cosmos-client.mjs's own `process.env.COSMOS_ENDPOINT || (await sm(...))` idiom, and is what
// lets this module be pointed at a scratch/test Postgres with zero network or secret access (see
// tests/pg-state.test.mjs).
//
// INERT BY DEFAULT: nothing in this file is imported or invoked unless a caller explicitly asks for
// it (STATE_BACKEND=postgres). isConfigured() only checks that connection VALUES resolved, exactly
// like cosmos-client.mjs's own isConfigured() only checks that Cosmos config values resolved -- it
// does not itself decide whether Postgres is "the" backend; that decision lives in each of the two
// callers' own dispatcher (see the STATE_BACKEND check in cosmos-client.mjs / common.mjs).
import crypto from "node:crypto";
import { kvSecret } from "./azure-secret.mjs";
import { connect as pgConnect } from "./pg-wire.mjs";
import { translate } from "./pg-sql-translate.mjs";

// Both containers this file is asked to serve. Same allow-list discipline as cosmos-client.mjs's own
// CONTAINERS set -- a caller-supplied container string must never reach SQL un-validated.
const CONTAINERS = new Set(["decisions_pending", "signals"]);
const ID_RE = /^[A-Za-z0-9_.\-]{1,255}$/;

/** Container -> physical table, prefixed exactly like the gateway's postgres.ts tableFor() so the two
 *  new tables sit in the SAME agentstate_* naming convention as the gateway's own tables in the same
 *  database, even though the gateway never reads or writes these two specifically. */
export function tableFor(coll) {
  if (!CONTAINERS.has(coll)) throw new Error(`unknown container "${coll}" (allowed: ${[...CONTAINERS].join(", ")})`);
  return `agentstate_${coll}`;
}

function assertId(value, label = "id") {
  if (typeof value !== "string" || !ID_RE.test(value) || /^\.+$/.test(value)) {
    throw new Error(`invalid ${label} (must match the agent-state id charset)`);
  }
}

// ---- connection config -------------------------------------------------------------------------
let _cfg; // memoized {host,port,database,user,password} | null
async function cfg() {
  if (_cfg !== undefined) return _cfg;
  const host = process.env.PG_HOST || (await kvSecret("aws-pg-host"));
  const user = process.env.PG_USER || (await kvSecret("aws-pg-master-user"));
  const password = process.env.PG_PASSWORD || (await kvSecret("aws-pg-master-password"));
  const portRaw = process.env.PG_PORT || (await kvSecret("aws-pg-port"));
  const database = process.env.PG_DATABASE || "agentstate";
  const port = portRaw ? parseInt(portRaw, 10) : 5432;
  _cfg = host && user && password ? { host, port: Number.isFinite(port) && port > 0 ? port : 5432, database, user, password } : null;
  return _cfg;
}

export async function isConfigured() {
  return (await cfg()) !== null;
}

// ---- connection lifecycle -----------------------------------------------------------------------
// One lazily-opened connection, reused for every call in this process. Both callers (decision-clock,
// signal-radar) are short-lived CLI invocations issuing a handful of SEQUENTIAL queries (e.g. sweep's
// per-row readDoc+replaceDoc loop), not a concurrent server, so a single memoized connection is the
// right amount of machinery -- no pool needed, matching the "just enough" spirit of the existing
// dependency-free Cosmos clients. A FAILED connect is deliberately NOT cached (only a successful one
// is), so a transient connect failure never poisons every subsequent call for the rest of the process.
let _conn = null;
async function getConn() {
  if (_conn) return _conn;
  const c = await cfg();
  if (!c) throw new Error("Postgres agent-state not configured (aws-pg-host/aws-pg-master-user/aws-pg-master-password unavailable).");
  const sslEnabled = (process.env.PG_SSL || "true").toLowerCase() !== "false";
  // Mirrors otchealth-mcp-server's PG_SSL_VERIFY: verifying the RDS-issued cert needs the RDS CA
  // bundle, not yet baked in anywhere this runs, so the default is encrypt-without-verify --
  // strictly better than plaintext, and the traffic never leaves the VPC. Same env var NAME as the
  // gateway's own PG_SSL_VERIFY (different runtime, deliberately consistent naming).
  const sslVerify = (process.env.PG_SSL_VERIFY || "false").toLowerCase() === "true";
  const conn = await pgConnect({ host: c.host, port: c.port, database: c.database, user: c.user, password: c.password, ssl: sslEnabled, sslVerify });
  _conn = conn;
  return _conn;
}

/** Close the CLI-owned connection after all work settles. A referenced PostgreSQL socket
 * otherwise keeps Node alive after a successful scan/sweep and leaks one server slot per cron.
 * Idempotent; does not resolve credentials or connect when nothing was opened. */
export async function closeConnection() {
  const conn = _conn;
  _conn = null;
  if (conn) await conn.end();
}

/** Test-only: drop the memoized config + connection so a test can point this module at a different
 *  (scratch/local) Postgres instance without cross-contaminating another test's state. Mirrors
 *  cosmos-auth.mjs's _resetAadTokenCacheForTests() -- same purpose, same naming convention. A no-op
 *  in any real call path; nothing here is invoked by createDoc/readDoc/etc. */
export async function _resetForTests() {
  try { await closeConnection(); } catch { /* best-effort */ }
  _cfg = undefined;
}

function newEtag() {
  return `"${crypto.randomUUID()}"`;
}

// ---- CRUD surface, mirroring cosmos-client.mjs's exported shape + otchealth-mcp-server's
// postgres.ts return contracts exactly (so the callers' dispatch wrappers need no translation) -------

/** Create a document. Duplicate (pk, id) throws a 409-shaped error, matching cosmos-client.mjs's own
 *  createDoc ("if (!res.ok) throw"). */
export async function createDoc(coll, pkValue, doc) {
  const table = tableFor(coll);
  assertId(pkValue, "partition key");
  const id = String(doc.id ?? "");
  assertId(id);
  const etag = newEtag();
  const conn = await getConn();
  try {
    await conn.query(`INSERT INTO ${table} (pk, id, doc, etag) VALUES ($1, $2, $3, $4)`, [pkValue, id, JSON.stringify(doc), etag]);
  } catch (e) {
    // PARITY with the gateway's postgres.ts: a real 409, not a generic failure, so a caller that
    // ever branches on "already exists" (none does today, but cosmos-client.mjs's own contract is a
    // throw either way) gets a message that says so.
    if (e.code === "23505") throw new Error(`Postgres createDoc ${coll} -> 409: duplicate id ${id} in partition ${pkValue}`);
    throw new Error(`Postgres createDoc ${coll} -> ${e.message}`);
  }
  return { status: 201, ok: true, body: doc, etag };
}

/** Read by id + partition key. Returns null when absent (never throws for "not found"), matching
 *  cosmos-client.mjs's readDoc exactly. */
export async function readDoc(coll, pkValue, id) {
  const table = tableFor(coll);
  assertId(pkValue, "partition key");
  assertId(id);
  const conn = await getConn();
  const r = await conn.query(`SELECT doc, etag FROM ${table} WHERE pk = $1 AND id = $2`, [pkValue, id]);
  if (!r.rows.length) return null;
  return { doc: JSON.parse(r.rows[0][0]), etag: r.rows[0][1] };
}

/**
 * Replace a document, honouring an optional If-Match etag. Returns a {status,ok,body,etag} response
 * object WITHOUT throwing on a 404/412 -- matching cosmos-client.mjs's replaceDoc, which just returns
 * whatever the raw Cosmos response was and lets the caller decide whether to check `.ok` (decision.mjs
 * today does not).
 *
 * The single-statement CTE is load-bearing, ported verbatim from the gateway's postgres.ts: a
 * read-then-write would race, and a plain conditional UPDATE cannot tell "absent" from "stale" (both
 * report zero rows updated). `present` is computed in the SAME statement as the update, so the two
 * stay distinguishable without a second round trip.
 */
export async function replaceDoc(coll, pkValue, id, doc, ifMatch) {
  const table = tableFor(coll);
  assertId(pkValue, "partition key");
  assertId(id);
  const etag = newEtag();
  const conn = await getConn();
  const r = await conn.query(
    `WITH present AS (
       SELECT 1 FROM ${table} WHERE pk = $1 AND id = $2
     ), updated AS (
       UPDATE ${table} SET doc = $3, etag = $4
        WHERE pk = $1 AND id = $2 AND ($5::text IS NULL OR etag = $5)
        RETURNING 1
     )
     SELECT (SELECT count(*) FROM present) AS present, (SELECT count(*) FROM updated) AS updated`,
    [pkValue, id, JSON.stringify(doc), etag, ifMatch ?? null],
  );
  const present = Number(r.rows[0]?.[0] ?? 0);
  const updated = Number(r.rows[0]?.[1] ?? 0);
  if (updated > 0) return { status: 200, ok: true, body: doc, etag };
  if (present === 0) return { status: 404, ok: false, body: null, etag: null };
  return { status: 412, ok: false, body: null, etag: null };
}

/** Insert-or-replace, matching cosmos-client.mjs's upsertDoc (the underlying operation
 *  cosmosPutSignal in signal-radar/common.mjs relies on via its `upsert:true` Cosmos flag). */
export async function upsertDoc(coll, pkValue, doc) {
  const table = tableFor(coll);
  assertId(pkValue, "partition key");
  const id = String(doc.id ?? "");
  assertId(id);
  const etag = newEtag();
  const conn = await getConn();
  await conn.query(
    `INSERT INTO ${table} (pk, id, doc, etag) VALUES ($1, $2, $3, $4)
       ON CONFLICT (pk, id) DO UPDATE SET doc = EXCLUDED.doc, etag = EXCLUDED.etag`,
    [pkValue, id, JSON.stringify(doc), etag],
  );
  return { status: 200, ok: true, body: doc, etag };
}

/**
 * Run a Cosmos-SQL query against Postgres, via pg-sql-translate.mjs. Fail-closed: an unsupported
 * construct throws (never silently mistranslated), a real Postgres error throws too -- matching
 * cosmos-client.mjs's own queryDocs ("if (!res.ok) throw"). Default max mirrors cosmos-client.mjs's
 * own default (`opts.max ?? 200`) exactly.
 */
export async function queryDocs(coll, query, parameters = [], opts = {}) {
  const table = tableFor(coll);
  if (opts.pk !== undefined) assertId(opts.pk, "partition key");
  const { text, values } = translate({ table, query, parameters, pk: opts.pk, max: opts.max ?? 200 });
  const conn = await getConn();
  const r = await conn.query(text, values);
  return r.rows.map((row) => JSON.parse(row[0]));
}

/** A short unique id. Identical shape to cosmos-client.mjs's own newId, so ids minted under one
 *  backend stay valid (and look native) under the other -- same reasoning as the gateway's own
 *  store.ts, which re-exports cosmos.newId() rather than branching newId on STATE_BACKEND at all. */
export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

