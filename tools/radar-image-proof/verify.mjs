import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const prefixes = ['skills/signal-radar/', 'skills/kb-memory/', 'skills/fleet-dispatch/', 'setup/'];
const executeCommand = (name, args) => {
  const r = spawnSync(name, args, { maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
  if (r.status !== 0) throw new Error(`${name} failed; output suppressed`);
  return r.stdout;
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Never starts the container. Source is read from Git objects, not a dirty checkout.
export function verifyRadarImage({ repo, source, digest }, execute = executeCommand) {
  if (!/^[a-f0-9]{40}$/.test(source ?? '') || !/^sha256:[a-f0-9]{64}$/.test(digest ?? '')) {
    throw new Error('Immutable source and image identities required');
  }
  if (execute('git', ['-C', repo, 'cat-file', '-t', source]).toString().trim() !== 'commit') {
    throw new Error('Source object must be a commit');
  }
  const rows = execute('git', ['-C', repo, 'ls-tree', '-rz', '--full-tree', source, '--', ...prefixes])
    .toString().split('\0').filter(Boolean);
  const files = rows.map(row => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(row);
    if (!match || !prefixes.some(p => match[3].startsWith(p)) || match[3].split('/').some(p => p === '..')
        || /[\\\r\n]/.test(match[3])) throw new Error('Unsupported source tree entry');
    return { file: match[3], object: match[2] };
  });
  for (const required of ['skills/signal-radar/radar.mjs', 'skills/signal-radar/common.mjs',
    'skills/signal-radar/job/radar.sh', 'skills/kb-memory/pg-state.mjs', 'skills/fleet-dispatch/dispatch.mjs']) {
    if (!files.some(x => x.file === required)) throw new Error(`Missing required source: ${required}`);
  }
  const image = `900915535335.dkr.ecr.us-east-1.amazonaws.com/doc-indexer@${digest}`;
  const dir = mkdtempSync(join(tmpdir(), 'radar-image-proof-'));
  let container;
  try {
    execute('docker', ['pull', '--platform', 'linux/arm64', image]);
    const identity = JSON.parse(execute('docker', ['image', 'inspect', image, '--format', '{{json .}}']).toString());
    if (identity.Os !== 'linux' || identity.Architecture !== 'arm64') throw new Error('Wrong image platform');
    if (!identity.RepoDigests?.includes(image)) throw new Error('Inspected digest does not match requested image');
    container = execute('docker', ['create', '--platform', 'linux/arm64', '--entrypoint', '/bin/true', image]).toString().trim();
    if (!/^[a-f0-9]{64}$/.test(container)) throw new Error('Invalid container identifier');
    for (const prefix of prefixes) {
      const dest = join(dir, prefix.slice(0, -1));
      mkdirSync(dirname(dest), { recursive: true });
      execute('docker', ['cp', `${container}:/app/${prefix.slice(0, -1)}`, dest]);
    }
    const verified = files.map(({ file, object }) => {
      const expected = hash(execute('git', ['-C', repo, 'cat-file', 'blob', object]));
      let current = dir;
      const parts = file.split('/');
      for (let i = 0; i < parts.length; i++) {
        current = join(current, parts[i]);
        const stat = lstatSync(current);
        if (stat.isSymbolicLink() || (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
          throw new Error(`Non-regular extracted path: ${file}`);
        }
      }
      const actual = hash(readFileSync(join(dir, file)));
      if (actual !== expected) throw new Error(`Image/source mismatch: ${file}`);
      return { file, sha256: actual };
    });
    return { source, image, platform: 'linux/arm64', match: true, files: verified,
      scope: 'Tracked files in radar, kb-memory, fleet-dispatch and setup. Other detector dependencies, external services, build provenance and runtime acceptance are not established.' };
  } finally {
    try { if (/^[a-f0-9]{64}$/.test(container ?? '')) execute('docker', ['rm', container]); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 6) throw new Error('Usage: verify.mjs checkout source-commit platform-digest receipt-path');
  const [repo, source, digest, output] = process.argv.slice(2);
  const receipt = verifyRadarImage({ repo, source, digest });
  writeFileSync(output, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ source, image: receipt.image, match: true, verifiedFiles: receipt.files.length, scope: receipt.scope }));
}
