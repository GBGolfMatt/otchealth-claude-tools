# CFO source catalog materializer

This is an actual boto3 source worker, not an injected catalog adapter. Execute only
inside the authorized CFO AWS source boundary. CTO receives aggregate receipts, never
source rows. It does not access original documents, text sidecars, identities or model
providers. It cannot make stale enrichment current or turn missing enrichment into proof.

`materialize.handler(event, context)` is the Lambda entry point. The same implementation
supports `python materialize.py REQUEST.json` on an authorized AWS worker with Python 3.12
and boto3. No source data may be downloaded to this CTO checkout to run it.

The prefix-scoped request has exactly five fields: `operation` (`inspect` or `publish`),
`source_version_id`, `cohort_id`, `policy_sha256`, and `source_prefixes` (the exact
approved original-relative prefixes ending in `/`). These must come from the release
owner’s cohort configuration. No example policy hash or cohort is an authorization.

The independently deployed `CFO_CATALOG_MATERIALIZER_AUTHORIZATIONS_JSON` environment
setting must contain a unique matching tuple: `cohort_id`, `policy_sha256`,
`source_prefixes`, `source_version_id`, `allow_publish` (boolean), and `expires_at`
(timezone-qualified timestamp). Request values cannot create this authorization.
Missing, mismatched or expired tuples refuse before any source read. Authority is
rechecked before publication and before success. Keep Invoke and deployment-change
permissions separate. The default environment has no authorization.

For the full authorized CFO corpus, explicitly add `source_scope:
"all_cfo_source_documents"` to both request and deployment authorization and set
`source_prefixes: []`. This includes root-level and nested original-relative paths
from only the fixed CFO catalog. Internal paths remain excluded. Empty prefixes
without that explicit scope remain invalid. An inspection-specific label and policy
can authorize this read-only coverage check without activating any Graph cohort.

The bucket and original catalog key are fixed in source. The lead CTO verified the
catalog's existence with HEAD on September 9 UTC: 193236929 bytes, version
`DnD6kh5zerxAGu.BWo6Tn7LWnGMd0p6y`. Recheck current HEAD before execution. The worker
requires this exact requested version to be current before and after reading. It reads
with both VersionId and IfMatch and verifies returned version, ETag and byte count.

Inspection is read-only. It streams bounded JSONL and returns aggregate exclusion
reasons. Eligible rows must already claim a valid original SHA-256, sidecar availability,
successful enrichment and an enrichment SHA-256 equal to the original SHA-256. Unknown
fields, including document text and summaries, are dropped. Only the thirteen exact
planner fields are retained. Conflicting rows for one original path are refused. No
original filename, entity name or selected row appears in the result or error output.

Publication refuses an empty eligible set. It writes an immutable content-addressed
JSONL object below `graph-trial/20260909/materialized-cfo/` using IfNoneMatch and an S3
SHA-256 checksum, then GETs and hashes the downstream artifact. A repeated request
verifies the existing object instead of replacing it. Temporary selected metadata is
stored only on the trusted worker's ephemeral disk and closed on completion or error.
Source catalog changes cause a new immutable artifact, never an in-place replacement.

Receipt bindings include cohort, policy hash, hash of the approved prefixes, original
catalog VersionId and exact byte hash, output byte hash, counts, and output key/version.
`catalog_source_sha256` retains the existing logical identity convention: hash of the
canonical `{room,source_index,url}` for the authoritative source catalog's HTTPS URL.
`catalog_content_sha256` is the distinct exact projected-file byte hash. ETag is never
represented as SHA-256. The destination key includes a hash of the complete receipt
binding. A sibling `.receipt.json` object preserves the full immutable binding and
verified catalog version; it too uses conditional creation and checksum readback.
The returned receipt key and exact byte hash let another worker verify it independently.
The worker does not log, persist to Brain, update a cohort, or activate a job.

Any error after an attempted PUT returns `publication_unknown` with `published: null`
and the exact technical key/hash/version references available for reconciliation.
It never reports `published: false` when a write may have occurred. A repeated identical
authorized request reconciles existing immutable objects by reading and hashing them.
If the upstream source has since changed or authority has expired, the normal request
refuses and the release owner must perform read-only reconciliation of the returned
references. Unknown outcomes must not be treated as an instruction to overwrite.

## Concrete release gates

1. Independently review this source and tests. Package this file in the approved source
   worker, with bounded timeout, ephemeral disk and existing AWS credentials. No new
   service or capacity is presumed approved. The CLI and handler use sanitized errors.
2. Inspect using the actual cohort, policy hash, prefix set and current source VersionId.
   A `not_ready_no_eligible_rows` receipt is a real schema blocker, never success.
3. Review the returned counts and bind the requested source VersionId. Publish the same
   reviewed request with `operation: publish`. The receipt proves a catalog mirror and
   its version only, not original binary lineage or current source content.
4. The release owner must bind the exact key, logical source hash, content hash and
   source VersionId to the configured cohort and its publication receipt. Gateway
   catalog readers currently validate ETag and length, not the receipt content hash.
   Add that enforcement before claiming fully pinned live acceptance.
5. Source-current validation must revalidate upstream catalog VersionId and refresh or
   invalidate the cohort when it changes. The current gateway checks only the selected
   row in its configured mirrored catalog. A fixed mirror alone is not current-source
   authority. A refresh must not silently abandon prior cursor or stale-source evidence.
6. Catalog association does not prove that the original binary's hash still matches
   current bytes. The audited indexer historically skipped already cataloged paths.
   Full-text preparation separately pins current versioned `_TEXT` bytes and truthfully
   reports `catalog_association_only`. Keep that limitation until real lineage exists.
7. Confirm independent live CFO source-to-relationship publication and fresh-session
   retrieval, then natural scheduled execution. No synthetic result satisfies this gate.

## Exact permission requirements, review only

Inspection needs `s3:GetObject` for HEAD and `s3:GetObjectVersion` for version-pinned GET
on only `arn:aws:s3:::otchealth-finance-legal-dr-55c84f6b/otchealthcfodata/cfo-source-docs/_CATALOG/catalog.jsonl`.
It needs no bucket list and no access to any other source key.

Publication additionally needs `s3:PutObject` and `s3:GetObject` under the exact
approved destination cohort prefix below `graph-trial/20260909/materialized-cfo/`.
No delete, ACL, IAM, role assumption or other room access is required. KMS permissions,
if required by the existing bucket, must be reviewed separately, never broadened here.

The separate gateway `_TEXT/*` `s3:GetObjectVersion` policy is required for full-text
preparation, not for this materializer. Its known narrow review file is
`audits/2026-09-07/team/gateway-pr316-cfo-text-version-read-policy.json` in the CTO seat.
This component neither applies that policy nor restarts the gateway.

## Reproducible worker image

The Dockerfile pins the public Python 3.12 multi-platform base by immutable manifest
digest. `requirements.lock` pins all seven public dependency wheels by version and
SHA-256. Public registry/PyPI verification is recorded in `image-inputs.json`.
The locked SDK service model was checked offline for conditional PUT/checksum and
version-pinned GET support. No AWS credentials or source objects were used in that check.

The container runs as UID/GID 10001. `supervisor.py` starts a separate Linux process
group for the fixed worker, gives it 600 seconds, sends SIGTERM to the entire group,
then SIGKILL after a 30-second grace. Only bounded structured worker output is returned;
raw stderr is discarded. A timeout, malformed output or nonzero success claim produces
an unknown outcome. The runtime owner additionally guards the ECS task at 900 seconds.

Build with the manual-only reviewed build path using `build-worker.sh` in the existing
Depot project and existing ECR repository. It uses a unique `cfo-catalog-<commit>` tag,
never shared `latest`, and verifies both platform manifests and exact registry digest.
`build-receipt.py` records source-file hashes, commit, platform manifests and immutable
image digest. Upload the four technical build receipt artifacts with the existing
workflow's immutable uploader. This recipe does not dispatch ECS, change IAM or schedules.
The existing shared doc-indexer workflow has a fixed Dockerfile and must not be blindly
dispatched for this image; a reviewed manual-only build-path addition is still required.

Tests run inside each image build. On Windows, 14 tests passed and two Linux signal-group
tests were explicitly skipped; those must run on Linux before image acceptance. Local
Docker is unavailable, so no built worker image or live source execution is claimed here.
