# Release Verification Standard (the app factory's debugging process)

Owner: the Developer/CTO seat. Status: STANDING POLICY (Matt directive, 2026-09-06).

Matt, 2026-09-06: *"Mark is there to review the final product for final release,
not to find bugs. Mark is not a bug finder. He's not a debugger. You are the
debugger."* And: *"the goal is for us to become an app factory. We can't be an
app factory if we can't debug internally."*

This is that process. It applies to every app in the portfolio, not just the two
that provoked it.

---

## The premise

A reviewer packet is a **claim sheet**. Every numbered item in it asserts that
something works. Today those claims are written by the same seat that wrote the
code, and shipped to a clinician who is asked, implicitly, to discover which of
them are false. That is backwards, and it is also *expensive*: Mark Moore's
scarce judgement is clinical and professional, and it is wasted the moment he
spends it on a broken image tag.

So the standard is one sentence:

> **A human reviewer may only be asked questions a machine cannot answer.**

Everything else in this document is the machinery for deciding which questions
those are, and for actually answering the rest.

---

## Stage 0 — Classify every packet item (do this FIRST, before any testing)

Before a packet ships, every numbered item gets exactly one letter. The letter
is written next to the item in the working notes, and the packet itself carries
a **verified-by** line for each item.

| Class | Meaning | What the packet says |
|---|---|---|
| **A** | Machine-proven. A committed, CI-wired test asserts this exact claim against the payload that ships. | "Verified by `qa/unit/foo.spec.mjs` on this commit." Present it as background, not as a question. |
| **B** | Machine-**provable**, not yet automated. There is no technical obstacle; nobody has written the assertion. | Do not ship it as a reviewer question. **Write the test.** If it genuinely cannot land this cycle, the packet must say "not independently verified" in those words. |
| **C** | Genuinely human. Clinical judgement, wording, feel, hardware behavior no harness reaches (audio routing, haptics, VoiceOver rhythm, a native picker's dismiss gesture). | This is the packet. This is what the reviewer is for. |

The classification is the load-bearing step, because **class B is where the
failure lives**. Class B items look exactly like class C items in a packet — a
sentence asking a human to check something — and they are the ones a machine
should have caught. The 2026-09-06 audits found:

- **iHEARtest, 16 items:** most already class A, three class B (two closed
  same-day by `tests/boot-gate/packet-item-proofs.spec.mjs`), one genuinely
  class C.
- **AWARE, 9 items:** items 1 to 6 and 8 class A with named specs; item 9a
  class A; **item 9b class B** — "the exercise opens, plays real audio, three
  answers are accepted, Today reflects the practice" had no committed
  assertion anywhere, despite being the entire point of the release; item 7
  (native iOS picker wheel) genuinely class C.

A B-class item you ship as a question is you asking the reviewer to do your job.

### The corollary rule: no claim survives a build unread

A packet copied forward from the previous build is **a set of lies by default**
until each sentence is re-verified against this build. The AWARE 1779565782
packet carried six stale claims byte-identical from its predecessor, including
a build-info line saying *"Exercises? Still locked by design"* in a packet
titled *"Exercises Unlocked"*, and an instruction to "work through the 8 items"
in a packet with 9. Diff every packet against its predecessor and justify every
line that did not change.

---

## The five stages

Each stage answers a question the previous one cannot. Run them in order; a
later stage never substitutes for an earlier one.

### Stage 1 — Source gates (already exist; keep them honest)

Unit specs, the i18n parity gate, the PHI compliance grep, lint, typecheck.
These prove properties of the **source**. They are necessary and they are not
sufficient, which is the entire subject of stage 3.

Rule: every bug fix ships with a regression spec **and fail-on-old-code proof** —
you must have watched the new test fail against the old code. A test written
after the fix, never seen red, proves only that it compiles.

### Stage 2 — Drive the SHIPPED payload in a browser

A Playwright harness (WebKit first, because that is the shipping engine on iOS;
Chromium second for speed) at the reviewer's exact device viewport.

Two rules that both came out of real defects:

1. **Serve the payload that ships, not the dev tree.** AWARE has two web trees:
   `www/` is legacy/dev with 39 script tags, and the public build assembles
   something else entirely — `www/release/` *plus* whatever
   `materialize-content-mode.mjs` copies in from the admitted content package.
   Several of AWARE's own e2e gates serve raw `www/release/` and assert the
   *opposite* state from what ships (task BLOCKED, zero start buttons), which is
   correct for their fixture and irrelevant to the product. Exactly one gate
   (`run-public-content-availability.mjs`) materializes the real payload. Point
   new gates at that one.
2. **Match the reviewer's viewport exactly.** AWARE's suite currently uses three
   different sizes — 402x874 (genuinely iPhone 16 Pro, the real device),
   393x852, and 390x844 — and the gate underpinning most packet items is not
   the one the reviewer holds. Pin one constant, import it everywhere.

### Stage 3 — Artifact truth

`skills/release-verification/artifact-truth.mjs`, run against the **downloaded
shipped IPA**, before the TestFlight upload.

**Status per app, because "enforced" is a property of a workflow and not of a
tool.** iHEARtest wires it as a blocking step in `ios-depot.yml`
(`iheartest#254`); everywhere else it still runs by hand, which makes it a habit
rather than a gate. Calling it mandatory fleet-wide before that is true would be
the same overclaim this standard exists to stop.

Wiring is per app and needs no owner action, which is worth saying because I
assumed otherwise for several days. *Importing* the toolkit at build time needs a
cross-repo token that only an owner can provision; **vendoring** the single
dependency-free file needs nothing, and it is the pattern iHEARtest already uses
for its jsPDF bundle. Record the source commit and the copy's sha256 next to it,
and assert that pairing in a test, so drift is answerable rather than a guess.
A blocker that is real for one implementation is not a blocker on the goal.

This is the stage the factory did not have. `grep -rl "Payload/" skills/`
returned nothing before 2026-09-06: no tool in the toolkit had ever opened a
shipped artifact. Full operating manual in that skill's `SKILL.md`; the short
version is that source is a claim and the artifact is the fact, and the central
mechanism is `capabilityCoupling` — derive required Info.plist keys from what
the shipped bundle can actually reach, rather than maintaining a per-app list.

Proven both directions before adoption, with the evidence graded honestly. The
Build 58 run that caught all three known defects is **historical and not
reproducible** — GitHub expires build artifacts after 14 days and that one is
gone. The reproducible proofs are the committed test suite, the recorded runs
against Build 59 and both AWARE builds (clean, with the absent microphone key
cleared rather than merely unflagged), and a counterfactual built from the real
Build 59 bundle with only the photo key removed, which reports exactly the
violation describing the crash.
A committed test suite builds synthetic known-bad IPAs and pins the whole
truth table plus the exit-code contract, so that proof is repeatable by anyone
rather than resting on artifacts that happened to be on one machine.

It is a text scan, so read its verdicts at their real strength: a violation is
a strong signal worth blocking on; a pass means no shipped-bundle path matches
those patterns, not that the app cannot reach the API. Native-only reach is
invisible to it by construction.

### Stage 4 — Deterministic real device

Today the fleet's only real-device testing is the AWS Device Farm **built-in
fuzz suite**: random input, 20-minute budget. Across all 21 Device Farm runs
this fleet has ever executed — iHEARtest, AWARE, Flatstick, PlantID — **every
single one was `BUILTIN_FUZZ`. Zero scripted runs, ever.**

Random testing is not a gate, it is a lottery. The TCC crash survived 16 tagged
builds and was caught only when one seed happened to walk into the share sheet.
The ladder out, cheapest first:

1. **Pin the fuzz seed** (`test.parameters.seed`). Zero new infrastructure,
   available today. Converts "random every time" into "the identical event
   sequence every time" — so a crash reproduces, and a fix is provably a fix
   rather than a different roll. Do this immediately; it is the highest
   value-per-effort item in this document.
2. **XCTest UI (XCUITest).** Verified live against our own account: `BUILTIN_FUZZ`,
   `XCTEST`, and `XCTEST_UI` are all compatible with the existing
   `iheartest-iphone16` pool **with no additional artifact and no custom
   environment YAML**. Upload types `IOS_APP` + `XCTEST_UI_TEST_PACKAGE`.
   XCUITest reads WKWebView content through the standard accessibility
   hierarchy, so a Capacitor app is reachable without any webview-context
   gymnastics. This is where class B items that need a real device go — item 16
   (Save Image) becomes "tap share, tap Save Image, assert the app is still
   alive and the picker appeared."
3. **Appium** only if iOS+Android test reuse is wanted. It now *mandates*
   custom-environment YAML (confirmed: `GetDevicePoolCompatibility` with
   `APPIUM_NODE` returns a hard `ArgumentException` demanding a test spec), and
   `NATIVE_APP` to `WEBVIEW_*` context switching is independently documented as
   flaky on real iOS devices. Do not start here.
4. **Widen the matrix when there is something to run on it.** 72 iOS devices are
   available (iOS 15.0.2 through 26.6); the current pool contains exactly one
   iPhone 16 on iOS 18.0. Also available and unused: 13 network profiles
   including a `Disabled` profile that is effectively "connectivity is dead",
   radio toggles, and fake GPS. A matrix of random fuzz is still random; widen
   *after* step 2.

**Provenance for the numbers above**, so they can be re-checked rather than
inherited. All read live from our own AWS account (`us-west-2`) on 2026-09-06:

| Claim | How to re-derive it |
|---|---|
| 21 runs, all `BUILTIN_FUZZ` | `devicefarm list-projects`, then `list-runs` per project ARN, tallying `.runs[].type` |
| `XCTEST_UI` needs no custom YAML | `devicefarm get-device-pool-compatibility --device-pool-arn <iheartest-iphone16> --test-type XCTEST_UI` returns compatible |
| Appium mandates a test spec | the same call with `--test-type APPIUM_NODE` returns `ArgumentException` demanding one |
| 72 iOS devices, 13 network profiles | `devicefarm list-devices` filtered to `platform=IOS`; `devicefarm list-network-profiles` |

Two honest limits on the census. It counts runs the account still returns, so a
run aged out of Device Farm's retention would not appear — read "21" as *every
run visible to us*, which is the number that matters for the claim being made
(nobody has scripted anything). And device and profile inventories are AWS's to
change; re-run the call rather than quoting this table a year from now.

**Read Device Farm results correctly.** Two traps, both hit for real:

- A `bug_type` **309** `.ips` is a crash. A **308** with `is_simulated` is a
  benign iOS user-fault diagnostic while the process keeps running. Confirm the
  app's pid still logs after the timestamp before calling it a crash.
- An `.ips` file is **two newline-delimited JSON documents** (header, then
  body), and `bug_type`/`is_simulated` live in the header. `resp.json()` on the
  whole file throws — which is exactly how our crash classifier came to be
  unreachable in production while looking perfectly well-built in the repo.

And the framing rule: **a clean fuzz run is negative evidence.** "Twenty minutes
of random input did not crash it" does not mean a feature works. AWARE's packet
inferred from a clean fuzz run that the native picker "was proven to present and
dismiss cleanly"; the repo's own HANDOFF.md explicitly disclaims that inference
two files away.

### Stage 5 — Issue the packet

Only now. Every item carries its class and its verified-by line. Class C items
are the body of the packet; class A items appear as stated background so the
reviewer knows what is already settled; class B items are either closed or
labelled, in plain words, as not independently verified.

---

## Which engine does what

The point of four engines is **independence**, not throughput. A second opinion
from the seat that wrote the code is not a second opinion.

Grade these four paragraphs differently, because they are not equally proven.
The Claude Code and subagent lanes are what this document was written from, so
they are described from use. The ChatGPT lane's mechanics were verified live on
2026-08-29 (an `occ_gpt_cto` authorization-code exchange against
`mcp.otchealth.app`, 17 of 17 checks) — but *that it produces good adversarial
review* is a design intent nobody has run yet. The Codex constraints ("no
inbound API", separately funded, `AGENTS.md` limits) come from a vendor-docs
research pass on 2026-08-29, not from operating it, and the lane is blocked on
the owner action noted below, so treat that paragraph as a plan. HyperAgent's is
a plan too. **Nothing below the first two paragraphs has shipped**; they are here
because the split is the design, and saying so is cheaper than discovering later
which parts were aspiration.

**Claude Code (this seat) — owner.**
Writes the gates, reads every diff, runs artifact-truth, holds merge authority,
and issues the packet. Also the only seat that touches secrets, AWS, or
production. Non-transferable.

**Sonnet-5 subagents (parallel, in-session) — fan-out.**
Per-app or per-dimension audits running concurrently: packet-coverage audits,
capability sweeps, Device Farm capability research. They are how one seat
audits nine apps in an evening. Standing rule, and it has repeatedly earned its
place: **never merge a subagent's work unread, and never repeat a subagent's
claim without checking it.** This week a subagent asserted the shipped build
sends an unsubstituted `{{APP_VERSION}}` to Sentry; the artifact showed
`v1.6.0` and zero placeholders. The real finding underneath was different and
more useful — our own test harnesses are polluting the production Sentry
project.

**ChatGPT (gateway connector, `occ_gpt_*` lanes) — adversarial packet review.**
Has brain access through `mcp.otchealth.app` and, critically, did not write the
code. Give it the packet and the evidence index and ask one question: *which of
these claims is not actually proven by the evidence cited?* It is read-heavy and
holds no merge authority, which is precisely what makes it useful here.

**Codex — the deterministic test suites.**
Codex has no inbound API; it is reached by `@codex` comments on GitHub issues
and PRs, and its output arrives as PRs we review. That shape is a poor fit for
orchestration and an excellent fit for **bulk test authoring**: the XCUITest
specs of stage 4, the class-B Playwright assertions of stage 2, per app. It is
separately funded, so it is throughput that does not draw the shared weekly
limit. Adopt `AGENTS.md` in each app repo mirroring that repo's `CLAUDE.md`
rails (32 KiB limit, closer-wins merge) so Codex inherits the same constraints.
*Blocked on one owner action: approving the Codex GitHub App on the org.*

**HyperAgent — cadence and drift.**
Scheduled, always-on, with a durable doc store. Its job is the recurring
question no session remembers to ask: re-run artifact-truth against the newest
shipped build of every app nightly, diff each app's packet against its
predecessor, and flag any gate that has not run in N days. Verification that
only happens when someone thinks to run it is not a gate.

---

## Evidence rules (these are the ones that were violated)

1. **Verify the artifact, not the tree.** Build-time pruning, content
   materialization, and placeholder substitution all make the repo a poor
   witness.
2. **A check that cannot run must fail loudly.** Exit 2 exists for this. The
   crash classifier that threw on parse, the eval job whose image tag had
   expired, the auto-critic that posted "fail-safe approve" and reported
   SUCCESS — all reported healthy while doing nothing. Distinguish *transport
   failure* from *clean result* at every layer.
3. **Assert the outcome, not the mechanism.** The `{{APP_VERSION}}` rule that
   fired on comments documenting the substitution is the cautionary example.
4. **Negative evidence is not positive evidence.** "It did not crash" is not
   "it works."
5. **A conclusion that BLOCKS work deserves stronger evidence than one that
   merely informs**, because nobody re-tests a blocker. The n8n data-tables
   work was blocked for a day by a runbook conclusion drawn from *unauthenticated*
   probes: a 401 means "you did not authenticate", not "the route does not exist."
6. **Merged and built is not deployed.** A skill can merge, its image can build
   green on that exact SHA, and the task can still fail at runtime because the
   Dockerfile's COPY list is selective. Rehearse once before trusting a gate.

---

## Adopting this in a new app (the factory checklist)

1. Write `skills/release-verification/schema/<app>.release-truth.json`. Prove it
   by running it against a build you already know is bad.
2. Identify the shipped payload. Answer in writing: *what exactly does
   `cap sync` copy into the bundle, and does any script transform it first?*
   For a two-tree app, name both trees and which one ships.
3. Pin one device-viewport constant; import it in every browser gate.
4. Wire artifact-truth into the iOS workflow: vendor it, then add a blocking step
   after the export attestation and BEFORE the device-farm and store uploads.
   Fail fast, and do not spend device minutes on an artifact already known bad.
   Copy the shape from `iheartest/qa/release-verification/`. Until this is done
   the app's stage 3 is a manual habit rather than a gate.
5. Pin the Device Farm fuzz seed.
6. Classify the first packet A/B/C. Count the B items. That number is the
   app's verification debt, and it is the backlog Codex works through.
