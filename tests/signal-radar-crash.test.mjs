import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const fixture = fileURLToPath(new URL('./fixtures/radar-crash-child.mjs', import.meta.url));
function child(directory, mode, boundary) {
  return new Promise((resolve, reject) => {
    const worker = fork(fixture, [directory, mode], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
      env: { ...process.env, OPENAI_USAGE_DISABLE: '1' } });
    let result, hit = false;
    const timer = setTimeout(() => { worker.kill('SIGKILL'); reject(new Error('Synthetic crash fixture timed out')); }, 15_000);
    worker.on('error', reject);
    worker.on('message', message => {
      if (message.boundary === boundary && boundary) { hit = true; worker.kill('SIGKILL'); }
      if (message.result) result = message.result;
    });
    worker.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, hit, result }); });
  });
}
const readState = directory => Object.values(JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')).rows)[0].doc;
const accepts = directory => existsSync(join(directory, 'inbox.jsonl')) ? readFileSync(join(directory, 'inbox.jsonl'), 'utf8').trim().split('\n').length : 0;
for (const [mode, boundary, count, expected] of [
  ['kill-pending', 'pending', 1, 'sent'],
  ['kill-dispatching', 'dispatching', 0, 'dispatching'],
  ['kill-accepted', 'accepted', 1, 'dispatching'],
]) {
  test(`real process termination at ${boundary} preserves restart safety`, { timeout: 35_000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'radar-crash-test-'));
    try {
      const stopped = await child(directory, mode, boundary);
      assert.equal(stopped.hit, true);
      assert.notEqual(stopped.code, 0);
      const replay = await child(directory, 'restart');
      assert.equal(readState(directory).dispatch_state, expected);
      assert.equal(accepts(directory), count);
      if (boundary === 'pending') { assert.equal(replay.code, 0); assert.equal(replay.result.dispatched.length, 1); }
      else { assert.equal(replay.code, 1); assert.ok(replay.result.unresolved.length > 0); }
      const again = await child(directory, 'restart');
      assert.equal(accepts(directory), count);
      assert.equal(again.code, boundary === 'pending' ? 0 : 1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
test('accepted response loss stays ambiguous across a new process', { timeout: 35_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'radar-crash-test-'));
  try {
    const first = await child(directory, 'lost-response');
    assert.equal(first.code, 1);
    assert.equal(readState(directory).dispatch_state, 'ambiguous');
    const replay = await child(directory, 'restart');
    assert.equal(replay.code, 1);
    assert.ok(replay.result.unresolved.length > 0);
    assert.equal(accepts(directory), 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
