"""Verify manifest digest/platforms and record public build inputs, never runtime data."""
import hashlib
import json
import pathlib
import re
import sys


def main():
    revision, image_digest, directory = sys.argv[1:]
    assert re.fullmatch(r"[a-f0-9]{40}", revision)
    assert re.fullmatch(r"sha256:[a-f0-9]{64}", image_digest)
    output = pathlib.Path(directory)
    raw = (output / "manifest.json").read_bytes()
    assert len(raw) <= 65536
    # Docker inspect may append a single newline to exact registry bytes.
    digest = lambda b: hashlib.sha256(b).hexdigest()
    assert any("sha256:" + digest(candidate) == image_digest for candidate in (raw, raw.removesuffix(b"\n")))
    manifest = json.loads(raw)
    platforms = {f"{m['platform']['os']}/{m['platform']['architecture']}": m["digest"]
                 for m in manifest["manifests"]}
    assert set(platforms) == {"linux/amd64", "linux/arm64"} and len(manifest["manifests"]) == 2
    assert all(re.fullmatch(r"sha256:[a-f0-9]{64}", v) for v in platforms.values())
    metadata_raw = (output / "build-metadata.json").read_bytes()
    assert len(metadata_raw) <= 65536 and json.loads(metadata_raw)["containerimage.digest"] == image_digest
    source = pathlib.Path(__file__).parent
    files = ["materialize.py", "inventory_census.py", "coverage_report.py", "worker.py", "supervisor.py", "Dockerfile", ".dockerignore", "requirements.lock", "test_materialize.py", "test_inventory_census.py", "test_inventory_integration.py", "test_coverage_report.py", "test_supervisor.py", "image-inputs.json"]
    receipt = {"schema": "cfo-catalog-worker-build-v1", "source_commit": revision,
               "image": "900915535335.dkr.ecr.us-east-1.amazonaws.com/doc-indexer@" + image_digest,
               "platform_manifests": platforms,
               "build_metadata_sha256": digest(metadata_raw),
               "source_files_sha256": {p: digest((source / p).read_bytes()) for p in files},
               "built_image_manifest_verified": True, "source_run_executed": False}
    body = json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode()
    with (output / "receipt.json").open("xb") as stream:
        stream.write(body)
    with (output / "receipt.sha256").open("x", encoding="ascii") as stream:
        stream.write(digest(body) + "\n")
    print(json.dumps({"build_receipt_sha256": digest(body), "image_digest": image_digest}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("build_receipt_invalid", file=sys.stderr)
        sys.exit(1)
