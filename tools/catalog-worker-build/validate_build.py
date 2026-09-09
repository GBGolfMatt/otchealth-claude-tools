#!/usr/bin/env python3
"""Bind the vendored CTO source receipt to an immutable catalog-worker build receipt."""
import argparse
import hashlib
import json
import re
from pathlib import Path, PurePosixPath

HEX40 = re.compile(r"^[a-f0-9]{40}$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
IMAGE = re.compile(r"^900915535335\.dkr\.ecr\.us-east-1\.amazonaws\.com/doc-indexer@(sha256:[a-f0-9]{64})$")
PLATFORMS = {"linux/amd64", "linux/arm64"}
CRITICAL_SOURCE_FILES = {
    "materialize.py", "worker.py", "supervisor.py", "Dockerfile", ".dockerignore",
    "requirements.lock", "test_materialize.py", "test_supervisor.py", "image-inputs.json",
    "inventory_census.py", "test_inventory_census.py", "coverage_report.py",
    "test_coverage_report.py", "test_inventory_integration.py",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_json(path):
    raw = Path(path).read_bytes()
    require(len(raw) <= 1_000_000, "receipt too large")
    value = json.loads(raw)
    require(isinstance(value, dict), "receipt must be an object")
    return value, raw


def commit(value, name):
    require(isinstance(value, str) and HEX40.fullmatch(value), f"invalid {name}")
    return value


def hash_value(value, name):
    require(isinstance(value, str) and SHA256.fullmatch(value), f"invalid {name}")
    return value


def origin_files(value):
    require(isinstance(value, list) and value, "missing origin files")
    result = {}
    for entry in value:
        require(isinstance(entry, dict), "invalid origin file")
        path = entry.get("path")
        pure = PurePosixPath(path) if isinstance(path, str) else None
        require(pure and path and not pure.is_absolute() and ".." not in pure.parts and "\\" not in path and ":" not in path and path not in result,
                "unsafe origin file path")
        require(isinstance(entry.get("size"), int) and entry["size"] >= 0, "invalid origin file size")
        result[path] = hash_value(entry.get("sha256"), "origin file hash")
    return result


def source_file_hashes(value, expected):
    require(isinstance(value, dict) and set(value) == CRITICAL_SOURCE_FILES, "unexpected critical source file set")
    for path, digest in value.items():
        pure = PurePosixPath(path) if isinstance(path, str) else None
        require(pure and path and not pure.is_absolute() and ".." not in pure.parts and "\\" not in path and ":" not in path,
                "unsafe source file path")
        require(hash_value(digest, "source file hash") == expected.get(path), "worker source hash differs from origin manifest")


def validate(source_origin, source_origin_sha256, build_receipt, receipt_sha256, expected_source_commit, expected_toolkit_commit):
    expected_source_commit = commit(expected_source_commit, "expected CTO source commit")
    expected_toolkit_commit = commit(expected_toolkit_commit, "expected toolkit commit")
    require(source_origin.get("origin_repository") == "InnerScopeHearing/otchealth-cto", "unexpected origin repository")
    require(source_origin.get("component_path") == "tools/neptune-trial/catalog-materializer", "unexpected component path")
    cto_commit = commit(source_origin.get("source_commit"), "CTO source commit")
    require(cto_commit == expected_source_commit, "CTO source commit differs from caller input")
    toolkit_commit = commit(source_origin.get("toolkit_build_commit"), "toolkit build commit")
    require(toolkit_commit == expected_toolkit_commit, "toolkit build commit differs from caller input")
    require(build_receipt.get("schema") == "cfo-catalog-worker-build-v1", "unexpected build receipt schema")
    require(commit(build_receipt.get("source_commit"), "build receipt source commit") == toolkit_commit,
            "toolkit build commit differs from build receipt source commit")
    image = build_receipt.get("image")
    image_match = IMAGE.fullmatch(image) if isinstance(image, str) else None
    require(image_match is not None, "image must be immutable doc-indexer digest")
    manifests = build_receipt.get("platform_manifests")
    require(isinstance(manifests, dict) and set(manifests) == PLATFORMS, "wrong build platforms")
    for platform, digest in manifests.items():
        require(platform in PLATFORMS, "unexpected platform")
        require(isinstance(digest, str) and re.fullmatch(r"sha256:[a-f0-9]{64}", digest), "invalid platform digest")
    require(build_receipt.get("built_image_manifest_verified") is True, "manifest was not verified")
    require(build_receipt.get("source_run_executed") is False, "receipt claims source execution")
    hash_value(build_receipt.get("build_metadata_sha256"), "build metadata hash")
    source_file_hashes(build_receipt.get("source_files_sha256"), origin_files(source_origin.get("files")))
    hash_value(receipt_sha256, "build receipt checksum")
    return {
        "schema": "cfo-catalog-worker-release-binding-v1",
        "origin_repository": source_origin["origin_repository"],
        "component_path": source_origin["component_path"],
        "cto_source_commit": cto_commit,
        "toolkit_build_commit": toolkit_commit,
        "image": image,
        "platform_manifests": manifests,
        "source_origin_sha256": source_origin_sha256,
        "build_receipt_sha256": receipt_sha256,
        "source_run_executed": False,
    }


def validate_artifacts(directory, build_receipt):
    manifest_raw = (directory / "manifest.json").read_bytes()
    metadata_raw = (directory / "build-metadata.json").read_bytes()
    require(len(manifest_raw) <= 65536 and len(metadata_raw) <= 65536, "build artifact too large")
    image_digest = IMAGE.fullmatch(build_receipt["image"]).group(1)
    digest = lambda data: hashlib.sha256(data).hexdigest()
    require(any("sha256:" + digest(candidate) == image_digest for candidate in (manifest_raw, manifest_raw.removesuffix(b"\n"))),
            "manifest bytes do not match image digest")
    manifest = json.loads(manifest_raw)
    rows = manifest.get("manifests")
    require(isinstance(rows, list) and len(rows) == 2, "unexpected manifest list")
    platforms = {f"{row['platform']['os']}/{row['platform']['architecture']}": row["digest"] for row in rows}
    require(platforms == build_receipt["platform_manifests"], "manifest platforms differ from receipt")
    require(json.loads(metadata_raw).get("containerimage.digest") == image_digest, "build metadata digest differs from receipt")
    require(digest(metadata_raw) == build_receipt["build_metadata_sha256"], "build metadata hash differs from receipt")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True)
    parser.add_argument("--expected-source-commit", required=True)
    parser.add_argument("--expected-toolkit-commit", required=True)
    args = parser.parse_args()
    directory = Path(args.directory)
    origin, origin_raw = read_json(directory / "source-origin.json")
    build, build_raw = read_json(directory / "receipt.json")
    checksum_raw = (directory / "receipt.sha256").read_text("ascii")
    require(re.fullmatch(r"[a-f0-9]{64}\n", checksum_raw) is not None, "invalid build receipt checksum file")
    actual_checksum = hashlib.sha256(build_raw).hexdigest()
    require(checksum_raw.rstrip("\n") == actual_checksum, "build receipt checksum mismatch")
    validate_artifacts(directory, build)
    binding = validate(origin, hashlib.sha256(origin_raw).hexdigest(), build, actual_checksum,
                       args.expected_source_commit, args.expected_toolkit_commit)
    output = directory / "final-receipt.json"
    with output.open("x", encoding="utf-8") as stream:
        json.dump(binding, stream, sort_keys=True, separators=(",", ":"))
        stream.write("\n")


if __name__ == "__main__":
    try:
        main()
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as error:
        print(f"catalog_build_receipt_invalid: {error}", flush=True)
        raise SystemExit(1)
