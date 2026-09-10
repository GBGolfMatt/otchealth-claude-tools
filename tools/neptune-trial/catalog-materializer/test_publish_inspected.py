import hashlib
import importlib.util
import json
import unittest
from datetime import datetime, timezone

SPEC = importlib.util.spec_from_file_location("publish", __file__.replace("test_publish_inspected.py", "publish_inspected.py"))
publish = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publish)
NOW = lambda: datetime(2026, 1, 1, tzinfo=timezone.utc)


class Body:
    def __init__(self, value): self.value, self.closed = value, False
    def iter_chunks(self, chunk_size=65536):
        for i in range(0, len(self.value), chunk_size): yield self.value[i:i + chunk_size]
    def close(self): self.closed = True


class Conflict(Exception):
    def __init__(self): self.response = {"Error": {"Code": "PreconditionFailed"}}


class S3:
    def __init__(self, version="source-v1"):
        self.version, self.objects, self.head_calls, self.source_gets = version, {}, 0, 0
    def head_object(self, Bucket, Key):
        self.head_calls += 1
        self.assert_source(Bucket, Key)
        return {"VersionId": self.version, "ContentLength": 1, "ETag": "source-etag"}
    def get_object(self, Bucket, Key, **kwargs):
        if Key == publish.SOURCE:
            self.source_gets += 1
            raise AssertionError("publisher must never read source contents")
        row = self.objects[Key]
        return {"VersionId": row["version"], "Body": Body(row["data"])}
    def put_object(self, Bucket, Key, Body, **kwargs):
        if Key in self.objects and kwargs.get("IfNoneMatch") == "*": raise Conflict()
        self.objects[Key] = {"data": Body if isinstance(Body, bytes) else Body.read() if hasattr(Body, "read") else b"".join(Body.iter_chunks()),
                             "version": "v" + str(len(self.objects) + 1)}
    def assert_source(self, Bucket, Key):
        assert Bucket == publish.BUCKET and Key == publish.SOURCE


def binding(data):
    return {"schema":"cfo-catalog-materialization-v1", "cohort_id":"cfo-test", "policy_sha256":"b" * 64,
            "source_prefixes_sha256":"c" * 64, "source_version_id":"source-v1", "source_etag_sha256":"d" * 64,
            "source_catalog_content_sha256":"e" * 64, "source_bytes":1,
            "catalog_content_sha256":hashlib.sha256(data).hexdigest(),
            "catalog_source_sha256":"f" * 64, "catalog_bytes":len(data),
            "counts":{"source_rows":1,"eligible_rows":1,"duplicate_rows":0,"excluded":{}},
            "lineage":"catalog_association_only", "source_current_checked":True}


def event(data):
    core = binding(data)
    core["source_prefixes_sha256"] = hashlib.sha256(publish.encode(["finance/"])).hexdigest()
    receipt = {**core, "status":"inspected", "published":False}
    return {"operation":"publish_inspected", "inspect_receipt":receipt,
            "inspect_receipt_sha256":hashlib.sha256(publish.encode(receipt)).hexdigest()}


def auth():
    return [{"cohort_id":"cfo-test", "policy_sha256":"b" * 64, "source_prefixes":["finance/"],
             "source_version_id":"source-v1", "allow_publish":True, "expires_at":"2099-01-01T00:00:00Z"}]


class PublishInspectedTests(unittest.TestCase):
    def test_publishes_only_receipt_derived_immutable_keys_without_source_get(self):
        data = b'{"path":"finance/a.json"}\n'; s3 = S3()
        result = publish.publish_inspected(event(data), s3, lambda: Body(data), auth(), NOW)
        expected_binding = publish.digest(publish.encode(publish.binding_from_inspect(event(data)["inspect_receipt"])))
        self.assertEqual(result["catalog_key"], f"{publish.DEST}cfo-test/{expected_binding}/{hashlib.sha256(data).hexdigest()}.jsonl")
        self.assertEqual(result["receipt_key"], result["catalog_key"].replace(".jsonl", ".receipt.json"))
        self.assertEqual(s3.source_gets, 0)
        self.assertEqual(s3.head_calls, 3)

    def test_rejects_tampered_receipt_stale_source_and_mismatched_local_catalog_before_put(self):
        data = b'catalog\n'
        changed = event(data); changed["inspect_receipt"]["cohort_id"] = "other"
        with self.assertRaisesRegex(publish.Refused, "inspect_receipt_hash_mismatch"):
            publish.publish_inspected(changed, S3(), lambda: Body(data), auth(), NOW)
        with self.assertRaisesRegex(publish.Refused, "source_not_current"):
            publish.publish_inspected(event(data), S3("source-v2"), lambda: Body(data), auth(), NOW)
        s3 = S3()
        with self.assertRaisesRegex(publish.Refused, "publication_input_mismatch"):
            publish.publish_inspected(event(data), s3, lambda: Body(b"other\n"), auth(), NOW)
        self.assertEqual(s3.objects, {})

    def test_retry_is_idempotent_and_authority_remains_fresh(self):
        data = b'catalog\n'; s3 = S3(); first = publish.publish_inspected(event(data), s3, lambda: Body(data), auth(), NOW)
        second = publish.publish_inspected(event(data), s3, lambda: Body(data), auth(), NOW)
        self.assertEqual(first["catalog_key"], second["catalog_key"])
        denied = [{**auth()[0], "allow_publish":False}]
        with self.assertRaisesRegex(publish.Refused, "authority_invalid"):
            publish.publish_inspected(event(data), s3, lambda: Body(data), denied, NOW)


if __name__ == "__main__": unittest.main()
