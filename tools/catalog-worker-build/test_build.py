import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


HERE = Path(__file__).resolve().parent
VALIDATOR = HERE / "validate_build.py"
CTO = "a" * 40
TOOLKIT = "b" * 40
PLATFORM_DIGESTS = {"linux/amd64": "sha256:" + "d" * 64, "linux/arm64": "sha256:" + "e" * 64}
CRITICAL = {"materialize.py", "worker.py", "supervisor.py", "Dockerfile", ".dockerignore", "requirements.lock", "test_materialize.py", "test_supervisor.py", "image-inputs.json", "inventory_census.py", "test_inventory_census.py", "coverage_report.py", "test_coverage_report.py", "test_inventory_integration.py"}


def write_json(path, value, compact=False):
    path.write_text(json.dumps(value, sort_keys=True, separators=(",", ":") if compact else None), encoding="utf-8")


def receipts(directory):
    manifest = {"manifests": [{"platform": {"os": "linux", "architecture": "amd64"}, "digest": PLATFORM_DIGESTS["linux/amd64"]}, {"platform": {"os": "linux", "architecture": "arm64"}, "digest": PLATFORM_DIGESTS["linux/arm64"]}]}
    manifest_raw = json.dumps(manifest, separators=(",", ":")).encode()
    digest = "sha256:" + hashlib.sha256(manifest_raw).hexdigest()
    metadata_raw = json.dumps({"containerimage.digest": digest}, separators=(",", ":")).encode()
    (directory / "manifest.json").write_bytes(manifest_raw)
    (directory / "build-metadata.json").write_bytes(metadata_raw)
    origin = {
        "origin_repository": "InnerScopeHearing/otchealth-cto",
        "component_path": "tools/neptune-trial/catalog-materializer",
        "source_commit": CTO,
        "toolkit_build_commit": TOOLKIT,
        "files": [{"path": name, "sha256": "f" * 64, "size": 1} for name in sorted(CRITICAL)],
    }
    build = {
        "schema": "cfo-catalog-worker-build-v1", "source_commit": TOOLKIT,
        "image": "900915535335.dkr.ecr.us-east-1.amazonaws.com/doc-indexer@" + digest,
        "platform_manifests": PLATFORM_DIGESTS, "build_metadata_sha256": hashlib.sha256(metadata_raw).hexdigest(),
        "source_files_sha256": {name: "f" * 64 for name in sorted(CRITICAL)},
        "built_image_manifest_verified": True, "source_run_executed": False,
    }
    write_json(directory / "source-origin.json", origin)
    write_json(directory / "receipt.json", build, compact=True)
    raw = (directory / "receipt.json").read_bytes()
    (directory / "receipt.sha256").write_text(hashlib.sha256(raw).hexdigest() + "\n", encoding="ascii")
    return origin, build


def validate(directory):
    return subprocess.run([sys.executable, str(VALIDATOR), "--directory", str(directory),
                           "--expected-source-commit", CTO, "--expected-toolkit-commit", TOOLKIT], text=True, capture_output=True)


class ValidateBuildTests(unittest.TestCase):
    def test_binds_exact_cto_toolkit_and_immutable_image(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw); receipts(directory)
            result = validate(directory)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            binding = json.loads((directory / "final-receipt.json").read_text())
            self.assertEqual(binding["cto_source_commit"], CTO)
            self.assertEqual(binding["toolkit_build_commit"], TOOLKIT)
            self.assertTrue(binding["image"].startswith("900915535335.dkr.ecr.us-east-1.amazonaws.com/doc-indexer@sha256:"))
            self.assertEqual(binding["platform_manifests"], PLATFORM_DIGESTS)

    def test_rejects_tampered_receipt_checksum(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw); receipts(directory)
            (directory / "receipt.sha256").write_text("0" * 64 + "\n", encoding="ascii")
            self.assertNotEqual(validate(directory).returncode, 0)

    def test_rejects_origin_or_toolkit_identity_mismatch(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw); origin, _ = receipts(directory)
            origin["source_commit"] = "9" * 40; write_json(directory / "source-origin.json", origin)
            self.assertNotEqual(validate(directory).returncode, 0)
            receipts(directory)
            build = json.loads((directory / "receipt.json").read_text()); build["source_commit"] = "8" * 40
            write_json(directory / "receipt.json", build, compact=True)
            (directory / "receipt.sha256").write_text(hashlib.sha256((directory / "receipt.json").read_bytes()).hexdigest() + "\n", encoding="ascii")
            self.assertNotEqual(validate(directory).returncode, 0)

    def test_rejects_mutable_or_wrong_platform_image_receipt(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw); _, build = receipts(directory)
            build["image"] = "900915535335.dkr.ecr.us-east-1.amazonaws.com/doc-indexer:latest"
            write_json(directory / "receipt.json", build, compact=True)
            (directory / "receipt.sha256").write_text(hashlib.sha256((directory / "receipt.json").read_bytes()).hexdigest() + "\n", encoding="ascii")
            self.assertNotEqual(validate(directory).returncode, 0)
            receipts(directory)
            build = json.loads((directory / "receipt.json").read_text()); build["platform_manifests"] = {"linux/arm64": PLATFORM_DIGESTS["linux/arm64"]}
            write_json(directory / "receipt.json", build, compact=True)
            (directory / "receipt.sha256").write_text(hashlib.sha256((directory / "receipt.json").read_bytes()).hexdigest() + "\n", encoding="ascii")
            self.assertNotEqual(validate(directory).returncode, 0)

    def test_rejects_worker_source_hash_not_in_origin_manifest(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw); _, build = receipts(directory)
            build["source_files_sha256"]["worker.py"] = "0" * 64
            write_json(directory / "receipt.json", build, compact=True)
            (directory / "receipt.sha256").write_text(hashlib.sha256((directory / "receipt.json").read_bytes()).hexdigest() + "\n", encoding="ascii")
            self.assertNotEqual(validate(directory).returncode, 0)

    def test_rejects_incomplete_or_extended_critical_input_set(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw); _, build = receipts(directory)
            build["source_files_sha256"].pop("inventory_census.py")
            write_json(directory / "receipt.json", build, compact=True)
            (directory / "receipt.sha256").write_text(hashlib.sha256((directory / "receipt.json").read_bytes()).hexdigest() + "\n", encoding="ascii")
            self.assertNotEqual(validate(directory).returncode, 0)

            _, build = receipts(directory)
            build["source_files_sha256"]["unreviewed.py"] = "f" * 64
            write_json(directory / "receipt.json", build, compact=True)
            (directory / "receipt.sha256").write_text(hashlib.sha256((directory / "receipt.json").read_bytes()).hexdigest() + "\n", encoding="ascii")
            self.assertNotEqual(validate(directory).returncode, 0)


class BuildWorkerContractTests(unittest.TestCase):
    def test_build_script_uses_unique_tag_and_emits_receipts_with_fake_clients(self):
        if os.name != "posix":
            self.skipTest("the hermetic shell contract runs on the Linux workflow runner")
        script = Path(os.environ.get("CATALOG_WORKER_BUILD_SCRIPT", "tools/neptune-trial/catalog-materializer/build-worker.sh"))
        if not script.exists():
            self.fail("catalog materializer must be vendored before its build contract can pass")
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw) / "repo"; component = root / "tools/neptune-trial/catalog-materializer"
            shutil.copytree(script.parent, component)
            fakebin = Path(raw) / "bin"; fakebin.mkdir(); runner_temp = Path(raw) / "runner"; runner_temp.mkdir()
            revision = "7" * 40
            (fakebin / "git").write_text("#!/usr/bin/env bash\nset -euo pipefail\ncase \"$*\" in\n  'rev-parse --show-toplevel') echo \"$FAKE_ROOT\" ;;\n  'rev-parse HEAD') echo \"$FAKE_REVISION\" ;;\n  'status --porcelain -- '* ) : ;;\n  *) exit 2 ;;\nesac\n")
            (fakebin / "depot").write_text("#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' \"$@\" > \"$FAKE_DEPOT_ARGS\"\nwhile [[ $# -gt 0 ]]; do [[ \"$1\" == --metadata-file ]] && { printf '{\"containerimage.digest\":\"sha256:%s\"}' \"$FAKE_DIGEST\" > \"$2\"; exit 0; }; shift; done\nexit 1\n")
            (fakebin / "docker").write_text("#!/usr/bin/env bash\nset -euo pipefail\ncat \"$FAKE_MANIFEST\"\n")
            for path in fakebin.iterdir(): path.chmod(0o755)
            manifest = {"manifests": [{"platform": {"os": "linux", "architecture": "amd64"}, "digest": "sha256:" + "3" * 64}, {"platform": {"os": "linux", "architecture": "arm64"}, "digest": "sha256:" + "4" * 64}]}
            manifest_path = Path(raw) / "manifest.json"; manifest_raw = json.dumps(manifest, separators=(",", ":")).encode(); manifest_path.write_bytes(manifest_raw)
            env = {"PATH": str(fakebin) + os.pathsep + os.environ["PATH"], "RUNNER_TEMP": str(runner_temp), "FAKE_ROOT": str(root), "FAKE_REVISION": revision,
                   "FAKE_DEPOT_ARGS": str(Path(raw) / "depot-args.txt"), "FAKE_DIGEST": hashlib.sha256(manifest_raw).hexdigest(), "FAKE_MANIFEST": str(manifest_path)}
            result = subprocess.run(["bash", str(component / "build-worker.sh")], text=True, capture_output=True, env=env)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            receipt_dir = runner_temp / f"cfo-catalog-{revision}"
            self.assertTrue((receipt_dir / "receipt.json").is_file())
            self.assertTrue((receipt_dir / "receipt.sha256").is_file())
            self.assertEqual((receipt_dir / "receipt.json").read_bytes() and json.loads((receipt_dir / "receipt.json").read_text())["source_commit"], revision)
            args = (Path(raw) / "depot-args.txt").read_text()
            self.assertIn(f"cfo-catalog-{revision}", args)
            self.assertNotIn("latest", args)


if __name__ == "__main__":
    unittest.main()
