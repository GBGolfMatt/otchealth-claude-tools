import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, renameSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { verifyRadarImage } from './verify.mjs';
const paths = ['skills/signal-radar/radar.mjs', 'skills/signal-radar/common.mjs', 'skills/signal-radar/job/radar.sh',
  'skills/signal-radar/new-outbox.mjs', 'skills/kb-memory/pg-state.mjs', 'skills/fleet-dispatch/dispatch.mjs', 'setup/helper.mjs'];
const ids = { repo: '.', source: 'a'.repeat(40), digest: `sha256:${'b'.repeat(64)}` };
function fake({ mismatch = false, arch = 'arm64', symlink = false, sourceType = 'commit', copiedLink = false } = {}) {
  const calls = [];
  return { calls, execute(name, args) {
    calls.push([name, ...args]);
    if (name === 'git' && args.includes('-t')) return Buffer.from(sourceType);
    if (name === 'git' && args.includes('ls-tree')) return Buffer.from(paths.map(p => `${symlink ? '120000' : '100644'} blob ${'c'.repeat(40)}\t${p}\0`).join(''));
    if (name === 'git') return Buffer.from('source\n');
    if (args[0] === 'image') return Buffer.from(JSON.stringify({ Os: 'linux', Architecture: arch,
      RepoDigests: [`900915535335.dkr.ecr.us-east-1.amazonaws.com/doc-indexer@${ids.digest}`] }));
    if (args[0] === 'create') return Buffer.from('d'.repeat(64));
    if (args[0] === 'cp') {
      const prefix = args[1].split(':/app/')[1];
      for (const p of paths.filter(p => p.startsWith(prefix + '/'))) {
        const output = join(args[2], p.slice(prefix.length + 1));
        mkdirSync(dirname(output), { recursive: true });
        writeFileSync(output, mismatch && p.endsWith('new-outbox.mjs') ? 'changed' : 'source\n');
      }
      if (copiedLink && prefix === 'skills/signal-radar') {
        renameSync(args[2], args[2] + '-target');
        symlinkSync(args[2] + '-target', args[2], process.platform === 'win32' ? 'junction' : 'dir');
      }
    }
    return Buffer.from('');
  } };
}
test('covers new radar modules and shared dependencies without executing image', () => {
  const f = fake(); const r = verifyRadarImage(ids, f.execute);
  assert.equal(r.files.length, paths.length);
  assert.ok(f.calls.filter(c => c[0] === 'docker').every(c => ['pull', 'image', 'create', 'cp', 'rm'].includes(c[1])));
  assert.equal(f.calls.at(-1)[1], 'rm');
});
test('tree object cannot stand in for source commit', () => {
  const f = fake({ sourceType: 'tree' });
  assert.throws(() => verifyRadarImage(ids, f.execute), /must be a commit/);
  assert.ok(!f.calls.some(c => c[0] === 'docker'));
});
test('image-supplied symlink fails before following it and cleans container', () => {
  const f = fake({ copiedLink: true });
  assert.throws(() => verifyRadarImage(ids, f.execute), /Non-regular extracted path/);
  assert.equal(f.calls.at(-1)[1], 'rm');
});
test('new replay module mismatch fails and cleans stopped container', () => {
  const f = fake({ mismatch: true });
  assert.throws(() => verifyRadarImage(ids, f.execute), /mismatch/);
  assert.equal(f.calls.at(-1)[1], 'rm');
});
test('wrong platform fails before container creation', () => {
  const f = fake({ arch: 'amd64' });
  assert.throws(() => verifyRadarImage(ids, f.execute), /platform/);
  assert.ok(!f.calls.some(c => c[1] === 'create'));
});
test('reject mutable tag and symlink source entries before docker operations', () => {
  const f = fake();
  assert.throws(() => verifyRadarImage({ ...ids, digest: 'latest' }, f.execute), /Immutable/);
  assert.equal(f.calls.length, 0);
  const g = fake({ symlink: true });
  assert.throws(() => verifyRadarImage(ids, g.execute), /Unsupported/);
  assert.ok(!g.calls.some(c => c[0] === 'docker'));
});
