// Tests for skills/release-verification/artifact-truth.mjs.
//
// These build SYNTHETIC IPAs rather than leaning on a downloaded artifact. A
// release gate whose only evidence is "I ran it once against a build I happened
// to have on disk" is exactly the kind of unrepeatable proof this tool exists
// to replace -- and that ad-hoc evidence disappears the moment the scratch
// directory is cleaned. A fixture that builds its own known-bad artifact can be
// re-run by anyone, forever.
//
// The truth table under test is the one the tool turns on:
//
//   reachable | declared | verdict
//   ----------|----------|-------------------------------------------
//   yes       | no       | VIOLATION  (the iHEARtest TCC crash)
//   yes       | yes      | pass
//   no        | no       | pass       (the AWARE microphone key)
//   no        | yes      | violation only when forbidIfUnreachable
//
// plus the exit-code contract, which is the part that makes the other results
// trustworthy: 0 clean, 1 violations, and 2 for every "I could not look".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'skills/release-verification/artifact-truth.mjs');

function tmp(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `artifact-truth-test-${prefix}-`));
}

// A minimal XML Info.plist. The tool reads binary plists too (that is most of
// its parser), but XML is what a test can construct honestly without hand-rolling
// a bplist writer whose bugs would then be under test rather than the tool's.
function plistXml(entries) {
    const body = Object.entries(entries)
        .map(([k, v]) =>
            typeof v === 'boolean'
                ? `  <key>${k}</key>\n  <${v} />`
                : `  <key>${k}</key>\n  <string>${v}</string>`)
        .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
}

// Builds a real .ipa: a zip with Payload/App.app inside, which is what the tool
// unzips. Using the actual container format keeps the extraction path under test
// instead of stubbed.
function makeIpa({ plist = {}, web = {}, webRoot = 'public', rawPlist = null }) {
    const dir = tmp('ipa');
    const appDir = path.join(dir, 'Payload', 'App.app');
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'Info.plist'), rawPlist ?? plistXml(plist));
    for (const [rel, text] of Object.entries(web)) {
        const abs = path.join(appDir, webRoot, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, text);
    }
    const ipa = path.join(dir, 'App.ipa');
    execFileSync('zip', ['-q', '-r', ipa, 'Payload'], { cwd: dir });
    return ipa;
}

// Bundle-reading rules require an explicit webBundle.root, so the default here
// mirrors what every real manifest does rather than making each test repeat it.
// Pass `webBundle: null` to deliberately omit the root and exercise that path.
function makeManifest(expect) {
    const readsBundle = expect.renderedVersion || (expect.capabilityCoupling || []).length
        || ((expect.webBundle && expect.webBundle.mustContain) || []).length
        || ((expect.webBundle && expect.webBundle.mustNotContain) || []).length;
    if (readsBundle && expect.webBundle === undefined) expect = { ...expect, webBundle: { root: 'public' } };
    if (expect.webBundle === null) { expect = { ...expect }; delete expect.webBundle; }
    const f = path.join(tmp('manifest'), 'm.json');
    fs.writeFileSync(f, JSON.stringify({ app: 'fixture', expect }, null, 2));
    return f;
}

function run(ipa, manifest, { timeout = 120000 } = {}) {
    // The timeout is not belt-and-braces, it is load-bearing. A malformed
    // artifact once HUNG this tool, and a test written to catch a hang must not
    // itself hang: without this, spawnSync blocks forever and the suite stalls
    // instead of failing. `timedOut` is surfaced so a caller can tell "exited
    // with the wrong code" from "never exited at all" -- they need different fixes.
    const r = spawnSync('node', [TOOL, '--ipa', ipa, '--manifest', manifest], { encoding: 'utf8', timeout });
    return { code: r.status, out: `${r.stdout}${r.stderr}`, timedOut: r.signal === 'SIGTERM' && r.status === null };
}

const BASE_PLIST = { CFBundleIdentifier: 'com.fixture.app', CFBundleShortVersionString: '1.2.3' };

// --- the coupling truth table ----------------------------------------------

test('a matched capability with no declared key is a violation (the TCC crash)', () => {
    const ipa = makeIpa({
        plist: BASE_PLIST,
        web: { 'js/share.js': 'if (navigator.share) { shareCard(); }' },
    });
    const manifest = makeManifest({
        capabilityCoupling: [{ ifBundleMatches: 'navigator\\.share', requirePlistKey: 'NSPhotoLibraryAddUsageDescription' }],
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 1, out);
    assert.match(out, /does NOT declare NSPhotoLibraryAddUsageDescription/);
});

test('a matched capability with the key declared passes', () => {
    const ipa = makeIpa({
        plist: { ...BASE_PLIST, NSPhotoLibraryAddUsageDescription: 'Save your result card.' },
        web: { 'js/share.js': 'if (navigator.share) { shareCard(); }' },
    });
    const manifest = makeManifest({
        capabilityCoupling: [{ ifBundleMatches: 'navigator\\.share', requirePlistKey: 'NSPhotoLibraryAddUsageDescription' }],
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 0, out);
    assert.match(out, /shipped bundle matches .* AND the key is declared/);
});

test('no output line claims REACHABILITY, because only a text match was established', () => {
    // The tool scans the shipped web layer as text. It cannot resolve control
    // flow, so a hit in a comment or in dead code counts and a dynamically
    // built reference is missed. Saying a bundle "reaches" an API claims an
    // analysis nobody ran -- and these exact lines get pasted into reviewer
    // packets and PR comments, where the qualifier does not travel with them.
    //
    // The verdict is unchanged and still blocks: a match with no declared key
    // is the exact shape of the real TCC crash, and the fix for a genuine hit
    // (declare the key) is correct either way. Only the claim is narrowed.
    //
    // Asserted over BOTH branches, because the earlier rounds tightened the
    // pass lines and left the violation lines saying "reaches" -- which is
    // backwards, since the violation lines are the quotable ones.
    const web = { 'js/share.js': 'if (navigator.share) { shareCard(); }' };
    const rule = { ifBundleMatches: 'navigator\\.share', requirePlistKey: 'NSPhotoLibraryAddUsageDescription' };

    const violating = run(
        makeIpa({ plist: BASE_PLIST, web }),
        makeManifest({ capabilityCoupling: [rule] }),
    );
    assert.equal(violating.code, 1, violating.out);

    const passing = run(
        makeIpa({ plist: { ...BASE_PLIST, NSPhotoLibraryAddUsageDescription: 'Save your card.' }, web }),
        makeManifest({ capabilityCoupling: [rule] }),
    );
    assert.equal(passing.code, 0, passing.out);

    // Fails against the old code, which printed "shipped bundle reaches ..."
    // and "reachable in bundle AND declared".
    for (const { label, out } of [{ label: 'violation', out: violating.out }, { label: 'pass', out: passing.out }]) {
        assert.doesNotMatch(out, /bundle reaches/, `${label} output asserts reachability`);
        assert.doesNotMatch(out, /reachable in bundle/, `${label} output asserts reachability`);
        // "matches"/"match" is the claim the scan actually supports.
        assert.match(out, /match/i, `${label} output should describe a text match`);
    }
});

test('unreachable and undeclared passes, and says so accurately (the AWARE case)', () => {
    const ipa = makeIpa({ plist: BASE_PLIST, web: { 'js/app.js': 'renderToday();' } });
    const manifest = makeManifest({
        capabilityCoupling: [{ ifBundleMatches: 'getUserMedia', requirePlistKey: 'NSMicrophoneUsageDescription' }],
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 0, out);
    assert.match(out, /no shipped-bundle path matches .* and the key is undeclared/);
});

test('unmatched but declared is a violation when forbidIfUnreachable is set', () => {
    const ipa = makeIpa({
        plist: { ...BASE_PLIST, NSMicrophoneUsageDescription: 'Hear yourself.' },
        web: { 'js/app.js': 'renderToday();' },
    });
    const manifest = makeManifest({
        capabilityCoupling: [{ ifBundleMatches: 'getUserMedia', requirePlistKey: 'NSMicrophoneUsageDescription', forbidIfUnreachable: true }],
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 1, out);
    assert.match(out, /declares NSMicrophoneUsageDescription but no shipped-bundle path matches/);
});

test('unreachable but declared without forbidIfUnreachable never claims the key is undeclared', () => {
    // Regression: this branch used to print "unreachable in bundle, correctly
    // undeclared" about a key that WAS declared. A report that misstates what it
    // found is worse than no report, because it gets quoted into a packet.
    const ipa = makeIpa({
        plist: { ...BASE_PLIST, NSMicrophoneUsageDescription: 'Used by a native-only path.' },
        web: { 'js/app.js': 'renderToday();' },
    });
    const manifest = makeManifest({
        capabilityCoupling: [{ ifBundleMatches: 'getUserMedia', requirePlistKey: 'NSMicrophoneUsageDescription' }],
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 0, out);
    assert.match(out, /declared, and no shipped-bundle path matches/);
    assert.doesNotMatch(out, /correctly undeclared/);
});

test('andBundleMatches narrows a share rule to the file that also handles an image', () => {
    // A PDF share offers Save to Files and never touches the photo library, so a
    // bare navigator.share must not demand the photo-add key.
    const manifest = makeManifest({
        capabilityCoupling: [{
            ifBundleMatches: 'navigator\\.share',
            andBundleMatches: 'image/png|toBlob',
            requirePlistKey: 'NSPhotoLibraryAddUsageDescription',
        }],
    });

    const pdfOnly = makeIpa({ plist: BASE_PLIST, web: { 'js/report.js': 'navigator.share({ files: [pdf] });' } });
    assert.equal(run(pdfOnly, manifest).code, 0);

    const imageShare = makeIpa({
        plist: BASE_PLIST,
        web: { 'js/card.js': 'canvas.toBlob(b => navigator.share({ files: [new File([b], "card.png")] }));' },
    });
    const r = run(imageShare, manifest);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /AND/);
});

test('a share/image flow SPLIT across two files prints an advisory, not silence', () => {
    // The same-file requirement stops a false positive (a PDF share does not
    // touch the photo library). Its cost is a miss: a genuine share-image flow
    // can live across two modules, and then the conjunction holds in no single
    // file while the shipped payload as a whole still supports Save Image.
    //
    // Reporting that as "no shipped-bundle path matches" is true of the
    // conjunction and reads as "nothing matched" -- a blind spot presented as a
    // clean scan, which is the failure this whole tool exists against. It stays
    // a pass (making it a violation would reinstate the false positive), but it
    // has to be VISIBLE.
    const ipa = makeIpa({
        plist: BASE_PLIST,
        web: {
            'js/share.js': 'navigator.share({ files: [b] })',
            'js/image.js': 'canvas.toBlob(b => b) // image/png',
        },
    });
    const manifest = makeManifest({
        webBundle: { root: 'public' },
        capabilityCoupling: [{
            ifBundleMatches: 'navigator\\.share|canShare',
            andBundleMatches: 'image/png|toBlob',
            requirePlistKey: 'NSPhotoLibraryAddUsageDescription',
        }],
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 0, out);
    // Fails against the old code, which emitted only the "no shipped-bundle
    // path matches" pass line and nothing else.
    assert.match(out, /note {2}capability NSPhotoLibraryAddUsageDescription/);
    assert.match(out, /does not match in the SAME file/);
    assert.match(out, /js\/share\.js/);
});

test('both patterns must hit the SAME file, not two unrelated modules', () => {
    const manifest = makeManifest({
        capabilityCoupling: [{
            ifBundleMatches: 'navigator\\.share',
            andBundleMatches: 'toBlob',
            requirePlistKey: 'NSPhotoLibraryAddUsageDescription',
        }],
    });
    const split = makeIpa({
        plist: BASE_PLIST,
        web: { 'js/share.js': 'navigator.share({ text: "hi" });', 'js/thumb.js': 'canvas.toBlob(cacheThumb);' },
    });
    const { code, out } = run(split, manifest);
    assert.equal(code, 0, out);
});

// --- the exit-code contract -------------------------------------------------

test('a malformed manifest exits 3 (verifier misconfigured), not 2 and not 1', () => {
    // It used to exit 2 and print ARTIFACT UNREADABLE, which is a statement
    // about the BUILD -- for a typo in a config file, with an IPA that was
    // perfectly fine. A wrong diagnosis is worse than a vague one because it is
    // actionable: someone goes and debugs the artifact.
    const ipa = makeIpa({ plist: BASE_PLIST });
    const bad = path.join(tmp('manifest'), 'm.json');
    fs.writeFileSync(bad, '{ this is not json');
    const { code, out } = run(ipa, bad);
    assert.equal(code, 3, out);
    assert.match(out, /VERIFIER MISCONFIGURED/);
    assert.doesNotMatch(out, /ARTIFACT UNREADABLE/, 'a config error must not be reported as an unreadable build');
});

test('a file that is not an IPA exits 2', () => {
    const notIpa = path.join(tmp('junk'), 'App.ipa');
    fs.writeFileSync(notIpa, 'not a zip');
    const { code, out } = run(notIpa, makeManifest({}));
    assert.equal(code, 2, out);
});

test('a zip with no Payload/ exits 2', () => {
    const dir = tmp('nopayload');
    fs.mkdirSync(path.join(dir, 'Other'));
    fs.writeFileSync(path.join(dir, 'Other', 'x.txt'), 'x');
    const ipa = path.join(dir, 'App.ipa');
    execFileSync('zip', ['-q', '-r', ipa, 'Other'], { cwd: dir });
    const { code, out } = run(ipa, makeManifest({}));
    assert.equal(code, 2, out);
});

test('a corrupt Info.plist exits 2, never 0 and never 1', () => {
    // The dangerous outcome is not the crash, it is a plist that parses to
    // nothing and makes every plist rule pass vacuously.
    const ipa = makeIpa({ rawPlist: 'bplist00   truncated garbage' });
    const manifest = makeManifest({ infoPlist: { equals: { CFBundleIdentifier: 'com.fixture.app' } } });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 2, out);
});

test('a wrong webBundle.root exits 2 instead of silently passing every rule', () => {
    // The worst failure this tool could have: a typo in `root` used to make
    // every bundle and coupling rule skip while the run printed CLEAN.
    const ipa = makeIpa({
        plist: BASE_PLIST,
        web: { 'js/share.js': 'navigator.share({});' },
        webRoot: 'public',
    });
    const manifest = makeManifest({
        webBundle: { root: 'pubic', mustNotContain: [{ pattern: 'navigator\\.share' }] },
        capabilityCoupling: [{ ifBundleMatches: 'navigator\\.share', requirePlistKey: 'NSPhotoLibraryAddUsageDescription' }],
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 2, out);
    assert.doesNotMatch(out, /VERDICT: CLEAN/);
});

test('missing arguments exit 3, not 2 -- a caller mistake is not an unreadable build', () => {
    const r = spawnSync('node', [TOOL], { encoding: 'utf8' });
    assert.equal(r.status, 3);
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /ARTIFACT UNREADABLE/);
});

// --- plist and bundle rules -------------------------------------------------

test('forbidden and equals plist rules fire', () => {
    const ipa = makeIpa({ plist: { ...BASE_PLIST, NSPhotoLibraryUsageDescription: 'read the library' } });
    const manifest = makeManifest({
        infoPlist: {
            equals: { CFBundleIdentifier: 'com.fixture.app' },
            forbidden: [{ key: 'NSPhotoLibraryUsageDescription', why: 'add-only is the correct scope' }],
        },
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 1, out);
    assert.match(out, /NSPhotoLibraryUsageDescription PRESENT/);
});

test('renderedVersion compares the rendered tag to the binary version', () => {
    const manifest = makeManifest({
        webBundle: { root: 'public' },
        renderedVersion: { file: 'index.html', elementId: 'app-version-tag' },
    });

    const good = makeIpa({
        plist: BASE_PLIST,
        web: { 'index.html': '<footer><span id="app-version-tag">v1.2.3</span></footer>' },
    });
    assert.equal(run(good, manifest).code, 0);

    // The placeholder case this rule replaced a false-positive scan for.
    const stale = makeIpa({
        plist: BASE_PLIST,
        web: { 'index.html': '<footer><span id="app-version-tag">{{APP_VERSION}}</span></footer>' },
    });
    const r = run(stale, manifest);
    assert.equal(r.code, 1, r.out);
});

test('a comment mentioning the placeholder does not trip renderedVersion', () => {
    // The exact false positive that a mustNotContain "{{APP_VERSION}}" rule
    // produced on Build 59: it fired on comments documenting the substitution
    // mechanism. Assert the outcome the user reads, not the mechanism.
    const ipa = makeIpa({
        plist: BASE_PLIST,
        web: {
            'index.html': '<footer><span id="app-version-tag">v1.2.3</span></footer>',
            'js/native.js': '// The build replaces {{APP_VERSION}} in index.html at package time.',
        },
    });
    const manifest = makeManifest({
        webBundle: { root: 'public' },
        renderedVersion: { file: 'index.html', elementId: 'app-version-tag' },
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 0, out);
});

test('renderedVersion fails loud when the file is not where the manifest says', () => {
    // renderedVersion.file resolves relative to webBundle.root. Getting that
    // wrong must report "cannot find it" rather than quietly passing, since a
    // rule that cannot locate its subject has verified nothing.
    const ipa = makeIpa({
        plist: BASE_PLIST,
        web: { 'index.html': '<span id="app-version-tag">v1.2.3</span>' },
        webRoot: 'public',
    });
    // Points at a filename that is not in the bundle. The earlier version of
    // this test got its miss for a different reason -- it omitted webBundle.root
    // so the scan walked the whole .app and the file's rel path came back as
    // "public/index.html" -- which stopped being expressible once a root became
    // mandatory. Same intent, fixture no longer riding on the loose scan.
    const manifest = makeManifest({
        webBundle: { root: 'public' },
        renderedVersion: { file: 'version.html', elementId: 'app-version-tag' },
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 1, out);
    assert.match(out, /cannot find version\.html in the shipped bundle/);
});

// --- the binary-plist parser, on real production bytes ----------------------
// tests/fixtures/binary-info.plist is the actual Info.plist lifted out of the
// shipped AWARE IPA (1.4.0 / 1779565782). Every other fixture here writes XML,
// which left the custom bplist00 reader -- the path that runs against every
// real build -- with no coverage at all. That gap was worth closing with real
// bytes rather than a hand-rolled writer whose own bugs would then be what is
// under test.

const BINARY_PLIST = path.join(ROOT, 'tests/fixtures/binary-info.plist');

function makeBinaryPlistIpa(web = {}) {
    return makeIpa({ rawPlist: fs.readFileSync(BINARY_PLIST), web });
}

test('the binary-plist reader parses a real shipped Info.plist', () => {
    const ipa = makeBinaryPlistIpa();
    const manifest = makeManifest({
        infoPlist: { equals: { CFBundleIdentifier: 'com.innerscope.aware' } },
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 0, out);
    // The header line proves the version strings came out of the binary blob.
    assert.match(out, /1\.4\.0 \(1779565782\)/);
});

test('a plist rule fails against the real binary plist when it should', () => {
    // Guards the inverse: a parser returning an empty object would make the
    // test above pass vacuously and every forbidden-key rule pass too.
    const ipa = makeBinaryPlistIpa();
    const manifest = makeManifest({
        infoPlist: { equals: { CFBundleIdentifier: 'com.innerscope.iheartest' } },
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 1, out);
    assert.match(out, /com\.innerscope\.aware/);
});

test('capability coupling reads the real binary plist: absent key, unreachable API', () => {
    // This is the exact claim the tool makes about the shipped AWARE build.
    const ipa = makeBinaryPlistIpa({ 'js/app.js': 'renderToday();' });
    const manifest = makeManifest({
        webBundle: { root: 'public' },
        capabilityCoupling: [{ ifBundleMatches: 'getUserMedia', requirePlistKey: 'NSMicrophoneUsageDescription', forbidIfUnreachable: true }],
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 0, out);
});

// --- manifest validation is an INSPECTION step, not a violation -------------

test('an invalid regex in the manifest exits 3, not 1', () => {
    // A manifest can be valid JSON and still be a broken rule set. Compiling
    // mid-run turned that into exit 1, which claims the artifact is at fault.
    const ipa = makeIpa({ plist: BASE_PLIST });
    const manifest = makeManifest({
        capabilityCoupling: [{ ifBundleMatches: '[', requirePlistKey: 'NSMicrophoneUsageDescription' }],
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 3, out);
    assert.match(out, /not a valid regular expression/);
    assert.match(out, /VERIFIER MISCONFIGURED/);
});

test('a rule missing requirePlistKey exits 3 rather than matching nothing', () => {
    const ipa = makeIpa({ plist: BASE_PLIST });
    const manifest = makeManifest({ capabilityCoupling: [{ ifBundleMatches: 'getUserMedia' }] });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 3, out);
    assert.match(out, /requirePlistKey/);
});

test('a webBundle pattern that is not a string exits 3', () => {
    const ipa = makeIpa({ plist: BASE_PLIST, web: { 'js/a.js': 'x' } });
    const manifest = makeManifest({ webBundle: { root: 'public', mustNotContain: [{ why: 'no pattern given' }] } });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 3, out);
});

// --- renderedVersion markup tolerance ---------------------------------------

test('renderedVersion accepts single quotes and a non-leading id attribute', () => {
    // `<span class="x" id='tag'>` is valid HTML that the double-quote-only,
    // id-must-come-first pattern reported as a release defect.
    const manifest = makeManifest({
        webBundle: { root: 'public' },
        renderedVersion: { file: 'index.html', elementId: 'app-version-tag' },
    });
    const ipa = makeIpa({
        plist: BASE_PLIST,
        web: { 'index.html': "<footer><span class=\"muted\" id='app-version-tag'>v1.2.3</span></footer>" },
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 0, out);
});

test('renderedVersion says the tag is absent rather than blaming the version', () => {
    // "renders null, binary is v1.2.3" reads like a version mismatch. A missing
    // or runtime-rendered tag is a different problem and gets its own message.
    const manifest = makeManifest({
        webBundle: { root: 'public' },
        renderedVersion: { file: 'index.html', elementId: 'app-version-tag' },
    });
    const ipa = makeIpa({ plist: BASE_PLIST, web: { 'index.html': '<footer></footer>' } });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 1, out);
    assert.match(out, /no element with id "app-version-tag"/);
    assert.match(out, /rendered at runtime/);
});

// --- an unreadable plist must never reach CLEAN -----------------------------

test('garbage in Info.plist exits 2 rather than printing CLEAN', () => {
    // The worst outcome this tool can produce, and it did: the XML reader
    // returns {} for anything it does not understand, because its key/value
    // regex simply finds no matches. {} is a dictionary, so a type check alone
    // let it through, every plist rule then passed vacuously, and the run
    // printed VERDICT: CLEAN over an artifact nobody had read.
    const ipa = makeIpa({ rawPlist: 'this is not a plist at all' });
    const { code, out } = run(ipa, makeManifest({}));
    assert.equal(code, 2, out);
    assert.doesNotMatch(out, /VERDICT: CLEAN/);
});

test('a plist that parses but has no CFBundleIdentifier is treated as a failed parse', () => {
    const ipa = makeIpa({ plist: { SomeUnrelatedKey: 'x' } });
    const { code, out } = run(ipa, makeManifest({}));
    assert.equal(code, 2, out);
    assert.match(out, /no CFBundleIdentifier/);
});

// --- webBundle patterns are REGEXES, and must be matched as such ------------

test('a webBundle pattern with alternation matches as a regex, not a literal', () => {
    // These were compiled during validation and then evaluated with
    // String.includes, so `getUserMedia|mediaDevices` was searched for as that
    // literal 24-character string and matched nothing: a rule that looks like
    // it is guarding and is not.
    const ipa = makeIpa({ plist: BASE_PLIST, web: { 'js/mic.js': 'navigator.mediaDevices.getUserMedia({audio:true})' } });
    const manifest = makeManifest({
        webBundle: { root: 'public', mustNotContain: [{ pattern: 'getUserMedia|mediaDevices', why: 'the mic path must not ship' }] },
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 1, out);
    assert.match(out, /getUserMedia\|mediaDevices found in js\/mic\.js/);
});

test('a mustContain alternation is satisfied by either branch', () => {
    const ipa = makeIpa({ plist: BASE_PLIST, web: { 'js/a.js': 'cioConsentGranted()' } });
    const manifest = makeManifest({
        webBundle: { root: 'public', mustContain: [{ pattern: 'cioConsentGranted|analyticsConsentGranted' }] },
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 0, out);
});

// --- infoPlist rule shapes are validated too --------------------------------

test('an infoPlist rule with no key exits 3 rather than matching undefined', () => {
    // `plist[undefined]` does not throw; it quietly reports "undefined MISSING"
    // or passes a forbidden check that never looked at anything. Nonsense
    // matching is worse than a crash because it is reported as a result.
    const ipa = makeIpa({ plist: BASE_PLIST });
    for (const expect_ of [
        { infoPlist: { required: [{ why: 'no key given' }] } },
        { infoPlist: { forbidden: [{ why: 'no key given' }] } },
    ]) {
        const { code, out } = run(ipa, makeManifest(expect_));
        assert.equal(code, 3, out);
        assert.match(out, /key must be a non-empty string/);
    }
});

// --- "declared" must mean a usable purpose string ---------------------------
// A usage description is the sentence iOS shows in the permission prompt. A
// present-but-empty key is not a disclosure, and `requirePlistKey in plist`
// counted it as one -- so an artifact with no valid TCC disclosure could report
// CLEAN, which is the exact failure the rule exists to catch.

const SHARE_RULE = {
    ifBundleMatches: 'navigator\\.share',
    requirePlistKey: 'NSPhotoLibraryAddUsageDescription',
};
const SHARE_WEB = { 'js/share.js': 'canvas.toBlob(b => navigator.share({ files: [b] }))' };

test('an empty purpose string does not count as declared', () => {
    const ipa = makeIpa({ plist: { ...BASE_PLIST, NSPhotoLibraryAddUsageDescription: '' }, web: SHARE_WEB });
    const manifest = makeManifest({ webBundle: { root: 'public' }, capabilityCoupling: [SHARE_RULE] });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 1, out);
    assert.match(out, /not a usable purpose string/);
});

test('a whitespace-only purpose string does not count as declared', () => {
    const ipa = makeIpa({ plist: { ...BASE_PLIST, NSPhotoLibraryAddUsageDescription: '   ' }, web: SHARE_WEB });
    const manifest = makeManifest({ webBundle: { root: 'public' }, capabilityCoupling: [SHARE_RULE] });
    assert.equal(run(ipa, manifest).code, 1);
});

test('a non-string purpose value does not count as declared', () => {
    const ipa = makeIpa({ plist: { ...BASE_PLIST, NSPhotoLibraryAddUsageDescription: true }, web: SHARE_WEB });
    const manifest = makeManifest({ webBundle: { root: 'public' }, capabilityCoupling: [SHARE_RULE] });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 1, out);
    assert.match(out, /not a usable purpose string/);
});

test('present-but-unusable is reported differently from absent', () => {
    // "does NOT declare" would send someone looking for a missing key that is
    // sitting right there with a bad value.
    const withEmpty = makeIpa({ plist: { ...BASE_PLIST, NSPhotoLibraryAddUsageDescription: '' }, web: SHARE_WEB });
    const absent = makeIpa({ plist: BASE_PLIST, web: SHARE_WEB });
    const manifest = makeManifest({ webBundle: { root: 'public' }, capabilityCoupling: [SHARE_RULE] });
    assert.match(run(withEmpty, manifest).out, /has NSPhotoLibraryAddUsageDescription but its value/);
    assert.match(run(absent, manifest).out, /does NOT declare NSPhotoLibraryAddUsageDescription/);
});

test('an unusable purpose string is a violation even with NO bundle match and no forbidIfUnreachable', () => {
    // Pins the documented fifth row. The other four rows are about coupling;
    // this one is about the key being broken on its own terms -- iOS renders an
    // empty permission prompt regardless of what the web layer reaches.
    //
    // Documented and implemented behaviour had drifted apart here: the table
    // described a two-valued plist axis (absent / declared) and this third
    // state fell through the gap. The code was right and the docs were wrong,
    // which is the less common direction and the easier one to miss.
    const ipa = makeIpa({
        plist: { ...BASE_PLIST, NSMicrophoneUsageDescription: '' },
        web: { 'js/app.js': 'renderToday();' },   // nothing matches getUserMedia
    });
    const manifest = makeManifest({
        webBundle: { root: 'public' },
        capabilityCoupling: [{ ifBundleMatches: 'getUserMedia', requirePlistKey: 'NSMicrophoneUsageDescription' }],
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 1, out);
    assert.match(out, /not a usable purpose string/);
});

test('a real purpose string still passes', () => {
    const ipa = makeIpa({
        plist: { ...BASE_PLIST, NSPhotoLibraryAddUsageDescription: 'Save your result card to Photos.' },
        web: SHARE_WEB,
    });
    const manifest = makeManifest({ webBundle: { root: 'public' }, capabilityCoupling: [SHARE_RULE] });
    assert.equal(run(ipa, manifest).code, 0);
});

// --- renderedVersion.elementId is a literal, not a pattern ------------------

test('a regex metacharacter in elementId never crashes the run', () => {
    // Before escaping, `[` threw at RegExp construction OUTSIDE inspect(), so
    // Node exited 1 and the run blamed the artifact for what was really a
    // broken verifier configuration.
    //
    // I first wrote this expecting exit 2, and that was wrong: once the id is
    // escaped there is no throw to classify. An id is a literal, so `[` is a
    // perfectly readable configuration naming an element that does not exist,
    // and "no element with id" at exit 1 is the accurate answer. Exit 2 is for
    // "I could not look", and here we looked.
    const ipa = makeIpa({ plist: BASE_PLIST, web: { 'index.html': '<span id="x">v1.2.3</span>' } });
    const manifest = makeManifest({
        webBundle: { root: 'public' },
        renderedVersion: { file: 'index.html', elementId: '[' },
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 1, out);
    assert.match(out, /no element with id "\["/);
    assert.doesNotMatch(out, /Invalid regular expression|SyntaxError/);
});

test('elementId is matched literally, so metacharacters cannot match a different element', () => {
    // Unescaped, `a.c` would match id="abc". It must match only id="a.c".
    const manifest = makeManifest({
        webBundle: { root: 'public' },
        renderedVersion: { file: 'index.html', elementId: 'a.c' },
    });
    const wrongElement = makeIpa({ plist: BASE_PLIST, web: { 'index.html': '<span id="abc">v1.2.3</span>' } });
    const r = run(wrongElement, manifest);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /no element with id "a\.c"/);

    const exact = makeIpa({ plist: BASE_PLIST, web: { 'index.html': '<span id="a.c">v1.2.3</span>' } });
    assert.equal(run(exact, manifest).code, 0);
});

// --- the XML reader needs a floor -------------------------------------------

test('text that merely contains a plist-shaped fragment is not accepted as a plist', () => {
    // The reader is a regex over key/value pairs, so any text carrying a
    // matching fragment would otherwise look like a successfully parsed plist
    // and let the configured checks run against a corrupt file.
    const ipa = makeIpa({
        rawPlist: 'garbage garbage <key>CFBundleIdentifier</key><string>com.fixture.app</string> more garbage',
    });
    const { code, out } = run(ipa, makeManifest({ infoPlist: { equals: { CFBundleIdentifier: 'com.fixture.app' } } }));
    assert.equal(code, 2, out);
    assert.match(out, /not XML plist content/);
});

// --- a truncated XML plist is unreadable, not evidence ----------------------
// The <plist>/<dict> shape check above is NOT enough, and the function's own
// comment said so before the guard was written to match. A truncated document
// keeps its opening tags and its early keys, so it passed the floor and every
// key past the cut read as absent.
//
// Two distinct wrong outcomes fall out of that, and the second is the nastier:
// a false CLEAN when the configured keys happen to precede the cut, and a
// FABRICATED VIOLATION when they follow it. Exit 2 exists so that "I could not
// read it" is never reported as a pass and never as a finding.

const TRUNC_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>CFBundleIdentifier</key>\n\t<string>com.fixture.app</string>\n';

test('a truncated plist whose configured keys precede the cut exits 2, not CLEAN', () => {
    const ipa = makeIpa({
        rawPlist: `${TRUNC_HEAD}\t<key>NSPhotoLibraryAddUsageDescription</key>\n\t<string>Save your card.</string>\n\t<key>UILaunchStoryboard`,
        web: { 'js/share.js': 'if (navigator.share) { shareCard(); }' },
    });
    const manifest = makeManifest({
        webBundle: { root: 'public' },
        capabilityCoupling: [{ ifBundleMatches: 'navigator\\.share', requirePlistKey: 'NSPhotoLibraryAddUsageDescription' }],
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 2, out);
    assert.match(out, /truncated/);
});

test('a truncated plist NEVER fabricates a violation about a key past the cut', () => {
    // Reproduced against the old code before this was fixed: the mic key sits
    // past the cut, so it read as absent and the coupling rule announced
    // "Info.plist does NOT declare NSMicrophoneUsageDescription" -- a confident,
    // quotable accusation about a key the tool never actually looked at.
    const ipa = makeIpa({
        rawPlist: `${TRUNC_HEAD}\t<key>NSMicroph`,
        web: { 'js/mic.js': 'navigator.mediaDevices.getUserMedia({ audio: true })' },
    });
    const manifest = makeManifest({
        webBundle: { root: 'public' },
        capabilityCoupling: [{ ifBundleMatches: 'getUserMedia', requirePlistKey: 'NSMicrophoneUsageDescription' }],
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 2, out);
    assert.doesNotMatch(out, /does NOT declare/, 'reported a phantom missing key from an unreadable plist');
});

test('a mangled middle exits 2 even when the closing </plist> is present', () => {
    // Truncation is not the only corruption; a mangled middle leaves the
    // document terminated but incoherent.
    //
    // The first fixture I wrote here was not actually unbalanced -- an extra
    // <dict> plus an extra </dict> cancel out -- so the test failed and the
    // tool was right. Keeping the note because "I wrote a bad fixture" and "the
    // guard does not work" produce the identical red, and only one of them is a
    // reason to change the code. This one drops a </key> instead.
    //
    // This assertion used to demand the string "do not balance", from the
    // tag-COUNTING heuristic that guarded the old regex reader. The recursive
    // reader that replaced it does not count anything -- it reports the exact
    // position where the document stopped making sense. Asserting the vaguer
    // message would now pin a diagnosis strictly worse than the one available,
    // so this asserts the contract (exit 2, and the specific defect named)
    // rather than the old wording.
    const ipa = makeIpa({
        rawPlist: `${TRUNC_HEAD}\t<key>NSPhotoLibraryAddUsageDescription\n\t<string>x</string>\n</dict>\n</plist>\n`,
    });
    const { code, out } = run(ipa, makeManifest({ infoPlist: { equals: { CFBundleIdentifier: 'com.fixture.app' } } }));
    assert.equal(code, 2, out);
    assert.match(out, /expected <\/key> but found <string>/, 'the message should name where the document stopped parsing');
    assert.match(out, /malformed/);
});

test('a realistic nested plist with arrays and a self-closing <dict\/> still parses', () => {
    // The false-positive guard for the two checks above. Real Info.plists nest
    // dicts inside arrays (CFBundleURLTypes) and carry empty self-closing dicts
    // (UISceneConfigurations); a balance check that trips on those would fail
    // every real artifact, which is a worse failure than the one being fixed.
    const ipa = makeIpa({
        rawPlist: [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
            '<plist version="1.0">', '<dict>',
            '\t<key>CFBundleIdentifier</key><string>com.fixture.app</string>',
            '\t<key>ITSAppUsesNonExemptEncryption</key><false/>',
            '\t<key>CFBundleURLTypes</key><array><dict>',
            '\t\t<key>CFBundleURLName</key><string>com.fixture.app</string>',
            '\t\t<key>CFBundleURLSchemes</key><array><string>fixture</string></array>',
            '\t</dict></array>',
            '\t<key>UIApplicationSceneManifest</key><dict>',
            '\t\t<key>UISceneConfigurations</key><dict/>',
            '\t</dict>',
            '</dict>', '</plist>', '',
        ].join('\n'),
    });
    const { code, out } = run(ipa, makeManifest({ infoPlist: { equals: { CFBundleIdentifier: 'com.fixture.app' } } }));
    assert.equal(code, 0, out);
});

// --- zero scanned files is fatal whenever any rule reads the bundle ---------
// The first version of this guard read `if (wantedRoot && files.length === 0)`,
// so a manifest with capabilityCoupling and no webBundle.root fell straight
// through: the scan rooted at the .app itself, found no text (a real bundle's
// top level is compiled binaries), every coupling rule reported "no
// shipped-bundle path matches", and the run printed CLEAN.
//
// Verifying nothing and finding nothing printed the same way -- inside the
// guard written to stop exactly that. Condition the check on what the RULES
// need, never on what the manifest happened to mention.

// --- the artifact boundary ------------------------------------------------
// Every verdict this tool prints is only worth something if the bytes behind it
// came out of the .app that shipped. webBundle.root is manifest-supplied, and
// an unchecked path join lets it leave that boundary.

test('a webBundle.root with ".." cannot escape the shipped .app', () => {
    // Reproduced against the old code: root "../../" scanned the extraction
    // parent and printed VERDICT: CLEAN, exit 0, over files that were never in
    // the app. The same escape could manufacture a finding just as easily.
    const ipa = makeIpa({ plist: BASE_PLIST, web: { 'js/app.js': 'renderToday();' } });
    const manifest = makeManifest({
        webBundle: { root: '../../' },
        capabilityCoupling: [{ ifBundleMatches: 'getUserMedia', requirePlistKey: 'NSMicrophoneUsageDescription' }],
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 3, out);
    assert.match(out, /\.\.".{0,40}segment|outside the shipped \.app/);
    assert.doesNotMatch(out, /VERDICT: CLEAN/);
});

test('a nested ".." inside an otherwise normal root is refused too', () => {
    // Rejected structurally by SEGMENT, not by a prefix test, so a "..' buried
    // mid-path is caught rather than only a leading one.
    const ipa = makeIpa({ plist: BASE_PLIST, web: { 'js/app.js': 'renderToday();' } });
    const manifest = makeManifest({
        webBundle: { root: 'public/../../..' },
        renderedVersion: { file: 'index.html', elementId: 'app-version-tag' },
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 3, out);
    assert.doesNotMatch(out, /VERDICT: CLEAN/);
});

test('an absolute webBundle.root is refused', () => {
    const ipa = makeIpa({ plist: BASE_PLIST, web: { 'js/app.js': 'renderToday();' } });
    const manifest = makeManifest({
        webBundle: { root: '/etc' },
        capabilityCoupling: [{ ifBundleMatches: 'getUserMedia', requirePlistKey: 'NSMicrophoneUsageDescription' }],
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 3, out);
    assert.match(out, /absolute path/);
});

test('a legitimate nested root inside the .app still works', () => {
    // The false-positive guard: the boundary check must not break a real
    // manifest that points at a subdirectory deeper than one level.
    const ipa = makeIpa({
        plist: BASE_PLIST,
        web: { 'app.js': 'navigator.share({})' },
        webRoot: 'public/assets',
    });
    const manifest = makeManifest({
        webBundle: { root: 'public/assets' },
        capabilityCoupling: [{ ifBundleMatches: 'navigator\\.share', requirePlistKey: 'NSPhotoLibraryAddUsageDescription' }],
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 1, out);   // matched, key absent -> the normal violation
    assert.match(out, /does NOT declare NSPhotoLibraryAddUsageDescription/);
});

// A symlink escape needs an IPA built with real symlink entries, which makeIpa
// does not do. An IPA is a zip and zips carry symlinks; `zip --symlinks` stores
// them and unzip restores them, so this is reachable by anything that produces
// an archive, not a contrived case.
function makeSymlinkIpa({ linkName, target, extra = {} }) {
    const dir = tmp('symipa');
    const appDir = path.join(dir, 'Payload', 'App.app');
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'Info.plist'), plistXml(BASE_PLIST));
    for (const [rel, text] of Object.entries(extra)) {
        const abs = path.join(appDir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, text);
    }
    fs.symlinkSync(target, path.join(appDir, linkName));
    const ipa = path.join(dir, 'App.ipa');
    execFileSync('zip', ['-q', '-r', '-y', ipa, 'Payload'], { cwd: dir });
    return ipa;
}

test('a .app that is ITSELF a symlink out of Payload/ is fatal', () => {
    // The boundary has to be anchored to the extraction directory, not to the
    // .app. readShippedText trusts realpath(appDir) as its base, which is only
    // sound if appDir is inside the extraction -- and an archive can store
    // Payload/App.app as a symlink.
    //
    // Reproduced against the pre-fix code: it read the FOREIGN Info.plist
    // (reporting a version that never shipped), scanned the foreign web layer,
    // and emitted a violation naming a file the artifact does not contain. The
    // downstream symlink checks could not help, because a base derived from the
    // compromised value makes every foreign path trivially "inside" it.
    const foreign = tmp('foreign-app');
    const foreignApp = path.join(foreign, 'App.app');
    fs.mkdirSync(path.join(foreignApp, 'public'), { recursive: true });
    fs.writeFileSync(path.join(foreignApp, 'Info.plist'), plistXml({ ...BASE_PLIST, CFBundleShortVersionString: '9.9.9' }));
    fs.writeFileSync(path.join(foreignApp, 'public', 'secret.js'), 'navigator.mediaDevices.getUserMedia({})');

    const dir = tmp('appsym');
    fs.mkdirSync(path.join(dir, 'Payload'), { recursive: true });
    fs.symlinkSync(foreignApp, path.join(dir, 'Payload', 'App.app'));
    const ipa = path.join(dir, 'App.ipa');
    execFileSync('zip', ['-q', '-r', '-y', ipa, 'Payload'], { cwd: dir });

    const manifest = makeManifest({
        webBundle: { root: 'public' },
        capabilityCoupling: [{ ifBundleMatches: 'getUserMedia', requirePlistKey: 'NSMicrophoneUsageDescription' }],
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 2, out);
    assert.match(out, /symlink/i);
    assert.doesNotMatch(out, /VERDICT/);
    assert.doesNotMatch(out, /secret\.js/, 'named a file from outside the artifact');
    assert.doesNotMatch(out, /9\.9\.9/, 'reported a version read from outside the artifact');
});

test('a webBundle.root that is a SYMLINK out of the .app is fatal', () => {
    // path.resolve is lexical and never touches the filesystem, so the string
    // checks pass this cleanly. Reproduced against the pre-fix code: it read
    // the foreign file and emitted a VIOLATION naming it -- manufacturing an
    // actionable, quotable finding out of bytes that never shipped, which is
    // worse than suppressing a real one.
    const outside = tmp('outside');
    fs.writeFileSync(path.join(outside, 'secret.js'), 'navigator.mediaDevices.getUserMedia({})');
    const ipa = makeSymlinkIpa({ linkName: 'public', target: outside });
    const manifest = makeManifest({
        webBundle: { root: 'public' },
        capabilityCoupling: [{ ifBundleMatches: 'getUserMedia', requirePlistKey: 'NSMicrophoneUsageDescription' }],
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 2, out);
    assert.match(out, /symlink/i);
    assert.doesNotMatch(out, /VERDICT/);
    assert.doesNotMatch(out, /secret\.js/, 'named a file from outside the artifact');
});

test('a symlink DEEPER inside a legitimate root is fatal too', () => {
    // Guarding only the root would leave the tree below it open.
    const outside = tmp('outside-deep');
    fs.writeFileSync(path.join(outside, 'secret.js'), 'navigator.mediaDevices.getUserMedia({})');
    const ipa = makeSymlinkIpa({
        linkName: 'public/vendor',
        target: outside,
        extra: { 'public/js/app.js': 'renderToday();' },
    });
    const manifest = makeManifest({
        webBundle: { root: 'public' },
        capabilityCoupling: [{ ifBundleMatches: 'getUserMedia', requirePlistKey: 'NSMicrophoneUsageDescription' }],
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 2, out);
    assert.match(out, /symlink/i);
    assert.doesNotMatch(out, /secret\.js/, 'named a file from outside the artifact');
});

test('a symlink pointing back INSIDE the bundle is followed, and counted once', () => {
    // The false-positive guard. Refusing every symlink would be easy and wrong:
    // an inside-pointing link ships real bytes and must still be scanned.
    // Deduped by resolved identity, so reaching one file through both its real
    // path and an alias does not double the file count or print it twice in a
    // violation's evidence.
    const ipa = makeSymlinkIpa({
        linkName: 'public/alias',
        target: 'real',
        extra: { 'public/real/share.js': 'navigator.share({})' },
    });
    const manifest = makeManifest({
        webBundle: { root: 'public' },
        capabilityCoupling: [{ ifBundleMatches: 'navigator\\.share', requirePlistKey: 'NSPhotoLibraryAddUsageDescription' }],
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 1, out);
    assert.match(out, /1 text files under public/);
    assert.match(out, /\(real\/share\.js\)/);   // once, not "real/share.js, real/share.js"
});

test('capabilityCoupling with no webBundle.root is refused outright', () => {
    // Now a contract violation in its own right, not merely a vacuous-pass risk.
    // Without a root the scan walked the entire .app, and an .app carries
    // localization strings, resource JSON and framework text -- so a rule whose
    // claim is about the shipped WEB bundle could match something that is not
    // the web payload at all. The zero-files guard cannot catch that case,
    // because there are plenty of files, just the wrong ones.
    const ipa = makeIpa({ plist: BASE_PLIST, web: { 'js/app.js': 'x' } });
    const manifest = makeManifest({
        webBundle: null,
        capabilityCoupling: [{ ifBundleMatches: 'getUserMedia', requirePlistKey: 'NSMicrophoneUsageDescription' }],
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 3, out);
    assert.match(out, /does not set webBundle\.root/);
    assert.doesNotMatch(out, /VERDICT: CLEAN/);
});

test('the vacuous-pass guard still fires when a root IS set and holds no text', () => {
    // The other half of the pair above: root named correctly, directory present
    // but empty. Rules that read the bundle would all pass having scanned
    // nothing, which must be exit 2 rather than CLEAN.
    const dir = tmp('emptyroot');
    const appDir = path.join(dir, 'Payload', 'App.app');
    fs.mkdirSync(path.join(appDir, 'public'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'Info.plist'), plistXml(BASE_PLIST));
    const ipa = path.join(dir, 'App.ipa');
    execFileSync('zip', ['-q', '-r', ipa, 'Payload'], { cwd: dir });

    const manifest = makeManifest({
        webBundle: { root: 'public' },
        capabilityCoupling: [{ ifBundleMatches: 'getUserMedia', requirePlistKey: 'NSMicrophoneUsageDescription' }],
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 2, out);
    assert.match(out, /would pass vacuously/);
    assert.doesNotMatch(out, /VERDICT: CLEAN/);
});

test('renderedVersion with no root and no scanned files exits 2', () => {
    const ipa = makeIpa({ plist: BASE_PLIST, web: {} });
    const manifest = makeManifest({ renderedVersion: { file: 'index.html', elementId: 'app-version-tag' } });
    assert.equal(run(ipa, manifest).code, 2);
});

test('webBundle rules with no root and no scanned files exit 3 (manifest error, not an unreadable artifact)', () => {
    const ipa = makeIpa({ plist: BASE_PLIST, web: {} });
    const manifest = makeManifest({ webBundle: { mustNotContain: [{ pattern: 'getUserMedia' }] } });
    assert.equal(run(ipa, manifest).code, 3);
});

test('a plist-only manifest still passes with no scanned files', () => {
    // The guard keys on what the rules need. A manifest that never reads the
    // bundle has nothing to pass vacuously, so an empty scan is fine there.
    const ipa = makeIpa({ plist: BASE_PLIST, web: {} });
    const manifest = makeManifest({ infoPlist: { equals: { CFBundleIdentifier: 'com.fixture.app' } } });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 0, out);
});

// --- the documented example must actually be usable -------------------------

test('the manifest example in SKILL.md is valid JSON and the tool accepts it', () => {
    // The published example carried a literal newline inside a string value, so
    // anyone who copied it got exit 2 from this very tool. A copyable example
    // that does not parse is worse than no example: it teaches the reader that
    // the tool is broken.
    const md = fs.readFileSync(path.join(ROOT, 'skills/release-verification/SKILL.md'), 'utf8');
    const block = md.match(/```jsonc\n([\s\S]*?)```/);
    assert.ok(block, 'SKILL.md no longer contains a jsonc manifest example');

    // Strip // comments the way a jsonc reader would, then require real JSON.
    const stripped = block[1].replace(/^\s*\/\/.*$/gm, '').replace(/\s+\/\/.*$/gm, '');
    const parsed = JSON.parse(stripped);

    // Parsing is necessary but not sufficient: run it as a real manifest so the
    // example is proven usable, not merely well-formed.
    const manifestFile = path.join(tmp('doc-example'), 'm.json');
    fs.writeFileSync(manifestFile, JSON.stringify(parsed));
    const ipa = makeIpa({
        plist: { ...BASE_PLIST, CFBundleIdentifier: 'com.innerscope.iheartest', NSPhotoLibraryAddUsageDescription: 'Save your card.', NSMicrophoneUsageDescription: 'Speech check.' },
        web: {
            'index.html': '<span id="app-version-tag">v1.2.3</span>',
            'js/app.js': 'cioConsentGranted(); canvas.toBlob(b => navigator.share({ files: [b] }));',
            'js/mic.js': 'navigator.mediaDevices.getUserMedia({ audio: true })',
        },
    });
    const { code, out } = run(ipa, manifestFile);
    assert.notEqual(code, 2, `the documented example is not a usable manifest: ${out}`);
});

// ---------------------------------------------------------------------------
// Binary plist hardening. A built IPA's Info.plist is binary, so this is the
// branch every real artifact takes -- and it shipped with no validation at all
// while the XML branch had a truncation floor. Same bug, more common path.
//
// The reproduction that motivated these: truncating tests/fixtures/binary-info.plist
// to 60% did not produce exit 2, it HUNG the process. A garbage length byte
// becomes an enormous `len` and the array branch tries to materialise it. A hang
// defeats the exit-code contract completely -- no 0, no 1, no 2, just a paid
// macOS runner sitting until its job timeout with nothing to diagnose from.
// ---------------------------------------------------------------------------

// Minimal bplist00 writer. Only the types these cases need, 1-byte offsets and
// refs, so the whole file stays under 256 bytes. Hand-built on purpose: the
// point is to construct object graphs a real encoder would never emit.
function bplist(objects, topObject = 0) {
    const header = Buffer.from('bplist00', 'latin1');
    // A count of 15 or more cannot fit the low nibble and must use bplist's
    // extended-length form: nibble 0x0f, then an integer object. Getting this
    // wrong is how the first draft of these fixtures produced a header the
    // hardened parser correctly rejected -- which is the parser working.
    const hdr = (base, count) => (count < 15
        ? Buffer.from([base | count])
        : Buffer.from([base | 0x0f, 0x10, count]));
    const bodies = objects.map((o) => {
        if (o.type === 'ascii') {
            return Buffer.concat([hdr(0x50, o.value.length), Buffer.from(o.value, 'ascii')]);
        }
        if (o.type === 'utf16') {
            const b = Buffer.alloc(o.value.length * 2);
            b.write(o.value, 0, 'utf16le');
            b.swap16(); // bplist stores UTF-16 big-endian
            return Buffer.concat([hdr(0x60, o.value.length), b]);
        }
        if (o.type === 'array') {
            return Buffer.concat([hdr(0xa0, o.refs.length), Buffer.from(o.refs)]);
        }
        if (o.type === 'dict') {
            return Buffer.concat([hdr(0xd0, o.keys.length), Buffer.from(o.keys), Buffer.from(o.values)]);
        }
        // An arbitrary single marker byte, for testing object types the reader
        // is supposed to refuse. The first draft of that test poked a marker
        // into a finished buffer by searching for the string next to it, which
        // silently hit the extended-LENGTH byte instead (a 15-char value does
        // not fit the low nibble) and produced a truncation error rather than
        // the type refusal under test. Say what you mean at the point the bytes
        // are written instead of computing an offset into them afterwards.
        if (o.type === 'raw') return Buffer.from([o.marker]);
        throw new Error(`unhandled fixture type ${o.type}`);
    });
    const offsets = [];
    let pos = header.length;
    for (const b of bodies) { offsets.push(pos); pos += b.length; }
    const table = Buffer.from(offsets);
    const trailer = Buffer.alloc(32);
    trailer[6] = 1;                                   // offsetSize
    trailer[7] = 1;                                   // objRefSize
    trailer.writeBigUInt64BE(BigInt(objects.length), 8);
    trailer.writeBigUInt64BE(BigInt(topObject), 16);
    trailer.writeBigUInt64BE(BigInt(pos), 24);        // offsetTableStart
    return Buffer.concat([header, ...bodies, table, trailer]);
}

test('a TRUNCATED binary plist exits 2 instead of hanging', () => {
    const good = fs.readFileSync(BINARY_PLIST);
    const ipa = makeIpa({ rawPlist: Buffer.from(good.subarray(0, Math.floor(good.length * 0.6))) });
    const manifest = makeManifest({ infoPlist: { equals: { CFBundleIdentifier: 'com.fixture.app' } } });
    const { code, out, timedOut } = run(ipa, manifest, { timeout: 20000 });
    // The hang check is the real assertion here, and it has to come from the
    // spawn itself. Before the fix this process never exited.
    assert.equal(timedOut, false, 'the tool must terminate on a truncated binary plist, not hang');
    assert.equal(code, 2, `truncated binary plist must be exit 2 (could not inspect), got ${code}: ${out}`);
    assert.match(out, /binary plist|bplist00/i);
});

test('a bplist whose version is not 00 is refused by name rather than guessed at', () => {
    const bad = Buffer.from(fs.readFileSync(BINARY_PLIST));
    bad.write('bplistZZ', 0, 'latin1');
    const ipa = makeIpa({ rawPlist: bad });
    const manifest = makeManifest({ infoPlist: { equals: { CFBundleIdentifier: 'com.fixture.app' } } });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 2, `unknown bplist version must be exit 2, got ${code}: ${out}`);
    assert.match(out, /bplist00/, 'the message should name the magic it requires');
    // It must NOT fall through to the XML branch, whose error would send the
    // reader looking for missing <plist> tags in a binary file.
    assert.doesNotMatch(out, /not XML plist content/);
});

test('a trailer pointing its offset table past EOF is exit 2, not a partial parse', () => {
    const buf = bplist([{ type: 'dict', keys: [1], values: [2] }, { type: 'ascii', value: 'CFBundleIdentifier' }, { type: 'ascii', value: 'com.fixture.app' }]);
    // Push offsetTableStart beyond the file.
    buf.writeBigUInt64BE(BigInt(buf.length + 4096), buf.length - 32 + 24);
    const ipa = makeIpa({ rawPlist: buf });
    const manifest = makeManifest({ infoPlist: { equals: { CFBundleIdentifier: 'com.fixture.app' } } });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 2, `offset table past EOF must be exit 2, got ${code}: ${out}`);
});

test('a cyclic object graph is exit 2 rather than a stack overflow', () => {
    // obj0 = { "CFBundleIdentifier": obj2 }, obj2 = [obj0]. Walking obj0 reaches
    // obj0 again, which without the re-entrancy guard recurses until the stack dies.
    const buf = bplist([
        { type: 'dict', keys: [1], values: [2] },
        { type: 'ascii', value: 'CFBundleIdentifier' },
        { type: 'array', refs: [0] },
    ]);
    const ipa = makeIpa({ rawPlist: buf });
    const manifest = makeManifest({ infoPlist: { equals: { CFBundleIdentifier: 'com.fixture.app' } } });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 2, `cyclic binary plist must be exit 2, got ${code}: ${out}`);
    assert.match(out, /cyclic|itself/i);
});

test('a UTF-16 string referenced twice reads the same both times', () => {
    // swap16() mutates in place. Reading one shared string object through two
    // dict entries byte-swapped it twice: correct on the first read, silent
    // mojibake on the second. Object 3 is referenced by BOTH values here.
    // CFBundleIdentifier is present because the tool treats a plist without it
    // as a failed parse -- a floor that fired on the first draft of this fixture
    // and was right to.
    const buf = bplist([
        { type: 'dict', keys: [1, 2, 3], values: [4, 5, 5] },
        { type: 'ascii', value: 'CFBundleIdentifier' },
        { type: 'ascii', value: 'CFBundleShortVersionString' },
        { type: 'ascii', value: 'CFBundleVersion' },
        { type: 'ascii', value: 'com.fixture.app' },
        { type: 'utf16', value: '1.2.3é' }, // non-ASCII forces the UTF-16 branch
    ]);
    const ipa = makeIpa({ rawPlist: buf });
    const manifest = makeManifest({
        infoPlist: { equals: { CFBundleIdentifier: 'com.fixture.app', CFBundleShortVersionString: '1.2.3é', CFBundleVersion: '1.2.3é' } },
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 0, `both reads of a shared UTF-16 string must match; got ${code}: ${out}`);
});

test('a symlink out of the web root is NOT scanned, and the skip is stated', () => {
    // ROUND 22 GOT THIS WRONG AND THIS TEST ENCODED THE ERROR. It asserted the
    // linked file WAS scanned and merely relabelled in the output -- treating a
    // scope problem as a presentation problem. webBundle.root is a SEMANTIC
    // boundary: SKILL.md says an .app "carries localization strings, resource
    // JSON and framework text, so a capability rule could match a file the web
    // layer never contains", which is exactly what following this link does.
    // Inside the .app is a SECURITY question; inside the web root is a SCOPE
    // question, and they need different answers.
    const dir = tmp('ipa');
    const appDir = path.join(dir, 'Payload', 'App.app');
    fs.mkdirSync(path.join(appDir, 'public'), { recursive: true });
    fs.mkdirSync(path.join(appDir, 'Frameworks', 'shared'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'Info.plist'), plistXml({ CFBundleIdentifier: 'com.fixture.app' }));
    // A real web file, so the scan has genuine content and the skip is the only exclusion.
    fs.writeFileSync(path.join(appDir, 'public', 'app.js'), 'console.log("web")');
    // The framework text a capability rule must NOT be allowed to match.
    fs.writeFileSync(path.join(appDir, 'Frameworks', 'shared', 'cam.js'), 'navigator.mediaDevices.getUserMedia({audio:true})');
    fs.symlinkSync(path.join('..', 'Frameworks', 'shared'), path.join(appDir, 'public', 'shared'));
    const ipa = path.join(dir, 'App.ipa');
    execFileSync('zip', ['-q', '-r', '-y', ipa, 'Payload'], { cwd: dir });

    const manifest = makeManifest({
        webBundle: { root: 'public' },
        capabilityCoupling: [{ ifBundleMatches: 'getUserMedia', requirePlistKey: 'NSMicrophoneUsageDescription' }],
    });
    const { code, out } = run(ipa, manifest);
    // No microphone key is declared, and no IN-SCOPE file matches, so this is
    // correctly CLEAN. Before the fix it was a violation raised from framework
    // bytes -- the false positive webBundle.root exists to prevent.
    assert.equal(code, 0, `out-of-scope bytes must not raise a finding; got ${code}: ${out}`);
    assert.match(out, /skipped/, 'the skip must be stated, not silent');
    assert.match(out, /outside the declared web root/);
    assert.doesNotMatch(out, /FAIL/, 'no violation may come from outside the web root');
});

test('a web root whose only content is an out-of-scope symlink is exit 2, not a clean pass', () => {
    // The scope skip must not become a route to a vacuous pass: if skipping
    // leaves nothing scanned, the zero-files guard has to fire. Verifying
    // nothing and finding nothing print the same way otherwise.
    const dir = tmp('ipa');
    const appDir = path.join(dir, 'Payload', 'App.app');
    fs.mkdirSync(path.join(appDir, 'public'), { recursive: true });
    fs.mkdirSync(path.join(appDir, 'Frameworks', 'shared'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'Info.plist'), plistXml({ CFBundleIdentifier: 'com.fixture.app' }));
    fs.writeFileSync(path.join(appDir, 'Frameworks', 'shared', 'cam.js'), 'navigator.mediaDevices.getUserMedia({})');
    fs.symlinkSync(path.join('..', 'Frameworks', 'shared'), path.join(appDir, 'public', 'shared'));
    const ipa = path.join(dir, 'App.ipa');
    execFileSync('zip', ['-q', '-r', '-y', ipa, 'Payload'], { cwd: dir });

    const manifest = makeManifest({
        webBundle: { root: 'public' },
        capabilityCoupling: [{ ifBundleMatches: 'getUserMedia', requirePlistKey: 'NSMicrophoneUsageDescription' }],
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 2, `scanning nothing must be exit 2, got ${code}: ${out}`);
});


test('two top-level .app bundles is exit 2, not a clean verdict about whichever came first', () => {
    // NOT hypothetical: an embedded watch app built with SKIP_INSTALL=NO
    // archives as a second top-level .app, which this fleet has shipped into
    // before. The old code took `readdirSync(...).find(...)`, so it would parse
    // whichever bundle the listing yielded first -- order not guaranteed -- and
    // report exit 0 about the wrong app.
    const dir = tmp('ipa');
    const main = path.join(dir, 'Payload', 'App.app');
    const watch = path.join(dir, 'Payload', 'AppWatch.app');
    fs.mkdirSync(path.join(main, 'public'), { recursive: true });
    fs.mkdirSync(watch, { recursive: true });
    fs.writeFileSync(path.join(main, 'Info.plist'), plistXml({ CFBundleIdentifier: 'com.fixture.app' }));
    fs.writeFileSync(path.join(watch, 'Info.plist'), plistXml({ CFBundleIdentifier: 'com.fixture.app.watchkitapp' }));
    fs.writeFileSync(path.join(main, 'public', 'app.js'), 'console.log(1)');
    const ipa = path.join(dir, 'App.ipa');
    execFileSync('zip', ['-q', '-r', ipa, 'Payload'], { cwd: dir });

    const manifest = makeManifest({ infoPlist: { equals: { CFBundleIdentifier: 'com.fixture.app' } } });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 2, `an ambiguous Payload must be exit 2, got ${code}: ${out}`);
    assert.match(out, /2 top-level \.app bundles/);
    assert.match(out, /App\.app/);
    assert.match(out, /AppWatch\.app/, 'both bundles should be named so the archive can be fixed');
});

test('a bad webBundle.root is refused before the artifact is even opened', () => {
    // Round 24: the root checks lived inside the artifact-reading inspect(), so
    // a manifest error still printed ARTIFACT UNREADABLE. Ordering is the proof
    // that the fix is real rather than a relabel: point --ipa at a file that
    // does not exist AND give a traversing root. If the root is validated
    // first, the message names the root; if the artifact is opened first, it
    // complains about the missing file instead.
    // A rule that is otherwise VALID, so the only thing wrong is the root. The
    // first draft used a renderedVersion missing elementId, which tripped rule
    // compilation first and proved nothing about ordering.
    const manifest = makeManifest({
        webBundle: { root: '../../etc' },
        capabilityCoupling: [{ ifBundleMatches: 'getUserMedia', requirePlistKey: 'NSMicrophoneUsageDescription' }],
    });
    const { code, out } = run('/nonexistent/never-created.ipa', manifest);
    assert.equal(code, 3, `manifest error must be exit 3, got ${code}: ${out}`);
    assert.match(out, /VERIFIER MISCONFIGURED/);
    assert.match(out, /webBundle\.root/, 'the message must name the manifest field, not the missing file');
    assert.doesNotMatch(out, /ARTIFACT UNREADABLE/);
});

test('SKILL.md documents the exit code the tool actually returns for the omitted-root case', () => {
    // Rounds 23, 24 and 25 were ONE drift travelling outward: the exit contract
    // was fixed in the handler, then at the call site, then in the prose -- and
    // each time the earlier fix was already believed. A claim that lives only in
    // a document cannot be checked by the suite that proves the behaviour, so
    // this ties the two together for the case that actually moved.
    const skill = fs.readFileSync(path.join(ROOT, 'skills/release-verification/SKILL.md'), 'utf8');

    // The tool's real answer for a manifest that reads the bundle without a root.
    const ipa = makeIpa({ plist: BASE_PLIST });
    // webBundle: null is how you actually omit the root -- makeManifest INJECTS
    // { root: 'public' } otherwise, so the first draft of this test quietly
    // exercised a valid manifest and read its exit 2 as a contradiction.
    const manifest = makeManifest({
        capabilityCoupling: [{ ifBundleMatches: 'getUserMedia', requirePlistKey: 'NSMicrophoneUsageDescription' }],
        webBundle: null,
    });
    const { code } = run(ipa, manifest);
    assert.equal(code, 3, 'omitting webBundle.root must be a manifest error');

    // And the sentence a reader relies on must say the same number.
    const para = skill.match(/Omitting the root is[\s\S]{0,120}/);
    assert.ok(para, 'SKILL.md should still explain what omitting the root does');
    assert.match(para[0], /exit 3/, `SKILL.md must document exit ${code} here, not a stale one: ${para[0].slice(0, 80)}`);
    assert.doesNotMatch(para[0], /exit 2/, 'the superseded exit 2 claim must not survive alongside it');

    // The table must carry a row for every code the tool can return.
    for (const c of ['`0`', '`1`', '`2`', '`3`']) {
        assert.ok(skill.includes(c), `the exit table is missing a row for ${c}`);
    }
});

// --- the XML reader must not FLATTEN the document ---------------------------
// The reader these replace was one global regex over <key>/<string> pairs run
// across the whole file. A regex that "extracts pairs" implicitly flattens the
// tree, and flattening is last-wins, so a key nested inside an <array> or a
// child <dict> overwrote the root key of the same name. Real Info.plists nest
// constantly, so this was not a hypothetical shape.
//
// Both of these were reproduced against the old reader before the recursive
// one was written. The second is the one that matters: a false CLEAN on the
// exact rule that exists to catch a shipped TCC crash.

const NESTED_HEAD = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">', '<dict>',
].join('\n');

test('a key nested inside an array does not overwrite the root key of the same name', () => {
    const ipa = makeIpa({
        rawPlist: [
            NESTED_HEAD,
            '\t<key>CFBundleIdentifier</key><string>com.fixture.app</string>',
            '\t<key>CFBundleURLTypes</key><array><dict>',
            '\t\t<key>CFBundleIdentifier</key><string>com.nested.decoy</string>',
            '\t</dict></array>',
            '</dict>', '</plist>', '',
        ].join('\n'),
    });
    const { code, out } = run(ipa, makeManifest({ infoPlist: { equals: { CFBundleIdentifier: 'com.fixture.app' } } }));
    // Old reader: parsed CFBundleIdentifier as "com.nested.decoy" and reported
    // identity drift against an app whose identity was correct. A fabricated
    // violation, in the tool's most quotable voice, about a value the OS reads
    // correctly.
    assert.equal(code, 0, out);
    assert.doesNotMatch(out, /com\.nested\.decoy/, 'a nested value must never be reported as the root value');
});

test('a usage-description key nested in an array does NOT satisfy a root-level coupling rule', () => {
    // The dangerous direction. The coupling rule exists because a bundle that
    // calls getUserMedia without a ROOT NSMicrophoneUsageDescription crashes on
    // first use. A nested occurrence is invisible to iOS -- TCC reads the root
    // dict -- but the flattening reader saw the key, called the rule satisfied,
    // and printed CLEAN over a build that would crash on a real device.
    const ipa = makeIpa({
        rawPlist: [
            NESTED_HEAD,
            '\t<key>CFBundleIdentifier</key><string>com.fixture.app</string>',
            '\t<key>UIApplicationSceneManifest</key><dict>',
            '\t\t<key>NSMicrophoneUsageDescription</key><string>Not where iOS looks.</string>',
            '\t</dict>',
            '</dict>', '</plist>', '',
        ].join('\n'),
        web: { 'js/mic.js': 'navigator.mediaDevices.getUserMedia({ audio: true })' },
    });
    const manifest = makeManifest({
        webBundle: { root: 'public' },
        capabilityCoupling: [{ ifBundleMatches: 'getUserMedia', requirePlistKey: 'NSMicrophoneUsageDescription' }],
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 1, `a key only present in a nested dict must still count as undeclared; got ${code}: ${out}`);
    assert.match(out, /does NOT declare NSMicrophoneUsageDescription/);
});

test('XML entities in a string are decoded before comparison', () => {
    // The old reader did no entity decoding at all, so a display name written
    // (correctly) as `Ear &amp; Eye` compared unequal to `Ear & Eye` and was
    // reported as drift between what was built and what was claimed.
    const ipa = makeIpa({
        rawPlist: [
            NESTED_HEAD,
            '\t<key>CFBundleIdentifier</key><string>com.fixture.app</string>',
            '\t<key>CFBundleDisplayName</key><string>Ear &amp; Eye &#8212; 5&lt;6</string>',
            '</dict>', '</plist>', '',
        ].join('\n'),
    });
    const manifest = makeManifest({
        infoPlist: { equals: { CFBundleDisplayName: 'Ear & Eye — 5<6' } },
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 0, out);
});

test('a key declared twice in the same dict is exit 2, not a coin flip', () => {
    // plutil resolves this last-wins. A build-produced plist with a duplicated
    // key is a mangled file, and which value iOS honours is not something this
    // tool will assert on a guess -- especially since the two values here would
    // produce OPPOSITE verdicts.
    const ipa = makeIpa({
        rawPlist: [
            NESTED_HEAD,
            '\t<key>CFBundleIdentifier</key><string>com.fixture.app</string>',
            '\t<key>CFBundleIdentifier</key><string>com.fixture.other</string>',
            '</dict>', '</plist>', '',
        ].join('\n'),
    });
    const { code, out } = run(ipa, makeManifest({ infoPlist: { equals: { CFBundleIdentifier: 'com.fixture.app' } } }));
    assert.equal(code, 2, out);
    assert.match(out, /twice in the same dict/);
});

test('an element the reader cannot represent is exit 2, not a partial parse', () => {
    const ipa = makeIpa({
        rawPlist: [
            NESTED_HEAD,
            '\t<key>CFBundleIdentifier</key><string>com.fixture.app</string>',
            '\t<key>SomethingNew</key><ordereddict><key>a</key><string>b</string></ordereddict>',
            '</dict>', '</plist>', '',
        ].join('\n'),
    });
    const { code, out } = run(ipa, makeManifest({ infoPlist: { equals: { CFBundleIdentifier: 'com.fixture.app' } } }));
    assert.equal(code, 2, out);
    assert.match(out, /cannot represent/);
});

test('integers, dates, data and comments in a real-shaped plist all parse', () => {
    // The false-positive guard for every refusal above. A reader strict enough
    // to reject an unknown element must still accept the element types Xcode
    // actually emits, or it fails every real artifact -- a worse failure than
    // the one being fixed.
    const ipa = makeIpa({
        rawPlist: [
            NESTED_HEAD,
            '\t<!-- a comment, which Xcode does emit in hand-edited plists -->',
            '\t<key>CFBundleIdentifier</key><string>com.fixture.app</string>',
            '\t<key>UIRequiredDeviceCapabilities</key><array><string>armv7</string></array>',
            '\t<key>MinimumOSVersion</key><string>15.0</string>',
            '\t<key>CFBundleNumericThing</key><integer>42</integer>',
            '\t<key>CFBundleRealThing</key><real>1.5</real>',
            '\t<key>BuildMachineOSBuild</key><date>2026-09-07T00:00:00Z</date>',
            '\t<key>SomeBlob</key><data>aGVsbG8=</data>',
            '\t<key>EmptyString</key><string/>',
            '\t<key>ITSAppUsesNonExemptEncryption</key><false/>',
            '</dict>', '</plist>', '',
        ].join('\n'),
    });
    const manifest = makeManifest({
        infoPlist: {
            equals: { CFBundleIdentifier: 'com.fixture.app', CFBundleNumericThing: 42, EmptyString: '' },
            required: [{ key: 'SomeBlob', why: 'presence of a non-string type must still register' }],
        },
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 0, out);
});

// --- the two readers must agree about the same logical document -------------
// XML and binary are two decoders of one format. When they disagree, at least
// one is wrong, and the disagreement is invisible in tests that only ever feed
// one of them. This section exists because hardening the XML reader ALONE
// created exactly that split: XML learned to parse <real>/<date>/<data> and to
// refuse duplicate keys, while the binary reader -- the branch every real IPA
// takes -- still returned null for those types and silently overwrote
// duplicates.
//
// `return null` was the specific defect, and its comment was the tell: "types
// this checker never asserts against" reasons about what the MANIFEST asserts,
// not about what the FILE contains. A null-valued key is still PRESENT, so
// `k in plist` was true while the value was a lie.

test('a binary plist with an unrepresentable object type is exit 2, not a null-valued key', () => {
    // Marker 0x80 is a UID, which appears in keyed archives and never in an
    // Info.plist. Before the fix it came back as null, and the equals check
    // then compared String(null) and announced drift -- a fabricated violation
    // sourced entirely from the reader's own shrug.
    const buf = bplist([
        { type: 'dict', keys: [1], values: [2] },
        { type: 'ascii', value: 'CFBundleIdentifier' },
        { type: 'raw', marker: 0x80 },
    ]);
    const ipa = makeIpa({ rawPlist: buf });
    const manifest = makeManifest({ infoPlist: { equals: { CFBundleIdentifier: 'com.fixture.app' } } });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 2, `an unreadable object type must be exit 2, got ${code}: ${out}`);
    assert.match(out, /cannot represent/);
    assert.doesNotMatch(out, /expected "com\.fixture\.app"/, 'must not report drift sourced from its own unread value');
});

test('a binary plist that declares a key twice is exit 2, matching the XML reader', () => {
    const buf = bplist([
        { type: 'dict', keys: [1, 2], values: [3, 4] },
        { type: 'ascii', value: 'CFBundleIdentifier' },
        { type: 'ascii', value: 'CFBundleIdentifier' },
        { type: 'ascii', value: 'com.fixture.app' },
        { type: 'ascii', value: 'com.fixture.other' },
    ]);
    const ipa = makeIpa({ rawPlist: buf });
    const { code, out } = run(ipa, makeManifest({ infoPlist: { equals: { CFBundleIdentifier: 'com.fixture.app' } } }));
    assert.equal(code, 2, out);
    assert.match(out, /twice in the same dictionary/);
});

// --- a plist file must be ONE plist document -------------------------------
// The reader locates the root by searching for the first <plist>, which means
// leading junk was skipped and trailing junk was ignored. A partial overwrite
// of a longer file leaves a whole second document behind the first, and
// stopping at the first </plist> reports a confident verdict about a file whose
// real content is ambiguous.

test('content before the <plist> element is exit 2, not a verdict about the part that parsed', () => {
    const ipa = makeIpa({
        rawPlist: `some other file's tail\n${plistXml(BASE_PLIST)}`,
    });
    const { code, out } = run(ipa, makeManifest({ infoPlist: { equals: { CFBundleIdentifier: 'com.fixture.app' } } }));
    assert.equal(code, 2, out);
    assert.match(out, /before its <plist> element/);
});

test('a second document concatenated after </plist> is exit 2', () => {
    // The realistic shape: a shorter plist written over a longer one without
    // truncating. The first document is complete and parses perfectly, which is
    // exactly why stopping there is dangerous.
    const ipa = makeIpa({
        rawPlist: `${plistXml(BASE_PLIST)}${plistXml({ CFBundleIdentifier: 'com.fixture.stale' })}`,
    });
    const { code, out } = run(ipa, makeManifest({ infoPlist: { equals: { CFBundleIdentifier: 'com.fixture.app' } } }));
    assert.equal(code, 2, `a concatenated second document must be exit 2, got ${code}: ${out}`);
    assert.match(out, /after its <\/plist>/);
    assert.doesNotMatch(out, /VERDICT: CLEAN/);
});

test('trailing whitespace after </plist> is still fine', () => {
    // The false-positive guard: every real plist ends with a newline.
    const ipa = makeIpa({ rawPlist: `${plistXml(BASE_PLIST)}\n\n  \n` });
    const { code, out } = run(ipa, makeManifest({ infoPlist: { equals: { CFBundleIdentifier: 'com.fixture.app' } } }));
    assert.equal(code, 0, out);
});

// --- `__proto__` is a legal plist key and JS treats it as a trapdoor --------
// `obj['__proto__'] = value` on an ordinary object sets the PROTOTYPE, not an
// own property. So a `<key>__proto__</key>` entry -- which the plist DTD says
// nothing against -- never appears in Object.keys or hasOwnProperty, while
// every property of its value becomes visible through the prototype chain to
// `plist[k]` and to `k in plist`.
//
// Three of the four places that read the plist by a manifest-supplied key used
// exactly those unguarded forms. `capabilityCoupling` was the only one that
// guarded with hasOwnProperty, which is what makes this a miss rather than an
// oversight: the pattern was known and applied once.
//
// Both directions were reproduced live before the fix, on XML and binary alike.

const PROTO_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>CFBundleIdentifier</key><string>com.fixture.app</string>\n';

test('a __proto__ key cannot satisfy infoPlist.required', () => {
    // The false CLEAN, on the exact key behind the iHEARtest TCC crash.
    const ipa = makeIpa({
        rawPlist: `${PROTO_HEAD}  <key>__proto__</key>\n  <dict><key>NSPhotoLibraryAddUsageDescription</key><string>INJECTED</string></dict>\n</dict>\n</plist>\n`,
    });
    const manifest = makeManifest({
        infoPlist: { required: [{ key: 'NSPhotoLibraryAddUsageDescription', why: 'the TCC crash' }] },
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 1, `a prototype-injected key is not a shipped key; got ${code}: ${out}`);
    assert.match(out, /NSPhotoLibraryAddUsageDescription MISSING/);
    assert.doesNotMatch(out, /VERDICT: CLEAN/);
});

test('a __proto__ key cannot manufacture an infoPlist.forbidden violation', () => {
    // The other direction: a fabricated finding about a key that is not a real
    // entry of the shipped plist.
    const ipa = makeIpa({
        rawPlist: `${PROTO_HEAD}  <key>__proto__</key>\n  <dict><key>NSMicrophoneUsageDescription</key><string>INJECTED</string></dict>\n</dict>\n</plist>\n`,
    });
    const manifest = makeManifest({
        infoPlist: { forbidden: [{ key: 'NSMicrophoneUsageDescription', why: 'this build must not ask for the mic' }] },
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 0, `a prototype-injected key must not be reported PRESENT; got ${code}: ${out}`);
    assert.match(out, /forbids NSMicrophoneUsageDescription: absent/);
});

test('a __proto__ key cannot reach capabilityCoupling either', () => {
    // This path already guarded with hasOwnProperty, so it is a lock rather
    // than a repair -- but the guard now has to survive the null-prototype
    // dicts too, and a test is cheaper than remembering that.
    const ipa = makeIpa({
        rawPlist: `${PROTO_HEAD}  <key>__proto__</key>\n  <dict><key>NSMicrophoneUsageDescription</key><string>INJECTED</string></dict>\n</dict>\n</plist>\n`,
        web: { 'js/mic.js': 'navigator.mediaDevices.getUserMedia({ audio: true })' },
    });
    const manifest = makeManifest({
        webBundle: { root: 'public' },
        capabilityCoupling: [{ ifBundleMatches: 'getUserMedia', requirePlistKey: 'NSMicrophoneUsageDescription' }],
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 1, out);
    assert.match(out, /does NOT declare NSMicrophoneUsageDescription/);
});

test('a real key literally named __proto__ is read as an ordinary key', () => {
    // The false-positive guard. The fix must not make `__proto__` unreadable,
    // only ordinary: with a null-prototype dict it becomes a normal own key,
    // which is what the plist file actually says it is.
    const ipa = makeIpa({
        rawPlist: `${PROTO_HEAD}  <key>__proto__</key><string>just a string</string>\n</dict>\n</plist>\n`,
    });
    // The equals map is built with JSON.parse, NOT an object literal. In a
    // literal, `{ __proto__: 'x' }` is prototype-setting SYNTAX and creates no
    // key at all -- the first draft of this test did exactly that, so it
    // asserted nothing and passed against the unfixed tool too. A regression
    // test that passes before the fix is not a regression test, and here the
    // fixture had fallen into the very trap the test is about.
    const equals = JSON.parse('{"__proto__":"just a string","CFBundleIdentifier":"com.fixture.app"}');
    assert.ok(Object.prototype.hasOwnProperty.call(equals, '__proto__'), 'fixture must carry a REAL __proto__ key');
    const manifest = makeManifest({ infoPlist: { equals } });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 0, out);
});

test('a dict-valued key reported by infoPlist.equals does not crash the run', () => {
    // Null-prototype objects have no toString, so `String(someDict)` throws
    // "Cannot convert object to primitive value". An unhandled throw here would
    // defeat the exit-code contract as surely as a wrong answer would.
    const ipa = makeIpa({
        rawPlist: `${PROTO_HEAD}  <key>UIApplicationSceneManifest</key><dict><key>a</key><string>b</string></dict>\n</dict>\n</plist>\n`,
    });
    const manifest = makeManifest({ infoPlist: { equals: { UIApplicationSceneManifest: 'something' } } });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 1, `a dict-valued key must report drift, not crash; got ${code}: ${out}`);
    assert.match(out, /UIApplicationSceneManifest is "<dict>"/);
});

// --- mustContain must match inside ONE file --------------------------------
// It used to test a synthetic haystack built by joining every shipped file with
// a `\n/*path*/\n` separator, so a rule could be satisfied by text spanning two
// unrelated files. mustNotContain was already per-file; the two families were
// inconsistently scoped inside the same block.

test('mustContain is not satisfied by a match spanning two unrelated files', () => {
    const ipa = makeIpa({
        webRoot: 'public',
        plist: BASE_PLIST,
        web: {
            'a-unrelated.js': '// setup code, ends oddly with: scrubber',
            'z-other.js': '.init(); // a different file entirely',
        },
    });
    const manifest = makeManifest({
        webBundle: { root: 'public', mustContain: [{ pattern: 'scrubber[\\s\\S]{0,40}\\.init\\(', why: 'the scrubber must be wired up' }] },
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 1, `a cross-file match is not evidence the bundle does the thing; got ${code}: ${out}`);
    assert.match(out, /NOT found in any single shipped file/);
    assert.doesNotMatch(out, /VERDICT: CLEAN/);
});

test('mustContain still passes on a real single-file match, and names the file', () => {
    // The false-positive guard, plus the reason per-file is better evidence:
    // the pass line can point at where the proof lives.
    const ipa = makeIpa({
        webRoot: 'public',
        plist: BASE_PLIST,
        web: { 'js/native.js': 'async function cioConsentGranted() { return true; }', 'js/other.js': 'noop();' },
    });
    const manifest = makeManifest({
        webBundle: { root: 'public', mustContain: [{ pattern: 'cioConsentGranted', why: 'telemetry must be consent-gated' }] },
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 0, out);
    assert.match(out, /bundle contains cioConsentGranted \(in js[/\\]native\.js\)/);
});
