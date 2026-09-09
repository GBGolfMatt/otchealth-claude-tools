import copy
import unittest

from test_materialize import FakeS3, row, event, invoke, FULL_SCOPE_AUTHORIZATIONS, materialize
from inventory_census import PREFIX
from coverage_report import reconcile_finance, InvalidReport


class InventoryIntegrationTests(unittest.TestCase):
    def setup_case(self):
        request = event(source_prefixes=[], source_scope="all_cfo_source_documents", reconcile_inventory=True)
        authority = copy.deepcopy(FULL_SCOPE_AUTHORIZATIONS)
        authority[0].update(reconcile_inventory=True, allow_publish=False)
        s3 = FakeS3(materialize.encode(row()) + b"\n")
        s3.inventory_calls = []
        def listing(**kwargs):
            s3.inventory_calls.append(kwargs)
            return {"IsTruncated":False, "KeyCount":2, "Contents":[
                {"Key":PREFIX+"finance/ledger.json", "Size":10},
                {"Key":PREFIX+"_TEXT/finance/ledger.json.txt", "Size":20}]}
        s3.list_objects_v2 = listing
        return request, authority, s3

    def test_authorized_join_and_strict_receipt_validation(self):
        request, authority, s3 = self.setup_case()
        receipt = invoke(request, s3, authority)
        report = reconcile_finance(receipt, request)
        self.assertEqual(report["inventory_reconciliation"]["catalog_and_original_paths"],1)
        self.assertEqual(report["inventory_reconciliation"]["catalog_text_object_missing"],0)
        self.assertFalse(report["inventory_reconciliation"]["source_original_hash_verified"])
        self.assertEqual(s3.puts, [])
        self.assertGreaterEqual(s3.head_calls,4)
        bad = copy.deepcopy(receipt)
        bad["inventory_reconciliation"]["catalog_only_valid_paths"] += 1
        with self.assertRaises(InvalidReport): reconcile_finance(bad,request)

    def test_missing_or_wrong_inventory_authority_reads_nothing(self):
        for value in (None,False,1):
            request, authority, s3 = self.setup_case()
            if value is None: authority[0].pop("reconcile_inventory")
            else: authority[0]["reconcile_inventory"] = value
            with self.assertRaises(materialize.Refused): invoke(request,s3,authority)
            self.assertEqual(s3.head_calls,0)
            self.assertEqual(s3.inventory_calls,[])

    def test_changed_catalog_before_inventory_refuses(self):
        request, authority, s3 = self.setup_case()
        s3.head_versions=["source-v1","changed"]
        with self.assertRaises(materialize.Refused): invoke(request,s3,authority)
        self.assertEqual(s3.inventory_calls,[])

    def test_changed_catalog_between_pages_stops_before_second_list(self):
        request, authority, s3 = self.setup_case()
        s3.head_versions=["source-v1","source-v1","changed"]
        def first_page(**kwargs):
            s3.inventory_calls.append(kwargs)
            return {"IsTruncated":True, "NextContinuationToken":"next", "Contents":[]}
        s3.list_objects_v2=first_page
        with self.assertRaises(materialize.Refused): invoke(request,s3,authority)
        self.assertEqual(len(s3.inventory_calls),1)

    def test_publish_or_partial_scope_inventory_refuses(self):
        request, authority, s3 = self.setup_case()
        request["operation"]="publish"
        with self.assertRaises(materialize.Refused): invoke(request,s3,authority)
        self.assertEqual(s3.head_calls,0)
        request["operation"]="inspect"
        request.pop("source_scope")
        request["source_prefixes"]=["finance/"]
        with self.assertRaises(materialize.Refused): invoke(request,s3,authority)
        self.assertEqual(s3.inventory_calls,[])


if __name__ == "__main__":
    unittest.main()
