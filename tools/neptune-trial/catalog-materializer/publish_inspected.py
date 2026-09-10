"""Receipt-bound CFO catalog publication. This process never reads source contents.

It accepts a hash-pinned inspect receipt plus a deployment-owned local catalog file.
The caller cannot choose a destination key: both immutable keys are derived from the
reviewed receipt. The only source operation is a HEAD check for the exact inspected
catalog VersionId before and after destination persistence.
"""
import base64
import hashlib
import json
import os
import re
from datetime import datetime, timezone

BUCKET = "otchealth-finance-legal-dr-55c84f6b"
SOURCE = "otchealthcfodata/cfo-source-docs/_CATALOG/catalog.jsonl"
DEST = "graph-trial/20260909/materialized-cfo/"
MAX_BYTES = 192 * 1024 * 1024
SHA = re.compile(r"^[a-f0-9]{64}$")


class Refused(Exception):
    pass


class PublicationUnknown(Refused):
    def __init__(self, state):
        super().__init__("publication_unknown")
        self.state = dict(state)


def require(condition, code):
    if not condition:
        raise Refused(code)


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def digest(value):
    return hashlib.sha256(value).hexdigest()


def version(value):
    return (isinstance(value, str) and 0 < len(value) <= 1024 and value != "null"
            and not re.search(r"[\x00-\x20\x7f]", value))


def head_current(s3, source_version_id):
    current = s3.head_object(Bucket=BUCKET, Key=SOURCE)
    require(current.get("VersionId") == source_version_id, "source_not_current")
    require(type(current.get("ContentLength")) is int and 0 < current["ContentLength"] <= MAX_BYTES,
            "source_size_invalid")
    require(isinstance(current.get("ETag"), str) and current["ETag"], "source_etag_missing")
    return current


_BINDING = ("schema", "cohort_id", "policy_sha256", "source_prefixes_sha256",
            "source_version_id", "source_etag_sha256", "source_catalog_content_sha256",
            "source_bytes", "catalog_content_sha256", "catalog_source_sha256",
            "catalog_bytes", "counts", "lineage", "source_current_checked")


def binding_from_inspect(receipt):
    require(type(receipt) is dict, "inspect_receipt_invalid")
    keys = set(receipt)
    optional = {"source_scope", "identity_field_census", "inventory_reconciliation"}
    require(set(_BINDING) | {"status", "published"} <= keys <= set(_BINDING) | {"status", "published"} | optional,
            "inspect_receipt_invalid")
    require(receipt.get("status") == "inspected" and receipt.get("published") is False,
            "inspect_receipt_not_inspected")
    binding = {key: receipt[key] for key in _BINDING}
    if "source_scope" in receipt:
        binding["source_scope"] = receipt["source_scope"]
    require(binding["schema"] == "cfo-catalog-materialization-v1", "inspect_receipt_invalid")
    require(isinstance(binding["cohort_id"], str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", binding["cohort_id"]),
            "inspect_receipt_invalid")
    require(SHA.fullmatch(binding["policy_sha256"] or "") and SHA.fullmatch(binding["source_prefixes_sha256"] or "")
            and SHA.fullmatch(binding["source_etag_sha256"] or "") and SHA.fullmatch(binding["source_catalog_content_sha256"] or "")
            and SHA.fullmatch(binding["catalog_content_sha256"] or "") and SHA.fullmatch(binding["catalog_source_sha256"] or ""),
            "inspect_receipt_invalid")
    require(version(binding["source_version_id"]) and type(binding["source_bytes"]) is int and 0 < binding["source_bytes"] <= MAX_BYTES
            and type(binding["catalog_bytes"]) is int and 0 < binding["catalog_bytes"] <= MAX_BYTES
            and binding["lineage"] == "catalog_association_only" and binding["source_current_checked"] is True,
            "inspect_receipt_invalid")
    counts = binding["counts"]
    require(type(counts) is dict and type(counts.get("eligible_rows")) is int and counts["eligible_rows"] > 0,
            "inspect_receipt_not_ready")
    return binding


def authorize(binding, authorizations, now):
    require(type(authorizations) is list and 0 < len(authorizations) <= 32, "authority_missing")
    matches = [item for item in authorizations if type(item) is dict and item.get("cohort_id") == binding["cohort_id"]]
    require(len(matches) == 1, "authority_mismatch")
    allowed = matches[0]
    required = {"cohort_id", "policy_sha256", "source_prefixes", "source_version_id", "allow_publish", "expires_at"}
    if "source_scope" in binding:
        required.add("source_scope")
    require(set(allowed) == required and allowed.get("allow_publish") is True, "authority_invalid")
    require(allowed["cohort_id"] == binding["cohort_id"] and allowed["policy_sha256"] == binding["policy_sha256"]
            and allowed["source_version_id"] == binding["source_version_id"], "authority_mismatch")
    require(type(allowed["source_prefixes"]) is list
            and digest(encode(sorted(allowed["source_prefixes"]))) == binding["source_prefixes_sha256"],
            "authority_mismatch")
    require(allowed.get("source_scope") == binding.get("source_scope"), "authority_mismatch")
    try:
        expiry = datetime.fromisoformat(allowed["expires_at"].replace("Z", "+00:00"))
        require(expiry.tzinfo is not None and expiry > now(), "authority_expired")
    except (AttributeError, TypeError, ValueError):
        raise Refused("authority_invalid") from None


def read_exact(open_catalog, binding):
    require(callable(open_catalog), "publication_input_invalid")
    source = open_catalog()
    actual = hashlib.sha256()
    size = 0
    try:
        for chunk in source.iter_chunks(chunk_size=65536):
            require(isinstance(chunk, bytes), "publication_input_invalid")
            size += len(chunk)
            require(size <= binding["catalog_bytes"], "publication_input_mismatch")
            actual.update(chunk)
    finally:
        source.close()
    require(size == binding["catalog_bytes"] and actual.hexdigest() == binding["catalog_content_sha256"],
            "publication_input_mismatch")


def verify(s3, key, size, expected_hash):
    response = s3.get_object(Bucket=BUCKET, Key=key)
    actual, count = hashlib.sha256(), 0
    try:
        for chunk in response["Body"].iter_chunks(chunk_size=65536):
            count += len(chunk)
            require(count <= size, "publication_conflict")
            actual.update(chunk)
    finally:
        response["Body"].close()
    require(count == size and actual.hexdigest() == expected_hash, "publication_conflict")
    require(version(response.get("VersionId")), "publication_unversioned")
    return response["VersionId"]


def publish_inspected(event, s3, open_catalog, authorizations=None, now=None):
    state = {}
    try:
        require(type(event) is dict and set(event) == {"operation", "inspect_receipt", "inspect_receipt_sha256"}
                and event["operation"] == "publish_inspected" and SHA.fullmatch(event["inspect_receipt_sha256"] or ""),
                "request_shape")
        require(digest(encode(event["inspect_receipt"])) == event["inspect_receipt_sha256"], "inspect_receipt_hash_mismatch")
        binding = binding_from_inspect(event["inspect_receipt"])
        now = now or (lambda: datetime.now(timezone.utc))
        authorize(binding, authorizations, now)
        head_current(s3, binding["source_version_id"])
        read_exact(open_catalog, binding)
        binding_hash = digest(encode(binding))
        catalog_key = f"{DEST}{binding['cohort_id']}/{binding_hash}/{binding['catalog_content_sha256']}.jsonl"
        receipt_key = catalog_key.removesuffix(".jsonl") + ".receipt.json"
        state.update({"catalog_key": catalog_key, "catalog_content_sha256": binding["catalog_content_sha256"],
                      "binding_sha256": binding_hash, "receipt_key": receipt_key,
                      "source_version_id": binding["source_version_id"]})
        catalog = open_catalog()
        try:
            s3.put_object(Bucket=BUCKET, Key=catalog_key, Body=catalog, ContentLength=binding["catalog_bytes"],
                          ContentType="application/x-ndjson", IfNoneMatch="*",
                          ChecksumSHA256=base64.b64encode(bytes.fromhex(binding["catalog_content_sha256"])).decode(),
                          Metadata={"binding-sha256": binding_hash, "content-sha256": binding["catalog_content_sha256"]})
        except Exception as error:
            code = getattr(error, "response", {}).get("Error", {}).get("Code")
            if code not in ("PreconditionFailed", "412", "ConditionalRequestConflict", "409"):
                raise
        finally:
            catalog.close()
        catalog_version_id = verify(s3, catalog_key, binding["catalog_bytes"], binding["catalog_content_sha256"])
        head_current(s3, binding["source_version_id"])
        authorize(binding, authorizations, now)
        receipt = {**binding, "status": "published", "published": True, "catalog_key": catalog_key,
                   "catalog_version_id": catalog_version_id, "binding_sha256": binding_hash}
        receipt_bytes, receipt_hash = encode(receipt), digest(encode(receipt))
        state.update({"receipt_sha256": receipt_hash, "catalog_version_id": catalog_version_id})
        try:
            s3.put_object(Bucket=BUCKET, Key=receipt_key, Body=receipt_bytes, ContentLength=len(receipt_bytes),
                          ContentType="application/json", IfNoneMatch="*",
                          ChecksumSHA256=base64.b64encode(bytes.fromhex(receipt_hash)).decode(),
                          Metadata={"content-sha256": receipt_hash})
        except Exception as error:
            code = getattr(error, "response", {}).get("Error", {}).get("Code")
            if code not in ("PreconditionFailed", "412", "ConditionalRequestConflict", "409"):
                raise
        receipt_version_id = verify(s3, receipt_key, len(receipt_bytes), receipt_hash)
        head_current(s3, binding["source_version_id"])
        authorize(binding, authorizations, now)
        return {**receipt, "receipt_key": receipt_key, "receipt_sha256": receipt_hash,
                "receipt_version_id": receipt_version_id}
    except Exception:
        if state:
            raise PublicationUnknown(state) from None
        raise


def handler(event, context=None):
    try:
        import boto3
        from botocore.config import Config
        raw = os.environ.get("CFO_CATALOG_MATERIALIZER_AUTHORIZATIONS_JSON", "")
        path = os.environ.get("CFO_CATALOG_PUBLICATION_INPUT_PATH", "")
        require(0 < len(raw.encode("utf-8")) <= 16384 and path == "/work/inspected-catalog.jsonl",
                "publication_configuration")
        authorizations = json.loads(raw)
        def open_catalog():
            return open(path, "rb")
        s3 = boto3.client("s3", region_name="us-east-1", config=Config(connect_timeout=10, read_timeout=45, retries={"max_attempts": 2}))
        return publish_inspected(event, s3, open_catalog, authorizations)
    except PublicationUnknown as error:
        return {"status": "publication_unknown", "published": None, "code": "publication_unknown", "reconciliation": error.state}
    except Refused as error:
        return {"status": "refused", "published": False, "code": str(error)}
    except Exception:
        return {"status": "failed", "published": False, "code": "catalog_publication_failed"}
