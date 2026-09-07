// Verify the real signal schema's stable IDs cross the Postgres adapter unchanged as bound values.
// Local PostgreSQL protocol fixture only: no cloud, external credentials, or production data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import * as state from '../skills/kb-memory/pg-state.mjs';
import { makeSignal } from '../skills/signal-radar/schema.mjs';

function frame(type, payload = Buffer.alloc(0)) {
  const size = Buffer.alloc(4); size.writeInt32BE(payload.length + 4);
  return Buffer.concat([Buffer.from(type), size, payload]);
}
function row(values) {
  const count = Buffer.alloc(2); count.writeInt16BE(values.length);
  return frame('D', Buffer.concat([count, ...values.flatMap(value => {
    const data = Buffer.from(value), size = Buffer.alloc(4); size.writeInt32BE(data.length);
    return [size, data];
  })]));
}
function parameters(payload) {
  // Bind: portal, statement, format-code array, count, length-prefixed text values.
  let offset = payload.indexOf(0) + 1; offset = payload.indexOf(0, offset) + 1;
  const formats = payload.readInt16BE(offset); offset += 2 + formats * 2;
  const count = payload.readInt16BE(offset); offset += 2;
  return Array.from({length:count}, () => {
    const size = payload.readInt32BE(offset); offset += 4;
    if (size === -1) return null;
    const value = payload.toString('utf8', offset, offset + size); offset += size; return value;
  });
}

test('signal IDs retain their stable identity through parameterized CRUD while other validation stays strict', {timeout:5000}, async () => {
  const signal = makeSignal({detector:'fixture-detector', owner:'cto', subject:'Fixture Subject', severity:'low', why:'fixture', suggested_action:'none'});
  assert.equal(signal.id, 'fixture-detector::fixture-subject');
  const sockets = new Set(), statements = [];
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let buffered = Buffer.alloc(0), startup = true, query, values;
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      if (startup) {
        if (buffered.length < 4 || buffered.length < buffered.readInt32BE(0)) return;
        buffered = buffered.subarray(buffered.readInt32BE(0)); startup = false;
        socket.write(Buffer.concat([frame('R', Buffer.alloc(4)), frame('Z', Buffer.from('I'))]));
      }
      while (buffered.length >= 5) {
        const size = buffered.readInt32BE(1) + 1;
        if (buffered.length < size) break;
        const type = String.fromCharCode(buffered[0]), payload = buffered.subarray(5, size);
        buffered = buffered.subarray(size);
        if (type === 'P') query = payload.toString('utf8', 1, payload.indexOf(0, 1));
        if (type === 'B') values = parameters(payload);
        if (type === 'S') {
          statements.push({query, values});
          const rows = query.startsWith('SELECT doc, etag') ? [row([JSON.stringify(signal), 'fixture-etag'])] : query.startsWith('WITH present') ? [row(['1','1'])] : [];
          socket.write(Buffer.concat([frame('1'), frame('2'), ...rows, frame('C', Buffer.from('SELECT 1\0')), frame('Z', Buffer.from('I'))]));
        } else if (type === 'X') socket.end();
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = {PG_HOST:'127.0.0.1', PG_PORT:String(server.address().port), PG_DATABASE:'fixture', PG_USER:'fixture', PG_PASSWORD:'not-a-real-secret', PG_SSL:'false'};
  const original = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    await state._resetForTests();
    assert.equal((await state.upsertDoc('signals', 'cto', signal)).ok, true);
    assert.equal((await state.createDoc('signals', 'cto', signal)).status, 201);
    assert.equal((await state.readDoc('signals', 'cto', signal.id)).doc.id, signal.id);
    assert.equal((await state.replaceDoc('signals', 'cto', signal.id, signal, 'fixture-etag')).status, 200);
    assert.equal(statements.length, 4);
    for (const statement of statements) {
      assert.equal(statement.values[0], 'cto');
      assert.equal(statement.values[1], signal.id);
      assert.equal(statement.query.includes(signal.id), false, 'document identity must stay out of SQL text');
    }
    // The legacy plain-ID shape stays valid, and arbitrary long/path/SQL-like IDs remain rejected.
    await state.upsertDoc('signals', 'cto', {...signal, id:'fixture_legacy-1'});
    const count = statements.length;
    for (const id of ['', '.', '..', 'x'.repeat(256), 'bad/id', 'bad\\id', 'bad?id', "bad';--"]) {
      await assert.rejects(state.upsertDoc('signals', 'cto', {...signal, id}), /invalid id/);
    }
    await assert.rejects(state.upsertDoc('signals', 'cto::other', signal), /invalid partition key/);
    await assert.rejects(state.queryDocs('signals', 'SELECT * FROM c', [], {pk:'cto::other'}), /invalid partition key/);
    await assert.rejects(state.createDoc('decisions_pending', 'cto', signal), /invalid id/);
    await assert.rejects(state.upsertDoc('signals;DROP TABLE', 'cto', signal), /unknown container/);
    assert.equal(statements.length, count, 'invalid identifiers must be rejected before SQL execution');
  } finally {
    await state._resetForTests();
    for (const [key,value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});
