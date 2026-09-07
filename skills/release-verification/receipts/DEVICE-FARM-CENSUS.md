# Device Farm census: the stage-4 numbers, with their output

`app-kit/RELEASE-VERIFICATION-STANDARD.md` stage 4 asserts several facts about
our AWS Device Farm account. An earlier draft gave the command to re-derive each
one but not its output, which a review pass correctly called unsupported: a
command is a recipe, not evidence, and nobody re-runs a recipe before quoting
the number next to it.

All of the below was read live from AWS account `900915535335`, region
`us-west-2`, on **2026-09-06**, via SigV4 `POST /` with
`x-amz-target: DeviceFarm_20150623.<Operation>`.

## Every run the account still returns is a built-in fuzz run

`ListProjects`, then `ListRuns` per project ARN (paging `nextToken`), tallying
`.runs[].type`:

```
  AWARE        5 run(s)
  Flatstick    11 run(s)
  iHEARtest    5 run(s)
  iHEARtest    0 run(s)
TOTAL RUNS: 21
BY TYPE: {"BUILTIN_FUZZ":21}
```

21 runs, one type: **zero scripted runs among them** (scope qualified two
paragraphs down, and the qualification travels with every restatement of this
number). (There are two projects named
`iHEARtest`; the empty one is a duplicate. It is listed rather than tidied away
because the tally has to account for every project the API returns.)

The count is of runs the account still returns, so a run aged out of retention
would not appear. That bounds what this number can support. It shows **no
scripted device testing in use** — a scripted suite anyone actually relied on
would put recent runs in this window — and it does *not* show that nobody ever
scripted a run. An earlier draft stated the retention caveat and then walked it
back in the same sentence ("which is what the claim needs: nobody has scripted
anything"), which is the overclaim this document exists to argue against,
committed in its own evidence file.

## Device and network-profile inventory

`ListDevices` (paged), filtered to `platform: IOS`; `ListNetworkProfiles`:

```
iOS devices: 72   os range: 15.0.2 .. 26.6
network profiles: 13  (3G Average, 3G Good, 3G Lossy, Disabled, EDGE Average,
                       EDGE Good, EDGE Lossy, Full, GPRS, HSDPA, WiFi Average,
                       WiFi Good, WiFi Lossy)
```

`Disabled` is the profile that makes "connectivity is dead" a testable state.
AWS owns this inventory and will change it; re-run rather than quoting this file
a year from now.

## Test-type compatibility for the existing pool

`GetDevicePoolCompatibility` against pool `iheartest-iphone16`, with a real
`appArn` (a previously uploaded `IOS_APP`):

```
  HTTP 200  BUILTIN_FUZZ  compatible=1 incompatible=0
  HTTP 200  XCTEST        compatible=1 incompatible=0
  HTTP 200  XCTEST_UI     compatible=1 incompatible=0
  HTTP 400  APPIUM_NODE   ArgumentException Invalid input for ScheduleRun API
            detected. The service could not schedule a run because the test type
            you specified is only compatible with custom environment mode. Please
            edit your request to specify a custom environment mode test spec file.
```

So XCTest UI needs **no custom-environment YAML and no change to the device
pool**, and Appium mandates a test spec. That is the evidence behind the stage-4
ladder ordering.

**It does need its own test bundle** (`XCTEST_UI_TEST_PACKAGE` alongside
`IOS_APP`) — an XCUITest run has to have tests to run. An earlier version of
this file said "no additional artifact", which was false and, worse, contradicted
the corrected sentence in the standard that cites this file as its evidence. What
the probe establishes is that the *surrounding infrastructure* needs nothing new;
writing the tests is the work.

`XCTEST` was missing from an earlier capture even though the standard's claim
names three test types. Rather than weaken the claim, the probe was re-run for
the third; the row above is that run. A claim whose stated provenance does not
cover it is unsupported even when it happens to be true.

**A trap worth recording, because it produced a confidently wrong answer.** The
first probe omitted `appArn` and returned HTTP 200 with
`compatible=0 incompatible=0` for *every* test type asked — including
`BUILTIN_FUZZ`, which this pool has demonstrably run 21 times. Read literally
that says the pool is incompatible with everything. It does not: with no app to
evaluate against, the API has nothing to judge and answers with empty lists
rather than an error.

An all-zero result across a control case you know to be true is the tell. Had
`BUILTIN_FUZZ` not been in the list as a sanity check, the zero for `XCTEST_UI`
would have looked like a real finding and reversed the ladder above. **Always
include a case whose answer you already know.**
