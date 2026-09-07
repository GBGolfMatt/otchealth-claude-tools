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
//   this file's whole point is that the two are different. There is also
//   nothing here for a symbol-based scan to find: the app links no PhotoKit
//   at all, because the write happens inside UIActivityViewController on the
//   user's behalf when they choose Save Image. Only a real device shows it,
//   as a runtime kill. (An earlier version of this comment asserted what
//   Apple's own scanner does internally. That was an unsourced claim about
//   someone else's tooling, removed from SKILL.md and then left here -- a
//   correction that reached the doc and not the code it describes.)
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
// what the shipped bundle actually contains. If the shipped web layer's TEXT
// MATCHES a privacy-sensitive API's pattern, the shipped Info.plist must
// declare it. That single rule catches iHEARtest's crash automatically AND clears AWARE's absent key
// rather than leaving it suspicious -- the same rule, opposite verdicts, no
// per-app special-casing.
//
// SCOPE, stated plainly because the rule is easy to over-trust: this is a TEXT
// SCAN of the shipped web layer. A literal match in a comment, a string, or
// dead code counts as a MATCH, and a dynamically built or heavily minified
// reference can be missed. So a violation is a strong signal worth blocking on,
// while a pass means "no shipped-bundle path matches these patterns", NOT "this
// app provably cannot reach that API". Native-only reach is invisible here by
// construction, and nothing in this tool closes that: the plist rules only
// check the keys a manifest names, and a finite device run samples paths
// rather than enumerating them. They REDUCE the gap; neither covers it.
//
// Usage:
//   node artifact-truth.mjs --ipa <path/to/App.ipa> --manifest <app.release-truth.json> [--json]
//
// EXIT CODES. 0 = every declared expectation holds. 1 = at least one violation.
// 2 = could not inspect the ARTIFACT (never reported as a pass). 3 = the
// VERIFIER ITSELF is unusable -- missing arguments, unreadable or invalid
// manifest, a rule that will not compile. 2 and 3 both block; they are separate
// because 2 is a statement about the build and 3 is a statement about our own
// configuration, and printing the former when the latter is true sends someone
// to debug an artifact that is fine.

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
  process.exit(3);   // caller error, not an unreadable artifact -- see EXIT CODES above
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
  // EXACTLY ONE top-level .app, not the first one readdir happens to return.
  // This is not a hypothetical layout: an embedded watch app built with
  // SKIP_INSTALL=NO archives as a SECOND top-level .app -- a misconfiguration
  // this fleet has actually shipped into (see the Flatstick watch/widget
  // notes). With `.find()` the tool would parse whichever bundle the directory
  // listing yielded first, scan its web layer, and print a CLEAN verdict about
  // the wrong app. Worse, readdir order is not guaranteed, so which bundle got
  // verified could differ between runs on the same artifact.
  //
  // Ambiguity here is exactly the case exit 2 exists for: an artifact we cannot
  // identify unambiguously has not been verified, whatever the rules say.
  const apps = fs.readdirSync(payload).filter((n) => n.endsWith('.app'));
  if (apps.length === 0) throw new Error(`no .app bundle inside Payload/ of ${ipa}`);
  if (apps.length > 1) {
    throw new Error(
      `Payload/ of ${path.basename(ipa)} holds ${apps.length} top-level .app bundles (${apps.join(', ')}), ` +
      'so there is no single artifact to make claims about. A watch app built with SKIP_INSTALL=NO ' +
      'produces this. Fix the archive rather than letting the tool guess which one shipped.',
    );
  }
  const app = apps[0];
  const appDir = path.join(payload, app);

  // ANCHOR THE BOUNDARY HERE, not downstream. readShippedText treats
  // realpath(appDir) as its trusted base, which is only sound if appDir is
  // itself inside the extraction. It is not automatically: an archive can store
  // `Payload/App.app` (or `Payload` itself) as a SYMLINK, and unzip restores it.
  //
  // Reproduced before fixing. With the .app a symlink to a foreign bundle, the
  // run read that bundle's Info.plist -- reporting version 9.9.9, which never
  // shipped -- scanned its web layer, and emitted a violation naming a file the
  // artifact does not contain. The downstream symlink checks could not help,
  // because deriving the trusted base FROM the compromised value makes every
  // foreign path trivially "inside" it.
  //
  // A boundary is only as good as the thing it is anchored to, so anchor to the
  // directory this process created and validate inward from there.
  const realDir = fs.realpathSync(dir);
  const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);
  const realPayload = fs.realpathSync(payload);
  if (!within(realPayload, realDir)) {
    throw new Error(`Payload/ in ${path.basename(ipa)} resolves to ${realPayload}, outside the extraction directory -- the archive stores it as a symlink`);
  }
  const realApp = fs.realpathSync(appDir);
  if (!within(realApp, realPayload)) {
    throw new Error(`${app} resolves to ${realApp}, outside the extracted Payload/ -- the archive stores the .app as a symlink, so nothing under it is evidence about this artifact`);
  }
  return { root: dir, appDir };
}

// plutil is macOS-only, so convert the binary plist ourselves. Info.plist in a
// built IPA is almost always binary (bplist00); the XML branch covers the
// occasional uncompiled one. The dispatch matches the 6-char "bplist" prefix
// on purpose while the parser demands the full "bplist00": a file that claims
// to be a bplist of some other version must reach the binary parser and be
// REFUSED there by name, not fall through to the XML branch and be rejected
// with a misleading "not XML plist content".
function readPlist(file) {
  const buf = fs.readFileSync(file);
  if (buf.slice(0, 6).toString('latin1') === 'bplist') return parseBinaryPlist(buf);
  return parseXmlPlist(buf.toString('utf8'));
}

// XML plist reader.
//
// What it replaced, and why that mattered: the old reader was ONE global regex
// over `<key>..</key><string>..</string>` pairs, run across the whole document.
// A regex that "extracts pairs" implicitly FLATTENS the tree, and flattening is
// last-wins -- so a key nested inside an <array> or a child <dict> silently
// OVERWROTE the root key of the same name. Real Info.plists nest constantly
// (CFBundleURLTypes is an array of dicts, NSAppTransportSecurity and
// UIApplicationSceneManifest are dicts), so this was not a hypothetical shape.
// Reproduced before this was written: a root CFBundleIdentifier of
// `com.real.app` with a nested one of `com.nested.decoy` parsed as the decoy.
//
// That is the worst failure mode this tool has. Not "I could not read it" --
// exit 2 covers that honestly -- but a CONFIDENT VERDICT about a value the OS
// never sees, printed in the tool's most quotable voice. The binary branch has
// always parsed structurally and so never had this bug, which meant the two
// branches could disagree about the same logical file.
//
// So this is a small recursive-descent reader over the plist DTD's value
// elements. It is deliberately intolerant: anything it cannot represent
// faithfully THROWS, which the caller maps to exit 2. It never guesses, never
// returns partial data, and never flattens.
//
// It is not a validating XML parser and does not claim to be one. It rejects
// documents a real parser would accept (unknown elements, duplicate keys). That
// asymmetry is deliberate: a false exit 2 stops a build with a message naming
// the file and the construct, which a human fixes in a minute. A false verdict
// ships.
function parseXmlPlist(text) {
  const fail = (msg) => { throw new Error(`Info.plist ${msg}`); };

  // Strip the XML declaration, the DOCTYPE and comments in ONE pass that knows
  // about CDATA, rather than three independent regexes. A naive comment strip
  // would mangle a `<!--` that legitimately sits inside a CDATA section, and a
  // naive tag-counting heuristic (which is what used to guard this function)
  // would miscount a `<dict>` written inside a comment. Both are unlikely in a
  // build-produced Info.plist. "Unlikely" is how the flattening bug above got
  // in, so handle them.
  let s = '';
  for (let j = 0; j < text.length;) {
    if (text.startsWith('<![CDATA[', j)) {
      const end = text.indexOf(']]>', j);
      if (end < 0) fail('has an unterminated <![CDATA[ section, so the document is truncated');
      s += text.slice(j, end + 3);
      j = end + 3;
    } else if (text.startsWith('<!--', j)) {
      const end = text.indexOf('-->', j);
      if (end < 0) fail('has an unterminated XML comment, so the document is truncated');
      j = end + 3;
    } else if (text.startsWith('<?', j)) {
      const end = text.indexOf('?>', j);
      if (end < 0) fail('has an unterminated <? processing instruction, so the document is truncated');
      j = end + 2;
    } else if (text.startsWith('<!DOCTYPE', j)) {
      const end = text.indexOf('>', j);
      if (end < 0) fail('has an unterminated <!DOCTYPE, so the document is truncated');
      // An internal subset can contain '>' inside its brackets, so the first
      // '>' would land mid-declaration and desynchronise everything after it.
      // No Apple-generated plist has one; refuse rather than mis-skip.
      if (text.slice(j, end).includes('[')) fail('has a <!DOCTYPE with an internal subset, which this reader does not parse');
      j = end + 1;
    } else {
      s += text[j++];
    }
  }

  // Refuse input that is not a plist at all, before any parsing. Without this,
  // the recursive descent below would report a shape complaint about arbitrary
  // text, which sends the reader looking for a malformed plist in a file that
  // is not one.
  const plistAt = s.search(/<plist[\s>]/i);
  if (plistAt < 0) {
    fail('is not XML plist content (no <plist> element) and does not start with the bplist00 magic');
  }
  // Anything before the root element other than whitespace means this file is
  // not one plist document, and reading "the first <plist> we can find" out of
  // it is guessing. The declaration, DOCTYPE and comments were already removed
  // above, so a real Info.plist has only newlines here.
  if (s.slice(0, plistAt).trim() !== '') {
    fail(`has ${JSON.stringify(s.slice(0, plistAt).trim().slice(0, 60))} before its <plist> element, so it is not a single plist document`);
  }

  let i = plistAt;

  const skipSpace = () => { while (i < s.length && /\s/.test(s[i])) i++; };

  // Reads one element tag and advances past its '>'.
  const readTag = () => {
    skipSpace();
    if (i >= s.length) fail('ends where an element was expected, so the document is truncated');
    if (s[i] !== '<') fail(`has character data where an element was expected: ${JSON.stringify(s.slice(i, i + 40))}`);
    const end = s.indexOf('>', i);
    if (end < 0) fail('has an unterminated element (a "<" with no ">"), so the document is truncated');
    const body = s.slice(i + 1, end);
    i = end + 1;
    const close = body.startsWith('/');
    const selfClose = body.endsWith('/');
    if (close && selfClose) fail(`has the malformed element <${body}>`);
    // Validate the WHOLE tag, not just its first token. This used to
    // `.split(/\s/)[0]` and discard the rest, so `</string junk>` parsed as an
    // ordinary closing tag and the document produced a verdict -- while
    // ElementTree rejects that same file as not well-formed. Anything after the
    // name must be well-formed attributes (and a closing tag may carry none).
    const inner = (close ? body.slice(1) : body).replace(/\/$/, '');
    const name = inner.trim().split(/\s/)[0];
    if (!/^[A-Za-z_][\w.:-]*$/.test(name)) fail(`has the malformed element <${body}>`);
    const rest = inner.slice(inner.indexOf(name) + name.length);
    if (close) {
      if (rest.trim() !== '') fail(`has the malformed closing tag <${body}>: a closing tag carries no attributes`);
    } else if (!/^(?:\s+[A-Za-z_:][\w.:-]*\s*=\s*(?:"[^"]*"|'[^']*'))*\s*$/.test(rest)) {
      fail(`has the malformed element <${body}>: what follows the name is not well-formed attributes`);
    }
    return { close, selfClose, name };
  };

  const expectClose = (name) => {
    const t = readTag();
    if (!t.close || t.name !== name) {
      fail(`expected </${name}> but found <${t.close ? '/' : ''}${t.name}${t.selfClose ? '/' : ''}>: the document is malformed, and a partially readable plist is not evidence about the keys it appears to lack`);
    }
  };

  const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  // A bare `&` that begins no reference is invalid XML, and the previous commit
  // got this wrong in a way worth recording. It refused `&widget;` on the
  // grounds that reporting a verdict on a document no parser accepts is what
  // exit 2 is for -- and then exempted a bare `&` one line later, reasoning
  // that it "carries no ambiguity about what it means". That is the identical
  // argument ("leave it visible") that had just been rejected for the named
  // case, applied inside the commit rejecting it, with a test written to pin
  // the exception.
  //
  // Both checks now agree, because the evidence does: ElementTree rejects
  // `<string>a & b</string>` as not well-formed, and Apple's own writer emits
  // `a &amp; b`, so a bare `&` never appears in a legitimately produced plist.
  // Note this runs inside decode(), which readText applies only to ordinary
  // character data -- CDATA content is spliced in raw and stays exempt, which
  // is correct, since `&` is literal and legal inside CDATA.
  const BARE_AMP = /&(?!(?:#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);)/;
  const decode = (raw) => {
    const bad = raw.match(BARE_AMP);
    if (bad) fail(`contains a bare "&" that begins no entity reference (near ${JSON.stringify(raw.slice(Math.max(0, bad.index - 12), bad.index + 12))}), so it is not well-formed XML`);
    return raw.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
    if (Object.prototype.hasOwnProperty.call(ENTITY, e)) return ENTITY[e];
    // An undefined named entity makes the document invalid XML, full stop. This
    // used to return the text unchanged, under a comment saying that was better
    // than "inventing a character" -- which sounds prudent and is the wrong
    // call, because it invents something too: a string the document does not
    // mean. Reproduced: a display name of `Ear &widget; Eye` produced
    // VERDICT: CLEAN here, while Python's ElementTree rejects the same file
    // outright with "undefined entity". Reporting a verdict on a document a
    // real parser refuses is precisely what exit 2 exists to prevent. The plist
    // DTD defines no entities beyond XML's five, and a DOCTYPE with an internal
    // subset is already refused above, so there is nothing legitimate here to
    // preserve.
    if (e[0] !== '#') fail(`uses the undefined XML entity &${e};, so it is not a document any XML parser would accept`);
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) fail(`uses the out-of-range character reference &${e};`);
    return String.fromCodePoint(code);
    });
  };

  // Character data up to the next element, with CDATA spliced in and entities
  // decoded. The old reader did not decode entities at all, so a CFBundleName
  // of `Ear &amp; Eye` compared unequal to `Ear & Eye` and reported drift.
  const readText = () => {
    let out = '';
    for (;;) {
      if (s.startsWith('<![CDATA[', i)) {
        const end = s.indexOf(']]>', i);
        if (end < 0) fail('has an unterminated <![CDATA[ section, so the document is truncated');
        out += s.slice(i + 9, end);
        i = end + 3;
        continue;
      }
      const lt = s.indexOf('<', i);
      if (lt < 0) fail('ends inside an element value, so the document is truncated');
      out += decode(s.slice(i, lt));
      i = lt;
      if (!s.startsWith('<![CDATA[', i)) return out;
    }
  };

  const parseValue = (depth) => {
    // A cycle is impossible in a tree, but a pathological file can still nest
    // far enough to blow the stack, and a RangeError is not one of the three
    // outcomes this tool promises.
    if (depth > 64) fail('nests deeper than 64 levels, which no Info.plist does; refusing rather than recursing');
    const t = readTag();
    if (t.close) fail(`has a closing </${t.name}> where a value was expected`);
    switch (t.name) {
      case 'string': {
        if (t.selfClose) return '';
        const v = readText();
        expectClose('string');
        return v;
      }
      case 'true':
      case 'false': {
        if (!t.selfClose) expectClose(t.name);
        return t.name === 'true';
      }
      case 'integer':
      case 'real': {
        if (t.selfClose) fail(`has a self-closing <${t.name}/>, which carries no value`);
        const raw = readText().trim();
        expectClose(t.name);
        // <integer> means an integer. Number() accepts '1.5' and '1e3' and
        // even '0x10', so the type in the document and the value handed back
        // could disagree while the run still reported a verdict.
        if (t.name === 'integer' && !/^[+-]?\d+$/.test(raw)) {
          fail(`has <integer>${raw}</integer>, which is not an integer`);
        }
        if (t.name === 'real' && !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) {
          fail(`has <real>${raw}</real>, which is not a real number`);
        }
        const n = Number(raw);
        if (raw === '' || !Number.isFinite(n)) fail(`has <${t.name}>${raw}</${t.name}>, which is not a number`);
        return n;
      }
      case 'date': {
        if (t.selfClose) fail('has a self-closing <date/>, which carries no value');
        const raw = readText().trim();
        expectClose('date');
        // Normalised to an ISO string so this agrees with the binary reader,
        // which decodes its 8-byte double the same way. Returning the raw text
        // here would make the two readers hand back different values for the
        // same logical document.
        const d = new Date(raw);
        if (Number.isNaN(d.getTime())) fail(`has <date>${raw}</date>, which is not a representable instant`);
        return d.toISOString();
      }
      case 'data': {
        if (t.selfClose) return Buffer.alloc(0);
        const raw = readText();
        expectClose('data');
        // Buffer.from(..., 'base64') silently DISCARDS characters it does not
        // recognise, so garbage decoded to a shorter buffer and the run carried
        // on with bytes the document does not contain.
        const b64 = raw.replace(/\s+/g, '');
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64)) {
          fail('has a <data> element whose contents are not valid base64');
        }
        return Buffer.from(b64, 'base64');
      }
      case 'array': {
        const arr = [];
        if (t.selfClose) return arr;
        for (;;) {
          skipSpace();
          if (s.startsWith('</', i)) { expectClose('array'); return arr; }
          arr.push(parseValue(depth + 1));
        }
      }
      case 'dict': {
        // Null prototype, deliberately. `obj['__proto__'] = v` on an ordinary
        // object literal sets the PROTOTYPE instead of creating an own key, so
        // a `<key>__proto__</key>` entry -- perfectly legal in the plist DTD --
        // would leak its children into every lookup and would also slip past
        // the duplicate-key check below, since it never becomes an own key.
        const obj = Object.create(null);
        if (t.selfClose) return obj;
        for (;;) {
          skipSpace();
          if (s.startsWith('</', i)) { expectClose('dict'); return obj; }
          const kt = readTag();
          if (kt.close || kt.name !== 'key') {
            fail(`has <${kt.close ? '/' : ''}${kt.name}> inside a <dict> where a <key> was expected: every dict entry is a key followed by its value`);
          }
          let key = '';
          if (!kt.selfClose) { key = readText(); expectClose('key'); }
          if (Object.prototype.hasOwnProperty.call(obj, key)) {
            // plutil resolves this last-wins, but a build-produced plist with a
            // duplicated key is a mangled file, and which value the OS actually
            // honours is not something this tool will assert on a coin flip.
            fail(`declares the key ${JSON.stringify(key)} twice in the same dict`);
          }
          obj[key] = parseValue(depth + 1);
        }
      }
      default:
        fail(`contains the element <${t.name}>, which this reader cannot represent; refusing rather than reporting a verdict about a file it only partly understands`);
    }
    return undefined; // unreachable: fail() always throws
  };

  const open = readTag();
  if (open.close || open.name !== 'plist') fail('does not open with a <plist> element');
  if (open.selfClose) fail('has an empty <plist/> element and so declares no keys at all');
  const root = parseValue(0);
  expectClose('plist');
  // And nothing after it. A partial overwrite of a longer file leaves a whole
  // second document trailing the first, and stopping at the first </plist>
  // would report a confident verdict about a file whose real content is
  // ambiguous. Both ends of this check exist for the same reason: "I read the
  // part that looked like a plist" is a guess, and guessing is what exit 2 is
  // for.
  if (s.slice(i).trim() !== '') {
    fail(`has ${JSON.stringify(s.slice(i).trim().slice(0, 60))} after its </plist>, so it is not a single plist document`);
  }
  if (root === null || typeof root !== 'object' || Array.isArray(root) || Buffer.isBuffer(root)) {
    fail('has a root element that is not a <dict>, so it has no keys to check');
  }
  return root;
}

// Return the spans of HTML that sit OUTSIDE comments, as separate strings.
//
// Deliberately not "strip the comments and search the result". Two defects made
// the one-line `.replace(/<!--[\s\S]*?-->/g, '')` wrong, and CodeQL flagged the
// first as incomplete multi-character sanitization:
//
//   1. Deleting a comment can SYNTHESISE the delimiter it removes. Given
//      `<!<!-- -->-- >`, the match starts at index 2, and cutting it joins the
//      surrounding `<!` and `-- >` into `<!-- >` -- a comment opener that was
//      never in the document. Any later reasoning is then about text the file
//      does not contain.
//   2. An UNTERMINATED `<!--` matched nothing, so everything after it survived.
//      A browser treats an unclosed comment as running to EOF, so that left
//      elements the user never sees available to be read as the live version
//      tag: a wrong answer in the dangerous direction.
//
// Returning SPANS fixes both at the root. Nothing is ever concatenated, so no
// delimiter can be manufactured across a cut, and an unterminated comment
// simply ends the last span. Each span is searched on its own, which is also
// the honest model: an element cannot straddle a comment boundary.
function htmlSpansOutsideComments(html) {
  const spans = [];
  let start = 0;
  for (let i = 0; i < html.length;) {
    if (html.startsWith('<!--', i)) {
      spans.push(html.slice(start, i));
      const end = html.indexOf('-->', i + 4);
      if (end < 0) return spans; // unterminated: the remainder is comment, as a browser reads it
      i = end + 3;
      start = i;
      continue;
    }
    i++;
  }
  spans.push(html.slice(start));
  return spans;
}

// Binary plist dates count seconds from 2001-01-01 UTC, not the Unix epoch.
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

// Small binary-plist reader covering the object types an Info.plist uses.
function parseBinaryPlist(buf) {
  // A built IPA's Info.plist is binary, so THIS is the branch every real
  // artifact takes -- and it was the branch with no validation at all. The XML
  // branch got a truncation floor because a truncated XML plist reads every key
  // past the cut as absent; the binary branch shipped with nothing equivalent,
  // which is the same bug in the more common path.
  //
  // It was worse than silent-wrong. A TRUNCATED bplist HUNG the process:
  // a garbage length byte becomes an enormous `len` and `Array.from({length:
  // len})` tries to materialise it. A hang defeats the exit-code contract
  // completely -- there is no 0, 1 or 2, just a CI job sitting until its
  // timeout with no diagnosis, on a paid macOS runner. Reproduced before this
  // was written by truncating tests/fixtures/binary-info.plist to 60%.
  //
  // Contract: anything this cannot parse with confidence THROWS, which the
  // caller maps to exit 2. It never returns partial data, and it never hangs.
  if (buf.length < 40 || buf.subarray(0, 8).toString('latin1') !== 'bplist00') {
    // Exactly `bplist00`, which is what the docs have always claimed. The old
    // check accepted any `bplist` prefix, so a version this code cannot
    // actually parse was fed to it and the result trusted.
    throw new Error('Info.plist does not carry the bplist00 magic, or is shorter than the 32-byte trailer plus 8-byte header it must contain');
  }
  const need = (pos, n, what) => {
    if (!Number.isInteger(pos) || !Number.isInteger(n) || pos < 8 || n < 0 || pos + n > buf.length) {
      throw new Error(`binary plist is malformed: ${what} would read ${n} byte(s) at offset ${pos}, outside this ${buf.length}-byte file`);
    }
    return pos;
  };
  const uint = (pos, n) => { let v = 0; for (let b = 0; b < n; b++) v = v * 256 + buf[pos + b]; return v; };

  const trailer = buf.subarray(buf.length - 32);
  const offsetSize = trailer[6];
  const objRefSize = trailer[7];
  const numObjects = Number(trailer.readBigUInt64BE(8));
  const topObject = Number(trailer.readBigUInt64BE(16));
  const offsetTableStart = Number(trailer.readBigUInt64BE(24));

  if (offsetSize < 1 || offsetSize > 8 || objRefSize < 1 || objRefSize > 8) {
    throw new Error(`binary plist trailer declares offsetSize=${offsetSize} objRefSize=${objRefSize}, outside the legal 1..8`);
  }
  if (!(numObjects >= 1) || !(topObject < numObjects)) {
    throw new Error(`binary plist trailer declares numObjects=${numObjects} and topObject=${topObject}, which cannot both hold`);
  }
  // Checked BEFORE the table loop, so an absurd numObjects fails here rather
  // than spinning through billions of iterations first.
  need(offsetTableStart, numObjects * offsetSize, 'offset table');
  if (offsetTableStart + numObjects * offsetSize > buf.length - 32) {
    throw new Error('binary plist offset table runs into its own trailer, so the file is truncated or corrupt');
  }

  const offsets = [];
  for (let i = 0; i < numObjects; i++) {
    const off = uint(offsetTableStart + i * offsetSize, offsetSize);
    need(off, 1, `object ${i}`);
    if (off >= buf.length - 32) throw new Error(`binary plist object ${i} starts at ${off}, which is inside the trailer`);
    offsets.push(off);
  }
  const readRef = (pos) => {
    need(pos, objRefSize, 'object reference');
    const r = uint(pos, objRefSize);
    if (r >= numObjects) throw new Error(`binary plist holds a reference to object ${r}, but the trailer declares only ${numObjects}`);
    return r;
  };
  function readLen(pos, low) {
    if (low !== 0x0f) return { len: low, next: pos };
    need(pos, 1, 'extended length marker');
    const t = buf[pos];
    if ((t >> 4) !== 0x1) throw new Error('binary plist extended length is not an integer marker, so the object header is corrupt');
    const n = 1 << (t & 0x0f);
    if (n > 8) throw new Error(`binary plist extended length claims ${n} bytes, more than the 8 an integer can occupy`);
    need(pos + 1, n, 'extended length');
    return { len: uint(pos + 1, n), next: pos + 1 + n };
  }

  // An offset table can describe a cycle (A refers to B refers to A). Without
  // this the walk recurses until the stack dies, which is a crash rather than
  // the exit 2 the contract promises. Only re-entrancy is rejected: an object
  // legitimately referenced from two places is still read twice.
  const active = new Set();
  function obj(index, depth = 0) {
    if (depth > 64) throw new Error('binary plist nests deeper than 64 levels, which no Info.plist does');
    if (active.has(index)) throw new Error(`binary plist object ${index} is reachable from itself, so the object graph is cyclic`);
    active.add(index);
    try { return readObj(index, depth); } finally { active.delete(index); }
  }
  function readObj(index, depth) {
    const pos = offsets[index];
    need(pos, 1, `object ${index} marker`);
    const marker = buf[pos];
    const high = marker >> 4;
    const low = marker & 0x0f;
    if (marker === 0x08) return false;
    if (marker === 0x09) return true;
    if (high === 0x1) {
      const n = 1 << low;
      if (n !== 1 && n !== 2 && n !== 4 && n !== 8 && n !== 16) {
        throw new Error(`binary plist integer claims ${n} bytes, which is not one of the 1/2/4/8/16 the format allows`);
      }
      need(pos + 1, n, 'integer');
      // 1, 2 and 4-byte integers are unsigned; 8 and 16-byte are SIGNED two's
      // complement, which is how CFBinaryPlist encodes every negative number.
      // Reading those unsigned turned -7 into 18446744073709552000 -- and note
      // that is not even the correct unsigned value, because the old
      // `v * 256 + byte` accumulator loses precision past 2^53, so the answer
      // was wrong twice over. Observed live: `SomeNegative is
      // 18446744073709552000, expected -7`, a fabricated violation about a
      // perfectly well-formed plist.
      if (n <= 4) return uint(pos + 1, n);
      let v = 0n;
      for (let b = 0; b < n; b++) v = (v << 8n) | BigInt(buf[pos + 1 + b]);
      const bits = BigInt(n * 8);
      if (v >= 1n << (bits - 1n)) v -= 1n << bits;
      // Return a Number only when it round-trips exactly. Beyond the safe range
      // a Number would silently round, and a rounded value compared against a
      // manifest is the same class of quiet wrongness this whole branch exists
      // to remove. A BigInt stringifies correctly for every comparison and
      // message below.
      return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
    }
    if (high === 0x5) {
      const { len, next } = readLen(pos + 1, low);
      need(next, len, 'ascii string');
      return buf.subarray(next, next + len).toString('ascii');
    }
    if (high === 0x6) {
      const { len, next } = readLen(pos + 1, low);
      need(next, len * 2, 'utf16 string');
      // COPY before swapping. `swap16()` mutates in place, and a string object
      // referenced from two places would be swapped twice -- correct on the
      // first read and silently mojibake on the second.
      return Buffer.from(buf.subarray(next, next + len * 2)).swap16().toString('utf16le');
    }
    if (high === 0xa) {
      const { len, next } = readLen(pos + 1, low);
      need(next, len * objRefSize, 'array');
      const out = new Array(len);
      for (let i = 0; i < len; i++) out[i] = obj(readRef(next + i * objRefSize), depth + 1);
      return out;
    }
    if (high === 0x2) {
      // Real. 0x22 is a 4-byte float, 0x23 an 8-byte double, both big-endian.
      const n = 1 << low;
      if (n !== 4 && n !== 8) throw new Error(`binary plist real claims ${n} bytes, which is neither a float nor a double`);
      need(pos + 1, n, 'real');
      const r = n === 4 ? buf.readFloatBE(pos + 1) : buf.readDoubleBE(pos + 1);
      // The XML reader already refuses a non-finite <real>; this one did not,
      // so NaN and Infinity came back as values. describePlistValue has no
      // branch for them, JSON.stringify(NaN) is the string "null", and a
      // violation message then reported a present, non-null value as `null` --
      // the same fabricated-null shape that the `return null` bug produced,
      // arriving through a different door.
      if (!Number.isFinite(r)) throw new Error('binary plist holds a real that is NaN or Infinity, which no Info.plist value is');
      return r;
    }
    if (high === 0x3) {
      // A date is marker 0x33 exactly -- the low nibble is not a length here,
      // it is part of the type. Accepting any 0x3n and then reading 8 bytes
      // regardless would parse 0x30 as a date and hand back a verdict built on
      // a byte sequence the format never said was one.
      if (marker !== 0x33) throw new Error(`binary plist holds marker 0x${marker.toString(16).padStart(2, '0')}, which is not the 0x33 a date must be`);
      // Date. An 8-byte big-endian double of seconds since 2001-01-01 UTC.
      // Normalised to an ISO string so this agrees with the XML reader, which
      // normalises <date> the same way. Two readers of one logical document
      // that return different types for the same key are a bug waiting for a
      // manifest to trip over it.
      need(pos + 1, 8, 'date');
      const d = new Date(APPLE_EPOCH_MS + buf.readDoubleBE(pos + 1) * 1000);
      if (Number.isNaN(d.getTime())) throw new Error('binary plist holds a date that is not a representable instant');
      return d.toISOString();
    }
    if (high === 0x4) {
      const { len, next } = readLen(pos + 1, low);
      need(next, len, 'data');
      return Buffer.from(buf.subarray(next, next + len));
    }
    if (high === 0xd) {
      const { len, next } = readLen(pos + 1, low);
      need(next, len * objRefSize * 2, 'dictionary');
      // Null prototype for the same reason as the XML reader: `__proto__` is a
      // legal key, and on an ordinary object it would set the prototype rather
      // than an own property.
      const out = Object.create(null);
      for (let i = 0; i < len; i++) {
        const k = obj(readRef(next + i * objRefSize), depth + 1);
        // A dict key that is not a string would be coerced by `out[k] = v` into
        // something like "[object Object]" and then compared against a manifest
        // key as if it were real.
        if (typeof k !== 'string') throw new Error(`binary plist uses a ${k === null ? 'null' : typeof k} as a dictionary key, which no Info.plist does`);
        const v = obj(readRef(next + len * objRefSize + i * objRefSize), depth + 1);
        // Matches the XML reader: a duplicated key is a mangled file, and which
        // value the OS honours is not worth asserting on a coin flip.
        if (Object.prototype.hasOwnProperty.call(out, k)) {
          throw new Error(`binary plist declares the key ${JSON.stringify(k)} twice in the same dictionary`);
        }
        out[k] = v;
      }
      return out;
    }
    // Everything else REFUSES. This used to `return null` under the comment
    // "types this checker never asserts against" -- which reasoned about what
    // the MANIFEST asserts, not about what the FILE contains, and those are
    // different questions. A key whose value came back null was still PRESENT,
    // so `k in plist` was true while its value was a lie: an infoPlist.equals
    // compared String(null) and fabricated a violation, and a coupling rule
    // reported "has the key but its value is not a usable purpose string".
    // Confident, actionable, wrong.
    //
    // The three types that actually occur in an Info.plist -- real, date, data
    // -- are parsed above rather than refused, so this rejects only markers no
    // Info.plist carries (null, fill, UID, and any future type).
    throw new Error(`binary plist holds an object with marker 0x${marker.toString(16).padStart(2, '0')}, a type this reader cannot represent; refusing rather than reporting a verdict about a file it only partly understands`);
  }
  return obj(topObject);
}

// Read every shipped text file under the app bundle once, so bundle rules and
// capability coupling scan the SAME bytes the device runs.
// The STRING-level half of the webBundle.root checks. Split out so it can run
// during manifest validation, BEFORE the artifact is touched: a bad root is a
// broken manifest, and reporting it as "ARTIFACT UNREADABLE" was the exact
// mislabel the exit 2 / exit 3 split exists to end. These four checks need only
// the manifest and the .app path, so they are knowable without reading a byte
// of the build.
//
// The FIFTH check -- resolving symlinks with realpath -- stays inside
// readShippedText, because whether the root resolves out of the bundle depends
// on symlinks the ARCHIVE carries. That one genuinely is a fact about the
// artifact, so it stays exit 2. The seam is "could I know this from the
// manifest alone?", not "is it about a path?".
// `appDir` is optional: at manifest-validation time the artifact has not been
// extracted yet, so a synthetic base stands in. That is sound because the
// containment check is purely lexical here -- a relative path with no ".."
// segment resolves inside ANY base -- and the real base is re-checked later
// with the actual appDir.
function validateWebRootString(subdir, appDir = path.sep + '__unextracted__') {
  if (subdir === undefined || subdir === null) return;
  if (typeof subdir !== 'string' || subdir.trim() === '') {
    throw new Error(`webBundle.root must be a non-empty string (got ${JSON.stringify(subdir)})`);
  }
  if (path.isAbsolute(subdir) || /^[A-Za-z]:/.test(subdir)) {
    throw new Error(`webBundle.root "${subdir}" is an absolute path; it must be relative to the shipped .app`);
  }
  if (subdir.split(/[\\/]/).includes('..')) {
    throw new Error(`webBundle.root "${subdir}" contains a ".." segment, which would scan files outside the shipped .app`);
  }
  const resolvedRoot = path.resolve(appDir, subdir);
  const base = path.resolve(appDir);
  if (resolvedRoot !== base && !resolvedRoot.startsWith(base + path.sep)) {
    throw new Error(`webBundle.root "${subdir}" resolves outside the shipped .app (${resolvedRoot}); only bytes from the artifact may inform a verdict`);
  }
}

function readShippedText(appDir, subdir) {
  // The artifact boundary is the whole contract: this tool's verdicts are only
  // worth anything if every byte behind them came out of the .app that shipped.
  // `webBundle.root` is manifest-supplied, and an unchecked path join lets it
  // LEAVE that boundary -- reproduced live, root "../../" scanned the extraction
  // parent and printed VERDICT: CLEAN over files that were never in the app.
  // The same escape could just as easily manufacture a finding.
  //
  // Rejected here rather than sanitized: a root that points outside the bundle
  // is a broken manifest, and silently rewriting it to something safe would hide
  // that.
  //
  // THREE checks, because the first two are lexical and lexical is not enough.
  // The structural test (no absolute, no ".." segment) and the positional test
  // (path.resolve must land inside appDir) both operate on the STRING. An
  // earlier version of this comment claimed the positional test covered
  // symlinks; it does not, because path.resolve never touches the filesystem.
  //
  // That gap was real and reproduced: an IPA is a zip, zips carry symlink
  // entries, and unzip restores them. With `public` a symlink to an absolute
  // path outside the .app, the scan read a file that never shipped and emitted
  // a VIOLATION naming it. Manufacturing a finding from foreign bytes is worse
  // than suppressing one, because it is actionable and quotable.
  //
  // So the third check resolves real paths (`fs.realpathSync`) for the root and
  // for every symlinked entry encountered during the walk, and requires each to
  // stay inside the real appDir.
  validateWebRootString(subdir, appDir);
  const root = subdir ? path.join(appDir, subdir) : appDir;
  const files = [];
  const notes = [];
  if (!fs.existsSync(root)) return { root, files, notes, missing: true };

  // The real-path floor. Everything below this line may only read bytes that
  // live inside the extracted .app on disk, symlinks resolved.
  const realBase = fs.realpathSync(appDir);
  const inside = (p) => p === realBase || p.startsWith(realBase + path.sep);
  const realRoot = fs.realpathSync(root);
  if (!inside(realRoot)) {
    throw new Error(`webBundle.root "${subdir}" resolves through a symlink to ${realRoot}, outside the shipped .app; only bytes from the artifact may inform a verdict`);
  }

  const TEXT = new Set(['.html', '.js', '.mjs', '.cjs', '.json', '.css', '.svg', '.txt']);
  // Dedupe by RESOLVED identity. An inside-pointing symlink is legitimate and is
  // followed, but without this the same shipped bytes are read through both
  // paths -- which double-counts the "N text files" line and prints the same
  // file twice in a violation's evidence list. One file, one entry.
  const seen = new Set();
  // THREE TIERS, not two. Round 22 got this wrong and the error is worth keeping
  // written down: it followed an in-.app symlink out of the web root and merely
  // RELABELLED the resulting `../Frameworks/x.js` path, treating a scope problem
  // as a presentation problem. The reasoning was "the artifact boundary is the
  // bundle, not the declared web root" -- true for SECURITY and wrong for SCOPE.
  //
  // webBundle.root is a SEMANTIC boundary, and this file's own SKILL.md says so:
  // without a root "the scan would walk the whole .app ... an .app carries
  // localization strings, resource JSON and framework text, so a capability rule
  // could match a file the web layer never contains." A `public/` symlink to
  // `Frameworks/` recreates exactly that false-positive class -- a capability
  // finding raised from bytes the web layer never contained.
  //
  //   inside the web root        -> scan it
  //   inside the .app, outside   -> SKIP, and say so in a note. Not a security
  //   the root                      breach, just not the payload these rules
  //                                 make claims about. Skipping is correct
  //                                 rather than a miss, but it must be visible.
  //   outside the .app           -> exit 2. Foreign bytes, full stop.
  const insideRoot = (p) => p === realRoot || p.startsWith(realRoot + path.sep);
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      let target = abs;
      if (e.isSymbolicLink()) {
        // A symlink DEEPER in the tree escapes just as well as one at the root,
        // so resolve every one. Pointing back inside the bundle is harmless and
        // is followed; pointing out is fatal. A dangling link resolves to
        // nothing -- skip it rather than crash, since it ships no bytes.
        try { target = fs.realpathSync(abs); } catch { continue; }
        if (!inside(target)) {
          throw new Error(`${path.relative(realBase, abs)} is a symlink to ${target}, outside the shipped .app; a verdict must not be informed by bytes the artifact does not contain`);
        }
        if (!insideRoot(target)) {
          notes.push(`skipped ${path.relative(root, abs)}: it is a symlink to ${path.relative(realBase, target)}, which is inside the .app but outside the declared web root, so it is not part of the payload these rules describe`);
          continue;
        }
      }
      const st = fs.statSync(target);
      if (st.isDirectory()) {
        if (seen.has(target)) continue;   // also stops a symlink cycle from recursing forever
        seen.add(target);
        walk(target);
      } else if (TEXT.has(path.extname(e.name).toLowerCase())) {
        if (seen.has(target)) continue;
        seen.add(target);
        files.push({ rel: path.relative(root, abs), text: fs.readFileSync(target, 'utf8') });
      }
    }
  })(root);
  return { root, files, notes, missing: false };
}

// ---------------------------------------------------------------------------
// EXIT 2 IS THE WHOLE CONTRACT. Every step that merely *inspects* -- reading
// the manifest, unzipping, parsing Info.plist, walking the shipped bundle --
// must land on exit 2, never on exit 1. Exit 1 means "I looked and found a
// violation"; letting an unreadable plist or a malformed manifest fall through
// as a generic nonzero would say the artifact is bad when the truth is that we
// never managed to look at it. Those are different facts and a release gate has
// to keep them apart.
// --json promises machine-readable output, and on exits 2 and 3 it produced
// none: both handlers wrote prose to stderr and exited before the JSON writer
// at the bottom of the file was ever reached. A CI wrapper doing
// JSON.parse(stdout) -- a fair reading of "machine-readable" -- got a parse
// error on empty input, on exactly the two exit codes where a machine consumer
// most needs structure. The prose still goes to stderr for a human; the
// envelope goes to stdout for the caller.
function bail(kind, code, what, e, tail) {
  console.error(`${kind}: ${what}: ${e && e.message}`);
  console.error(tail);
  if (asJson) {
    console.log(JSON.stringify({
      verdict: code === 2 ? 'ARTIFACT_UNREADABLE' : 'VERIFIER_MISCONFIGURED',
      exitCode: code,
      stage: what,
      error: (e && e.message) || String(e),
      passes: [],
      violations: [],
      notes: [],
    }, null, 2));
  }
  process.exit(code);
}

function inspect(what, fn) {
  try {
    return fn();
  } catch (e) {
    bail('ARTIFACT UNREADABLE', 2, what, e, 'Failing with exit 2. Being unable to inspect is never reported as clean, and never as a violation either.');
  }
}

// The comment above says these are different facts and a release gate has to
// keep them apart -- and then an earlier version of this file ran BOTH through
// inspect(), so a typo in the manifest printed "ARTIFACT UNREADABLE" about an
// IPA that was perfectly fine. That is the misleading-evidence failure this
// whole tool exists to prevent, committed by the tool itself: it sends someone
// to examine an artifact when the broken thing is the config on disk.
//
// Exit 3 is safe to add: every consumer invokes this under `set -euo pipefail`
// with a bare call, so any non-zero still blocks. What changes is that a
// reader, and a script, can now tell "I could not read the build" from
// "you handed me a manifest I cannot use".
function configError(what, fn) {
  try {
    return fn();
  } catch (e) {
    bail('VERIFIER MISCONFIGURED', 3, what, e, 'Failing with exit 3. The artifact was never opened, so this says nothing about the build.');
  }
}

// An id is a literal, so escape it before it becomes part of a pattern.
function escapeForRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const RENDERED_VERSION_KEY = Symbol('renderedVersion');

const manifest = configError(`reading manifest ${manifestPath}`, () => JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
const expect = manifest.expect || {};

// Compile every pattern up front, inside inspect(). A manifest is valid JSON
// long before it is a valid RULE SET: `ifBundleMatches: "["` parses fine and
// then throws a SyntaxError at `new RegExp` deep in the run, which Node turns
// into exit 1 -- reporting a broken verifier configuration as a discovered
// violation of the artifact. Those are opposite conclusions. Compiling here
// also means a rule missing its required fields fails closed instead of
// matching nothing and quietly passing.
const compiled = configError(`validating rules in ${manifestPath}`, () => {
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
    patterns.set(RENDERED_VERSION_KEY, new RegExp(`<[^>]*\\bid\\s*=\\s*["']${escapeForRegExp(id)}["'][^>]*>([^<]*)<`, 'g'));
  }
  return patterns;
});

// Manifest-level webBundle.root validation, BEFORE the artifact is opened.
// Round 24 caught that these ran inside the artifact-reading inspect(), so a
// manifest with an absolute or traversing root still printed ARTIFACT
// UNREADABLE -- the very mislabel the exit 2 / exit 3 split had just been made
// to remove. Fixing the handler without moving these left the contract only
// half true, which is how a correction gets believed while still being wrong.
configError(`validating webBundle.root in ${manifestPath}`, () => {
  const expectBlock = manifest.expect || {};
  validateWebRootString(expectBlock.webBundle && expectBlock.webBundle.root);
  const readsBundle = Boolean(
    expectBlock.renderedVersion ||
    (expectBlock.capabilityCoupling || []).length ||
    ((expectBlock.webBundle && expectBlock.webBundle.mustContain) || []).length ||
    ((expectBlock.webBundle && expectBlock.webBundle.mustNotContain) || []).length,
  );
  if (readsBundle && !(expectBlock.webBundle && expectBlock.webBundle.root)) {
    throw new Error(
      'this manifest has rules that read the shipped bundle but does not set webBundle.root, ' +
      'so the scan would walk the entire .app rather than the web payload those rules describe. ' +
      'Set webBundle.root (usually "public").',
    );
  }
});
const rx = (source) => compiled.get(source);
const violations = [];
const passes = [];
// Advisories: things a reader should know that are NOT violations. They exist so
// a known blind spot prints something rather than nothing; silence is how a gate
// that verified less than it seems still looks clean.
const notes = [];

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
  // Anything the walk declined to scope in must be SAID. A skip that nobody
  // sees is the same shape as a check that silently did nothing.
  for (const n of b.notes || []) notes.push(n);
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

const plistHas = (k) => Object.prototype.hasOwnProperty.call(plist, k);
const plistGet = (k) => (plistHas(k) ? plist[k] : undefined);
// A short, safe rendering of any plist value. Never throws: with null-prototype
// dicts, `String(someDict)` raises "Cannot convert object to primitive value",
// and an unhandled throw here would defeat the exit-code contract as surely as
// a wrong answer would.
const describePlistValue = (v) => {
  if (Buffer.isBuffer(v)) return `<${v.length}-byte data>`;
  // JSON.stringify THROWS on a BigInt, and the violation messages below run it
  // over whatever this returns, so render one as its digits here.
  if (typeof v === 'bigint') return v.toString();
  if (v !== null && typeof v === 'object') return Array.isArray(v) ? `<array of ${v.length}>` : '<dict>';
  return v;
};

// --- 1. Info.plist expectations -------------------------------------------
// Every read below goes through plistHas/plistGet, never bare `plist[k]` or
// `k in plist`. Both readers now build their dicts with a null prototype, which
// is the structural half of the fix; this is the other half, and both are
// wanted because either alone leaves the other's assumption load-bearing.
//
// What this closes: `__proto__` is a legal plist key that the DTD says nothing
// against, and `obj['__proto__'] = value` on an ordinary object sets the
// PROTOTYPE rather than an own property. So a dict under that key never
// appeared in Object.keys or hasOwnProperty, while every property of its value
// became visible through the prototype chain to `plist[k]` and to `in`.
// Reproduced live, both directions, on XML and binary alike:
//
//   required:  a `__proto__` dict carrying NSPhotoLibraryAddUsageDescription
//              printed "ok plist requires ... present" and VERDICT: CLEAN --
//              a false clean on the exact key behind the iHEARtest TCC crash.
//   forbidden: the same trick manufactured "NSMicrophoneUsageDescription
//              PRESENT" for a key that is not a real entry of the plist.
//
// capabilityCoupling already guarded with hasOwnProperty. It was one of four
// places that read the plist by a manifest-supplied key, and the only one.
for (const r of (expect.infoPlist && expect.infoPlist.required) || []) {
  // Presence is hasOwnProperty, NOT truthiness. This used to read
  //
  //     if (typeof v === 'string' ? v.trim() : v)
  //
  // so any FALSY value counted as absent, and plists are full of legitimately
  // falsy values. Reproduced: `ITSAppUsesNonExemptEncryption: false` -- one of
  // the most common keys in the fleet, added precisely so App Store Connect
  // stops asking on every build -- was reported MISSING while sitting right
  // there with the correct value. An integer 0 did the same. Anyone writing the
  // natural required rule for that key would have had every build blocked by a
  // fabricated finding.
  //
  // The string-trim check is still wanted, because a blank purpose string is
  // not a disclosure. But blank-when-present and absent are DIFFERENT defects
  // with different fixes, and reporting them with one message sends half the
  // readers to the wrong place. Say which one it is.
  const v = plistGet(r.key);
  if (!plistHas(r.key)) {
    violations.push({ rule: 'infoPlist.required', detail: `${r.key} MISSING`, why: r.why });
  } else if (typeof v === 'string' && v.trim() === '') {
    violations.push({ rule: 'infoPlist.required', detail: `${r.key} is present but its string value is blank`, why: r.why });
  } else {
    passes.push(`plist requires ${r.key}: present`);
  }
}
for (const f of (expect.infoPlist && expect.infoPlist.forbidden) || []) {
  if (plistHas(f.key)) violations.push({ rule: 'infoPlist.forbidden', detail: `${f.key} PRESENT`, why: f.why });
  else passes.push(`plist forbids ${f.key}: absent`);
}
for (const [k, want] of Object.entries((expect.infoPlist && expect.infoPlist.equals) || {})) {
  const actual = plistGet(k);
  // describePlistValue is for MESSAGES. Comparing against it was a live false
  // CLEAN, and it was introduced here by the fix that added the helper: the
  // comparison read
  //
  //     if (String(describePlistValue(plistGet(k))) === String(want))
  //
  // and describePlistValue returns the literal '<dict>' for EVERY dict
  // regardless of content. So `equals: { NSAppTransportSecurity: "<dict>" }`
  // passed for any ATS configuration whatsoever. Reproduced: a locked-down
  // NSAllowsArbitraryLoads:false and a wide-open true with an injected
  // exception domain produced byte-identical "ok" lines and CLEAN verdicts.
  // Arrays were gated only on LENGTH, so two CFBundleURLTypes arrays with
  // different schemes compared equal.
  //
  // The trap it sets is worse than the single wrong verdict: an author who
  // writes the real intended content sees the rule fail forever (real content
  // never equals '<dict>'), and the obvious way to "fix" a rule that will not
  // pass is to paste in the summary string the tool itself printed -- at which
  // point the rule is permanently satisfied by anything of that shape.
  //
  // equals compares SCALARS. A structured value is not something string
  // equality can answer, so say that instead of pretending to answer it. This
  // can never produce a pass, which is the property that matters.
  if (actual !== null && typeof actual === 'object') {
    violations.push({
      rule: 'infoPlist.equals',
      detail: `${k} holds ${describePlistValue(actual)}, which infoPlist.equals cannot compare against ${JSON.stringify(want)}`,
      why: 'infoPlist.equals compares scalar values; pinning the contents of a structured key needs a rule that reads inside it, and comparing against a printed summary of the value would pass for any content of that shape',
    });
    continue;
  }
  if (String(actual) === String(want)) passes.push(`plist ${k} == ${want}`);
  else violations.push({ rule: 'infoPlist.equals', detail: `${k} is ${JSON.stringify(describePlistValue(actual))}, expected ${JSON.stringify(want)}`, why: 'identity/version drift between what was built and what was claimed' });
}

// --- 2. Shipped web-bundle expectations -----------------------------------
// This is the AWARE lesson: assert against the bundle that ships, never the
// repo tree, because a build can assemble something entirely different.
if (expect.webBundle) {
  if (bundle.missing) {
    violations.push({ rule: 'webBundle', detail: `declared bundle root not found in the artifact: ${expect.webBundle.root}`, why: 'the manifest describes a bundle layout this build does not produce' });
  } else {
    // Match with the COMPILED regex. These were compiled during validation but
    // then evaluated with String.includes, so `getUserMedia|mediaDevices` was
    // silently searched for as that literal 24-character string and matched
    // nothing -- a rule that looks like it is guarding and is not.
    //
    // BOTH rule families match PER FILE. mustNotContain always did;
    // mustContain used to test one synthetic haystack built by joining every
    // shipped file with a `\n/*path*/\n` separator, which let a single rule be
    // satisfied by text spanning two unrelated files. Reproduced live: a file
    // ending "...ends oddly with: scrubber" and a different file beginning
    // ".init();" together satisfied /scrubber[\s\S]{0,40}\.init\(/ and printed
    // VERDICT: CLEAN, with the pattern present in neither file.
    //
    // That is a false clean on a POSITIVE assertion -- a rule whose whole job
    // is to prove the shipped bundle really does something. It also contradicted
    // this tool's own rule for capabilityCoupling's andBundleMatches, where both
    // patterns must hit the SAME file because "two unrelated modules happening
    // to mention each is not evidence of one flow". Same argument, same answer.
    //
    // Per-file matching is also better evidence: the pass line can now name the
    // file the proof lives in instead of asserting a whole-bundle abstraction.
    for (const c of expect.webBundle.mustNotContain || []) {
      const hits = bundle.files.filter((f) => rx(c.pattern).test(f.text)).map((f) => f.rel);
      if (hits.length) violations.push({ rule: 'webBundle.mustNotContain', detail: `${c.pattern} found in ${hits.slice(0, 4).join(', ')}`, why: c.why });
      else passes.push(`bundle excludes ${c.pattern}`);
    }
    for (const c of expect.webBundle.mustContain || []) {
      const hits = bundle.files.filter((f) => rx(c.pattern).test(f.text)).map((f) => f.rel);
      if (hits.length) {
        passes.push(`bundle contains ${c.pattern} (in ${hits.slice(0, 3).join(', ')})`);
        continue;
      }
      violations.push({ rule: 'webBundle.mustContain', detail: `${c.pattern} NOT found in any single shipped file`, why: c.why });
      // Per-file matching fixed a false CLEAN and bought a possible false
      // VIOLATION in exchange: a genuinely split implementation -- a function
      // opened in one module and closed in another, or a template partial a
      // build step relocated -- satisfies the pattern across the payload while
      // matching no single file. capabilityCoupling already reports exactly
      // this shape for andBundleMatches rather than swallowing it; there is no
      // reason mustContain should be quieter about the same trade.
      //
      // "NOT found in any single shipped file" is TRUE either way, and that is
      // the problem: it reads as "absent" when the honest answer may be
      // "present, but not where this rule can see it". So say which one it is.
      // Join the TEXTS only. An earlier version glued them with a
      // `\n/*<path>*/\n` separator carrying each file's own relative path, so a
      // pattern matching a filename matched the tool's own bookkeeping: a
      // single-file bundle with a pattern of `share\.js` fired a note claiming
      // a match "across file boundaries" when there was one file, one boundary,
      // and the matched bytes were never in the app at all.
      const joined = bundle.files.map((f) => f.text).join('\n');
      if (rx(c.pattern).test(joined)) {
        notes.push(
          `webBundle.mustContain ${c.pattern}: matches the shipped payload only ACROSS file boundaries, never within one file. ` +
          'Either the implementation is genuinely split (in which case this rule cannot see it and the pattern should be narrowed to one file), ' +
          'or the match is a coincidence between two unrelated files -- which is why this rule does not accept it as evidence.',
        );
      }
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
    // Strip HTML comments BEFORE searching, and take every match rather than
    // the first. Both halves were load-bearing and both were missing, and
    // SKILL.md promised the opposite in the sentence justifying this rule's
    // whole design: "cannot be tripped by a comment, cannot be satisfied by a
    // placeholder". It could be tripped by a comment, in both directions.
    //
    // Reproduced. A commented-out template line holding the CORRECT string,
    // above a real element rendering `v1.5.0-STALE-BUG` against a 1.6.0 binary,
    // printed VERDICT: CLEAN -- a false clean over exactly the defect this rule
    // exists to catch, because `.match()` without /g returns the FIRST
    // occurrence and the comment came first. Reversed, a stale comment above a
    // correct element fabricated "version tag renders v1.5.0". Comments in a
    // built index.html are ordinary: merges and template scaffolding leave them
    // behind constantly.
    //
    // Two matches after stripping comments is not something to resolve by
    // picking one. A duplicate id is invalid HTML, the browser renders the
    // first and scripts that query it may find either, so which one "the
    // version tag" means is genuinely ambiguous -- and guessing is what this
    // tool refuses to do everywhere else.
    const rx = compiled.get(RENDERED_VERSION_KEY);
    const all = [];
    for (const span of htmlSpansOutsideComments(idxFile.text)) {
      rx.lastIndex = 0;
      all.push(...span.matchAll(rx));
    }
    if (all.length > 1) {
      violations.push({
        rule: 'renderedVersion',
        detail: `${idxFile.rel} contains ${all.length} elements with id "${id}" (outside comments), rendering ${JSON.stringify(all.map((x) => x[1].trim()))}`,
        why: 'a duplicate id is invalid HTML and makes "the version tag" ambiguous: the browser renders the first and a script querying it may find either, so this rule cannot say which one the user sees',
      });
    }
    const m = all[0] || null;
    const rendered = m ? m[1].trim() : null;
    const want = `v${describePlistValue(plistGet('CFBundleShortVersionString'))}`;
    if (rendered === want) passes.push(`rendered version tag "${rendered}" matches the binary`);
    else if (rendered === null) violations.push({ rule: 'renderedVersion', detail: `no element with id "${id}" and literal text found in ${idxFile.rel}`, why: 'either the tag was removed, or its text is rendered at runtime -- in which case this rule cannot verify it and should not be declared for this app' });
    else violations.push({ rule: 'renderedVersion', detail: `version tag renders ${JSON.stringify(rendered)}, binary is ${JSON.stringify(want)}`, why: 'the in-app version must match the build, and an unsubstituted template here also mis-tags every error report to a nonsense release' });
  }
}

// --- 3. Capability coupling: the rule that generalizes ---------------------
// If the SHIPPED bundle's TEXT MATCHES a privacy-sensitive API's pattern, the
// SHIPPED Info.plist must declare it. Never phrase this as "can reach": that
// would claim a control-flow analysis nobody ran, and these lines get pasted
// into PR comments where the qualifier is lost.
// Derived, not hand-maintained -- which is why it
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
  // THE SAME-FILE REQUIREMENT CAN MISS A REAL SPLIT FLOW, and silence is the
  // wrong way to report that. `andBundleMatches` exists to stop a false positive
  // (a PDF share does not touch the photo library), but a genuine share-image
  // flow can legitimately live across two modules -- a thumbnail helper in one,
  // the share call in another -- and the conjunction then holds in NO single
  // file while the shipped payload as a whole still supports Save Image.
  //
  // Left alone, that prints "no shipped-bundle path matches", which is true of
  // the conjunction and reads as "nothing matched". A blind spot the tool
  // reports as a clean scan is the exact failure this whole file exists against.
  // So when the primary matches SOMEWHERE and the conjunction matches NOWHERE,
  // say so as an advisory. Not a violation: making it one would reinstate the
  // false positive the narrowing was added to remove. Visible, not silent.
  const splitCandidates = secondary && matched.length === 0
    ? bundle.files.filter((f) => primary.test(f.text)).map((f) => f.rel)
    : [];
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
      // describePlistValue, not the raw value: JSON.stringify THROWS on a
      // BigInt, which the signed 8-byte integer path can legitimately return.
      // That threw uncaught and exited 1 -- the same code an honest violation
      // uses -- printing a stack trace instead of this finding. This was the
      // fourth site where a plist value reaches JSON.stringify, and the commit
      // that added describePlistValue to guard exactly that wired up the other
      // three and missed this one.
      detail: `Info.plist has ${rule.requirePlistKey} but its value is not a usable purpose string (${JSON.stringify(describePlistValue(raw))})`,
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
  if (splitCandidates.length) {
    notes.push(
      `capability ${rule.requirePlistKey}: /${rule.ifBundleMatches}/ matches ${splitCandidates.slice(0, 3).join(', ')} ` +
      `but /${rule.andBundleMatches}/ does not match in the SAME file, so this rule did not fire. ` +
      'If the flow is genuinely split across modules, this rule cannot see it -- check by hand.',
    );
  }
}

// ---------------------------------------------------------------------------
const result = {
  app: manifest.app,
  ipa: path.basename(ipaPath),
  bundleId: describePlistValue(plistGet('CFBundleIdentifier')),
  version: `${describePlistValue(plistGet('CFBundleShortVersionString'))} (${describePlistValue(plistGet('CFBundleVersion'))})`,
  shippedBundleFiles: bundle.missing ? 0 : bundle.files.length,
  passes,
  notes,
  violations,
  verdict: violations.length ? 'VIOLATIONS' : 'CLEAN',
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`artifact-truth: ${result.app} ${result.version} ${result.bundleId}`);
  console.log(`shipped bundle: ${result.shippedBundleFiles} text files under ${(expect.webBundle && expect.webBundle.root) || '(app root)'}`);
  for (const p of passes) console.log(`  ok    ${p}`);
  for (const n of notes) console.log(`  note  ${n}`);
  for (const v of violations) console.log(`  FAIL  [${v.rule}] ${v.detail}\n        why: ${v.why}`);
  console.log(result.violations.length ? `\nVERDICT: ${violations.length} violation(s)` : '\nVERDICT: CLEAN');
}

try { fs.rmSync(art.root, { recursive: true, force: true }); } catch {}
process.exitCode = violations.length ? 1 : 0;
