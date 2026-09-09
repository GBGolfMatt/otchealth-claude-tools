#!/usr/bin/env bash
# Run in the reviewed existing AWS build workflow, never as a source-data worker.
# Existing ECR authentication and Depot project authentication are required.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
revision="$(git rev-parse HEAD)"
component="tools/neptune-trial/catalog-materializer"
test -z "$(git status --porcelain -- "$component")"
[[ "$revision" =~ ^[a-f0-9]{40}$ ]]
tag="900915535335.dkr.ecr.us-east-1.amazonaws.com/doc-indexer:cfo-catalog-${revision}"
receipt_dir="${RUNNER_TEMP:?RUNNER_TEMP must point to the existing workflow artifact directory}/cfo-catalog-${revision}"
mkdir -p "$receipt_dir"
depot build --project p5k0c551zm --platform linux/amd64,linux/arm64 \
  --file "$root/$component/Dockerfile" --provenance=false --sbom=false \
  --label "org.opencontainers.image.revision=$revision" \
  --metadata-file "$receipt_dir/build-metadata.json" \
  --tag "$tag" --push "$root/$component"
image_digest="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["containerimage.digest"])' "$receipt_dir/build-metadata.json")"
[[ "$image_digest" =~ ^sha256:[a-f0-9]{64}$ ]]
docker buildx imagetools inspect "$tag@$image_digest" --raw > "$receipt_dir/manifest.json"
python3 "$root/$component/build-receipt.py" "$revision" "$image_digest" "$receipt_dir"
# Upload receipt.json, receipt.sha256, manifest.json and build-metadata.json with the
# existing workflow's immutable artifact uploader. No RunTask, IAM or schedule step here.
