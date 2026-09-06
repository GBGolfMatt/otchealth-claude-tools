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

function run(ipa, manifest) {
    const r = spawnSync('node', [TOOL, '--ipa', ipa, '--manifest', manifest], { encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
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

test('a malformed manifest exits 2, not 1', () => {
    const ipa = makeIpa({ plist: BASE_PLIST });
    const bad = path.join(tmp('manifest'), 'm.json');
    fs.writeFileSync(bad, '{ this is not json');
    const { code, out } = run(ipa, bad);
    assert.equal(code, 2, out);
    assert.match(out, /ARTIFACT UNREADABLE/);
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

test('missing arguments exit 2', () => {
    const r = spawnSync('node', [TOOL], { encoding: 'utf8' });
    assert.equal(r.status, 2);
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

test('an invalid regex in the manifest exits 2, not 1', () => {
    // A manifest can be valid JSON and still be a broken rule set. Compiling
    // mid-run turned that into exit 1, which claims the artifact is at fault.
    const ipa = makeIpa({ plist: BASE_PLIST });
    const manifest = makeManifest({
        capabilityCoupling: [{ ifBundleMatches: '[', requirePlistKey: 'NSMicrophoneUsageDescription' }],
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 2, out);
    assert.match(out, /not a valid regular expression/);
});

test('a rule missing requirePlistKey exits 2 rather than matching nothing', () => {
    const ipa = makeIpa({ plist: BASE_PLIST });
    const manifest = makeManifest({ capabilityCoupling: [{ ifBundleMatches: 'getUserMedia' }] });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 2, out);
    assert.match(out, /requirePlistKey/);
});

test('a webBundle pattern that is not a string exits 2', () => {
    const ipa = makeIpa({ plist: BASE_PLIST, web: { 'js/a.js': 'x' } });
    const manifest = makeManifest({ webBundle: { root: 'public', mustNotContain: [{ why: 'no pattern given' }] } });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 2, out);
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

test('an infoPlist rule with no key exits 2 rather than matching undefined', () => {
    // `plist[undefined]` does not throw; it quietly reports "undefined MISSING"
    // or passes a forbidden check that never looked at anything. Nonsense
    // matching is worse than a crash because it is reported as a result.
    const ipa = makeIpa({ plist: BASE_PLIST });
    for (const expect_ of [
        { infoPlist: { required: [{ why: 'no key given' }] } },
        { infoPlist: { forbidden: [{ why: 'no key given' }] } },
    ]) {
        const { code, out } = run(ipa, makeManifest(expect_));
        assert.equal(code, 2, out);
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

test('unbalanced tags mid-document exit 2 even when the closing </plist> is present', () => {
    // Truncation is not the only corruption; a mangled middle leaves the
    // document terminated but incoherent.
    //
    // The first fixture I wrote here was not actually unbalanced -- an extra
    // <dict> plus an extra </dict> cancel out -- so the test failed and the
    // tool was right. Keeping the note because "I wrote a bad fixture" and "the
    // guard does not work" produce the identical red, and only one of them is a
    // reason to change the code. This one drops a </key> instead.
    const ipa = makeIpa({
        rawPlist: `${TRUNC_HEAD}\t<key>NSPhotoLibraryAddUsageDescription\n\t<string>x</string>\n</dict>\n</plist>\n`,
    });
    const { code, out } = run(ipa, makeManifest({ infoPlist: { equals: { CFBundleIdentifier: 'com.fixture.app' } } }));
    assert.equal(code, 2, out);
    assert.match(out, /do not balance/);
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
    assert.equal(code, 2, out);
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
    assert.equal(code, 2, out);
    assert.doesNotMatch(out, /VERDICT: CLEAN/);
});

test('an absolute webBundle.root is refused', () => {
    const ipa = makeIpa({ plist: BASE_PLIST, web: { 'js/app.js': 'renderToday();' } });
    const manifest = makeManifest({
        webBundle: { root: '/etc' },
        capabilityCoupling: [{ ifBundleMatches: 'getUserMedia', requirePlistKey: 'NSMicrophoneUsageDescription' }],
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 2, out);
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
    assert.equal(code, 2, out);
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

test('webBundle rules with no root and no scanned files exit 2', () => {
    const ipa = makeIpa({ plist: BASE_PLIST, web: {} });
    const manifest = makeManifest({ webBundle: { mustNotContain: [{ pattern: 'getUserMedia' }] } });
    assert.equal(run(ipa, manifest).code, 2);
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
