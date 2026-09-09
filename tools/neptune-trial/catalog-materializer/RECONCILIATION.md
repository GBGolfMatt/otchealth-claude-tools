# Source metadata reconciliation

The opt-in inventory census runs only inside the authorized source runtime. It joins
exact valid original-relative catalog paths to current S3 object keys under the fixed
CFO source prefix. Only counters leave that runtime. Inventory listing is non-atomic;
source catalog HEAD is checked before and after the complete operation.

The census distinguishes catalog-only paths, original-only paths, intersections,
duplicate valid catalog rows, invalid paths and reserved pipeline paths. It reports
actual text-object presence separately from catalog sidecar claims. A nonempty text
object does not prove readable OCR, complete text or correct original provenance.
S3 ETags are not source SHA256 values. The source-original hash remains unverified.

Text keys follow the producer convention `_TEXT/<original relative path>.txt` with
exact case. Exclusion presence counters operate on unique paths per reason; one path
can appear in more than one reason when duplicate catalog rows disagree. These
counters must not be added to reproduce row totals.

No original or text object body is fetched. List permission is restricted to the
fixed source prefix. The listing refuses malformed responses, missing continuation
information, repeated cursors, duplicate keys and more than 200,000 objects or 201
pages. Authority is rechecked before every page and after enumeration. The existing
600-second process supervisor and external 900-second stop remain required.

## Repair routing

Current toolkit main source was inspected through GitHub on September 9:

- `skills/doc-indexer/indexer.mjs`, Git blob `91baf5c267de892daac68444e83289a055906fbe`.
  Lines 440-445 show that `--reindex` resets the catalog and `--prefix` narrows the
  object listing. Combining them can replace a whole-room catalog with a subset.
  Existing catalog rows otherwise skip indexing, so missing hashes and sidecar
  claims cannot be safely repaired using a blind repeated index command.
- `skills/doc-indexer/enrich.mjs`, Git blob `ff8396e6b91f22b846b181e165e4183d13291322`.
  Lines 1288-1311 require sidecars and no error before enrichment. `--dry-run`
  applies to the Bedrock batch lane, not every enrichment invocation.

Catalog-only paths require source-owner reconciliation before removal or recovery.
Original-only paths need a reviewed append-preserving index operation. Missing or
empty text objects require source-owned extraction/OCR under a bounded budget.
Missing source hashes require reading the original in that boundary and hashing
the bytes. Enrichment requires matching source hashes, verified text readiness and
the approved model/cost policy. Invalid and internal paths require separate policy
review rather than an automatic retry. No repair may overwrite the immutable
published catalog; repaired source state needs a fresh versioned cohort.

The required targeted repair should preserve unrelated catalog rows, pin the source
version, use conditional writes, record durable retry obligations and emit aggregate
success/failure receipts. It is not implemented by this census. The census does not
resolve entities or turn names, paths or model-derived associations into authority.
