# Radar release acceptance

The radar journal changes and file verifier are prepared source. No image build, task registration, schedule migration or live alert is authorized by running a local test.

Before release, reconcile the paired toolkit shared-writer change with the same base commit. The radar patch must not overwrite that owner's kb-memory files. Review the final combined source and run the radar, Postgres adapter, Docker import coverage and process-restart regressions.

Build only a unique source-commit image tag. Do not publish latest, which is consumed by other jobs. Extract the exact ARM64 digest without starting a container and compare the final commit's files using verify.mjs. File equality is a bounded check, not downstream acceptance or build attestation.

Only after review: register an immutable radar revision preserving all unrelated task fields; update matching guard specification and exact IAM task ARN through the release owner; verify live packages and permissions; take a fresh non-overwriting encrypted schedule backup; migrate only radar with its existing cadence/retry configuration; then verify the next natural run's task revision, completion and claim cleanup.

The journal distinguishes pending work from dispatch attempts whose outcome is uncertain. A fresh process may replay pending work. It must not blindly replay dispatching or ambiguous work, because the downstream inbox writer has no stable idempotency key or authoritative receipt lookup. The sent state confirms only that the dispatch subprocess returned successfully, not that a human or agent received/read the alert. Receiver receipt reconciliation and broader inbox writer concurrency are outside this patch.

Unresolved journal entries are operational failures requiring investigation in the authorized owner lane. Absence from an inbox does not prove a message was never delivered, since a consumer may already have acknowledged it. Do not clear ambiguity or reset it to pending based only on an empty inbox. Before retrying, establish the original outcome or obtain an explicit decision accepting duplicate risk. No journal-resolution mutation is implemented in this patch.

Synthetic subprocess tests terminate a process after durable pending storage, after its dispatch claim, and after a fake inbox accepts the alert. These exercise actual process termination and fresh-process replay with a filesystem journal. They do not establish live RDS durability, all receiver behavior, or achieved AWS savings.
