# Catalog worker source bundle verifier

Export locally with `python tools/catalog-worker-build/export_manifest.py --source-repo PATH --source-commit COMMIT --output tools/catalog-worker-build/origin.json`.

The workflow verifies with `python tools/catalog-worker-build/verify.py --expected-source-commit COMMIT --receipt PATH`. It checks `tools/neptune-trial/catalog-materializer` against the reviewed manifest, rejects links and extra files, and records the CTO source commit separately from the toolkit build commit. This is a reviewed vendored-origin binding, not an independent cryptographic attestation from GitHub.

The component contains exact Git blob bytes from CTO commit `0bf97add6ed0263b954b1320e56e6b0c6ab2ca4f`. Change it only by importing a newly reviewed CTO commit and regenerating the manifest, never by independently editing the copied implementation.

`build-catalog-worker-ecr.yml` is manual only and runs on trusted toolkit main. Both inputs are explicit commits; the toolkit commit must already be an ancestor of the checked-out main. It uses the existing doc-indexer ECR push role, existing Depot project and `DEPOT_TOKEN`, with no cross-repository credential assumption. Live role trust was verified as toolkit main only. Depot secret presence is checked without printing its value when the workflow runs.

The worker build script uses `cfo-catalog-<toolkit commit>`, never `latest`, and verifies both Linux architecture manifests. `validate_build.py` binds the registry manifest, build metadata, source hashes, CTO commit and toolkit commit into `final-receipt.json`. GitHub stores the receipt bundle under a unique run/attempt artifact name. No IAM, ECS, schedule or source-data action is part of this workflow. A successful image build still requires actual image verification and separately authorized bounded source inspection.
