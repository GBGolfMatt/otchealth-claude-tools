# Artifact provenance for the receipts

Where each IPA in `REAL-ARTIFACT-RECEIPTS.md` came from. Maintained by hand,
because a build run knows things the verifier cannot see from the bytes.

`ios-depot.yml` sets `retention-days: 14` on the IPA upload, so an entry older
than that is a historical record rather than a fetch recipe. That number is this
workflow's own setting, not a GitHub-wide rule -- the platform default is 90
days -- so check the workflow rather than assuming it if this is ever ported. Re-cut the build, or use
the TestFlight build of record, if you need to re-verify after expiry.

**Every row carries a run id, an artifact id and the artifact's zip digest**, so
a reader can re-fetch the same bytes and check them against the IPA sha256 in
`REAL-ARTIFACT-RECEIPTS.md` rather than taking the receipt's word for it. That
establishes **retrieval integrity**: you have what the run stored. It is not by
itself proof that those bytes reached TestFlight — that comes from the workflow
carrying one `IPA_PATH` through attestation, artifact upload and `altool`, which
`ios-depot.yml` does and which the standard's stage 3 spells out. The
two AWARE rows originally carried only a TestFlight tag, which made them
unre-fetchable for no reason other than that I had not written the ids down; a
review pass caught the asymmetry with the iHEARtest row. **Checked 2026-09-06:
all three artifacts report `expired: false`**, so as of today the receipts are
re-derivable end to end, not merely historical. That will lapse on the workflow's
14-day retention clock, which is the point of recording the digests now.

| App / build | IPA sha256 | Where it came from |
|---|---|---|
| iHEARtest 1.6.0 (59) | `8b52e45ec059e31fc03cb7924a34297728d71579c9ab3337bdecb844dbd9647f` | `InnerScopeHearing/iheartest` run `33995716282`, artifact `9978062078`, zip digest `sha256:25445dc2c7006b0f6f804a29cf51c6d55b5b6b11d4dd1d0b8d13698b3551c0f3`, head `691371d9748a3739dfb18a23f15e3c08a1f6b635`. The build that carries the `NSPhotoLibraryAddUsageDescription` fix. |
| AWARE 1.4.0 (1779565782) | `af7bc2c53c52c25d31b230a708892383f0ea6b84937dc72385418bdc03bac3d5` | `InnerScopeHearing/aware-aural-rehab` run `33944065447`, artifact `9962992210` (`aware-1.4.0-1779565782-c0e7fc74547dabcf594558feebc3bdd1a783bc62`), zip digest `sha256:a87635db73d280f47b32b530d0eb818a06746ea11e0fb3b2e15f49037fbd473b`, head `c0e7fc74547dabcf594558feebc3bdd1a783bc62`. Shipped as `tf/1.4.0+1779565782`. The build's OWN `release-manifest.json` records `ipaSha256` identical to the value in this row, so the hash is corroborated by the pipeline and not only by my transcript. Its `Info.plist` is also committed as `tests/fixtures/binary-info.plist`, which is how the binary-plist parser gets tested on production bytes. |
| AWARE 1.4.0 (1779565781) | `012768f37da4c27a4317564f1dd455b20fc237303deef367f1a2e3edeecacada` | `InnerScopeHearing/aware-aural-rehab` run `33930789315`, artifact `9958932720` (`aware-1.4.0-1779565781-4dfa6b9d80202b228419b43cd8d948a2b4282696`), zip digest `sha256:1f4dc9bc824a4c82e5337db6a3ecae37671006a06580051c503c9bcdd0eb8fef`, head `4dfa6b9d80202b228419b43cd8d948a2b4282696`. The preceding shipped build, verified as an independent second artifact so an AWARE pass is not a single-sample result. |

## Fetching a shipped IPA from its build run

The artifact download 302s to a presigned URL that **rejects** the
`Authorization` header, so follow the redirect without one:

```bash
LOC=$(curl -sS -o /dev/null -w '%{redirect_url}' \
  -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/repos/<owner>/<repo>/actions/artifacts/<id>/zip")
curl -sSL -o artifact.zip "$LOC"
unzip -q artifact.zip           # yields export/App.ipa
```

## Runs recorded here but not reproducible from an artifact

- **iHEARtest Build 58**, the run that first proved the tool catches real
  defects (all three known ones). Its artifact has since expired and the build
  was superseded by 59, so it cannot be re-fetched. The equivalent proof that
  survives is the counterfactual in the test suite plus this one, run against
  Build 59: take the real shipped `js/app.js` and the real Build 59
  `Info.plist`, remove only `NSPhotoLibraryAddUsageDescription`, and the
  capability rule reports exactly the violation that describes the crash.
