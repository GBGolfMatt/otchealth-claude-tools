# Stock reader publication repair, 2026-09-07

Status: prepared and tested, not deployed. This receipt contains infrastructure
metadata only. No private accounting records or credential values were retrieved.

## Live evidence

AWS Core API reads on 2026-09-07 at 19:53:47 UTC:

- Scheduler GetSchedule, us-east-1, name otchealth-innd-stock-daily, group default:
  ENABLED; cron(30 22 ? * MON-FRI *); timezone UTC; ECS stock task revision 5.
- ECS DescribeTaskDefinition, otchealth-job-innd-stock-daily:5:
  task role otchealthTaskRole; doc-indexer:latest image; command runs
  with-heartbeat.sh innd-stock-daily and node /app/skills/innd-stock/innd-stock.mjs update.
  MASSIVE_API_KEY and MASSIVE_API_KEY_2 are SSM bindings. Values were not read.
- CloudWatch GetLogEvents for innd-stock-daily/job/6f3837dd619f48c28acc0a1ebbf47e53:
  September 4 run updated the canonical workbook through September 3, 2,382 rows.
- S3 HeadObject for the canonical workbook: last modified September 4, 22:30:50 UTC,
  1,696,359 bytes. The CFO reader copy and text sidecar remained dated August 13.

These observations justify the AWS execution guidance and establish a publication
path mismatch. They do not prove that this new helper is deployed or that the final
market-data date is complete. The last run's source coverage still needs validation.

## Validation evidence

Initial PR head a54b46a5e300ae3c8f7544343cb13fdbb8a778be:
[toolkit test run 34157133218](https://github.com/InnerScopeHearing/otchealth-claude-tools/actions/runs/34157133218).
The run-tests.sh step passed, including its syntax check for every skill mjs file.
Node suite reported 3,001 tests, 2,999 passes and zero failures. Logs explicitly show
the five new publication tests passing and the existing stock S3 tests passing.
The index-writer and silent-success checks also passed.

The Windows local command node --test skills/innd-stock/publish-price-rail.test.mjs
passed 5 of 5 using synthetic bytes. node --check innd-stock.mjs also succeeded.

Review follow-up shares canonical destination constants between the CLI and
publisher so the returned URI and written path cannot drift independently.
Re-run the same checks on the final head before merging. The automatic prompt
comparison lacked scorecards; its green workflow is not a successful comparison.

## Production acceptance still required

Build the reviewed image and pin it only on the stock job. Verify IAM for the exact
existing source and reader paths without broadening access. Run update once, check
the metadata-only publication receipt and its hashes, then let the CFO verify an
exact-path document read. Do not declare completion from a merged PR, successful
image build, or scheduler trigger alone. Coordinate the release with the active CTO
task to avoid changing shared image tags or unrelated jobs.

## Follow-up implementation verification

Implementation commit 0f99d29b2b7d2174cf3b8ec2018d4465cbc51723 passed
[run 34157393707](https://github.com/InnerScopeHearing/otchealth-claude-tools/actions/runs/34157393707)
on 2026-09-07 at 19:55:56 UTC. All mjs syntax checks passed; 3,001 Node tests,
2,999 passed, 0 failed and 2 skipped. All five publication tests ran, as did the
existing stock status tests. The index-writer and silent-success gates passed.
This receipt-only follow-up changes no implementation or test code after that
verified commit. The prompt-comparison job still lacked scorecards and is not
claimed as a passed comparison. Production deployment remains outstanding.
