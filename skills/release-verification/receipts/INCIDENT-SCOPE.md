# Incident scope: how many builds carried the TCC crash

The count in SKILL.md and the standard is **derived, not recalled**, because
every narrative version of it was an undercount and each one inherited the last.
This file is the derivation and its output, so the number is checkable rather
than asserted.

## The query

A build is vulnerable only if BOTH hold: the share-image path is reachable in
the shipped web source, AND `NSPhotoLibraryAddUsageDescription` is absent from
`Info.plist`. A missing key alone is harmless if nothing reaches the library,
which is why the plist half on its own does not establish the claim.

Run in a checkout of `InnerScopeHearing/iheartest`:

```bash
for t in $(git tag -l 'tf/*' | sort -t+ -k2 -n); do
  key=$(git show "$t:ios/App/App/Info.plist"  2>/dev/null | grep -c NSPhotoLibraryAddUsageDescription)
  share=$(git show "$t:www/js/app.js" 2>/dev/null | grep -cE 'navigator\.share|canShare')
  image=$(git show "$t:www/js/app.js" 2>/dev/null | grep -cE 'toBlob|image/png')
  [ "${share:-0}" -gt 0 ] && [ "${image:-0}" -gt 0 ] && [ "${key:-1}" -eq 0 ] && echo "$t"
done
```

## Output, captured 2026-09-06T22:13:47Z

```
tf/1.5.14+42
tf/1.5.15+43
tf/1.5.17+45
tf/1.5.18+46
tf/1.5.19+47
tf/1.5.19+48
tf/1.5.20+49
tf/1.5.21+50
tf/1.5.21+51
tf/1.6.0+52
tf/1.6.0+53
tf/1.6.0+54
tf/1.6.0+55
tf/1.6.0+56
tf/1.6.0+57
tf/1.6.0+58
```

**16 tags.** `tf/1.5.14+42` is the earliest tag the repository has, so this is
every tagged build in its history until 59 added the key.

Read that as **16 tags whose SOURCE carries both conditions** — not as 16
independently verified shipped artifacts. The difference is the subject of the
next section, and it is not a technicality here.

## What this evidence is, and is not

It is a git query anyone with the repo can re-run. The output above is a
transcript of one run and carries exactly the weight a transcript carries; the
check that matters is the command, not my copy of its result.

It is recorded here because the number stopped being derived and started being
re-copied, which is how it went wrong three times: a commit message said four
and named a tag that does not exist, the standard repeated it and added a detail
nobody had checked, and a review pass then argued for six.

Three caveats, stated rather than glossed. **The first one is the document's own
thesis pointed back at this file, and it was raised by a review pass rather than
noticed by its author.**

- **This is a SOURCE query, and this standard exists because source is a claim
  while the artifact is the fact.** `git show <tag>:...` reads the repository,
  not the IPA that shipped. So the query establishes the SOURCE state of 16
  tags; it does not independently verify 16 shipped bundles, and it cannot,
  because `ios-depot.yml` uploads each IPA with `retention-days: 14` and every
  IPA older than Build 59's is gone. Nobody can re-check them, including me.

  This is precisely the reasoning that produced the AWARE false P0 one repo
  over: `www/` contained `getUserMedia` behind visible buttons, the shipped
  plist declared no microphone key, and the shipped IPA turned out to contain no
  `getUserMedia` at all, because the public build assembles a different bundle.
  A source query is *evidence about the source*, and the honest version of this
  claim says so.

  What survives at artifact strength is narrow and reproducible: Build 59's IPA
  verifies CLEAN with the key present (`REAL-ARTIFACT-RECEIPTS.md`), and the
  counterfactual in `SOURCES.md` takes that same real shipped `js/app.js` and
  real `Info.plist`, removes only the photo key, and reproduces exactly the
  violation that describes the crash. That is what makes the mechanism real. The
  16 is the source-level blast radius, and calling it anything stronger would
  make this file guilty of the failure the tool was built to catch.
- There is no `+44` tag, so the range is not contiguous.
- "Tagged" is not "reached testers". The repo convention tags every TestFlight
  build, but at least one build (an earlier 59 attempt) never reached App Store
  Connect. The claim is about tags, which is what this evidence supports.
