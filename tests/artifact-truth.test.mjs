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

function makeManifest(expect) {
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
    const manifest = makeManifest({ renderedVersion: { file: 'index.html', elementId: 'app-version-tag' } });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 1, out);
    assert.match(out, /cannot find index\.html in the shipped bundle/);
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

test('capabilityCoupling with no webBundle.root and no scanned files exits 2', () => {
    const ipa = makeIpa({ plist: BASE_PLIST, web: {} });
    const manifest = makeManifest({
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
