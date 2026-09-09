import json
import unittest
from unittest.mock import patch

from inventory_census import InventoryCensus, InventoryInvalid, PREFIX, BUCKET
from materialize import safe_path


class Pages:
    def __init__(self, pages):
        self.pages = list(pages)
        self.calls = []

    def list_objects_v2(self, **kwargs):
        self.calls.append(kwargs)
        return self.pages.pop(0)


def page(items, **extra):
    return {"Contents": [{"Key": PREFIX + path, "Size": size} for path, size in items],
            "IsTruncated": False, **extra}


class InventoryTests(unittest.TestCase):
    def test_exact_join_duplicates_exclusions_and_text_presence(self):
        census = InventoryCensus(safe_path)
        census.observe({"path": "a.pdf"}, None)
        census.observe({"path": "a.pdf"}, None)
        census.observe({"path": "missing.pdf"}, "missing_sidecar_claim")
        census.observe({"path": "b.pdf"}, "missing_source_hash")
        census.observe({"path": "_CATALOG/internal"}, "invalid_path")
        census.observe({"path": "../invalid"}, "invalid_path")
        api = Pages([page([("a.pdf", 4), ("b.pdf", 0), ("only.pdf", 2),
                           ("_TEXT/a.pdf.txt", 10), ("_TEXT/b.pdf.txt", 0),
                           ("_TEXT/orphan.pdf.txt", 3), ("_CATALOG/catalog.jsonl", 9)])])
        out = census.reconcile(api, lambda: None)
        self.assertEqual((out["catalog_valid_rows"], out["catalog_valid_unique_paths"]), (4, 3))
        self.assertEqual((out["catalog_and_original_paths"], out["catalog_only_valid_paths"],
                          out["original_only_valid_paths"]), (2, 1, 1))
        self.assertEqual(out["duplicate_valid_catalog_path_rows"], 1)
        self.assertEqual(out["internal_catalog_path_rows"], 1)
        self.assertEqual(out["invalid_catalog_path_rows"], 1)
        self.assertEqual(out["catalog_text_object_missing"], 1)
        self.assertEqual(out["catalog_empty_text_present"], 1)
        self.assertEqual(out["text_without_original_paths"], 1)
        self.assertEqual(out["exclusion_path_presence"]["missing_source_hash"]["original_present"], 1)
        self.assertNotIn("a.pdf", json.dumps(out))
        self.assertFalse(out["text_content_or_ocr_verified"])

    def test_pagination_exact_prefix_and_authority_rechecked(self):
        api = Pages([page([("a.pdf", 1)], IsTruncated=True, NextContinuationToken="next"), page([])])
        checks = []
        out = InventoryCensus(safe_path).reconcile(api, lambda: checks.append(True))
        self.assertEqual(out["inventory_pages"], 2)
        self.assertEqual(len(checks), 3)
        self.assertEqual(api.calls[1], {"Bucket":BUCKET, "Prefix":PREFIX, "MaxKeys":1000,
                                       "ContinuationToken":"next"})

    def test_incomplete_or_repeated_cursor_refuses(self):
        cases = [[{"Contents": []}], [page([], IsTruncated=True)],
                 [page([], IsTruncated=True, NextContinuationToken="repeat"),
                  page([], IsTruncated=True, NextContinuationToken="repeat")]]
        for pages in cases:
            with self.subTest(pages=pages), self.assertRaises(InventoryInvalid):
                InventoryCensus(safe_path).reconcile(Pages(pages), lambda: None)

    def test_outside_prefix_duplicate_or_bad_size_refuses(self):
        invalid = [{"Key":"another/prefix", "Size":1}, {"Key":PREFIX+"a", "Size":True},
                   {"Key":PREFIX+"a", "Size":-1}]
        for obj in invalid:
            with self.subTest(obj=obj), self.assertRaises(InventoryInvalid):
                InventoryCensus(safe_path).reconcile(Pages([{"Contents":[obj], "IsTruncated":False}]), lambda: None)
        with self.assertRaises(InventoryInvalid):
            InventoryCensus(safe_path).reconcile(Pages([page([("a",1), ("a",2)])]), lambda: None)

    def test_authority_failure_prevents_listing(self):
        api = Pages([])
        def deny():
            raise ValueError("expired")
        with self.assertRaises(ValueError):
            InventoryCensus(safe_path).reconcile(api, deny)
        self.assertEqual(api.calls, [])

    def test_case_sensitive_text_mapping_and_zero_bytes(self):
        c = InventoryCensus(safe_path)
        c.observe({"path":"case.pdf"}, None)
        out = c.reconcile(Pages([page([("case.pdf",1), ("_text/case.pdf.txt",10)])]), lambda: None)
        self.assertEqual(out["catalog_text_object_missing"], 1)
        self.assertEqual(out["inventory_categories"]["_text"], 1)

    def test_malformed_internal_and_eligible_excluded_overlap(self):
        c = InventoryCensus(safe_path)
        c.observe({"path":"_TEXT/../bad"}, "invalid_path")
        c.observe({"path":"same.pdf"}, None)
        c.observe({"path":"same.pdf"}, "missing_source_hash")
        out = c.reconcile(Pages([page([])]), lambda: None)
        self.assertEqual(out["invalid_catalog_path_rows"], 1)
        self.assertEqual(out["internal_catalog_path_rows"], 0)
        self.assertEqual(out["eligible_and_excluded_valid_paths"], 1)

    def test_invalid_schema_labels_and_terminal_metadata_refuse(self):
        c = InventoryCensus(safe_path)
        for row, reason in (([],None), ({"path":"a"},"arbitrary"), ({"path":"a"},True)):
            with self.assertRaises(InventoryInvalid): c.observe(row,reason)
        for response in ([], page([], KeyCount=1), page([], KeyCount=False), page([],NextContinuationToken="")):
            with self.assertRaises(InventoryInvalid):
                c.reconcile(Pages([response]), lambda: None)

    def test_object_bound_refuses_instead_of_returning_partial_counts(self):
        with patch("inventory_census.MAX_OBJECTS",1), self.assertRaises(InventoryInvalid):
            InventoryCensus(safe_path).reconcile(Pages([page([("a",1),("b",1)])]),lambda:None)


if __name__ == "__main__":
    unittest.main()
