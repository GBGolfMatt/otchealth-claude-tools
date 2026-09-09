// Regression for CLI work completing while a referenced PostgreSQL socket keeps Node alive.
// Real production CLI entrypoints + pg-state + pg-wire, a local protocol fixture, and no AWS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const stateUrl = new URL('../skills/kb-memory/pg-state.mjs', import.meta.url).href;
function frame(type, payload = Buffer.alloc(0)) {
  const size = Buffer.alloc(4); size.writeInt32BE(payload.length + 4);
  return Buffer.concat([Buffer.from(type), size, payload]);
}

for (const {job, partial = false} of [{job:'signal-radar'}, {job:'signal-radar', partial:true}, {job:'decision-clock'}]) {
  test(`${job} CLI exits naturally and terminates its database connection after ${partial ? 'partial persistence failure' : 'successful work'}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pg-cli-lifecycle-'));
    const sockets = new Set();
    let queries = 0, terminations = 0;
    const server = createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket));
      let buffered = Buffer.alloc(0), startup = true;
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
          const type = String.fromCharCode(buffered[0]); buffered = buffered.subarray(size);
          if (type === 'S') {
            queries++;
            socket.write(Buffer.concat([frame('1'), frame('2'), frame('n'), frame('C', Buffer.from('SELECT 0\0')), frame('Z', Buffer.from('I'))]));
          } else if (type === 'X') { terminations++; socket.end(); }
        }
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let child;
    try {
      const fixturePath = join(dir, 'fixture.mjs');
      await writeFile(fixturePath, `import * as state from ${JSON.stringify(stateUrl)};
export const NAME='empty-fixture', OWNER='cto', SEVERITY_RANK={};
export const run=async()=>({signals:process.env.PG_FIXTURE_PARTIAL==='true'?[{id:'fixture',owner:'cto',severity:'low',detector:'fixture',subject:'test',why:'test',suggested_action:'none'}]:[]});
export const isMnpiSubject=()=>false, shouldFire=()=>({fire:true});
export async function cosmosConfig(){await state.queryDocs('signals','SELECT * FROM c');return {backend:'postgres'};}
export const cosmosPutSignal=async()=>({ok:process.env.PG_FIXTURE_PARTIAL!=='true',reason:'fixture_failure'}), cosmosQuerySignals=async()=>[], posthogEmit=async()=>{};
export const isConfigured=async()=>true;
export const queryDocs=(...args)=>state.queryDocs(...args);
export const closeConnection=()=>state.closeConnection();
export const createDoc=(...args)=>process.env.PG_FIXTURE_PARTIAL==='true'?Promise.reject(new Error('fixture_failure')):state.createDoc(...args);
export const readDoc=(...args)=>state.readDoc(...args), replaceDoc=(...args)=>state.replaceDoc(...args);
export const newId=()=> 'fixture';
`);
      const fixtureUrl = pathToFileURL(fixturePath).href;
      const loaderPath = join(dir, 'loader.mjs');
      await writeFile(loaderPath, `export async function resolve(specifier, context, nextResolve) {
 const parent=context.parentURL||'';
 if ((parent.endsWith('/skills/signal-radar/radar.mjs') && (specifier==='./common.mjs'||specifier==='./schema.mjs'||specifier.startsWith('./detectors/')||specifier==='../kb-memory/pg-state.mjs')) || (parent.endsWith('/skills/decision-clock/decision.mjs') && specifier==='./cosmos-client.mjs')) return {url:${JSON.stringify(fixtureUrl)},shortCircuit:true};
 return nextResolve(specifier,context);
}`);
      const preload = 'data:text/javascript,' + encodeURIComponent(`import {register} from 'node:module';register(${JSON.stringify(pathToFileURL(loaderPath).href)});`);
      const relative = job === 'signal-radar' ? '../skills/signal-radar/radar.mjs' : '../skills/decision-clock/decision.mjs';
      const args = job === 'signal-radar' ? ['scan', '--emit'] : ['sweep', '--dispatch'];
      child = spawn(process.execPath, ['--import', preload, fileURLToPath(new URL(relative, import.meta.url)), ...args], {
        env: {...process.env, PG_HOST:'127.0.0.1', PG_PORT:String(server.address().port), PG_DATABASE:'fixture', PG_USER:'fixture', PG_PASSWORD:'not-a-real-secret', PG_SSL:'false', PG_FIXTURE_PARTIAL:String(partial)},
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.stdout.resume();
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('CLI completed its work but failed to exit within five seconds')); }, 5000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', (code, signal) => { clearTimeout(timer); resolve({code, signal}); });
      });
      assert.equal(result.code, partial ? 1 : 0, stderr);
      if (partial) assert.match(stderr, /signal journal write failed/, "the partial-persistence failure path must be the reason for exit 1");
      assert.equal(result.signal, null);
      assert.ok(queries >= 1, 'the test must open and query the real state connection');
      assert.equal(terminations, 1, 'the real wire client must send PostgreSQL Terminate');
    } finally {
      if (child && child.exitCode === null) child.kill();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      const cleanup = resolve(dir);
      assert.ok(cleanup.startsWith(resolve(tmpdir()) + sep + 'pg-cli-lifecycle-'), 'cleanup must stay in the test temp directory');
      await rm(cleanup, {recursive:true, force:true});
    }
  });
}
