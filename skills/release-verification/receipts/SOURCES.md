# Artifact provenance for the receipts

Where each IPA in `REAL-ARTIFACT-RECEIPTS.md` came from. Maintained by hand,
because a build run knows things the verifier cannot see from the bytes.

GitHub Actions expires artifacts 14 days after the run, so an entry older than
that is a historical record rather than a fetch recipe. Re-cut the build, or use
the TestFlight build of record, if you need to re-verify after expiry.

| App / build | IPA sha256 | Where it came from |
|---|---|---|
| iHEARtest 1.6.0 (59) | `8b52e45ec059e31fc03cb7924a34297728d71579c9ab3337bdecb844dbd9647f` | `InnerScopeHearing/iheartest` run `33995716282`, artifact `9978062078`, zip digest `sha256:25445dc2c7006b0f6f804a29cf51c6d55b5b6b11d4dd1d0b8d13698b3551c0f3`, head `691371d9748a3739dfb18a23f15e3c08a1f6b635`. The build that carries the `NSPhotoLibraryAddUsageDescription` fix. |
| AWARE 1.4.0 (1779565782) | `af7bc2c53c52c25d31b230a708892383f0ea6b84937dc72385418bdc03bac3d5` | Shipped to TestFlight as `tf/1.4.0+1779565782`. Its `Info.plist` is also committed as `tests/fixtures/binary-info.plist`, which is how the binary-plist parser gets tested on production bytes. |
| AWARE 1.4.0 (1779565781) | `012768f37da4c27a4317564f1dd455b20fc237303deef367f1a2e3edeecacada` | The preceding shipped build. Verified as an independent second artifact so an AWARE pass is not a single-sample result. |

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
