"""Exact-path metadata join inside the source boundary. Never return object keys."""
from collections import Counter, defaultdict

PREFIX = "otchealthcfodata/cfo-source-docs/"
BUCKET = "otchealth-finance-legal-dr-55c84f6b"
INTERNAL = {"_text", "_catalog", "_review", "_memory", "_state", "_archive"}
EXCLUSIONS = {"invalid_path", "outside_cohort", "missing_source_hash", "missing_sidecar_claim",
              "missing_enrichment_claim", "missing_matching_enrichment_hash", "source_error", "invalid_metadata_schema"}
MAX_OBJECTS = 200000
MAX_PAGES = 201


class InventoryInvalid(ValueError):
    pass


def check(condition):
    if not condition:
        raise InventoryInvalid("inventory_metadata_invalid")


def internal(path):
    return isinstance(path, str) and path.split("/", 1)[0].lower() in INTERNAL


def validate_report(report, counts):
    """Validate only aggregate shape/accounting, never authenticate a source."""
    numeric = {"catalog_valid_rows", "catalog_valid_unique_paths", "duplicate_valid_catalog_path_rows",
               "invalid_catalog_path_rows", "internal_catalog_path_rows", "inventory_object_count",
               "inventory_bytes", "inventory_pages", "catalog_and_original_paths", "catalog_only_valid_paths",
               "original_only_valid_paths", "zero_byte_original_paths", "eligible_original_present",
               "eligible_original_missing", "catalog_nonempty_text_present", "catalog_empty_text_present",
               "catalog_text_object_missing", "text_without_original_paths", "text_without_catalog_paths",
               "eligible_and_excluded_valid_paths"}
    flags = {"complete_listing":True, "listing_snapshot_atomic":False,
             "exclusion_categories_may_overlap_by_path":True, "source_original_hash_verified":False,
             "text_content_or_ocr_verified":False, "identity_authority_verified":False,
             "source_names_or_paths_returned":False}
    check(type(report) is dict and set(report) == numeric | set(flags) |
          {"schema", "inventory_categories", "exclusion_path_presence"})
    check(report["schema"] == "catalog-inventory-reconciliation-v1")
    check(all(report[k] is v for k,v in flags.items()))
    check(all(type(report[k]) is int and report[k] >= 0 for k in numeric))
    check(1 <= report["inventory_pages"] <= MAX_PAGES and report["inventory_object_count"] <= MAX_OBJECTS)
    categories = report["inventory_categories"]
    check(type(categories) is dict and set(categories) <= INTERNAL |
          {"directory_marker", "valid_source_candidate", "invalid_source_candidate_path", "malformed_internal_path"})
    check(all(type(v) is int and v >= 0 for v in categories.values()))
    check(sum(categories.values()) == report["inventory_object_count"])
    originals = categories.get("valid_source_candidate", 0)
    paths = report["catalog_valid_unique_paths"]
    check(report["catalog_valid_rows"] + report["invalid_catalog_path_rows"] + report["internal_catalog_path_rows"] == counts["source_rows"])
    check(paths + report["duplicate_valid_catalog_path_rows"] == report["catalog_valid_rows"])
    check(report["catalog_and_original_paths"] + report["catalog_only_valid_paths"] == paths)
    check(report["catalog_and_original_paths"] + report["original_only_valid_paths"] == originals)
    check(report["eligible_original_present"] + report["eligible_original_missing"] == counts["eligible_rows"])
    check(report["eligible_original_present"] <= report["catalog_and_original_paths"])
    check(report["eligible_original_missing"] <= report["catalog_only_valid_paths"])
    check(report["catalog_nonempty_text_present"] + report["catalog_empty_text_present"] + report["catalog_text_object_missing"] == paths)
    check(report["zero_byte_original_paths"] <= originals)
    check(report["eligible_and_excluded_valid_paths"] <= counts["eligible_rows"])
    check(report["text_without_original_paths"] <= categories.get("_text",0)
          and report["text_without_catalog_paths"] <= categories.get("_text",0))
    reasons = report["exclusion_path_presence"]
    fields = {"unique_valid_catalog_paths", "original_present", "original_missing", "nonempty_text_object_present",
              "empty_text_object_present", "text_object_missing"}
    check(type(reasons) is dict and set(reasons) <= set(counts["excluded"]) & EXCLUSIONS)
    for reason, values in reasons.items():
        check(type(values) is dict and set(values) == fields and all(type(v) is int and v >= 0 for v in values.values()))
        n = values["unique_valid_catalog_paths"]
        check(n <= min(paths,counts["excluded"][reason]))
        check(values["original_present"] + values["original_missing"] == n)
        check(values["nonempty_text_object_present"] + values["empty_text_object_present"] + values["text_object_missing"] == n)
    return report


class InventoryCensus:
    def __init__(self, safe_path):
        self.safe_path = safe_path
        self.rows = Counter()
        self.invalid_rows = 0
        self.internal_rows = 0
        self.eligible = set()
        self.excluded = defaultdict(set)

    def well_formed(self, path):
        if internal(path):
            first, sep, rest = path.partition("/")
            return self.safe_path("x" * len(first) + sep + rest)
        return self.safe_path(path)

    def observe(self, row, exclusion):
        check(type(row) is dict and (exclusion is None or type(exclusion) is str and exclusion in EXCLUSIONS))
        path = row.get("path")
        if not self.well_formed(path):
            self.invalid_rows += 1
        elif internal(path):
            self.internal_rows += 1
        else:
            self.rows[path] += 1
            if exclusion:
                self.excluded[exclusion].add(path)
            else:
                self.eligible.add(path)

    def reconcile(self, s3, authorize):
        originals, text_nonempty, text_empty, keys = set(), set(), set(), set()
        categories = Counter()
        zero_originals = set()
        token, tokens, total_bytes, pages = None, set(), 0, 0
        while True:
            authorize()
            params = {"Bucket": BUCKET, "Prefix": PREFIX, "MaxKeys": 1000}
            if token is not None:
                params["ContinuationToken"] = token
            response = s3.list_objects_v2(**params)
            check(type(response) is dict)
            pages += 1
            check(pages <= MAX_PAGES)
            objects = response.get("Contents", [])
            check(type(objects) is list and len(objects) <= 1000)
            if "KeyCount" in response:
                check(type(response["KeyCount"]) is int and response["KeyCount"] == len(objects))
            for obj in objects:
                check(type(obj) is dict)
                key, size = obj.get("Key"), obj.get("Size")
                check(type(key) is str and key.startswith(PREFIX) and key not in keys)
                check(type(size) is int and size >= 0)
                keys.add(key)
                check(len(keys) <= MAX_OBJECTS)
                total_bytes += size
                path = key[len(PREFIX):]
                if not path or path.endswith("/"):
                    category = "directory_marker"
                elif internal(path) and not self.well_formed(path):
                    category = "malformed_internal_path"
                elif internal(path):
                    category = path.split("/", 1)[0].lower()
                    if path.startswith("_TEXT/") and path.endswith(".txt"):
                        source_path = path[len("_TEXT/"):-len(".txt")]
                        if self.safe_path(source_path):
                            (text_nonempty if size else text_empty).add(source_path)
                elif self.safe_path(path):
                    category = "valid_source_candidate"
                    originals.add(path)
                    if size == 0:
                        zero_originals.add(path)
                else:
                    category = "invalid_source_candidate_path"
                categories[category] += 1
            truncated = response.get("IsTruncated")
            check(type(truncated) is bool)
            if not truncated:
                check(response.get("NextContinuationToken") is None)
                break
            token = response.get("NextContinuationToken")
            check(type(token) is str and token and token not in tokens)
            tokens.add(token)
        authorize()
        catalog = set(self.rows)
        both = catalog & originals
        text = text_nonempty | text_empty
        reasons = {}
        for reason, paths in sorted(self.excluded.items()):
            reasons[reason] = {"unique_valid_catalog_paths": len(paths),
                              "original_present": len(paths & originals),
                              "original_missing": len(paths - originals),
                              "nonempty_text_object_present": len(paths & text_nonempty),
                              "empty_text_object_present": len(paths & text_empty),
                              "text_object_missing": len(paths - text)}
        return {"schema": "catalog-inventory-reconciliation-v1",
                "complete_listing": True, "listing_snapshot_atomic": False,
                "catalog_valid_rows": sum(self.rows.values()),
                "catalog_valid_unique_paths": len(catalog),
                "duplicate_valid_catalog_path_rows": sum(self.rows.values()) - len(catalog),
                "invalid_catalog_path_rows": self.invalid_rows,
                "internal_catalog_path_rows": self.internal_rows,
                "inventory_object_count": len(keys), "inventory_bytes": total_bytes,
                "inventory_pages": pages, "inventory_categories": dict(sorted(categories.items())),
                "catalog_and_original_paths": len(both),
                "catalog_only_valid_paths": len(catalog - originals),
                "original_only_valid_paths": len(originals - catalog),
                "zero_byte_original_paths": len(zero_originals),
                "eligible_original_present": len(self.eligible & originals),
                "eligible_original_missing": len(self.eligible - originals),
                "catalog_nonempty_text_present": len(catalog & text_nonempty),
                "catalog_empty_text_present": len(catalog & text_empty),
                "catalog_text_object_missing": len(catalog - text),
                "text_without_original_paths": len(text - originals),
                "text_without_catalog_paths": len(text - catalog),
                "exclusion_path_presence": reasons,
                "exclusion_categories_may_overlap_by_path": True,
                "eligible_and_excluded_valid_paths": len(self.eligible & set().union(*self.excluded.values())),
                "source_original_hash_verified": False,
                "text_content_or_ocr_verified": False,
                "identity_authority_verified": False,
                "source_names_or_paths_returned": False}
