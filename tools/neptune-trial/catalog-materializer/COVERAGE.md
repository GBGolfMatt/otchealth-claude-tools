# Aggregate coverage reconciliation

This offline validator checks supplied aggregate receipts. It does not read sources,
change the worker image, bypass release approval or establish live operational acceptance.
Use `coverage-input-template.json` as the input template. An empty template reports
unknowns, never zeroes. `python coverage_report.py INPUT.json` emits the report. Keep input
limited to the producer's structured aggregate receipt and exact approved request.

The report distinguishes:

- Complete catalog-snapshot row counts from unmeasured or failed scans.
- Eligible unique catalog paths from duplicate eligible rows and excluded rows.
- Missing source/enrichment provenance, missing sidecar claims, invalid metadata,
  processing errors, scope exclusions, and invalid/internal paths.
- Parse failures, bounded scans, changed snapshots, authorization failures and unknown
  publication outcomes. Failures never supply a zero row count or percentage.

For complete receipts, conservation must hold exactly:

`catalog rows = eligible unique paths + duplicate eligible rows + all excluded rows`

Exclusions use the materializer's first-failing reason for each row. Categories are
mutually exclusive accounting buckets, not counts of every defect a document may have.
`invalid_path` combines invalid paths and reserved internal paths in the existing producer;
this report cannot separate those populations. Duplicate accounting applies only to
eligible rows. Unique original-document counts cannot be inferred from either bucket.

Binding checks cover the approved request's source version, policy, logical source
identity, cohort and scope. Published receipts additionally require consistent immutable
key, binding digest and durable receipt digest. This is consistency checking of supplied
data, not an authenticated S3 read or a fresh source-current check. The source snapshot
records that distinction explicitly. Unknown failure text is classified without echoing it.
The existing worker's failed/refused/unknown terminal receipts do not carry an authenticated
request digest. The report therefore places their failure categories under
`unattributed_worker_outcomes`, retains null source counts, and marks the intended source
measurement `unknown_unbound_worker_outcome`. It does not attribute a parse failure or
interruption to that source without a verified execution envelope. No production worker
or image change is introduced to work around this evidence gap.

The company-legal entry stays independently `not_measured` until its source owner provides
an authoritative aggregate contract. The finance producer cannot be relabeled as company
legal. An unverified user document target is a planning reference only, never a denominator.
Historical counts without the current exact source snapshot do not establish current scope.

Catalog eligibility is not full-document preparation, graph publication, relationship
correctness, fresh-session retrieval or multi-hop X-Y-Z acceptance. Those remain explicit
unverified stages. Reuse `subscription-jobs/prepared-text-coverage.mjs` inside the trusted
source runtime for actual contiguous text/chunk coverage; do not send text to this report
or duplicate that proof with aggregate arithmetic. Reuse durable publication and retrieval
receipts at their existing boundaries. This report never marks overall acceptance true.

Synthetic fixtures exercise the actual existing materializer with FakeS3 to produce
aggregate inputs. No original documents, source catalog rows from production, source
filenames, entity values, new infrastructure or deployment are used.
