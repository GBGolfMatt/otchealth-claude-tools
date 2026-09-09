import copy
import importlib.util
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

MATERIALIZE_TEST_SPEC = importlib.util.spec_from_file_location("materialize_test_helpers", __file__.replace("test_coverage_report.py", "test_materialize.py"))
materialize_tests = importlib.util.module_from_spec(MATERIALIZE_TEST_SPEC)
MATERIALIZE_TEST_SPEC.loader.exec_module(materialize_tests)
AUTHORIZATIONS = materialize_tests.AUTHORIZATIONS
FULL_SCOPE_AUTHORIZATIONS = materialize_tests.FULL_SCOPE_AUTHORIZATIONS
FakeS3 = materialize_tests.FakeS3
event = materialize_tests.event
invoke = materialize_tests.invoke
raw = materialize_tests.raw
row = materialize_tests.row
materialize = materialize_tests.materialize


SPEC = importlib.util.spec_from_file_location("coverage_report", __file__.replace("test_coverage_report.py", "coverage_report.py"))
coverage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(coverage)


def report_input(receipt, expected, target=None, company_legal=None):
    return {"schema": "catalog-census-input-v1", "finance_inspection": receipt,
            "finance_expected_request": expected,
            "company_legal": company_legal or {"measurement_status": "not_measured"},
            "unverified_user_document_target": target}


class CoverageReportTests(unittest.TestCase):
    def test_complete_counts_conserve_and_duplicate_counts_are_not_eligible_paths(self):
        good = row("finance/good.json")
        receipt = invoke(event(), FakeS3(raw(good, good, row("finance/missing.json", enriched_sha256=None),
                                                  row("other/outside.json"))))
        report = coverage.build_report(report_input(receipt, event()))
        finance = report["sources"][0]
        self.assertEqual(finance["measurement_status"], "complete_catalog_snapshot")
        self.assertEqual(finance["catalog_rows"], 4)
        self.assertEqual(finance["eligible_unique_catalog_paths"], 1)
        self.assertEqual(finance["duplicate_eligible_rows"], 1)
        self.assertEqual(finance["excluded_rows"], 2)
        self.assertTrue(finance["count_conservation_verified"])
        self.assertEqual(finance["exclusion_counts"], {"missing_matching_enrichment_hash": 1, "outside_cohort": 1})

    def test_missing_provenance_is_excluded_and_zero_eligible_is_a_complete_zero_not_a_denominator(self):
        receipt = invoke(event(), FakeS3(raw(row("finance/nohash.json", sha256="0" * 64, enriched_sha256="0" * 64),
                                              row("finance/noenrichment.json", enriched=False))))
        self.assertEqual(receipt["status"], "not_ready_no_eligible_rows")
        finance = coverage.build_report(report_input(receipt, event()))["sources"][0]
        self.assertEqual(finance["eligible_unique_catalog_paths"], 0)
        self.assertEqual(finance["excluded_rows"], 2)
        self.assertTrue(finance["count_conservation_verified"])
        self.assertIsNone(finance["authoritative_original_object_total"])
        self.assertIsNone(finance["coverage_percentage"])

    def test_parse_failure_and_interruption_leave_totals_unknown_never_zero(self):
        for receipt, failure in (
            ({"status": "failed", "published": False, "code": "source_json_invalid"}, "parse_failure"),
            ({"status": "publication_unknown", "published": None, "code": "publication_unknown"}, "publication_unknown"),
        ):
            report = coverage.build_report(report_input(receipt, event()))
            finance = report["sources"][0]
            self.assertEqual(finance["measurement_status"], "unknown_unbound_worker_outcome")
            self.assertIsNone(finance["failure"])
            self.assertIsNone(finance["catalog_rows"])
            self.assertIsNone(finance["eligible_unique_catalog_paths"])
            self.assertFalse(finance["count_conservation_verified"])
            self.assertEqual(report["unattributed_worker_outcomes"], [{"failure_category": failure,
                              "request_attribution": "unverified_failure_has_no_authenticated_request_identity", "counts": None}])

    def test_full_scope_is_true_only_for_actual_full_scope_receipt(self):
        normal_request = event()
        normal = invoke(normal_request, FakeS3(raw(row())))
        self.assertFalse(coverage.build_report(report_input(normal, normal_request))["sources"][0]["full_source_scope"])
        full_request = event(source_prefixes=[], source_scope="all_cfo_source_documents")
        full = invoke(full_request, FakeS3(raw(row("root.json"))), FULL_SCOPE_AUTHORIZATIONS)
        self.assertTrue(coverage.build_report(report_input(full, full_request))["sources"][0]["full_source_scope"])

    def test_unverified_47000_target_and_clo_placeholder_never_become_denominators_or_acceptance(self):
        receipt = invoke(event(), FakeS3(raw(row())))
        input_value = report_input(receipt, event(), target=47000)
        report = coverage.build_report(input_value)
        self.assertEqual(report["unverified_user_document_target"], 47000)
        self.assertFalse(report["target_is_authoritative_denominator"])
        self.assertIsNone(report["combined_current_unique_original_documents"])
        self.assertIsNone(report["combined_coverage_percentage"])
        self.assertFalse(report["full_operational_acceptance"])
        self.assertEqual(report["sources"][1]["measurement_status"], "not_measured")
        with self.assertRaises(coverage.InvalidReport):
            coverage.build_report(report_input(receipt, event(), company_legal={"measurement_status": "complete_catalog_snapshot"}))
        forged = copy.deepcopy(report)
        forged["full_operational_acceptance"] = True
        with self.assertRaises(coverage.InvalidReport):
            coverage.validate_report(forged, input_value)

    def test_actual_published_producer_receipt_has_matching_bound_hashes(self):
        request = event("publish")
        receipt = invoke(request, FakeS3(raw(row())))
        finance = coverage.build_report(report_input(receipt, request))["sources"][0]
        self.assertEqual(receipt["status"], "published")
        self.assertEqual(finance["measurement_status"], "complete_catalog_snapshot")
        self.assertEqual(finance["snapshot"]["source_version_id"], "source-v1")

    def test_mutated_receipt_fields_counts_and_statuses_are_rejected(self):
        request = event()
        receipt = invoke(request, FakeS3(raw(row())))
        mutations = [
            ("policy_sha256", "c" * 64),
            ("source_version_id", "source-v2"),
            ("catalog_source_sha256", "d" * 64),
            ("status", "complete"),
            ("published", True),
        ]
        for field, value in mutations:
            changed = copy.deepcopy(receipt)
            changed[field] = value
            with self.assertRaises(coverage.InvalidReport, msg=field):
                coverage.build_report(report_input(changed, request))
        for field, value in (("source_rows", True), ("eligible_rows", False), ("duplicate_rows", True)):
            changed = copy.deepcopy(receipt)
            changed["counts"][field] = value
            with self.assertRaises(coverage.InvalidReport, msg=field):
                coverage.build_report(report_input(changed, request))
        changed = copy.deepcopy(receipt)
        changed["counts"]["source_rows"] = 9
        with self.assertRaises(coverage.InvalidReport):
            coverage.build_report(report_input(changed, request))
        unknown = {"status": "failed", "published": False, "code": "invented_reason"}
        report = coverage.build_report(report_input(unknown, request))
        self.assertEqual(report["sources"][0]["measurement_status"], "unknown_unbound_worker_outcome")
        self.assertEqual(report["unattributed_worker_outcomes"][0]["failure_category"], "unclassified_worker_failure")

    def test_parser_canonical_validation_and_operation_binding_reject_malformed_aggregates(self):
        for raw_value in ('{"x":1,"x":2}', '{"x":NaN}', '{"x":Infinity}'):
            with self.assertRaises(coverage.InvalidReport):
                coverage.parse_aggregate(raw_value)
        receipt = invoke(event(), FakeS3(raw(row())))
        report_input_value = report_input(receipt, event())
        complete = coverage.build_report(report_input_value)
        forged = copy.deepcopy(complete)
        forged["sources"][0]["catalog_rows"] = True
        with self.assertRaises(coverage.InvalidReport):
            coverage.validate_report(forged, report_input_value)
        with self.assertRaises(coverage.InvalidReport):
            coverage.build_report(report_input(receipt, event("publish")))

    def test_unknown_exclusion_and_full_scope_outside_cohort_are_rejected_even_when_counts_conserve(self):
        normal_request = event()
        normal = invoke(normal_request, FakeS3(raw(row())))
        unknown = copy.deepcopy(normal)
        unknown["counts"] = {"source_rows": 2, "eligible_rows": 1, "duplicate_rows": 0, "excluded": {"invented": 1}}
        with self.assertRaises(coverage.InvalidReport):
            coverage.build_report(report_input(unknown, normal_request))
        full_request = event(source_prefixes=[], source_scope="all_cfo_source_documents")
        full = invoke(full_request, FakeS3(raw(row("root.json"))), FULL_SCOPE_AUTHORIZATIONS)
        outside = copy.deepcopy(full)
        outside["counts"] = {"source_rows": 2, "eligible_rows": 1, "duplicate_rows": 0, "excluded": {"outside_cohort": 1}}
        with self.assertRaises(coverage.InvalidReport):
            coverage.build_report(report_input(outside, full_request))

    def test_actual_parse_and_publication_unknown_failures_are_unattributed_and_reconciliation_is_strict(self):
        with self.assertRaises(materialize.Refused) as malformed:
            invoke(event(), FakeS3(raw(row()) + b'{bad json}\n'))
        parse_envelope = {"status": "failed", "published": False, "code": str(malformed.exception)}
        report = coverage.build_report(report_input(parse_envelope, event()))
        self.assertEqual(report["sources"][0]["measurement_status"], "unknown_unbound_worker_outcome")
        self.assertEqual(report["sources"][0]["catalog_rows"], None)
        self.assertEqual(report["unattributed_worker_outcomes"][0]["failure_category"], "parse_failure")
        s3 = FakeS3(raw(row()))
        s3.fail_published_read = True
        with self.assertRaises(materialize.PublicationUnknown) as unknown:
            invoke(event("publish"), s3)
        envelope = {"status": "publication_unknown", "published": None, "code": "publication_unknown",
                    "reconciliation": unknown.exception.state}
        report = coverage.build_report(report_input(envelope, event("publish")))
        self.assertEqual(report["sources"][0]["measurement_status"], "unknown_unbound_worker_outcome")
        changed = copy.deepcopy(envelope)
        changed["reconciliation"]["source_version_id"] = "source-v2"
        with self.assertRaises(coverage.InvalidReport):
            coverage.build_report(report_input(changed, event("publish")))


if __name__ == "__main__":
    unittest.main()
