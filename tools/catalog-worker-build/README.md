# Catalog worker source bundle verifier

Export locally with `python tools/catalog-worker-build/export_manifest.py --source-repo PATH --source-commit COMMIT --output tools/catalog-worker-build/origin.json`.

The workflow verifies with `python tools/catalog-worker-build/verify.py --expected-source-commit COMMIT --receipt PATH`. It verifies only `vendor/` against the manifest, rejects links and extra files, and writes source proof separately from the toolkit build commit.
