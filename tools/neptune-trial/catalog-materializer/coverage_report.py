"""Offline aggregate receipt reconciliation. No source access or acceptance authority."""
import json
import re

from materialize import MAX_BYTES, MAX_ROWS, BUCKET, SOURCE, digest, encode, validate
from inventory_census import validate_report as validate_inventory, InventoryInvalid

SCHEMA = "catalog-census-reconciliation-v1"
EXCLUSIONS = {
    "invalid_path": "invalid_or_internal_path",
    "outside_cohort": "outside_authorized_scope",
    "missing_source_hash": "missing_source_or_enrichment_provenance",
    "missing_sidecar_claim": "missing_sidecar_claim",
    "missing_enrichment_claim": "missing_source_or_enrichment_provenance",
    "missing_matching_enrichment_hash": "missing_source_or_enrichment_provenance",
    "source_error": "source_processing_error",
    "invalid_metadata_schema": "invalid_metadata_schema",
}
SHA = re.compile(r"^[a-f0-9]{64}$")
FAILURES = {
    "source_json_invalid": "parse_failure",
    "source_row_invalid": "row_parse_or_shape_failure",
    "source_line_limit": "bounded_scan_incomplete",
    "source_row_limit": "bounded_scan_incomplete",
    "selected_row_limit": "bounded_scan_incomplete",
    "source_size_invalid": "bounded_scan_incomplete",
    "source_length_changed": "transport_or_snapshot_incomplete",
    "source_not_current": "snapshot_changed",
    "source_pin_mismatch": "source_binding_failure",
    "source_duplicate_conflict": "conflicting_source_versions_or_metadata",
    "authority_missing": "authorization_unavailable",
    "authority_mismatch": "authorization_mismatch",
    "authority_invalid": "authorization_invalid",
    "authority_expired": "authorization_expired",
    "publish_not_authorized": "publication_not_authorized",
    "publication_unknown": "publication_unknown",
    "worker_interrupted": "interrupted_or_untrusted_worker_output",
    "materialization_failed": "unspecified_worker_failure",
}
BASE_RECEIPT = {
    "schema", "cohort_id", "policy_sha256", "source_prefixes_sha256", "source_version_id",
    "source_etag_sha256", "source_catalog_content_sha256", "source_bytes", "catalog_content_sha256",
    "catalog_source_sha256", "catalog_bytes", "counts", "lineage", "source_current_checked",
    "status", "published",
}
PUBLICATION = {"catalog_key", "catalog_version_id", "binding_sha256", "receipt_key", "receipt_sha256", "receipt_version_id"}


class InvalidReport(ValueError):
    pass


def check(condition):
    if not condition:
        raise InvalidReport("aggregate_receipt_invalid")


def integer(value, maximum=MAX_ROWS):
    return type(value) is int and 0 <= value <= maximum


def parse_aggregate(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            check(key not in result)
            result[key] = value
        return result
    def invalid_constant(_):
        raise InvalidReport("aggregate_receipt_invalid")
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)


def empty_source(source_family):
    return {"source_family": source_family, "measurement_status": "not_measured",
            "count_unit": "catalog_rows_not_unique_original_documents", "snapshot": None,
            "catalog_rows": None, "eligible_unique_catalog_paths": None,
            "duplicate_eligible_rows": None, "excluded_rows": None,
            "exclusion_counts": None, "failure_category_counts": None,
            "failure": None, "count_conservation_verified": False,
            "authoritative_original_object_total": None, "unique_original_document_total": None,
            "full_source_scope": None, "coverage_percentage": None,
            "original_lineage_verified": False}


def reconcile_finance(receipt, expected_request):
    result = empty_source("finance")
    if receipt is None:
        check(expected_request is None)
        return result
    check(type(receipt) is dict and type(expected_request) is dict)
    try:
        validate(expected_request)
    except Exception:
        raise InvalidReport("aggregate_receipt_invalid") from None
    # This adapter is intentionally the reviewed fixed finance producer only.
    status = receipt.get("status")
    if status in ("failed", "refused", "publication_unknown"):
        allowed = {"status", "published", "code"}
        check(set(receipt) == allowed or status == "publication_unknown" and set(receipt) == allowed | {"reconciliation"})
        check(receipt.get("published") is (None if status == "publication_unknown" else False))
        check(type(receipt.get("code")) is str)
        if "reconciliation" in receipt:
            pin = receipt["reconciliation"]
            required = {"catalog_key", "catalog_content_sha256", "binding_sha256", "source_version_id"}
            extra = {"receipt_key", "receipt_sha256", "catalog_version_id"}
            check(type(pin) is dict and set(pin) in (required, required | extra))
            check(pin["source_version_id"] == expected_request["source_version_id"])
            for name in ("catalog_content_sha256", "binding_sha256"):
                check(type(pin[name]) is str and SHA.fullmatch(pin[name]))
            key = f"graph-trial/20260909/materialized-cfo/{expected_request['cohort_id']}/{pin['binding_sha256']}/{pin['catalog_content_sha256']}.jsonl"
            check(pin["catalog_key"] == key)
            if extra <= set(pin):
                check(pin["receipt_key"] == key.removesuffix(".jsonl") + ".receipt.json"
                      and type(pin["receipt_sha256"]) is str and SHA.fullmatch(pin["receipt_sha256"])
                      and type(pin["catalog_version_id"]) is str
                      and re.fullmatch(r"[A-Za-z0-9._-]{1,1024}", pin["catalog_version_id"]) and pin["catalog_version_id"] != "null")
        result["measurement_status"] = "unknown_unbound_worker_outcome"
        # Never copy raw failure text or unknown-write payload fields into the report.
        return result
    check(status in ("inspected", "published", "not_ready_no_eligible_rows"))
    check(status != "published" or expected_request["operation"] == "publish")
    check(status != "inspected" or expected_request["operation"] == "inspect")
    fields = BASE_RECEIPT | ({"source_scope"} if "source_scope" in expected_request else set())
    if status == "published":
        fields |= PUBLICATION
    if "identity_field_census" in receipt:
        check(expected_request["operation"] == "inspect")
        fields |= {"identity_field_census"}
    if expected_request.get("reconcile_inventory"):
        fields |= {"inventory_reconciliation"}
    check(set(receipt) == fields)
    check(receipt["schema"] == "cfo-catalog-materialization-v1"
          and receipt["lineage"] == "catalog_association_only" and receipt["source_current_checked"] is True)
    check(receipt["published"] is (status == "published"))
    for field in ("cohort_id", "policy_sha256", "source_version_id", "source_scope"):
        check(receipt.get(field) == expected_request.get(field))
    check(receipt["source_prefixes_sha256"] == digest(encode(sorted(expected_request["source_prefixes"]))))
    expected_logical = digest(encode({"room": "finance", "source_index": "finance-cfo-source-docs",
                                    "url": f"https://{BUCKET}.s3.us-east-1.amazonaws.com/{SOURCE}"}))
    check(receipt["catalog_source_sha256"] == expected_logical)
    for field in ("policy_sha256", "source_prefixes_sha256", "source_etag_sha256", "source_catalog_content_sha256",
                  "catalog_content_sha256", "catalog_source_sha256"):
        check(type(receipt[field]) is str and SHA.fullmatch(receipt[field]))
    check(integer(receipt["source_bytes"], MAX_BYTES) and receipt["source_bytes"] > 0
          and integer(receipt["catalog_bytes"], MAX_BYTES))
    counts = receipt["counts"]
    check(type(counts) is dict and set(counts) == {"source_rows", "eligible_rows", "duplicate_rows", "excluded"})
    check(all(integer(counts[k]) for k in ("source_rows", "eligible_rows", "duplicate_rows")))
    excluded = counts["excluded"]
    check(type(excluded) is dict and set(excluded) <= set(EXCLUSIONS) and all(integer(v) for v in excluded.values()))
    check(counts["source_rows"] == counts["eligible_rows"] + counts["duplicate_rows"] + sum(excluded.values()))
    if expected_request.get("reconcile_inventory"):
        try:
            inventory = validate_inventory(receipt["inventory_reconciliation"], counts)
        except InventoryInvalid:
            raise InvalidReport("aggregate_receipt_invalid") from None
        result["inventory_reconciliation"] = inventory
    if "identity_field_census" in receipt:
        from materialize import IDENTITY_FIELDS, IDENTITY_SCOPES
        census = receipt["identity_field_census"]
        check(type(census) is dict and set(census) == {"schema", "raw_catalog", "eligible_unique_rows", "authority_verified", "scope", "nested_values_inspected", "identity_projection_performed"})
        check(census["schema"] == "structured-identity-field-census-v1" and census["scope"] == "top_level_field_availability_only")
        check(all(census[k] is False for k in ("authority_verified", "nested_values_inspected", "identity_projection_performed")))
        for kind, expected in (("raw_catalog", counts["source_rows"]), ("eligible_unique_rows", counts["eligible_rows"])):
            observed = census[kind]
            check(type(observed) is dict and set(observed) == {"rows", "fields_present", "nonempty_string_fields", "scoped_field_combinations"})
            check(type(observed["rows"]) is int and observed["rows"] == expected)
            for name, allowed in (("fields_present", IDENTITY_FIELDS), ("nonempty_string_fields", IDENTITY_FIELDS), ("scoped_field_combinations", IDENTITY_SCOPES)):
                check(type(observed[name]) is dict and set(observed[name]) == set(allowed))
                check(all(integer(v) and v <= expected for v in observed[name].values()))
            check(all(observed["nonempty_string_fields"][k] <= observed["fields_present"][k] for k in IDENTITY_FIELDS))
            check(all(observed["scoped_field_combinations"][k] <= min(observed["nonempty_string_fields"][f] for f in required) for k, required in IDENTITY_SCOPES.items()))
    check((status == "not_ready_no_eligible_rows") == (counts["eligible_rows"] == 0))
    check((receipt["catalog_bytes"] == 0) == (counts["eligible_rows"] == 0))
    check(counts["eligible_rows"] > 0 or counts["duplicate_rows"] == 0)
    if receipt["catalog_bytes"] == 0:
        check(receipt["catalog_content_sha256"] == digest(b""))
    if receipt.get("source_scope") == "all_cfo_source_documents":
        check(excluded.get("outside_cohort", 0) == 0)
    if status == "published":
        for field in ("binding_sha256", "receipt_sha256"):
            check(type(receipt[field]) is str and SHA.fullmatch(receipt[field]))
        for field in ("catalog_version_id", "receipt_version_id"):
            check(type(receipt[field]) is str and re.fullmatch(r"[A-Za-z0-9._-]{1,1024}", receipt[field])
                  and receipt[field] != "null")
        binding = {k: v for k, v in receipt.items() if k not in PUBLICATION | {"status", "published"}}
        check(receipt["binding_sha256"] == digest(encode(binding)))
        key = f"graph-trial/20260909/materialized-cfo/{receipt['cohort_id']}/{receipt['binding_sha256']}/{receipt['catalog_content_sha256']}.jsonl"
        check(receipt["catalog_key"] == key and receipt["receipt_key"] == key.removesuffix(".jsonl") + ".receipt.json")
        durable = {k: v for k, v in receipt.items() if k not in {"receipt_key", "receipt_sha256", "receipt_version_id"}}
        check(receipt["receipt_sha256"] == digest(encode(durable)))
    categories = {category: 0 for category in set(EXCLUSIONS.values())}
    for key, count in excluded.items():
        categories[EXCLUSIONS[key]] += count
    result.update({"measurement_status": "complete_catalog_snapshot", "snapshot": {
        "source_version_id": receipt["source_version_id"], "source_catalog_content_sha256": receipt["source_catalog_content_sha256"],
        "policy_sha256": receipt["policy_sha256"], "receipt_sha256": digest(encode(receipt)),
        "currentness": "checked_by_producer_at_scan_not_reverified_here"},
        "catalog_rows": counts["source_rows"], "eligible_unique_catalog_paths": counts["eligible_rows"],
        "duplicate_eligible_rows": counts["duplicate_rows"], "excluded_rows": sum(excluded.values()),
        "exclusion_counts": excluded, "failure_category_counts": categories,
        "count_conservation_verified": True,
        "full_source_scope": receipt.get("source_scope") == "all_cfo_source_documents"})
    return result


def build_report(value):
    check(type(value) is dict and set(value) == {"schema", "finance_inspection", "finance_expected_request",
          "company_legal", "unverified_user_document_target"} and value["schema"] == "catalog-census-input-v1")
    # Company legal needs its own authoritative adapter; never relabel the finance receipt.
    check(value["company_legal"] == {"measurement_status": "not_measured"})
    target = value["unverified_user_document_target"]
    check(target is None or integer(target, 1000000000))
    finance = reconcile_finance(value["finance_inspection"], value["finance_expected_request"])
    inspection = value["finance_inspection"]
    unbound = []
    if inspection is not None and inspection.get("status") in ("failed", "refused", "publication_unknown"):
        unbound.append({"failure_category": FAILURES.get(inspection["code"], "unclassified_worker_failure"),
                        "request_attribution": "unverified_failure_has_no_authenticated_request_identity",
                        "counts": None})
    return {"schema": SCHEMA, "validation_scope": "supplied_aggregate_consistency_only",
            "receipt_authenticity_verified": False, "source_currentness_reverified": False,
            "unverified_user_document_target": target, "target_is_authoritative_denominator": False,
            "sources": [finance, empty_source("company_legal")],
            "unattributed_worker_outcomes": unbound,
            "combined_current_unique_original_documents": None, "combined_coverage_percentage": None,
            "document_text_preparation": "not_verified_by_this_report",
            "durable_relationship_publication": "not_verified_by_this_report",
            "fresh_session_source_grounded_retrieval": "not_verified_by_this_report",
            "multi_hop_xyz_retrieval": "not_verified_by_this_report", "full_operational_acceptance": False}


def validate_report(report, input_value):
    check(encode(report) == encode(build_report(input_value)))
    return {"valid": True, "validation_scope": "supplied_aggregate_consistency_only",
            "full_operational_acceptance": False}


if __name__ == "__main__":
    import sys
    try:
        check(len(sys.argv) == 2)
        with open(sys.argv[1], "rb") as stream:
            raw = stream.read(65537)
        check(len(raw) <= 65536)
        print(json.dumps(build_report(parse_aggregate(raw)), sort_keys=True, separators=(",", ":")))
    except Exception:
        print('{"status":"invalid_aggregate_input","counts":null,"full_operational_acceptance":false}')
        sys.exit(1)
