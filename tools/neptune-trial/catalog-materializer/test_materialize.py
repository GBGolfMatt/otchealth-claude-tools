import hashlib
import importlib.util
import json
import unittest
from datetime import datetime, timezone


SPEC = importlib.util.spec_from_file_location("materialize", __file__.replace("test_materialize.py", "materialize.py"))
materialize = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(materialize)
AUTHORIZATIONS = [{"cohort_id": "cfo-test", "policy_sha256": "b" * 64, "source_prefixes": ["finance/"],
                   "source_version_id": "source-v1", "allow_publish": True, "expires_at": "2099-01-01T00:00:00Z"}]
FULL_SCOPE_AUTHORIZATIONS = [{"cohort_id": "cfo-test", "policy_sha256": "b" * 64, "source_prefixes": [],
                              "source_version_id": "source-v1", "source_scope": "all_cfo_source_documents",
                              "allow_publish": True, "expires_at": "2099-01-01T00:00:00Z"}]
NOW = lambda: datetime(2026, 1, 1, tzinfo=timezone.utc)


def invoke(request, s3, authorizations=AUTHORIZATIONS):
    return materialize.materialize(request, s3, authorizations, NOW)


class Body:
    def __init__(self, data, chunks=None):
        self.data = data
        self.chunks = chunks
        self.closed = False

    def iter_chunks(self, chunk_size=65536):
        if self.chunks is not None:
            yield from self.chunks
            return
        for offset in range(0, len(self.data), chunk_size):
            yield self.data[offset:offset + chunk_size]

    def close(self):
        self.closed = True


class Conflict(Exception):
    def __init__(self, code="PreconditionFailed"):
        self.response = {"Error": {"Code": code}}


class FakeS3:
    def __init__(self, data, version="source-v1", etag="source-etag"):
        self.data, self.version, self.etag = data, version, etag
        self.objects, self.puts = {}, []
        self.get_version = version
        self.get_etag = etag
        self.get_length = len(data)
        self.head_length = len(data)
        self.head_versions = []
        self.body_chunks = None
        self.head_calls = 0
        self.fail_published_read = False

    def head_object(self, Bucket, Key):
        assert Bucket == materialize.BUCKET and Key == materialize.SOURCE
        self.head_calls += 1
        version = self.head_versions.pop(0) if self.head_versions else self.version
        return {"VersionId": version, "ContentLength": self.head_length, "ETag": self.etag}

    def get_object(self, Bucket, Key, **kwargs):
        assert Bucket == materialize.BUCKET
        if Key == materialize.SOURCE:
            return {"VersionId": self.get_version, "ETag": self.get_etag,
                    "ContentLength": self.get_length, "Body": Body(self.data, self.body_chunks)}
        if self.fail_published_read:
            raise RuntimeError("synthetic read interruption")
        record = self.objects[Key]
        return {"VersionId": record["version"], "ETag": "published-etag", "ContentLength": len(record["data"]),
                "Body": Body(record["data"])}

    def put_object(self, **kwargs):
        self.puts.append(kwargs)
        key = kwargs["Key"]
        if key in self.objects and kwargs.get("IfNoneMatch") == "*":
            raise Conflict()
        payload = kwargs["Body"]
        data = payload.read() if hasattr(payload, "read") else payload
        self.objects[key] = {"data": data, "version": f"published-v{len(self.objects) + 1}"}


def row(path="finance/ledger.json", **changes):
    value = {"path": path, "sha256": "a" * 64, "sidecar": True, "enriched": True,
             "enriched_sha256": "a" * 64, "err": None, "entity": "synthetic",
             "untrusted_extra": "must_not_publish"}
    value.update(changes)
    return value


def raw(*rows):
    return b"\n".join(json.dumps(value, separators=(",", ":")).encode() for value in rows) + b"\n"


def event(operation="inspect", **changes):
    value = {"operation": operation, "source_version_id": "source-v1", "cohort_id": "cfo-test",
             "policy_sha256": "b" * 64, "source_prefixes": ["finance/"]}
    value.update(changes)
    return value


class MaterializeTests(unittest.TestCase):
    def test_structured_field_census_counts_raw_and_unique_eligible_without_values(self):
        identified = row(source_record_id="private-record", organization_id="private-org",
                         source_system="private-system", tenant_id="private-tenant")
        excluded = row("finance/excluded.json", sidecar=False, invoice_id="private-invoice")
        data = raw(identified, identified, excluded)
        source = FakeS3(data)
        result = invoke(event(), source)
        census = result["identity_field_census"]
        self.assertEqual(census["raw_catalog"]["rows"], 3)
        self.assertEqual(census["eligible_unique_rows"]["rows"], 1)
        self.assertEqual(census["raw_catalog"]["scoped_field_combinations"]["organization"], 2)
        self.assertEqual(census["eligible_unique_rows"]["scoped_field_combinations"]["organization"], 1)
        self.assertEqual(census["raw_catalog"]["fields_present"]["invoice_id"], 1)
        self.assertEqual(census["raw_catalog"]["scoped_field_combinations"]["invoice"], 0)
        self.assertFalse(census["authority_verified"])
        self.assertNotIn("private-", json.dumps(result))
        self.assertEqual(source.puts, [])

    def test_identity_census_does_not_change_published_binding_or_project_ids(self):
        result = invoke(event("publish"), FakeS3(raw(row(organization_id="private-id"))))
        self.assertNotIn("identity_field_census", result)
        self.assertNotIn("private-id", json.dumps(result))

    def test_inspect_never_writes_and_projects_only_allowed_fields(self):
        data = raw(row(doc_date="2026-01-01T00:00:00.000Z", entities=["Synthetic"]))
        s3 = FakeS3(data)
        result = invoke(event(), s3)
        self.assertEqual(result["status"], "inspected")
        self.assertFalse(result["published"])
        self.assertEqual(s3.puts, [])
        self.assertEqual(result["source_catalog_content_sha256"], hashlib.sha256(data).hexdigest())
        self.assertEqual(result["counts"]["eligible_rows"], 1)

    def test_publish_exact_bytes_is_idempotent_after_conditional_conflict_and_verified(self):
        data = raw(row(doc_date="2026-01-01T00:00:00.000Z", named_entities_people=["Synthetic Person"]))
        s3 = FakeS3(data)
        first = invoke(event("publish"), s3)
        second = invoke(event("publish"), s3)
        self.assertTrue(first["published"] and second["published"])
        self.assertEqual(first["catalog_key"], second["catalog_key"])
        self.assertEqual(first["catalog_content_sha256"], second["catalog_content_sha256"])
        self.assertEqual(len(s3.puts), 4)
        published = s3.objects[first["catalog_key"]]["data"]
        self.assertEqual(hashlib.sha256(published).hexdigest(), first["catalog_content_sha256"])
        selected = json.loads(published)
        self.assertEqual(set(selected), {"path", "sha256", "sidecar", "enriched", "enriched_sha256", "err", "doc_date", "entity", "named_entities_people"})
        self.assertNotIn("untrusted_extra", selected)
        self.assertEqual(selected["sha256"], "a" * 64)
        receipt = json.loads(s3.objects[first["receipt_key"]]["data"])
        self.assertEqual(receipt["catalog_key"], first["catalog_key"])
        self.assertEqual(hashlib.sha256(s3.objects[first["receipt_key"]]["data"]).hexdigest(), first["receipt_sha256"])

    def test_missing_or_bad_enrichment_is_excluded_without_fabrication(self):
        data = raw(row("finance/good.json"), row("finance/missing.json", enriched_sha256=None),
                   row("finance/bad.json", enriched_sha256="c" * 64), row("finance/no.json", enriched=False),
                   row("finance/zero.json", sha256="0" * 64, enriched_sha256="0" * 64),
                   row("finance/schema.json", entities="not-a-list"), row("finance/date.json", doc_date="2026-01-01"))
        result = invoke(event(), FakeS3(data))
        self.assertEqual(result["counts"]["eligible_rows"], 1)
        self.assertEqual(result["counts"]["excluded"], {"missing_matching_enrichment_hash": 2, "missing_enrichment_claim": 1,
                                                           "missing_source_hash": 1, "invalid_metadata_schema": 2})

    def test_duplicate_identity_is_idempotent_but_conflicting_projection_refuses(self):
        same = row("finance/one.json", doc_date="2026-01-01T00:00:00.000Z")
        result = invoke(event(), FakeS3(raw(same, same)))
        self.assertEqual(result["counts"]["eligible_rows"], 1)
        self.assertEqual(result["counts"]["duplicate_rows"], 1)
        changed = row("finance/one.json", doc_date="2026-01-02T00:00:00.000Z")
        with self.assertRaisesRegex(materialize.Refused, "source_duplicate_conflict"):
            invoke(event(), FakeS3(raw(same, changed)))

    def test_source_version_and_pin_changes_refuse(self):
        data = raw(row())
        stale = FakeS3(data, version="source-v2")
        with self.assertRaisesRegex(materialize.Refused, "source_not_current"):
            invoke(event(), stale)
        mismatch = FakeS3(data)
        mismatch.get_version = "source-v2"
        with self.assertRaisesRegex(materialize.Refused, "source_pin_mismatch"):
            invoke(event(), mismatch)
        changed_after_read = FakeS3(data)
        changed_after_read.head_versions = ["source-v1", "source-v2"]
        with self.assertRaisesRegex(materialize.Refused, "source_not_current"):
            invoke(event(), changed_after_read)

    def test_malformed_truncated_and_oversize_input_refuse(self):
        malformed = FakeS3(b'{"path":\xff}\n')
        with self.assertRaisesRegex(materialize.Refused, "source_json_invalid"):
            invoke(event(), malformed)
        truncated = FakeS3(raw(row()))
        truncated.head_length = len(truncated.data) + 1
        truncated.get_length = truncated.head_length
        with self.assertRaisesRegex(materialize.Refused, "source_length_changed"):
            invoke(event(), truncated)
        long_line = FakeS3(b"x" * (materialize.MAX_LINE + 1) + b"\n")
        with self.assertRaisesRegex(materialize.Refused, "source_line_limit"):
            invoke(event(), long_line)
        non_object = FakeS3(b"[]\n")
        with self.assertRaisesRegex(materialize.Refused, "source_row_invalid"):
            invoke(event(), non_object)
        oversize_selected = FakeS3(raw(row(entity="x" * 70000)))
        with self.assertRaisesRegex(materialize.Refused, "selected_row_limit"):
            invoke(event(), oversize_selected)

    def test_path_prefix_and_cohort_validation_reject_unsafe_requests(self):
        for bad_path in ("../finance/", "finance/%2e/", "https://example/", "_catalog/private/"):
            with self.assertRaisesRegex(materialize.Refused, "prefix_invalid"):
                invoke(event(source_prefixes=[bad_path]), FakeS3(raw(row())))
        for cohort in ("CFO", "cfo_test", "", "x" * 65):
            with self.assertRaisesRegex(materialize.Refused, "cohort_invalid"):
                invoke(event(cohort_id=cohort), FakeS3(raw(row())))
        result = invoke(event(), FakeS3(raw(row("legal/outside.json"))))
        self.assertEqual(result["status"], "not_ready_no_eligible_rows")
        self.assertEqual(result["counts"]["excluded"], {"outside_cohort": 1})

    def test_authorization_mismatch_expiry_and_missing_authority_refuse_before_reading_s3(self):
        for authorizations, code in ((None, "authority_missing"),
                                     ([{**AUTHORIZATIONS[0], "policy_sha256": "c" * 64}], "authority_mismatch"),
                                     ([{**AUTHORIZATIONS[0], "expires_at": "2020-01-01T00:00:00Z"}], "authority_expired")):
            s3 = FakeS3(raw(row()))
            with self.assertRaisesRegex(materialize.Refused, code):
                invoke(event(), s3, authorizations)
            self.assertEqual(s3.head_calls, 0)

    def test_failure_after_catalog_put_is_publication_unknown_with_reconciliation_tuple(self):
        s3 = FakeS3(raw(row()))
        s3.fail_published_read = True
        with self.assertRaises(materialize.PublicationUnknown) as caught:
            invoke(event("publish"), s3)
        self.assertEqual(str(caught.exception), "publication_unknown")
        self.assertIn("catalog_key", caught.exception.state)
        self.assertIn("catalog_content_sha256", caught.exception.state)
        self.assertIn("binding_sha256", caught.exception.state)
        self.assertEqual(len(s3.puts), 1)

    def test_explicit_full_cfo_scope_includes_root_and_nested_documents_but_excludes_internal_paths(self):
        data = raw(row("root-level.json"), row("finance/nested/child.json"),
                   row("_TEXT/private.json"), row("_CATALOG/internal.json"))
        full_scope = event(source_prefixes=[], source_scope="all_cfo_source_documents")
        result = invoke(full_scope, FakeS3(data), FULL_SCOPE_AUTHORIZATIONS)
        self.assertEqual(result["status"], "inspected")
        self.assertEqual(result["counts"]["eligible_rows"], 2)
        self.assertEqual(result["counts"]["excluded"], {"invalid_path": 2})
        self.assertEqual(result["source_scope"], "all_cfo_source_documents")

    def test_empty_legacy_prefixes_and_full_scope_without_matching_authority_refuse_before_s3_read(self):
        legacy = FakeS3(raw(row()))
        with self.assertRaisesRegex(materialize.Refused, "prefix_invalid"):
            invoke(event(source_prefixes=[]), legacy)
        self.assertEqual(legacy.head_calls, 0)
        unauthorized_full_scope = FakeS3(raw(row()))
        with self.assertRaisesRegex(materialize.Refused, "authority_invalid"):
            invoke(event(source_prefixes=[], source_scope="all_cfo_source_documents"), unauthorized_full_scope)
        self.assertEqual(unauthorized_full_scope.head_calls, 0)


if __name__ == "__main__":
    unittest.main()
