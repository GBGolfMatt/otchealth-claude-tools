---
name: innd-stock
description: Maintains the internal CFO INND price workbook on AWS S3 and publishes a verified finance-room copy plus searchable text.
---

# INND daily stock-price history

Public market data for internal CFO record keeping. No investor-facing publication.
The per-row Source column distinguishes Massive/Polygon data from Yahoo-derived history.

## Storage and CFO access

The updater stores its canonical workbook at the S3 mirror mapping
`otchealthcfodata/innd-stock/INND-daily-stock-history.xlsx`.

After each update, publish the identical workbook into the existing finance dataroom:
`cfo-source-docs/innd-stock/INND-daily-stock-history.xlsx`.
Its text sidecar is
`cfo-source-docs/_TEXT/innd-stock/INND-daily-stock-history.xlsx.txt`.

All objects stay in the existing finance-legal S3 bucket. Nothing enters commons.
The publication helper reads every object back and compares its SHA256 before
reporting success. The text includes the source workbook SHA256. A failed mirror
write or readback fails the job; retrying repairs incomplete publication.
This is a sequence of verified object writes, not an atomic multi-object transaction.
Search-index refresh remains separate from sidecar creation.

The old CFO copy was frozen while the canonical updater continued running.
Restarting the existing schedule alone cannot repair that path mismatch.

## Sources and limits

Massive/Polygon requests use `adjusted=false`, supplying as-traded OHLCV, VWAP and
trade counts where provided. Yahoo deep history is de-split using the configured
corporate events; its VWAP is a typical-price proxy. Massive wins on overlap.

Source comments document a 2024-06-24 spot check. That is not proof of independent
verification for every older Yahoo-derived row or for 2021-11-23. A valuation using
that date still needs the CFO's primary-source verification. No market-data plan
upgrade or new subscription is authorized by this repair.

The existing updater can fall back to Yahoo when Massive is unavailable. Inspect
per-row source and coverage before using a run for a source-specific valuation.

## Execution

The existing AWS EventBridge schedule `otchealth-innd-stock-daily` runs at
22:30 UTC Monday through Friday and launches the ECS stock job. The script is
baked into the doc-indexer image. Build and deploy a reviewed immutable image to
that job before claiming a source change is live. Do not repoint unrelated jobs.

`node skills/innd-stock/innd-stock.mjs update` appends and refreshes history.
`status` reads the canonical workbook.
`backfill` reconstructs history and should not replace a working workbook casually.
`local <file>` writes locally only.

`STORAGE_BACKEND` must be unset or `s3`. Azure and GCS are retired.
AWS task-role credentials access S3. Massive keys remain in AWS SSM and are injected
by the task definition. Never put credential values in logs, documents or code.
The existing image supplies the xlsx library.

## Acceptance

Verify the deployed image digest, a successful task, its metadata-only publication
receipt, matching source/destination hashes, the newest completed trading date and
the CFO's exact-path document read. Weekends and market holidays are not missing
trading rows. A scheduler firing or source-only write is insufficient.
