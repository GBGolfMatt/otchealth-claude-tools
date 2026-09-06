---
name: release-verification
description: Verify what a build actually SHIPPED rather than what its repo says, before a human reviewer ever sees it. Run "node artifact-truth.mjs --ipa <App.ipa> --manifest schema/<app>.release-truth.json" against the downloaded artifact to check Info.plist expectations, shipped-web-bundle content, and capability coupling (any privacy API reachable in the shipped bundle must have its usage-description key declared, or iOS terminates the process under TCC). Exit 0 clean, 1 violations, 2 artifact unreadable. Use before every TestFlight hand-off, and read app-kit/RELEASE-VERIFICATION-STANDARD.md for the surrounding five-stage process and the A/B/C packet-item classification that decides what a human is allowed to be asked.
---

# release-verification

The factory gate. A reviewer is there to judge a finished product, not to find
bugs. Anything a machine can settle must be settled by a machine first, and
the machine must look at the artifact that ships.

The doctrine (why, when, who, and how the stages fit together) lives in
`app-kit/RELEASE-VERIFICATION-STANDARD.md`. This file is the operating manual
for the tool in this directory.

## The one idea

**Source is a claim. The artifact is the fact.**

Every mature build pipeline transforms the tree between `git` and the store:
Capacitor copies a *subset* of `www/` into the app bundle, content-mode
scripts materialize different payloads for public vs internal builds, CI
substitutes version placeholders, Xcode injects plist values. So a grep of the
repo answers a question nobody asked. Two incidents in one week made this
concrete, and they point in **opposite** directions, which is what makes the
lesson trustworthy rather than a rule of thumb:

- **iHEARtest, four shipped builds.** Reading the repo would not have flagged
  anything. The shipped app hands a PNG to the iOS share sheet; a user
  choosing *Save Image* causes a write to the photo library on the app's
  behalf. `Info.plist` declared no `NSPhotoLibraryAddUsageDescription`, so iOS
  killed the process under TCC. It shipped that way in 53, 56, 57 and 58 (54
  and 55 never shipped, so it is four builds rather than a contiguous range).
  Apple's own binary scanner cannot
  see it, because that scanner does static API-surface analysis and the app
  links no PhotoKit at all.
- **AWARE, one day later.** Reading the repo produced a confident P0 that was
  simply false: `www/` contains `getUserMedia` in two modules behind visible
  buttons, and the shipped plist declares no microphone key. Identical shape
  to the real crash above. But the PUBLIC build assembles a different bundle
  and the shipped IPA contains no `getUserMedia` anywhere.

One rule resolves both: **if the shipped bundle can reach a privacy-sensitive
API, the shipped Info.plist must declare it.** Derive the requirement from the
artifact instead of maintaining a per-app list of expected keys. That single
rule flags iHEARtest's missing key *and* clears AWARE's absent key. Opposite
verdicts, no special-casing, and it stays right when an app changes.

Read the verdicts at their real strength. This is a text scan, so a violation
is a strong signal worth blocking on, while a pass means *no shipped-bundle
path matches these patterns*, not *this app cannot reach that API*. A literal
match in a comment or dead code counts as reachable; a dynamically built or
minified reference can be missed; native-only reach is invisible here by
construction. The tool's own output is worded that way on purpose, so a line
lifted out of it into a reviewer packet stays true.

## Running it

```bash
node artifact-truth.mjs --ipa /path/to/App.ipa \
                        --manifest schema/iheartest.release-truth.json
node artifact-truth.mjs --ipa ... --manifest ... --json   # machine-readable
```

Dependency-free apart from `unzip`. It parses binary plists itself (`bplist00`),
so it needs no `plistlib`, no macOS, and no Xcode.

| Exit | Meaning |
|------|---------|
| `0`  | Every declared expectation held. |
| `1`  | At least one violation. The report names the rule, what it saw, and why it matters. |
| `2`  | **Could not inspect the artifact at all.** Deliberately distinct from 0. A verifier that cannot read the thing has proven nothing, and must never print a pass. |

That third exit code is the whole reason to trust the other two. The failure
mode this tool is built against is *a gate that reports success while doing
nothing* — the same class as the crash classifier that never ran because the
`.ips` parse threw, and the eval job that "succeeded" for weeks while its
image tag had expired out of ECR. If a check cannot run, it must say so
loudly.

## Getting the artifact

The IPA is the input, so fetch the one that shipped, not a rebuild:

```bash
# from the Depot/GitHub Actions run that produced the TestFlight build
node qa/scripts/... # or the run's artifact download API
# NOTE: GitHub artifact downloads 302 to a presigned URL that REJECTS the
# Authorization header. Follow the redirect without it.
```

Never re-archive locally and verify that instead. A local rebuild is a
different artifact and reintroduces exactly the gap this tool closes.

## The manifest

One JSON file per app under `schema/<app>.release-truth.json`. Four rule
families, all optional:

```jsonc
{
  "app": "iheartest",
  "expect": {
    "infoPlist": {
      "equals":    { "CFBundleIdentifier": "com.innerscope.iheartest" },
      "forbidden": [{ "key": "NSPhotoLibraryUsageDescription",
                      "why": "add-only is the correct scope; over-declaring a read
                              permission invites App Review questions" }]
    },
    "webBundle": {
      "root": "public",                    // where Capacitor puts the web layer
      "mustContain":    [{ "pattern": "cioConsentGranted", "why": "..." }],
      "mustNotContain": [{ "pattern": "getUserMedia",      "why": "..." }]
    },
    "capabilityCoupling": [
      { "ifBundleMatches": "navigator\\.share|canShare",
        "requirePlistKey": "NSPhotoLibraryAddUsageDescription",
        "why": "the share sheet writes to the library on the app's behalf" },
      { "ifBundleMatches": "getUserMedia|mediaDevices",
        "requirePlistKey": "NSMicrophoneUsageDescription",
        "forbidIfUnreachable": true }
    ],
    "renderedVersion": { "file": "index.html", "elementId": "app-version-tag" }
  }
}
```

`capabilityCoupling` has four outcomes, and three of them are passes:

| Reachable in bundle | Declared in plist | Verdict |
|---|---|---|
| yes | no  | **VIOLATION** — the TCC kill |
| yes | yes | pass, "reachable AND declared" |
| no  | no  | pass, "no shipped-bundle path matches, and the key is undeclared" (this is AWARE) |
| no  | yes | violation **only if** `forbidIfUnreachable: true`, otherwise a pass that says the key *is* declared and tolerated |

Set `forbidIfUnreachable` when over-declaring is itself a problem (App Review
scrutiny, misleading permission prompts). Leave it off where a key is
legitimately there for a native path the web bundle cannot see — which is why
it is per-rule rather than global.

**`andBundleMatches` narrows a rule to files matching BOTH patterns**, and both
must hit the *same* file. It exists because a share call alone does not imply a
photo-library write: sharing a PDF offers Save to Files and never touches the
library, sharing a PNG offers Save Image and does. AWARE shares PDFs, so its
photo rule pairs `navigator\.share|canShare` with `image/png|toBlob|...`;
without that, any future PDF share would be a false positive. Requiring the
same file matters — a thumbnail helper in one module and an unrelated share in
another are not one flow.

### `renderedVersion` exists because of a false positive I shipped

The first version of the iHEARtest manifest had
`mustNotContain: "{{APP_VERSION}}"`, reasoning that an unsubstituted
placeholder in the shipped bundle means the version string is broken. It fired
on Build 59 — against three **comments** in `native.js` that document the
substitution mechanism. The rule was testing the mechanism, not the outcome.

`renderedVersion` asserts the outcome instead: the element the user actually
reads must contain `v` + the binary's own `CFBundleShortVersionString`. That
cannot be tripped by a comment, cannot be satisfied by a placeholder, and
stays correct if the substitution mechanism is ever rewritten. **Assert what
the user sees, not how the build produces it** — a good general rule for any
artifact check.

## Adding an app

1. Download its shipped IPA.
2. Copy the nearest `schema/*.release-truth.json` and set `app`,
   `CFBundleIdentifier`, and `webBundle.root` (`public` for Capacitor).
3. Run it. Read the "shipped bundle: N text files under <root>" line — if N is
   0 or absurdly small, `root` is wrong and every `webBundle` rule is
   vacuously passing.
4. **Prove the manifest by running it against a build you already know is
   bad.** A rule that has never failed has never been tested. The iHEARtest
   manifest was validated by pointing it at Build 58 (caught all three real
   defects) before Build 59 (clean).
5. Add the `capabilityCoupling` rules for every privacy API the app could
   plausibly reach, including ones you believe it does not — those produce the
   "correctly undeclared" certification, which is the output you want when a
   reviewer asks "are we sure the mic is not in there".

## Where it belongs in CI, and where it actually runs today

**Not yet wired into any app's workflow.** Today it is run by hand from the CTO
seat against a downloaded artifact before hand-off. Saying otherwise would make
this document guilty of the exact thing the tool exists to catch: describing a
gate that does not gate.

Wiring it is per-app and it is the next step. It belongs after the archive step
and **before** the TestFlight upload, so a violation stops the build rather than
annotating one already in review. It needs only the IPA, `node`, and `unzip`, so
it runs fine on the Linux side of a workflow against the built artifact.

## Known limits (state these, do not paper over them)

- **Text-scan only.** It reads the shipped web layer as text. It does not
  execute the app, cannot resolve dynamic dispatch, and cannot see a
  privacy API reached from *native* Swift that has no web-layer footprint. For
  native reach, the plist rules and a real-device run are the coverage.
- **Minified or bundled web layers** may not contain the literal pattern.
  For apps that ship a bundler output (React/Vite apps like Companion and
  Flatstick), match on strings that survive minification, and verify by
  running the rule against a build known to contain the capability.
- **Encrypted or unusual IPA layouts** exit 2 rather than guessing.
