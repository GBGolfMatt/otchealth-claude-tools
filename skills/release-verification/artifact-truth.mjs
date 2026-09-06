#!/usr/bin/env node
// artifact-truth.mjs -- verify what SHIPPED, not what is in git.
//
// WHY THIS EXISTS. Two incidents in one week, both found by hand, both
// generalizable to every app in the factory:
//
//   iHEARtest, 2026-09-05. The share card hands a PNG to the iOS share sheet.
//   Choosing "Save Image" writes to the photo library on the app's behalf.
//   Info.plist had no NSPhotoLibraryAddUsageDescription, so iOS terminated the
//   process under TCC. Enumerated from the tags rather than recalled: the same
//   defect is present in the SOURCE of 42, 43 and 45 through 58 -- 16 tagged
//   builds, every one in the repo's history until 59. That is a source-level
//   blast radius, not 16 verified artifacts: those IPAs expired long ago, and
//   this file's whole point is that the two are different. Apple's own
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
// rule catches iHEARtest's crash automatically AND clears AWARE's absent key
// rather than leaving it suspicious -- the same rule, opposite verdicts, no
// per-app special-casing.
//
// SCOPE, stated plainly because the rule is easy to over-trust: this is a TEXT
// SCAN of the shipped web layer. A literal match in a comment, a string, or
// dead code counts as "reachable", and a dynamically built or heavily minified
// reference can be missed. So a violation is a strong signal worth blocking on,
// while a pass means "no shipped-bundle path matches these patterns", NOT "this
// app provably cannot reach that API". Native-only reach is invisible here by
// construction; the plist rules and a real-device run cover that.
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
  // Refuse input that is not a plist at all. The reader below is a regex over
  // key/value pairs, so ANY text containing a matching
  // <key>..</key><string>..</string> fragment would otherwise be accepted as a
  // parsed plist.
  const openAt = text.search(/<plist[\s>]/i);
  if (openAt < 0 || !/<dict[\s>]/i.test(text)) {
    throw new Error('Info.plist is not XML plist content (no <plist> / <dict> element) and does not start with the bplist00 magic');
  }
  // The shape check above is NOT sufficient, and an earlier version of this
  // function said so in a comment and then shipped it anyway. A TRUNCATED plist
  // -- the realistic corruption for a partially written file or a cut-off
  // download -- keeps its opening tags and all of its early keys, so it sails
  // through. Every key after the cut then reads as ABSENT.
  //
  // That is not just a missed exit 2. The coupling rules turn those phantom
  // absences into confident VIOLATIONS: reproduced live, a plist truncated
  // mid-`<key>NSMicroph` produced "shipped bundle textually matches
  // /getUserMedia/ but Info.plist does NOT declare NSMicrophoneUsageDescription"
  // -- a fabricated defect, in the tool's most quotable voice, about a key that
  // may well exist past the cut. Exit 2 exists so "I could not read it" is never
  // reported as a pass OR as a finding.
  //
  // So require the document to be TERMINATED and its tags BALANCED. This is
  // still not a validating XML parser and does not claim to be one; it is a
  // structural floor that catches truncation and gross mangling, which is the
  // corruption that actually happens to a file on the way out of a build.
  if (!/<\/plist\s*>/i.test(text.slice(openAt))) {
    throw new Error('Info.plist has an opening <plist> but no closing </plist>: the document is truncated, so keys past the cut would read as absent and be reported as real violations');
  }
  const count = (re) => (text.match(re) || []).length;
  // `<dict/>` self-closes, so [\s>] deliberately does not count it as an opener.
  const dictOpen = count(/<dict[\s>]/gi), dictClose = count(/<\/dict\s*>/gi);
  const keyOpen = count(/<key\s*>/gi), keyClose = count(/<\/key\s*>/gi);
  if (dictOpen !== dictClose || keyOpen !== keyClose) {
    throw new Error(`Info.plist tags do not balance (<dict> ${dictOpen}/${dictClose}, <key> ${keyOpen}/${keyClose}): the document is malformed, and a partially readable plist is not evidence about the keys it appears to lack`);
  }
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
// EXIT 2 IS THE WHOLE CONTRACT. Every step that merely *inspects* -- reading
// the manifest, unzipping, parsing Info.plist, walking the shipped bundle --
// must land on exit 2, never on exit 1. Exit 1 means "I looked and found a
// violation"; letting an unreadable plist or a malformed manifest fall through
// as a generic nonzero would say the artifact is bad when the truth is that we
// never managed to look at it. Those are different facts and a release gate has
// to keep them apart.
function inspect(what, fn) {
  try {
    return fn();
  } catch (e) {
    console.error(`ARTIFACT UNREADABLE: ${what}: ${e && e.message}`);
    console.error('Failing with exit 2. Being unable to inspect is never reported as clean, and never as a violation either.');
    process.exit(2);
  }
}

// An id is a literal, so escape it before it becomes part of a pattern.
function escapeForRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const RENDERED_VERSION_KEY = Symbol('renderedVersion');

const manifest = inspect(`reading manifest ${manifestPath}`, () => JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
const expect = manifest.expect || {};

// Compile every pattern up front, inside inspect(). A manifest is valid JSON
// long before it is a valid RULE SET: `ifBundleMatches: "["` parses fine and
// then throws a SyntaxError at `new RegExp` deep in the run, which Node turns
// into exit 1 -- reporting a broken verifier configuration as a discovered
// violation of the artifact. Those are opposite conclusions. Compiling here
// also means a rule missing its required fields fails closed instead of
// matching nothing and quietly passing.
const compiled = inspect(`validating rules in ${manifestPath}`, () => {
  const patterns = new Map();
  const compile = (where, source) => {
    if (typeof source !== 'string' || source === '') throw new Error(`${where}: pattern must be a non-empty string, got ${JSON.stringify(source)}`);
    try {
      patterns.set(source, new RegExp(source));
    } catch (e) {
      throw new Error(`${where}: /${source}/ is not a valid regular expression (${e.message})`);
    }
  };
  for (const [i, r] of ((expect.webBundle && expect.webBundle.mustContain) || []).entries()) compile(`webBundle.mustContain[${i}]`, r.pattern);
  for (const [i, r] of ((expect.webBundle && expect.webBundle.mustNotContain) || []).entries()) compile(`webBundle.mustNotContain[${i}]`, r.pattern);
  for (const [i, r] of (expect.capabilityCoupling || []).entries()) {
    compile(`capabilityCoupling[${i}].ifBundleMatches`, r.ifBundleMatches);
    if (r.andBundleMatches !== undefined) compile(`capabilityCoupling[${i}].andBundleMatches`, r.andBundleMatches);
    if (typeof r.requirePlistKey !== 'string' || r.requirePlistKey === '') {
      throw new Error(`capabilityCoupling[${i}]: requirePlistKey must be a non-empty string, got ${JSON.stringify(r.requirePlistKey)}`);
    }
  }
  // infoPlist rules carry no regex, but a malformed one is just as bad: an
  // entry with no `key` becomes `plist[undefined]`, which quietly reports
  // "undefined MISSING" or passes a forbidden check that never looked at
  // anything. Nonsense matching is worse than a crash because it is reported
  // as a result.
  const ip = expect.infoPlist || {};
  for (const [i, r] of (ip.required || []).entries()) {
    if (typeof r.key !== 'string' || r.key === '') throw new Error(`infoPlist.required[${i}]: key must be a non-empty string, got ${JSON.stringify(r.key)}`);
  }
  for (const [i, r] of (ip.forbidden || []).entries()) {
    if (typeof r.key !== 'string' || r.key === '') throw new Error(`infoPlist.forbidden[${i}]: key must be a non-empty string, got ${JSON.stringify(r.key)}`);
  }
  for (const k of Object.keys(ip.equals || {})) {
    if (k === '') throw new Error('infoPlist.equals: keys must be non-empty strings');
  }
  if (expect.renderedVersion) {
    const id = expect.renderedVersion.elementId;
    if (typeof id !== 'string' || id === '') throw new Error('renderedVersion.elementId must be a non-empty string');
    // Compile it HERE, and escape it. An elementId is an HTML id, not a
    // pattern: interpolating it raw meant an id like `[` threw at RegExp
    // construction outside inspect() (exit 1, claiming the artifact was at
    // fault), and any id containing regex metacharacters could quietly match
    // the wrong element.
    patterns.set(RENDERED_VERSION_KEY, new RegExp(`<[^>]*\\bid\\s*=\\s*["']${escapeForRegExp(id)}["'][^>]*>([^<]*)<`));
  }
  return patterns;
});
const rx = (source) => compiled.get(source);
const violations = [];
const passes = [];

const art = inspect(`opening ${ipaPath}`, () => extract(ipaPath));

const plist = inspect('parsing Info.plist', () => {
  const parsed = readPlist(path.join(art.appDir, 'Info.plist'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Info.plist did not parse to a dictionary');
  }
  // An EMPTY object is the dangerous case, and it is what the XML reader
  // returns for any input it does not understand -- malformed XML, truncated
  // output, or plain garbage all yield {} because the key/value regex simply
  // finds no matches. {} is a dictionary, so a type check alone lets it
  // through, and then every plist rule passes vacuously and the run prints
  // VERDICT: CLEAN over an artifact nobody managed to read. Every real
  // Info.plist in a built app has CFBundleIdentifier, so its absence means the
  // parse failed rather than that the app lacks an identifier.
  const keys = Object.keys(parsed);
  if (keys.length === 0) throw new Error('Info.plist parsed to an empty dictionary (malformed, truncated, or not a plist at all)');
  if (!('CFBundleIdentifier' in parsed)) {
    throw new Error(`Info.plist parsed but has no CFBundleIdentifier (got ${keys.length} key(s): ${keys.slice(0, 5).join(', ')}) -- treating this as a failed parse rather than a readable plist`);
  }
  return parsed;
});

const wantedRoot = expect.webBundle && expect.webBundle.root;
const bundle = inspect('reading the shipped web bundle', () => {
  // A bundle-reading rule REQUIRES an explicit root. Without one the scan walked
  // the whole .app, which is not the thing these rules make claims about: an
  // .app carries localization strings, resource JSON and embedded framework
  // text, so a capability rule could match a file that is not the web payload
  // and report a violation about code the web layer never contains. The
  // zero-files guard below cannot catch that, because in the whole-.app case
  // there ARE files -- just the wrong ones.
  //
  // Naming the root also makes the scan deterministic and makes a wrong root
  // fail loudly (the missing-root branch above) instead of silently widening.
  // Both real manifests already set "public"; this makes that the contract.
  const needsRoot = Boolean(
    expect.renderedVersion ||
    (expect.capabilityCoupling || []).length ||
    ((expect.webBundle && expect.webBundle.mustContain) || []).length ||
    ((expect.webBundle && expect.webBundle.mustNotContain) || []).length,
  );
  if (needsRoot && !wantedRoot) {
    throw new Error(
      'this manifest has rules that read the shipped bundle but does not set webBundle.root, ' +
      'so the scan would walk the entire .app rather than the web payload those rules describe. ' +
      'Set webBundle.root (usually "public").',
    );
  }
  const b = readShippedText(art.appDir, wantedRoot);
  // A typo in `root` used to set missing:true, which made every webBundle and
  // capabilityCoupling rule skip and the run print VERDICT: CLEAN. That is the
  // central mechanism silently disabling itself, which is the exact failure
  // this tool exists to make impossible.
  if (b.missing) {
    throw new Error(`webBundle.root "${wantedRoot}" does not exist inside the shipped .app (is it "public"?)`);
  }
  // Zero scanned files is fatal whenever ANY rule reads the bundle, whether or
  // not a root was named.
  //
  // The first version of this guard read `if (wantedRoot && files.length === 0)`,
  // which meant a manifest with capabilityCoupling and no webBundle.root fell
  // through: the scan rooted at the .app itself, found no text (a real bundle's
  // top level is compiled binaries), and every coupling rule then reported "no
  // shipped-bundle path matches" and the run printed CLEAN. Verifying nothing
  // and finding nothing print the same way, which is the exact failure this
  // whole tool exists to prevent -- and I introduced it while writing the guard
  // against it. Condition the check on what the rules NEED, never on what the
  // manifest happened to say.
  const readsBundle = Boolean(
    wantedRoot ||
    expect.renderedVersion ||
    (expect.capabilityCoupling || []).length ||
    ((expect.webBundle && expect.webBundle.mustContain) || []).length ||
    ((expect.webBundle && expect.webBundle.mustNotContain) || []).length,
  );
  if (readsBundle && b.files.length === 0) {
    throw new Error(
      `no readable text files under ${wantedRoot ? `webBundle.root "${wantedRoot}"` : 'the app bundle root'}, ` +
      'but this manifest has rules that read the shipped bundle -- every one of them would pass vacuously. ' +
      'Set webBundle.root to where the web layer actually lives (usually "public").',
    );
  }
  return b;
});

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
    // Match with the COMPILED regex. These were compiled during validation but
    // then evaluated with String.includes, so `getUserMedia|mediaDevices` was
    // silently searched for as that literal 24-character string and matched
    // nothing -- a rule that looks like it is guarding and is not.
    for (const c of expect.webBundle.mustNotContain || []) {
      const hits = bundle.files.filter((f) => rx(c.pattern).test(f.text)).map((f) => f.rel);
      if (hits.length) violations.push({ rule: 'webBundle.mustNotContain', detail: `${c.pattern} found in ${hits.slice(0, 4).join(', ')}`, why: c.why });
      else passes.push(`bundle excludes ${c.pattern}`);
    }
    for (const c of expect.webBundle.mustContain || []) {
      if (rx(c.pattern).test(hay)) passes.push(`bundle contains ${c.pattern}`);
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
    // Accept single OR double quotes around the id, and allow the id anywhere
    // in the tag rather than requiring it first: `<span class="x" id='tag'>` is
    // valid HTML that the old double-quote-only pattern reported as a release
    // defect. The static-markup assumption that remains is real and stated in
    // the message: this reads the SHIPPED HTML, so a version injected purely at
    // runtime by client-side rendering cannot be seen here and the rule should
    // not be declared for such an app.
    const id = expect.renderedVersion.elementId;
    const m = idxFile.text.match(compiled.get(RENDERED_VERSION_KEY));
    const rendered = m ? m[1].trim() : null;
    const want = `v${plist.CFBundleShortVersionString}`;
    if (rendered === want) passes.push(`rendered version tag "${rendered}" matches the binary`);
    else if (rendered === null) violations.push({ rule: 'renderedVersion', detail: `no element with id "${id}" and literal text found in ${idxFile.rel}`, why: 'either the tag was removed, or its text is rendered at runtime -- in which case this rule cannot verify it and should not be declared for this app' });
    else violations.push({ rule: 'renderedVersion', detail: `version tag renders ${JSON.stringify(rendered)}, binary is ${JSON.stringify(want)}`, why: 'the in-app version must match the build, and an unsubstituted template here also mis-tags every error report to a nonsense release' });
  }
}

// --- 3. Capability coupling: the rule that generalizes ---------------------
// If the SHIPPED bundle can reach a privacy-sensitive API, the SHIPPED
// Info.plist must declare it. Derived, not hand-maintained -- which is why it
// flags iHEARtest's missing photo key and simultaneously clears AWARE's
// absent microphone key as correct.
for (const rule of expect.capabilityCoupling || []) {
  // `andBundleMatches` narrows a rule to files matching BOTH patterns. Needed
  // because a share call alone does not imply a photo-library write: sharing a
  // PDF offers Save to Files, sharing a PNG offers Save Image, and only the
  // second reaches the library. Both patterns must hit the SAME file, since two
  // unrelated modules happening to mention each is not evidence of one flow.
  const primary = rx(rule.ifBundleMatches);
  const secondary = rule.andBundleMatches ? rx(rule.andBundleMatches) : null;
  // Named `matched`, not `reached`. This is a text scan: it establishes that
  // the shipped bytes CONTAIN the pattern, which is a capability indicator, not
  // a proof that control flow gets there. A hit in a comment or in dead code
  // counts; a dynamically built reference is missed. Every message below is
  // worded to that strength on purpose, because these lines get lifted verbatim
  // into reviewer packets and PR comments, where an overclaim outlives the run.
  const matched = bundle.files
    .filter((f) => primary.test(f.text) && (!secondary || secondary.test(f.text)))
    .map((f) => f.rel);
  const pattern = secondary ? `/${rule.ifBundleMatches}/ AND /${rule.andBundleMatches}/` : `/${rule.ifBundleMatches}/`;
  // "Declared" has to mean a USABLE purpose string, not merely a present key.
  // A usage description is the sentence iOS shows the user, and an empty or
  // non-string value is not one: `in` alone would report CLEAN for an artifact
  // that still has no valid TCC disclosure, which is the very failure this rule
  // exists to catch. Present-but-unusable gets its own message, because "does
  // NOT declare" would send someone looking for a missing key that is right
  // there.
  const raw = Object.prototype.hasOwnProperty.call(plist, rule.requirePlistKey) ? plist[rule.requirePlistKey] : undefined;
  const present = raw !== undefined;
  const declared = typeof raw === 'string' && raw.trim() !== '';
  if (present && !declared) {
    violations.push({
      rule: 'capabilityCoupling',
      detail: `Info.plist has ${rule.requirePlistKey} but its value is not a usable purpose string (${JSON.stringify(raw)})`,
      why: 'iOS shows this string in the permission prompt; an empty or non-string value is not a disclosure, and the shipped bundle ' + (matched.length ? `textually matches ${pattern}` : 'may still reach it by a path this text scan cannot see'),
    });
  } else if (matched.length && !declared) {
    violations.push({
      rule: 'capabilityCoupling',
      detail: `shipped bundle textually matches ${pattern} (${matched.slice(0, 3).join(', ')}) but Info.plist does NOT declare ${rule.requirePlistKey}`,
      why: (rule.why || 'iOS terminates the process under TCC when an undeclared privacy-sensitive API is reached') + ' -- this is a text match, so confirm the call is live before treating it as the diagnosed cause; the block is fail-safe either way, since the correct fix for a genuine hit is to declare the key',
    });
  } else if (matched.length && declared) {
    passes.push(`capability ${rule.requirePlistKey}: shipped bundle matches ${pattern} AND the key is declared`);
  } else if (declared && rule.forbidIfUnreachable) {
    violations.push({
      rule: 'capabilityCoupling',
      detail: `Info.plist declares ${rule.requirePlistKey} but no shipped-bundle path matches ${pattern}`,
      why: 'over-declaring a permission invites App Review questions and misleads users',
    });
  } else if (declared) {
    // No text match but declared, with over-declaring tolerated for this rule.
    // (The manifest key is still spelled `forbidIfUnreachable`; renaming a
    // published schema key for a wording nit would break every manifest, and
    // the OUTPUT is what gets quoted.)
    // This used to print "correctly undeclared", which was simply false: the
    // key IS declared. A report that misstates what it found is worse than no
    // report, because it is quotable.
    passes.push(`capability ${rule.requirePlistKey}: declared, and no shipped-bundle path matches ${pattern} (tolerated: this rule does not set forbidIfUnreachable, so a native-only path may justify it)`);
  } else {
    passes.push(`capability ${rule.requirePlistKey}: no shipped-bundle path matches ${pattern}, and the key is undeclared`);
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
