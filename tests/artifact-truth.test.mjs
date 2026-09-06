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

test('reachable capability with no declared key is a violation (the TCC crash)', () => {
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

test('reachable capability with the key declared passes', () => {
    const ipa = makeIpa({
        plist: { ...BASE_PLIST, NSPhotoLibraryAddUsageDescription: 'Save your result card.' },
        web: { 'js/share.js': 'if (navigator.share) { shareCard(); }' },
    });
    const manifest = makeManifest({
        capabilityCoupling: [{ ifBundleMatches: 'navigator\\.share', requirePlistKey: 'NSPhotoLibraryAddUsageDescription' }],
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 0, out);
    assert.match(out, /reachable in bundle AND declared/);
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

test('unreachable but declared is a violation when forbidIfUnreachable is set', () => {
    const ipa = makeIpa({
        plist: { ...BASE_PLIST, NSMicrophoneUsageDescription: 'Hear yourself.' },
        web: { 'js/app.js': 'renderToday();' },
    });
    const manifest = makeManifest({
        capabilityCoupling: [{ ifBundleMatches: 'getUserMedia', requirePlistKey: 'NSMicrophoneUsageDescription', forbidIfUnreachable: true }],
    });
    const { code, out } = run(ipa, manifest);
    assert.equal(code, 1, out);
    assert.match(out, /declares NSMicrophoneUsageDescription but nothing in the shipped bundle/);
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
