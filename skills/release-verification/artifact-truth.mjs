#!/usr/bin/env node
// artifact-truth.mjs -- verify what SHIPPED, not what is in git.
//
// WHY THIS EXISTS. Two incidents in one week, both found by hand, both
// generalizable to every app in the factory:
//
//   iHEARtest, 2026-09-05. The share card hands a PNG to the iOS share sheet.
//   Choosing "Save Image" writes to the photo library on the app's behalf.
//   Info.plist had no NSPhotoLibraryAddUsageDescription, so iOS terminated the
//   process under TCC. It shipped in builds 53, 56, 57 and 58. Apple's own
//   binary scanner cannot catch it: that scanner does static API-surface
//   analysis and the app links no PhotoKit -- the share sheet reaches the
//   library for us. Only a real device shows it, as a runtime kill.
//
//   AWARE, 2026-09-06. The repo's www/ contains getUserMedia in two modules
//   reachable from visible buttons, and the shipped Info.plist declares no
//   microphone key -- which reads as the identical crash. It is not: the
//   PUBLIC build assembles a DIFFERENT bundle, and the shipped IPA contains
//   no getUserMedia at all. Reading the repo produced a false P0; reading the
//   artifact produced the truth.
//
// The lesson generalizes past both: source is a claim, the artifact is the
// fact. So this tool opens the thing that actually ships and checks it.
//
// THE CENTRAL IDEA is `capabilityCoupling`: rather than maintaining a
// hand-written list of "this app needs that key", DERIVE the requirement from
// what the shipped bundle actually does. If the shipped web layer can reach a
// privacy-sensitive API, the shipped Info.plist must declare it. That single
// rule catches iHEARtest's crash automatically AND certifies AWARE's absent
// key as correct rather than suspicious -- the same rule, opposite verdicts,
// no per-app special-casing.
//
// Usage:
//   node artifact-truth.mjs --ipa <path/to/App.ipa> --manifest <app.release-truth.json> [--json]
//
// Exit 0 = every declared expectation holds. Exit 1 = at least one violation.
// Exit 2 = could not inspect the artifact at all (never reported as a pass).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const asJson = process.argv.includes('--json');

const ipaPath = arg('ipa');
const manifestPath = arg('manifest');
if (!ipaPath || !manifestPath) {
  console.error('usage: artifact-truth.mjs --ipa <App.ipa> --manifest <release-truth.json> [--json]');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Extraction. Deliberately fails LOUD: an artifact we cannot open must never
// be reported as clean, because "no violations found" and "we never looked"
// print the same way otherwise.
// ---------------------------------------------------------------------------
function extract(ipa) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-truth-'));
  try {
    execFileSync('unzip', ['-o', '-q', ipa, 'Payload/*', '-d', dir], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    throw new Error(`could not unzip ${ipa}: ${e && e.message}`);
  }
  const payload = path.join(dir, 'Payload');
  if (!fs.existsSync(payload)) throw new Error(`no Payload/ inside ${ipa} -- not an iOS app archive?`);
  const app = fs.readdirSync(payload).find((n) => n.endsWith('.app'));
  if (!app) throw new Error(`no .app bundle inside Payload/ of ${ipa}`);
  return { root: dir, appDir: path.join(payload, app) };
}

// plutil is macOS-only, so convert the binary plist ourselves. Info.plist in a
// built IPA is almost always binary (bplist00); the XML branch covers the
// occasional uncompiled one.
function readPlist(file) {
  const buf = fs.readFileSync(file);
  if (buf.slice(0, 6).toString('latin1') === 'bplist') return parseBinaryPlist(buf);
  const text = buf.toString('utf8');
  const out = {};
  // Minimal XML plist reader: enough for <key>/<string>/<true>/<false>, which
  // is all these expectations ever assert against.
  const re = /<key>([^<]+)<\/key>\s*(?:<string>([\s\S]*?)<\/string>|<(true|false)\s*\/>)/g;
  let m;
  while ((m = re.exec(text))) out[m[1]] = m[2] !== undefined ? m[2] : m[3] === 'true';
  return out;
}

// Small binary-plist reader covering the object types an Info.plist uses.
function parseBinaryPlist(buf) {
  const trailer = buf.subarray(buf.length - 32);
  const offsetSize = trailer[6];
  const objRefSize = trailer[7];
  const numObjects = Number(trailer.readBigUInt64BE(8));
  const topObject = Number(trailer.readBigUInt64BE(16));
  const offsetTableStart = Number(trailer.readBigUInt64BE(24));
  const offsets = [];
  for (let i = 0; i < numObjects; i++) {
    let v = 0;
    for (let b = 0; b < offsetSize; b++) v = v * 256 + buf[offsetTableStart + i * offsetSize + b];
    offsets.push(v);
  }
  const readRef = (pos) => {
    let v = 0;
    for (let b = 0; b < objRefSize; b++) v = v * 256 + buf[pos + b];
    return v;
  };
  function readLen(pos, low) {
    if (low !== 0x0f) return { len: low, next: pos };
    const t = buf[pos];
    const n = 1 << (t & 0x0f);
    let v = 0;
    for (let b = 0; b < n; b++) v = v * 256 + buf[pos + 1 + b];
    return { len: v, next: pos + 1 + n };
  }
  function obj(index) {
    const pos = offsets[index];
    const marker = buf[pos];
    const high = marker >> 4;
    const low = marker & 0x0f;
    if (marker === 0x08) return false;
    if (marker === 0x09) return true;
    if (high === 0x1) {
      const n = 1 << low;
      let v = 0;
      for (let b = 0; b < n; b++) v = v * 256 + buf[pos + 1 + b];
      return v;
    }
    if (high === 0x5) { const { len, next } = readLen(pos + 1, low); return buf.subarray(next, next + len).toString('ascii'); }
    if (high === 0x6) { const { len, next } = readLen(pos + 1, low); return buf.subarray(next, next + len * 2).swap16().toString('utf16le'); }
    if (high === 0xa) {
      const { len, next } = readLen(pos + 1, low);
      return Array.from({ length: len }, (_, i) => obj(readRef(next + i * objRefSize)));
    }
    if (high === 0xd) {
      const { len, next } = readLen(pos + 1, low);
      const out = {};
      for (let i = 0; i < len; i++) {
        const k = obj(readRef(next + i * objRefSize));
        const v = obj(readRef(next + len * objRefSize + i * objRefSize));
        out[k] = v;
      }
      return out;
    }
    return null; // types this checker never asserts against
  }
  return obj(topObject);
}

// Read every shipped text file under the app bundle once, so bundle rules and
// capability coupling scan the SAME bytes the device runs.
function readShippedText(appDir, subdir) {
  const root = subdir ? path.join(appDir, subdir) : appDir;
  const files = [];
  if (!fs.existsSync(root)) return { root, files, missing: true };
  const TEXT = new Set(['.html', '.js', '.mjs', '.cjs', '.json', '.css', '.svg', '.txt']);
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (TEXT.has(path.extname(e.name).toLowerCase())) {
        files.push({ rel: path.relative(root, abs), text: fs.readFileSync(abs, 'utf8') });
      }
    }
  })(root);
  return { root, files, missing: false };
}

// ---------------------------------------------------------------------------
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const expect = manifest.expect || {};
const violations = [];
const passes = [];

let art;
try {
  art = extract(ipaPath);
} catch (e) {
  console.error(`ARTIFACT UNREADABLE: ${e.message}`);
  console.error('Failing with exit 2. An artifact we cannot open is never reported as clean.');
  process.exit(2);
}

const plist = readPlist(path.join(art.appDir, 'Info.plist'));
const bundle = readShippedText(art.appDir, expect.webBundle && expect.webBundle.root);

// --- 1. Info.plist expectations -------------------------------------------
for (const r of (expect.infoPlist && expect.infoPlist.required) || []) {
  const v = plist[r.key];
  if (typeof v === 'string' ? v.trim() : v) passes.push(`plist requires ${r.key}: present`);
  else violations.push({ rule: 'infoPlist.required', detail: `${r.key} MISSING`, why: r.why });
}
for (const f of (expect.infoPlist && expect.infoPlist.forbidden) || []) {
  if (f.key in plist) violations.push({ rule: 'infoPlist.forbidden', detail: `${f.key} PRESENT`, why: f.why });
  else passes.push(`plist forbids ${f.key}: absent`);
}
for (const [k, want] of Object.entries((expect.infoPlist && expect.infoPlist.equals) || {})) {
  if (String(plist[k]) === String(want)) passes.push(`plist ${k} == ${want}`);
  else violations.push({ rule: 'infoPlist.equals', detail: `${k} is ${JSON.stringify(plist[k])}, expected ${JSON.stringify(want)}`, why: 'identity/version drift between what was built and what was claimed' });
}

// --- 2. Shipped web-bundle expectations -----------------------------------
// This is the AWARE lesson: assert against the bundle that ships, never the
// repo tree, because a build can assemble something entirely different.
if (expect.webBundle) {
  if (bundle.missing) {
    violations.push({ rule: 'webBundle', detail: `declared bundle root not found in the artifact: ${expect.webBundle.root}`, why: 'the manifest describes a bundle layout this build does not produce' });
  } else {
    const hay = bundle.files.map((f) => `\n/*${f.rel}*/\n${f.text}`).join('');
    for (const c of expect.webBundle.mustNotContain || []) {
      const hits = bundle.files.filter((f) => f.text.includes(c.pattern)).map((f) => f.rel);
      if (hits.length) violations.push({ rule: 'webBundle.mustNotContain', detail: `${c.pattern} found in ${hits.slice(0, 4).join(', ')}`, why: c.why });
      else passes.push(`bundle excludes ${c.pattern}`);
    }
    for (const c of expect.webBundle.mustContain || []) {
      if (hay.includes(c.pattern)) passes.push(`bundle contains ${c.pattern}`);
      else violations.push({ rule: 'webBundle.mustContain', detail: `${c.pattern} NOT found in the shipped bundle`, why: c.why });
    }
  }
}

// --- 2b. Rendered version -------------------------------------------------
// Assert the OUTCOME, not the mechanism. The first draft of this checker had a
// mustNotContain rule for the literal "{{APP_VERSION}}" token and it fired on
// Build 59 -- against three COMMENTS in native.js that document the
// substitution step, plus the defensive code that strips an unfilled
// placeholder. A live defect was reported that did not exist. Checking what the
// user actually sees is both stricter and immune to prose: if substitution
// silently fails, the rendered tag stops matching the binary's own version.
if (expect.renderedVersion) {
  const idxFile = bundle.files.find((f) => f.rel === (expect.renderedVersion.file || 'index.html'));
  if (!idxFile) {
    violations.push({ rule: 'renderedVersion', detail: `cannot find ${expect.renderedVersion.file || 'index.html'} in the shipped bundle`, why: 'the version the user sees cannot be verified' });
  } else {
    const re = new RegExp(`id="${expect.renderedVersion.elementId}"[^>]*>([^<]*)<`);
    const m = idxFile.text.match(re);
    const rendered = m ? m[1].trim() : null;
    const want = `v${plist.CFBundleShortVersionString}`;
    if (rendered === want) passes.push(`rendered version tag "${rendered}" matches the binary`);
    else violations.push({ rule: 'renderedVersion', detail: `version tag renders ${JSON.stringify(rendered)}, binary is ${JSON.stringify(want)}`, why: 'the in-app version must match the build, and an unsubstituted template here also mis-tags every error report to a nonsense release' });
  }
}

// --- 3. Capability coupling: the rule that generalizes ---------------------
// If the SHIPPED bundle can reach a privacy-sensitive API, the SHIPPED
// Info.plist must declare it. Derived, not hand-maintained -- which is why it
// flags iHEARtest's missing photo key and simultaneously certifies AWARE's
// absent microphone key as correct.
for (const rule of expect.capabilityCoupling || []) {
  if (bundle.missing) continue;
  const reached = bundle.files.filter((f) => new RegExp(rule.ifBundleMatches).test(f.text)).map((f) => f.rel);
  const declared = rule.requirePlistKey in plist;
  if (reached.length && !declared) {
    violations.push({
      rule: 'capabilityCoupling',
      detail: `shipped bundle reaches /${rule.ifBundleMatches}/ (${reached.slice(0, 3).join(', ')}) but Info.plist does NOT declare ${rule.requirePlistKey}`,
      why: rule.why || 'iOS terminates the process under TCC when an undeclared privacy-sensitive API is reached',
    });
  } else if (reached.length && declared) {
    passes.push(`capability ${rule.requirePlistKey}: reachable in bundle AND declared`);
  } else if (!reached.length && declared && rule.forbidIfUnreachable) {
    violations.push({
      rule: 'capabilityCoupling',
      detail: `Info.plist declares ${rule.requirePlistKey} but nothing in the shipped bundle reaches /${rule.ifBundleMatches}/`,
      why: 'over-declaring a permission invites App Review questions and misleads users',
    });
  } else if (!reached.length) {
    passes.push(`capability ${rule.requirePlistKey}: unreachable in bundle, correctly undeclared`);
  }
}

// ---------------------------------------------------------------------------
const result = {
  app: manifest.app,
  ipa: path.basename(ipaPath),
  bundleId: plist.CFBundleIdentifier,
  version: `${plist.CFBundleShortVersionString} (${plist.CFBundleVersion})`,
  shippedBundleFiles: bundle.missing ? 0 : bundle.files.length,
  passes,
  violations,
  verdict: violations.length ? 'VIOLATIONS' : 'CLEAN',
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`artifact-truth: ${result.app} ${result.version} ${result.bundleId}`);
  console.log(`shipped bundle: ${result.shippedBundleFiles} text files under ${(expect.webBundle && expect.webBundle.root) || '(app root)'}`);
  for (const p of passes) console.log(`  ok    ${p}`);
  for (const v of violations) console.log(`  FAIL  [${v.rule}] ${v.detail}\n        why: ${v.why}`);
  console.log(result.violations.length ? `\nVERDICT: ${violations.length} violation(s)` : '\nVERDICT: CLEAN');
}

try { fs.rmSync(art.root, { recursive: true, force: true }); } catch {}
process.exitCode = violations.length ? 1 : 0;
