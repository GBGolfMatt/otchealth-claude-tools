# Targeted source metadata repair

The ordinary indexer is not a targeted repair path. Its `runIndex` skips existing
catalog paths unless `--reindex` resets the catalog; `flushCatalog` writes without
a conditional ETag. Do not combine reindex with a narrowed prefix.

This worker prepares an immutable, source-owned manifest. Run the verified image
with entry point `python /app/repair_supervisor.py`. Supply deployment-owned JSON
in `CFO_CATALOG_REPAIR_REQUEST_JSON` and
`CFO_CATALOG_REPAIR_AUTHORIZATIONS_JSON`. The only runtime operation is `plan`.
It reads the exact catalog version, requires its expected SHA-256, lists metadata
only under the fixed CFO source prefix, and conditionally creates its manifest
under `_CATALOG/repair-plans/<cohort>/<manifest-sha256>.json`. Paths and row hashes
stay in that source-owned manifest. The public receipt contains aggregate counts
and manifest/version/hash identifiers only. It never writes the catalog.

The manifest classifies missing originals, empty originals, missing or empty text,
sidecar claims, source errors, malformed flags, and missing verified enrichment.
Its scope is missing original objects plus the catalog's missing-sidecar and
missing-enrichment exclusion classes. Other valid rows are counted as outside
repair scope and do not consume the manifest entry limit.
Only `restore_sidecar_existence` is an automatic metadata repair candidate. That
action means the exact expected text object exists and is nonempty. It does not
prove that text corresponds to the original, that OCR is correct, or that any
enrichment or identity is verified. All existing hash, enrichment, engine, text
character count and business metadata fields must remain unchanged.

The pure `apply_row` helper changes only the sidecar existence flag for an exact
manifest row hash. It is not a storage transaction or authorization mechanism.
Before applying a reviewed manifest, a source-owned transaction must revalidate
the pinned catalog and every selected original/text metadata tuple, preserve
unrelated raw catalog lines, and use an ETag-conditioned catalog write. A 412 is a
conflict, not permission to retry stale bytes. A timeout after writing requires
reconciliation of the expected output hash before another write. The present
runtime intentionally exposes no apply operation until those transaction receipts
and the actual manifest candidate count are reviewed.

The September 10 census found 373 missing-sidecar claims with nonempty text objects.
That is the upper bound for this existence-only repair, not a claim that all 373
meet the additional error, flag-schema and nonzero-original checks. There were 51
empty-text and 660 missing-text rows among the remaining sidecar gaps. All 494
missing-enrichment rows had nonempty text, which cannot authorize an enrichment
claim. An existing `_CATALOG/.enrich-bedrock-batch.json` marker can only identify a
potential saved-result recovery route. Marker presence is not result verification
and this worker never calls a model or resumes a batch job.

Required runtime: one ARM64 Fargate task, 1 vCPU, 2 GiB memory, the fixed 600-second
supervisor plus 30-second kill grace, and an external 900-second stop. The source
catalog is bounded by the existing materializer limits. Inventory stops at 200,000
objects / 201 pages, the manifest at 5,000 entries / 8 MiB. Permissions are an
expiring exact catalog GET/version GET, fixed-prefix ListBucket, and GET/conditional
PUT only beneath this cohort's manifest prefix. No original/text GET, catalog PUT,
provider calls, additional sources, or shared gateway changes are required.

Source currentness is checked throughout. Inventory listing is non-atomic. If the
catalog changes, the worker fails closed; a manifest written just before that
change is not a current repair authorization. Preserve it as historical evidence
and prepare a fresh version-bound plan.
