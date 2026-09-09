"""Run only in the authorized CFO AWS source boundary. Never print catalog rows.

The Lambda handler and CLI share the real boto3 implementation. Inspect is read-only;
publish requires an exact version, cohort and policy hash and never changes a cohort.
"""
import base64
import hashlib
import json
import re
import tempfile
import unicodedata
from datetime import datetime, timezone
from inventory_census import InventoryCensus

BUCKET = "otchealth-finance-legal-dr-55c84f6b"
SOURCE = "otchealthcfodata/cfo-source-docs/_CATALOG/catalog.jsonl"
DEST = "graph-trial/20260909/materialized-cfo/"
MAX_BYTES = 192 * 1024 * 1024
MAX_LINE = 1024 * 1024
MAX_ROWS = 100000
FIELDS = ("path", "sha256", "sidecar", "enriched", "enriched_sha256", "err",
          "doc_date", "entity", "entities", "named_entities_orgs",
          "named_entities_people", "signatories", "counterparty")
SHA = re.compile(r"^[a-f0-9]{64}$")
IDENTITY_FIELDS = ("source_record_id", "source_system", "tenant_id", "organization_id",
                   "contact_id", "invoice_id", "issuing_organization_id", "case_id",
                   "court_system", "jurisdiction", "structured_identifiers", "identity_records")
IDENTITY_SCOPES = {"organization": ("organization_id", "source_system", "tenant_id"),
                   "contact": ("contact_id", "source_system", "tenant_id"),
                   "invoice": ("invoice_id", "source_system", "tenant_id", "issuing_organization_id"),
                   "legal_case": ("case_id", "court_system", "jurisdiction")}


def identity_field_census():
    return {"rows": 0, "fields_present": dict.fromkeys(IDENTITY_FIELDS, 0),
            "nonempty_string_fields": dict.fromkeys(IDENTITY_FIELDS, 0),
            "scoped_field_combinations": dict.fromkeys(IDENTITY_SCOPES, 0)}


def count_identity_fields(census, row):
    # Fixed field names and counts only. Never retain names, paths, IDs or bodies.
    census["rows"] += 1
    for field in IDENTITY_FIELDS:
        if field in row:
            census["fields_present"][field] += 1
        if isinstance(row.get(field), str) and row[field].strip():
            census["nonempty_string_fields"][field] += 1
    for kind, fields in IDENTITY_SCOPES.items():
        if all(isinstance(row.get(field), str) and row[field].strip() for field in fields):
            census["scoped_field_combinations"][kind] += 1


class Refused(Exception):
    pass


class PublicationUnknown(Refused):
    def __init__(self, state):
        super().__init__("publication_unknown")
        self.state = dict(state)


def require(condition, code):
    if not condition:
        raise Refused(code)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def safe_path(value):
    # Stricter than the planner: reject URL/control/backslash paths before publication.
    return (isinstance(value, str) and 0 < len(value) <= 1024
            and value == unicodedata.normalize("NFC", value)
            and not re.search(r"[\\%?#\x00-\x1f\x7f]", value)
            and not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", value)
            and all(p not in ("", ".", "..") for p in value.split("/"))
            and value.split("/")[0].lower() not in
            ("_text", "_catalog", "_review", "_memory", "_state", "_archive"))


def validate(event):
    fields = {"operation", "source_version_id", "cohort_id", "policy_sha256", "source_prefixes"}
    require(type(event) is dict and fields <= set(event) <= fields | {"source_scope", "reconcile_inventory"}, "request_shape")
    require(event["operation"] in ("inspect", "publish"), "operation_invalid")
    if "reconcile_inventory" in event:
        require(event["reconcile_inventory"] is True and event["operation"] == "inspect"
                and event.get("source_scope") == "all_cfo_source_documents", "inventory_scope_invalid")
    version = event["source_version_id"]
    require(isinstance(version, str) and 0 < len(version) <= 1024
            and version != "null" and not re.search(r"[\x00-\x20\x7f]", version), "source_version_invalid")
    require(isinstance(event["cohort_id"], str) and
            re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", event["cohort_id"]), "cohort_invalid")
    require(isinstance(event["policy_sha256"], str) and SHA.fullmatch(event["policy_sha256"]), "policy_invalid")
    prefixes = event["source_prefixes"]
    if "source_scope" in event:
        require(event["source_scope"] == "all_cfo_source_documents" and prefixes == [], "scope_invalid")
        return
    require(type(prefixes) is list and 1 <= len(prefixes) <= 16 and
            all(isinstance(p, str) and p.endswith("/") and safe_path(p[:-1]) for p in prefixes)
            and len(set(prefixes)) == len(prefixes), "prefix_invalid")


def authorize(event, authorizations, now):
    require(type(authorizations) is list and 0 < len(authorizations) <= 32, "authority_missing")
    matches = [a for a in authorizations if type(a) is dict and a.get("cohort_id") == event["cohort_id"]]
    require(len(matches) == 1, "authority_mismatch")
    allowed = matches[0]
    fields = {"cohort_id", "policy_sha256", "source_prefixes", "source_version_id", "allow_publish", "expires_at"}
    optional = {k for k in ("source_scope", "reconcile_inventory") if k in event}
    require(set(allowed) == (fields | optional)
            and type(allowed["allow_publish"]) is bool, "authority_invalid")
    require(allowed.get("source_scope") == event.get("source_scope"), "authority_mismatch")
    require(allowed.get("reconcile_inventory") is event.get("reconcile_inventory"), "authority_mismatch")
    require(all(allowed[k] == event[k] for k in ("cohort_id", "policy_sha256", "source_version_id"))
            and type(allowed["source_prefixes"]) is list
            and sorted(allowed["source_prefixes"]) == sorted(event["source_prefixes"]), "authority_mismatch")
    try:
        expiry = datetime.fromisoformat(allowed["expires_at"].replace("Z", "+00:00"))
        require(expiry.tzinfo is not None and expiry > now(), "authority_expired")
    except (ValueError, TypeError, AttributeError):
        raise Refused("authority_invalid") from None
    require(event["operation"] != "publish" or allowed["allow_publish"], "publish_not_authorized")


def reason(row, prefixes, all_source=False):
    if not safe_path(row.get("path")):
        return "invalid_path"
    if not all_source and not any(row["path"].startswith(p) for p in prefixes):
        return "outside_cohort"
    if (not isinstance(row.get("sha256"), str) or not SHA.fullmatch(row["sha256"])
            or row["sha256"] == "0" * 64):
        return "missing_source_hash"
    if row.get("sidecar") is not True:
        return "missing_sidecar_claim"
    if row.get("enriched") is not True:
        return "missing_enrichment_claim"
    if row.get("enriched_sha256") != row["sha256"]:
        return "missing_matching_enrichment_hash"
    err = row.get("err")
    if isinstance(err, (dict, list)) or err:
        return "source_error"
    for field in ("entity", "counterparty", "entities", "named_entities_orgs", "named_entities_people", "signatories"):
        value = row.get(field)
        if value is None or value == "":
            continue
        if field in ("entity", "counterparty"):
            if not isinstance(value, str) or not value.strip():
                return "invalid_metadata_schema"
        elif not isinstance(value, list) or any(not isinstance(x, str) or not x.strip() for x in value):
            return "invalid_metadata_schema"
    value = row.get("doc_date")
    if value is not None and value != "":
        if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", value):
            return "invalid_metadata_schema"
        try:
            datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return "invalid_metadata_schema"
    return None


def lines(body, expected_size, source_hash):
    pending = b""
    size = 0
    try:
        for chunk in body.iter_chunks(chunk_size=65536):
            source_hash.update(chunk)
            size += len(chunk)
            require(size <= expected_size, "source_length_changed")
            parts = (pending + chunk).split(b"\n")
            pending = parts.pop()
            for line in parts:
                require(len(line) <= MAX_LINE, "source_line_limit")
                yield line
            require(len(pending) <= MAX_LINE, "source_line_limit")
        require(size == expected_size, "source_length_changed")
        if pending:
            yield pending
    finally:
        body.close()


def head_current(s3, version):
    head = s3.head_object(Bucket=BUCKET, Key=SOURCE)
    require(head.get("VersionId") == version, "source_not_current")
    require(type(head.get("ContentLength")) is int and 0 < head["ContentLength"] <= MAX_BYTES,
            "source_size_invalid")
    require(isinstance(head.get("ETag"), str) and head["ETag"], "source_etag_missing")
    return head


def verify(s3, key, size, expected_hash):
    response = s3.get_object(Bucket=BUCKET, Key=key)
    actual = hashlib.sha256()
    count = 0
    try:
        for chunk in response["Body"].iter_chunks(chunk_size=65536):
            count += len(chunk)
            require(count <= size, "publication_conflict")
            actual.update(chunk)
    finally:
        response["Body"].close()
    require(count == size and actual.hexdigest() == expected_hash, "publication_conflict")
    require(response.get("VersionId") not in (None, "", "null"), "publication_unversioned")
    return response["VersionId"]


def materialize(event, s3, authorizations=None, now=None):
    state = {}
    try:
        return _materialize(event, s3, authorizations, now, state)
    except Exception:
        if state:
            raise PublicationUnknown(state) from None
        raise


def _materialize(event, s3, authorizations, now, publication_state):
    validate(event)
    now = now or (lambda: datetime.now(timezone.utc))
    authorize(event, authorizations, now)
    version = event["source_version_id"]
    head = head_current(s3, version)
    source = s3.get_object(Bucket=BUCKET, Key=SOURCE, VersionId=version, IfMatch=head["ETag"])
    if (source.get("VersionId") != version or source.get("ETag") != head["ETag"] or
            source.get("ContentLength") != head["ContentLength"]):
        source["Body"].close()
        raise Refused("source_pin_mismatch")
    counts = {"source_rows": 0, "eligible_rows": 0, "duplicate_rows": 0, "excluded": {}}
    raw_identity = identity_field_census()
    eligible_identity = identity_field_census()
    inventory = InventoryCensus(safe_path) if event.get("reconcile_inventory") else None
    source_hash = hashlib.sha256()
    output_hash = hashlib.sha256()
    seen = {}
    output_size = 0
    # Only the trusted source worker's ephemeral disk sees selected source metadata.
    with tempfile.TemporaryFile(mode="w+b") as output:
        for raw in lines(source["Body"], head["ContentLength"], source_hash):
            if not raw.strip():
                continue
            counts["source_rows"] += 1
            require(counts["source_rows"] <= MAX_ROWS, "source_row_limit")
            try:
                row = json.loads(raw.decode("utf-8"), parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            except (ValueError, UnicodeError):
                raise Refused("source_json_invalid") from None
            require(type(row) is dict, "source_row_invalid")
            if event["operation"] == "inspect":
                count_identity_fields(raw_identity, row)
            why = reason(row, event["source_prefixes"], event.get("source_scope") == "all_cfo_source_documents")
            if inventory is not None:
                inventory.observe(row, why)
            if why:
                counts["excluded"][why] = counts["excluded"].get(why, 0) + 1
                continue
            try:
                selected = encode({field: row[field] for field in FIELDS if field in row})
            except (ValueError, UnicodeError, RecursionError):
                raise Refused("source_row_invalid") from None
            require(len(selected) <= 65536, "selected_row_limit")
            # One current version per path. Multiple digests for one path are ambiguous.
            identity = digest(row["path"].encode("utf-8"))
            row_hash = digest(selected)
            if identity in seen:
                require(seen[identity] == row_hash, "source_duplicate_conflict")
                counts["duplicate_rows"] += 1
                continue
            seen[identity] = row_hash
            if event["operation"] == "inspect":
                count_identity_fields(eligible_identity, row)
            line = selected + b"\n"
            output_size += len(line)
            require(output_size <= MAX_BYTES, "publication_size_limit")
            output.write(line)
            output_hash.update(line)
            counts["eligible_rows"] += 1
        inventory_result = None
        if inventory is not None:
            def inventory_authorized():
                authorize(event, authorizations, now)
                head_current(s3, version)
            inventory_result = inventory.reconcile(s3, inventory_authorized)
        head_current(s3, version)
        authorize(event, authorizations, now)
        catalog_hash = output_hash.hexdigest()
        binding = {"schema": "cfo-catalog-materialization-v1", "cohort_id": event["cohort_id"],
                   "policy_sha256": event["policy_sha256"],
                   "source_prefixes_sha256": digest(encode(sorted(event["source_prefixes"]))),
                   "source_version_id": version, "source_etag_sha256": digest(head["ETag"].encode()),
                   "source_catalog_content_sha256": source_hash.hexdigest(),
                   "source_bytes": head["ContentLength"], "catalog_content_sha256": catalog_hash,
                   "catalog_source_sha256": digest(encode({"room": "finance", "source_index": "finance-cfo-source-docs",
                                                           "url": f"https://{BUCKET}.s3.us-east-1.amazonaws.com/{SOURCE}"})),
                   "catalog_bytes": output_size, "counts": counts,
                   "lineage": "catalog_association_only", "source_current_checked": True}
        if "source_scope" in event:
            binding["source_scope"] = event["source_scope"]
        if event["operation"] == "inspect" or counts["eligible_rows"] == 0:
            return {**binding, "status": "inspected" if counts["eligible_rows"] else "not_ready_no_eligible_rows",
                    "published": False, **({"identity_field_census": {
                        "schema": "structured-identity-field-census-v1", "raw_catalog": raw_identity,
                        "eligible_unique_rows": eligible_identity, "authority_verified": False,
                        "scope": "top_level_field_availability_only", "nested_values_inspected": False,
                        "identity_projection_performed": False}} if event["operation"] == "inspect" else {}),
                    **({"inventory_reconciliation": inventory_result} if inventory_result is not None else {})}
        binding_hash = digest(encode(binding))
        key = f"{DEST}{event['cohort_id']}/{binding_hash}/{catalog_hash}.jsonl"
        output.seek(0)
        publication_state.update({"catalog_key": key, "catalog_content_sha256": catalog_hash,
                                  "binding_sha256": binding_hash, "source_version_id": version})
        try:
            s3.put_object(Bucket=BUCKET, Key=key, Body=output, ContentLength=output_size,
                          ContentType="application/x-ndjson", IfNoneMatch="*",
                          ChecksumSHA256=base64.b64encode(bytes.fromhex(catalog_hash)).decode(),
                          Metadata={"binding-sha256": binding_hash, "content-sha256": catalog_hash})
        except Exception as error:
            code = getattr(error, "response", {}).get("Error", {}).get("Code")
            if code not in ("PreconditionFailed", "412", "ConditionalRequestConflict", "409"):
                raise
        published_version = verify(s3, key, output_size, catalog_hash)
        head_current(s3, version)
        authorize(event, authorizations, now)
        receipt = {**binding, "status": "published", "published": True, "catalog_key": key,
                   "catalog_version_id": published_version, "binding_sha256": binding_hash}
        receipt_bytes = encode(receipt)
        receipt_hash = digest(receipt_bytes)
        receipt_key = key.removesuffix(".jsonl") + ".receipt.json"
        publication_state.update({"receipt_key": receipt_key, "receipt_sha256": receipt_hash,
                                  "catalog_version_id": published_version})
        try:
            s3.put_object(Bucket=BUCKET, Key=receipt_key, Body=receipt_bytes, ContentLength=len(receipt_bytes),
                          ContentType="application/json", IfNoneMatch="*",
                          ChecksumSHA256=base64.b64encode(bytes.fromhex(receipt_hash)).decode(),
                          Metadata={"content-sha256": receipt_hash})
        except Exception as error:
            code = getattr(error, "response", {}).get("Error", {}).get("Code")
            if code not in ("PreconditionFailed", "412", "ConditionalRequestConflict", "409"):
                raise
        receipt_version = verify(s3, receipt_key, len(receipt_bytes), receipt_hash)
        head_current(s3, version)
        authorize(event, authorizations, now)
        return {**receipt, "receipt_key": receipt_key, "receipt_sha256": receipt_hash,
                "receipt_version_id": receipt_version}


def handler(event, context=None):
    # Never include AWS error strings, parser excerpts, keys or records in failure output.
    try:
        import boto3
        import os
        from botocore.config import Config
        authority_raw = os.environ.get("CFO_CATALOG_MATERIALIZER_AUTHORIZATIONS_JSON", "")
        require(len(authority_raw.encode("utf-8")) <= 16384, "authority_invalid")
        try:
            authorizations = json.loads(authority_raw)
        except (ValueError, TypeError):
            raise Refused("authority_missing") from None
        s3 = boto3.client("s3", region_name="us-east-1",
                          config=Config(connect_timeout=10, read_timeout=45, retries={"max_attempts": 2}))
        return materialize(event, s3, authorizations)
    except PublicationUnknown as error:
        return {"status": "publication_unknown", "published": None, "code": "publication_unknown",
                "reconciliation": error.state}
    except Refused as error:
        return {"status": "refused", "published": False, "code": str(error)}
    except Exception:
        return {"status": "failed", "published": False, "code": "materialization_failed"}


if __name__ == "__main__":
    import sys
    # Request metadata only. No arbitrary bucket, source key, output path or credential flags.
    try:
        require(len(sys.argv) == 2, "request_shape")
        with open(sys.argv[1], "rb") as request:
            raw = request.read(16385)
        require(len(raw) <= 16384, "request_size")
        result = handler(json.loads(raw))
    except Exception:
        result = {"status": "failed", "published": False, "code": "request_invalid"}
    print(json.dumps(result, separators=(",", ":")))
    sys.exit(0 if result["status"] in ("inspected", "published") else 1)
