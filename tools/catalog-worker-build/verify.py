#!/usr/bin/env python3
"""Verify worker bytes against a reviewed manifest exported from CTO Git blobs."""
import argparse, hashlib, json, os, subprocess, sys
from pathlib import Path, PurePosixPath

ORIGIN = "InnerScopeHearing/otchealth-cto"
COMPONENT = "tools/neptune-trial/catalog-materializer"

def safe_path(value):
    p = PurePosixPath(value)
    if not value or any(x in ("", ".", "..") for x in value.split("/")) or p.is_absolute() or "\\" in value or ":" in value: raise ValueError("unsafe path")
    return p

def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""): h.update(chunk)
    return h.hexdigest(), path.stat().st_size

def toolkit_head():
    out = subprocess.run(["git", "rev-parse", "HEAD"], text=True, capture_output=True, check=True).stdout.strip()
    if len(out) != 40 or any(c not in "0123456789abcdef" for c in out): raise ValueError("toolkit HEAD is not a 40-hex commit")
    return out

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--expected-source-commit", required=True)
    p.add_argument("--receipt", required=True)
    p.add_argument("--manifest", default=str(Path(__file__).with_name("origin.json")))
    p.add_argument("--component-dir", default=COMPONENT)
    a = p.parse_args()
    if len(a.expected_source_commit) != 40 or any(c not in "0123456789abcdef" for c in a.expected_source_commit): raise SystemExit("expected source commit must be 40 lowercase hex")
    manifest = json.loads(Path(a.manifest).read_text("utf-8"))
    if manifest.get("origin_repository") != ORIGIN or manifest.get("component_path") != COMPONENT: raise SystemExit("unexpected origin manifest")
    if manifest.get("source_commit") != a.expected_source_commit: raise SystemExit("manifest source commit differs from expected")
    files = manifest.get("files")
    if not isinstance(files, list) or not files: raise SystemExit("manifest has no files")
    expected = {}
    for entry in files:
        try: key = str(safe_path(entry["path"]))
        except (KeyError, ValueError): raise SystemExit("unsafe manifest path")
        if key in expected or not isinstance(entry.get("size"), int) or entry["size"] < 0 or len(entry.get("sha256", "")) != 64 or any(c not in "0123456789abcdef" for c in entry["sha256"]): raise SystemExit("invalid manifest entry")
        expected[key] = entry
    root = Path(os.path.abspath(a.component_dir))
    for ancestor in (root, *root.parents):
        if ancestor.is_symlink() or (hasattr(ancestor, "is_junction") and ancestor.is_junction()): raise SystemExit("symlink or junction found in component path")
    root = root.resolve()
    actual = {}
    for path in root.rglob("*"):
        if path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction()): raise SystemExit("symlink or junction found in vendor component")
        if path.is_file(): actual[path.relative_to(root).as_posix()] = path
    if set(actual) != set(expected): raise SystemExit("vendor files differ from manifest")
    proof = []
    for name in sorted(expected):
        got_hash, got_size = digest(actual[name]); want = expected[name]
        if got_hash != want["sha256"] or got_size != want["size"]: raise SystemExit(f"vendor mismatch: {name}")
        proof.append({"path": name, "sha256": got_hash, "size": got_size})
    receipt = {"origin_repository": ORIGIN, "source_commit": a.expected_source_commit, "component_path": COMPONENT, "toolkit_build_commit": toolkit_head(), "files": proof}
    Path(a.receipt).write_text(json.dumps(receipt, indent=2) + "\n", "utf-8")

if __name__ == "__main__": main()
