---
name: release-verification
description: Verify what a build actually SHIPPED rather than what its repo says, before a human reviewer ever sees it. In CI, run 'node artifact-truth.mjs --ipa $IPA_PATH --manifest schema/<app>.release-truth.json' against the export/upload candidate BEFORE the upload step, which is where the gate belongs; out of CI, run it against the artifact downloaded from a completed run. Either way it checks Info.plist expectations, shipped-web-bundle content, and capability coupling (if the shipped bundle's text matches a privacy API's pattern, its usage-description key must be declared, or iOS terminates the process under TCC). Exit 0 clean, 1 violations, 2 artifact unreadable, 3 verifier misconfigured. Use before every TestFlight hand-off, and read app-kit/RELEASE-VERIFICATION-STANDARD.md for the surrounding five-stage process and the A/B/C packet-item classification that decides what a human is allowed to be asked.
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

- **iHEARtest, 16 tagged builds by source.** The shipped app hands a PNG to the
  iOS share sheet; a user choosing *Save Image* causes a write to the photo
  library on the app's behalf. `Info.plist` declared no
  `NSPhotoLibraryAddUsageDescription`, so iOS killed the process under TCC.

  Nothing flagged it for 16 builds, and the reason is worth stating precisely,
  because an earlier draft of this line got it wrong. It said "reading the repo
  would not have flagged anything" — which contradicts the paragraph directly
  below, where the blast radius is counted by running `git show` against the
  repo. The evidence *was* in source. What was missing was anything that knew to
  correlate two facts sitting in different files: that the bundle reaches the
  share sheet, and that the plist declares no photo-library key. Neither file is
  suspicious alone. No reviewer reads them as a pair.

  Two things then keep the check honest at the artifact rather than in the repo.
  Xcode merges and injects `Info.plist` values at build time, so the source
  plist is a claim about the shipped one and not the shipped one itself. And
  which code actually ships varies by build configuration, which is exactly what
  the AWARE case below turns on.

  The count is derived, not recalled: **16 tagged builds carry the defect in
  source** — 42, 43, and 45 through 58, which is every tagged build the repo has
  until 59 fixed it. Note the wording: that is a `git show` query, so it is a
  source-level blast radius rather than 16 verified artifacts, and by this
  document's own thesis those are different things. The query, its verbatim
  output and all three caveats live in `receipts/INCIDENT-SCOPE.md`. It is
  recorded there rather than restated here so the number has one home instead of
  two that can drift.

  Every narrative version of this count was an undercount, each inheriting the
  last, which is why it is a committed query now rather than a sentence.

  There is also nothing here for a symbol-based scan to find: **the app links no
  PhotoKit at all.** The write happens inside `UIActivityViewController` on the
  user's behalf when they choose *Save Image*, so the photo-library access never
  appears as an API the binary calls. That is a statement about our own artifact,
  which is checkable. An earlier draft went further and asserted what Apple's
  scanner does internally; that was an unsourced claim about someone else's
  tooling, and it is removed rather than dressed up with a citation invented
  after the fact.
- **AWARE, one day later.** Reading the repo produced a confident P0 that was
  simply false: `www/` contains `getUserMedia` in two modules behind visible
  buttons, and the shipped plist declares no microphone key. Identical shape
  to the real crash above. But the PUBLIC build assembles a different bundle
  and the shipped IPA contains no `getUserMedia` anywhere.

One rule resolves both: **if the shipped bundle's text matches a
privacy-sensitive API's pattern, the shipped Info.plist must declare it.**
Derive the requirement from the
artifact instead of maintaining a per-app list of expected keys. That single
rule flags iHEARtest's missing key *and* clears AWARE's absent key. Opposite
verdicts, no special-casing, and it stays right when an app changes.

Read the verdicts at their real strength. This is a text scan, so a violation
is a strong signal worth blocking on, while a pass means *no shipped-bundle
path matches these patterns*, not *this app cannot reach that API*. A literal
match in a comment or dead code counts as a hit; a dynamically built or
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
| `2`  | **Could not inspect the artifact at all.** Deliberately distinct from 0. A verifier that cannot read the thing has proven nothing, so it must never print a pass — **and never a finding either**. That second half is the one that gets forgotten, and it was violated for real: a truncated `Info.plist` read every key past the cut as absent, so a coupling rule announced a missing `NSMicrophoneUsageDescription` it had never actually looked at. |
| `3`  | **The verifier itself is unusable** — missing arguments, an unreadable or invalid manifest, a rule that will not compile. Separate from 2 because 2 is a claim about the BUILD and 3 is a claim about our own configuration. Both block. Printing 2 when 3 is true sends someone to debug an artifact that is fine. |

That third exit code is the whole reason to trust the other two. The failure
mode this tool is built against is *a gate that reports success while doing
nothing* — the same class as the crash classifier that never ran because the
`.ips` parse threw, and the eval job that "succeeded" for weeks while its
image tag had expired out of ECR. If a check cannot run, it must say so
loudly.

## Getting the artifact

The IPA is the input, so use the bytes that ship, not a rebuild. Two cases, and
they are genuinely different despite yielding the same file:

- **In CI**, there is no download at all: the gate runs against the exported IPA
  that the upload step is about to transmit. Nothing is a *shipped* artifact
  before it is uploaded, so the claim to make is "this is the exact upload
  candidate", and it holds because the workflow passes one `IPA_PATH` to the
  gate and to `altool` with no rebuild between them.
- **Out of CI**, fetch the artifact from the run that produced the build. The
  recorded digest proves you got the bytes the run stored — it does **not**, by
  itself, prove those bytes are what Apple received. That comes from the
  workflow keeping one `IPA_PATH` across attest, artifact upload and `altool`;
  where a pipeline does not, call the download a build candidate:

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
families, all optional — except that **any rule which reads the shipped bundle
(`webBundle.mustContain` / `mustNotContain`, `capabilityCoupling`,
`renderedVersion`) requires `webBundle.root`**. Without it the scan would walk
the whole `.app`, which is not what those rules make claims about: an `.app`
carries localization strings, resource JSON and framework text, so a capability
rule could match a file the web layer never contains. Omitting the root is
**exit 3** — a manifest that cannot be used, caught before the IPA is opened —
not a silently wider scan. An invalid root (absolute, or containing a `..`
segment) is exit 3 for the same reason. The one root failure that is exit 2 is
a root resolving out of the bundle *through a symlink*, because whether that
happens depends on what the archive carries rather than on what the manifest
says.

```jsonc
{
  "app": "iheartest",
  "expect": {
    "infoPlist": {
      "equals":    { "CFBundleIdentifier": "com.innerscope.iheartest" },
      "forbidden": [{ "key": "NSPhotoLibraryUsageDescription",
                      "why": "add-only is the correct scope; over-declaring a read permission invites App Review questions" }]
    },
    "webBundle": {
      "root": "public",                    // where Capacitor puts the web layer
      "mustContain":    [{ "pattern": "cioConsentGranted", "why": "..." }],
      "mustNotContain": [{ "pattern": "getUserMedia",      "why": "..." }]
    },
    "capabilityCoupling": [
      { "ifBundleMatches":  "navigator\\.share|canShare",
        // Pair it. A share call ALONE does not imply a photo-library write --
        // sharing a PDF offers Save to Files and never touches the library. An
        // earlier version of this example omitted the conjunction and so taught
        // exactly what the andBundleMatches section below warns against, which
        // is worse than a wrong sentence: examples get copied, prose gets skimmed.
        "andBundleMatches": "image/png|toBlob|toDataURL",
        "requirePlistKey":  "NSPhotoLibraryAddUsageDescription",
        "why": "a shared IMAGE reaches the library on the app's behalf via Save Image" },
      { "ifBundleMatches": "getUserMedia|mediaDevices",
        "requirePlistKey": "NSMicrophoneUsageDescription",
        "forbidIfUnreachable": true }
    ],
    "renderedVersion": { "file": "index.html", "elementId": "app-version-tag" }
  }
}
```

`capabilityCoupling` outcomes. Note the plist axis is **three-valued**, not two:
a key can be absent, present with a usable purpose string, or present with a
value that is not a usable purpose string (empty, whitespace, non-string).

| Text match in shipped bundle | Plist key | Verdict |
|---|---|---|
| yes | absent | **VIOLATION** — the TCC kill |
| yes | usable | pass, "shipped bundle matches ... AND the key is declared" |
| no  | absent | pass, "no shipped-bundle path matches, and the key is undeclared" (this is AWARE) |
| no  | usable | violation **only if** `forbidIfUnreachable: true`, otherwise a pass that says the key *is* declared and tolerated |
| either | **present but unusable** | **VIOLATION, unconditionally** |

That last row does not depend on the match or on `forbidIfUnreachable`, and an
earlier version of this table omitted it — so the documented behaviour and the
implemented behaviour disagreed until a review pass caught it.

It is deliberate rather than an oversight in the code. A usage-description is
the sentence iOS shows in the permission prompt, so `""` is a declared key that
discloses nothing — a defect in the artifact on its own terms, independent of
whether anything reaches the API, which is why it is reported on its own terms.

An earlier draft justified this by asserting it "draws an App Review rejection".
That is a claim about Apple's review process with no citation behind it, and the
rule does not need it: "a declared key that discloses nothing" is checkable in
the artifact, which is the only kind of claim this document is entitled to make
about someone else's system.
The other rows are about *coupling*; this one is about the key being broken.

The left column says *text match*, not *reachable*, and so does every line the
tool prints. It is a scan of the shipped bytes: it can hit a comment or dead
code, and it can miss a dynamically built reference. Saying "reaches" would
claim a control-flow analysis nobody ran, and these lines get pasted into PR
comments and reviewer packets where the qualifier would be lost. The verdict
still blocks — a match plus a missing key is exactly the shape of the real
crash, and the fix for a genuine hit (declare the key) is right either way — but
the wording asserts only what was established. `forbidIfUnreachable` keeps its
name because renaming a published manifest key would break every manifest; it is
the output that gets quoted.

Set `forbidIfUnreachable` when over-declaring is itself a problem (App Review
scrutiny, misleading permission prompts). Leave it off where a key is
legitimately there for a native path the web bundle cannot see — which is why
it is per-rule rather than global.

**`infoPlist.equals` compares SCALARS only.** A key holding a dict, an array or
a data blob produces a violation saying so, never a pass. That is not a
limitation worth apologising for, it is the repair for a live false CLEAN: the
comparison used to run against the tool's own *printed summary* of the value, and
that summary is the literal `<dict>` for every dict. So
`equals: { "NSAppTransportSecurity": "<dict>" }` passed for a locked-down ATS and
for a wide-open one carrying an injected exception domain, identically. Arrays
were gated on length alone.

The trap was worse than the wrong verdict. An author who writes the real intended
content watches the rule fail forever, and the obvious way to fix a rule that
will not pass is to paste in the summary the tool just printed — at which point
it is permanently satisfied by anything of that shape. Pinning the *contents* of
a structured key needs a rule that reads inside it, which this tool does not yet
have; until it does, refusing is the honest answer.

**`infoPlist.required` means PRESENT**, by `hasOwnProperty`, not truthy. `false`
and `0` are ordinary plist values — `ITSAppUsesNonExemptEncryption` is *usually*
`false`, and it is declared precisely so App Store Connect stops asking on every
build. A present key whose string value is blank is reported as blank, separately
from absent, because those are different defects with different fixes.

**`andBundleMatches` narrows a rule to files matching BOTH patterns**, and both
must hit the *same* file. It exists because a share call alone does not imply a
photo-library write: sharing a PDF offers Save to Files and never touches the
library, sharing a PNG offers Save Image and does. AWARE shares PDFs, so its
photo rule pairs `navigator\.share|canShare` with `image/png|toBlob|...`;
without that, any future PDF share would be a false positive. Requiring the
same file matters — a thumbnail helper in one module and an unrelated share in
another are not one flow.

**That narrowing buys a false-positive fix and costs a possible miss**, so the
miss is reported rather than swallowed. A real share-image flow can legitimately
be split across two modules, and then the conjunction holds in no single file
while the shipped payload as a whole still supports Save Image. Printing only
"no shipped-bundle path matches" would be true of the conjunction and would read
as *nothing matched* — a blind spot presented as a clean scan. So when the
primary pattern matches somewhere and the conjunction matches nowhere, the run
emits a `note` naming the files, and says the rule could not see a split flow.
It stays a pass: promoting it to a violation would reinstate the false positive
the narrowing exists to remove.

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

That promise was FALSE for as long as the rule existed, and every prior review
round on this branch missed it. The match ran against the raw HTML and used
`.match()` without `/g`, so it found the FIRST occurrence of the id anywhere in
the file — including inside a comment. A leftover template comment holding the
correct string, above a live element rendering a stale one, produced
`VERDICT: CLEAN` over exactly the defect this rule exists to catch; reversed, a
stale comment above a correct element fabricated a violation. Comments in a
built `index.html` are ordinary, not contrived: merges and template scaffolding
leave them behind constantly.

The promise is now backed by the code rather than asserted over it. Comments are
stripped before the search, every occurrence is collected rather than the first,
and two live elements sharing the id is reported as ambiguous instead of
resolved by picking one — a duplicate id is invalid HTML, the browser renders
the first and a script querying it may find either, so which one the user sees
is genuinely unknown.

## Adding an app

1. Download its shipped IPA.
2. Copy the nearest `schema/*.release-truth.json` and set `app`,
   `CFBundleIdentifier`, and `webBundle.root` (`public` for Capacitor).
3. Run it. Read the "shipped bundle: N text files under <root>" line — if N is
   0 or absurdly small, `root` is wrong and every `webBundle` rule is
   vacuously passing.
4. **Prove the manifest by running it against a build you already know is
   bad.** A rule that has never failed has never been tested.

   The iHEARtest manifest was first validated against Build 58, which it failed
   on all three known defects. That run is **historical and no longer
   reproducible**: `ios-depot.yml` uploads the IPA with `retention-days: 14`,
   so Build 58's is gone and nobody can re-check it, including me. Treat it as a
   note in the log, not as evidence. (14 is OUR setting, not a GitHub rule --
   the platform default is 90 days and is configurable per upload.)

   What survives is reproducible and is what you should copy: the counterfactual
   in `tests/artifact-truth.test.mjs`, and the one recorded in
   `receipts/SOURCES.md` — take the real shipped Build 59 `js/app.js` and the
   real Build 59 `Info.plist`, remove only the photo key, and the rule reports
   exactly the violation that describes the crash.
5. Add the `capabilityCoupling` rules for every privacy API the app could
   plausibly reach, including ones you believe it does not. Those produce the
   "no shipped-bundle path matches, and the key is undeclared" line, which is
   what you want on hand when someone asks whether the mic is in there — read
   at its real strength: no configured pattern matched the shipped text, which
   is evidence, not proof of unreachability.

## Where it belongs in CI, and where it actually runs today

**Enforced in iHEARtest** (`iheartest#254`), a blocking step in `ios-depot.yml`.
**Run by hand everywhere else**, which makes it a habit rather than a gate there.
Saying otherwise would make this document guilty of the exact thing the tool
exists to catch: describing a gate that does not gate.

Wiring it needs only the IPA, `node` and `unzip`, so it runs fine on the Linux
side of a workflow. Two placement rules, both learned the hard way:

- **After the export attestation, before the device-farm and store uploads.** My
  first draft sat just before the TestFlight upload, which is correct and
  wasteful: a sub-second check would wait out a 45-minute device poll before it
  could block, and spend real device minutes on an artifact already known bad.
- **Exit 2 must block too.** An artifact the gate could not open is not evidence
  of anything.

Vendor the file rather than importing it if the app's workflow has no cross-repo
token, and record the source commit plus the copy's sha256 beside it with a test
asserting the pair. `iheartest/qa/release-verification/` is the worked example.

## Known limits (state these, do not paper over them)

- **What counts as shipped text is decided by content, not extension.** Every
  file under `webBundle.root` is read and scanned unless it carries a known
  media/font/archive extension (png, jpg, mp3, mp4, woff, zip, pdf, car, nib,
  wasm and the like) or its first 8 KiB contains a NUL byte -- git's own
  binary heuristic. So a `.map` sidecar with the full source in
  `sourcesContent`, an extensionless `<script src="app">`, a `.webmanifest`
  or a `.xml` are all scanned. An earlier version scanned only eight blessed
  extensions and said so nowhere, which let a `mustNotContain` walk straight
  past a `.map` that shipped the very text it existed to catch.
- **Every rule name is validated, at both levels.** The four categories
  (`webBundle`, `capabilityCoupling`, `infoPlist`, `renderedVersion`) and the
  keys inside them are the only ones accepted; anything else is exit 3 by name.
  A misspelled category (`capabilitycoupling`, `infoPList`) used to check
  nothing, print nothing, and let the run report CLEAN -- the quietest false
  CLEAN there is, because the author believes the rule exists.
- **Text-scan only.** It reads the shipped web layer as text. It does not
  execute the app, cannot resolve dynamic dispatch, and cannot see a
  privacy API reached from *native* Swift that has no web-layer footprint. For
  native reach, the plist rules and a real-device run are the coverage.
- **Minified or bundled web layers** may not contain the literal pattern.
  For apps that ship a bundler output (React/Vite apps like Companion and
  Flatstick), match on strings that survive minification, and verify by
  running the rule against a build known to contain the capability.
- **Encrypted or unusual IPA layouts** exit 2 rather than guessing.
- **The artifact boundary is enforced, and it took three checks.** `webBundle.root`
  must be relative, must contain no `..` segment, and must resolve inside the
  `.app` — but all three of those are string tests, and an IPA is a zip, so it
  can carry **symlinks**. A `public` symlinked to an absolute path outside the
  bundle passed every lexical check and made the tool read foreign bytes. So the
  root and every symlink met during the walk are resolved with `realpathSync`
  and required to stay inside the real app directory; anything else is exit 2.
  A symlink pointing back inside is legitimate and is followed, deduped by
  resolved identity so one file is not counted twice.
- **The plist readers refuse rather than guess, in both directions.** Binary
  (`bplist00`) and XML are each parsed structurally, and anything either cannot
  represent faithfully is exit 2 — never a pass, never a violation. A plist the
  tool could only partially read is not evidence about the keys it appears to
  lack, and an earlier version turned exactly that into a confident fabricated
  finding.

  The XML side is strict in ways a validating parser is not: an unknown element
  or a key declared twice in the same dict is refused, because `plutil` resolves
  a duplicate last-wins and which value iOS honours is not something worth
  asserting on a coin flip. That asymmetry is deliberate. A false exit 2 stops a
  build with a message naming the file and the construct, and a human fixes it
  in a minute. A false verdict ships.

  Both readers replaced something worse, and the XML one is the sharper lesson.
  It used to be a single global regex over `<key>`/`<string>` pairs. A regex
  that extracts pairs implicitly *flattens* the tree, and flattening is
  last-wins — so a key nested inside an `<array>` or a child `<dict>` silently
  overwrote the root key of the same name. Real `Info.plist` files nest
  constantly. The failure that matters is not the wrong version string: a
  `NSMicrophoneUsageDescription` nested where iOS never reads it satisfied the
  coupling rule, and the tool printed **VERDICT: CLEAN** over a build that would
  crash under TCC on a real device — inside the check written to catch that
  exact crash.
