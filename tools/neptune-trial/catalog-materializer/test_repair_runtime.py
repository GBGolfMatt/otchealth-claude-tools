import hashlib
import json
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import repair_runtime as runtime
from materialize import BUCKET, SOURCE
from inventory_census import PREFIX

NOW = lambda: datetime(2026, 1, 1, tzinfo=timezone.utc)


class Body:
    def __init__(self, data):
        self.data = data
        self.closed = False

    def iter_chunks(self, chunk_size=65536):
        for offset in range(0, len(self.data), chunk_size):
            yield self.data[offset:offset + chunk_size]

    def close(self):
        self.closed = True


class Conflict(Exception):
    def __init__(self):
        self.response = {"Error": {"Code": "PreconditionFailed"}}


class FakeS3:
    """Only admits the pinned catalog, inventory listing, and repair manifests."""
    def __init__(self, catalog, pages=None):
        self.catalog = catalog
        self.version = "source-v1"
        self.etag = "catalog-etag"
        self.head_versions = []
        self.pages = pages or [self.inventory_page()]
        self.manifests = {}
        self.gets = []
        self.puts = []
        self.lists = []
        self.collision_payload = None

    def inventory_page(self):
        path = "finance/record.json"
        return {"Contents": [
            {"Key": PREFIX + path, "Size": 4, "ETag": "orig", "LastModified": "2026-01-01T00:00:00Z"},
            {"Key": PREFIX + "_TEXT/" + path + ".txt", "Size": 5, "ETag": "text", "LastModified": "2026-01-01T00:00:00Z"},
        ], "KeyCount": 2, "IsTruncated": False, "NextContinuationToken": None}

    def head_object(self, **kwargs):
        self.assert_catalog(kwargs)
        version = self.head_versions.pop(0) if self.head_versions else self.version
        return {"VersionId": version, "ETag": self.etag, "ContentLength": len(self.catalog)}

    def get_object(self, **kwargs):
        key = kwargs.get("Key")
        self.gets.append(dict(kwargs))
        if key == SOURCE:
            self.assert_catalog(kwargs)
            if kwargs.get("VersionId") != self.version:
                raise AssertionError("catalog read was not version pinned")
            return {"VersionId": self.version, "ETag": self.etag,
                    "ContentLength": len(self.catalog), "Body": Body(self.catalog)}
        if isinstance(key, str) and key.startswith(runtime.DEST):
            if set(kwargs) != {"Bucket", "Key"} or kwargs["Bucket"] != BUCKET:
                raise AssertionError("manifest read has unexpected request shape")
            data = self.manifests[key]
            return {"VersionId": "manifest-v1", "ContentLength": len(data), "Body": Body(data)}
        raise AssertionError("original/text or unapproved object GET")

    def put_object(self, **kwargs):
        self.puts.append(dict(kwargs))
        key = kwargs.get("Key")
        if (kwargs.get("Bucket") != BUCKET or not isinstance(key, str) or not key.startswith(runtime.DEST)
                or kwargs.get("IfNoneMatch") != "*" or kwargs.get("ContentType") != "application/json"):
            raise AssertionError("non-immutable or non-manifest PUT")
        if self.collision_payload is not None:
            self.manifests[key] = self.collision_payload
            raise Conflict()
        if key in self.manifests:
            raise Conflict()
        self.manifests[key] = kwargs["Body"]
        return {"VersionId": "manifest-v1"}

    def list_objects_v2(self, **kwargs):
        self.lists.append(dict(kwargs))
        if kwargs.get("Bucket") != BUCKET or kwargs.get("Prefix") != PREFIX or kwargs.get("MaxKeys") != 1000:
            raise AssertionError("inventory listing escaped fixed scope")
        index = 0 if "ContinuationToken" not in kwargs else int(kwargs["ContinuationToken"])
        return self.pages[index]

    @staticmethod
    def assert_catalog(kwargs):
        if kwargs.get("Bucket") != BUCKET or kwargs.get("Key") != SOURCE:
            raise AssertionError("catalog operation escaped fixed source")


def catalog_line(**changes):
    row = {"path": "finance/record.json", "sha256": "a" * 64,
           "sidecar": False, "enriched": False}
    row.update(changes)
    return json.dumps(row, separators=(",", ":")).encode() + b"\n"


def request(data):
    return {"operation": "plan", "source_version_id": "source-v1",
            "source_sha256": hashlib.sha256(data).hexdigest(), "cohort_id": "repair-test",
            "policy_sha256": "b" * 64}


def approvals(req):
    return [{**req, "expires_at": "2099-01-01T00:00:00Z", "allow_manifest_write": True}]


class RepairRuntimeTests(unittest.TestCase):
    def invoke(self, source, s3=None, approval_value=None):
        req = request(source)
        return runtime.run(req, s3 or FakeS3(source),
                           approvals(req) if approval_value is None else approval_value, NOW)

    def test_pinned_catalog_and_metadata_only_manifest_idempotency(self):
        source, s3 = catalog_line(), FakeS3(catalog_line())
        first = self.invoke(source, s3)
        second = self.invoke(source, s3)
        self.assertEqual(first["status"], "inspected")
        self.assertEqual(second["status"], "inspected")
        self.assertEqual(first["manifest_key"], second["manifest_key"])
        self.assertEqual(first["manifest_sha256"], second["manifest_sha256"])
        self.assertEqual(len(s3.manifests), 1)
        self.assertEqual(len(s3.puts), 2)
        self.assertTrue(all(call["Key"] == SOURCE and call.get("VersionId") == "source-v1"
                            for call in s3.gets if call["Key"] == SOURCE))
        self.assertTrue(all(call["Key"] == SOURCE or call["Key"].startswith(runtime.DEST) for call in s3.gets))
        self.assertTrue(first["catalog_write_performed"] is False and first["published"] is False)

    def test_authority_mismatch_refuses_before_any_s3_call(self):
        source, s3, req = catalog_line(), FakeS3(catalog_line()), request(catalog_line())
        bad = approvals(req)
        bad[0]["policy_sha256"] = "c" * 64
        result = runtime.run(req, s3, bad, NOW)
        self.assertEqual((result["status"], result["code"]), ("refused", "repair_authority_mismatch"))
        self.assertFalse(s3.gets or s3.puts or s3.lists)

    def test_current_version_change_refuses_before_manifest_put(self):
        source, s3 = catalog_line(), FakeS3(catalog_line())
        s3.head_versions = ["source-v1", "source-v1", "source-v1", "source-v2"]
        result = self.invoke(source, s3)
        self.assertEqual((result["status"], result["code"]), ("refused", "source_not_current"))
        self.assertFalse(s3.puts)

    def test_incomplete_or_repeated_inventory_tokens_refuse_without_manifest(self):
        source = catalog_line()
        for page in (
            {"Contents": [], "KeyCount": 0, "IsTruncated": True, "NextContinuationToken": None},
            {"Contents": [], "KeyCount": 0, "IsTruncated": True, "NextContinuationToken": "0"},
        ):
            s3 = FakeS3(source, [page])
            result = self.invoke(source, s3)
            self.assertEqual((result["status"], result["code"]), ("refused", "repair_inventory_invalid"))
            self.assertFalse(s3.puts)

    def test_source_hash_mismatch_refuses_before_inventory_or_manifest(self):
        source, s3 = catalog_line(), FakeS3(catalog_line())
        req = request(source)
        req["source_sha256"] = "0" * 64
        result = runtime.run(req, s3, approvals(req), NOW)
        self.assertEqual((result["status"], result["code"]), ("refused", "repair_source_hash_mismatch"))
        self.assertFalse(s3.lists or s3.puts)

    def test_manifest_collision_with_different_bytes_refuses(self):
        source, s3 = catalog_line(), FakeS3(catalog_line())
        s3.collision_payload = b'{"not":"the-plan"}'
        result = self.invoke(source, s3)
        self.assertEqual((result["status"], result["code"]), ("refused", "repair_manifest_conflict"))
        self.assertTrue(result["manifest_write_possible"])

    def test_duplicate_json_keys_refuse_without_manifest(self):
        source = b'{"path":"finance/record.json","path":"finance/other.json"}\n'
        s3 = FakeS3(source)
        result = self.invoke(source, s3)
        self.assertEqual((result["status"], result["code"]), ("refused", "duplicate_json_key"))
        self.assertFalse(s3.puts)


if __name__ == "__main__":
    unittest.main()
