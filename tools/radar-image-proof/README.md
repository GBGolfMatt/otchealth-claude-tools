# Radar source and image verification preparation

This helper compares immutable Git blobs with tracked files copied from a stopped ARM64 doc-indexer container. It never starts radar or any image entrypoint. Its receipt contains paths and hashes only.

It covers all tracked files under signal-radar, kb-memory, fleet-dispatch and setup, including newly added radar delivery modules and the shared writer version. This is bounded source/file equality, not a cryptographic build attestation or complete detector dependency closure.

Before a future build, the release owner must reconcile the toolkit base with the shared-feed writer changes. The existing build-doc-indexer-ecr workflow defaults to latest; do not dispatch that default for this repair. Use an explicit unique source-commit tag, resolve the ARM64 manifest digest, then run the helper on a Docker-capable host with ECR read authentication:

```text
node tools/radar-image-proof/verify.mjs <checkout> <40-character-source-commit> <sha256:ARM64-manifest-digest> <receipt-path>
```

No build, image publication, task registration or schedule change is performed by this helper. Registration and guard migration remain separate reviewed steps. A passing comparison does not demonstrate downstream alert delivery or natural-run acceptance. Mutable tags and wrong-platform images are rejected.
