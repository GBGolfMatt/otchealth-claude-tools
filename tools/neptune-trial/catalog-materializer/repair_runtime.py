"""Source-bound repair manifest preparation. No original/text reads or catalog writes."""
import hashlib
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone

from materialize import BUCKET, SOURCE, MAX_BYTES, MAX_LINE, MAX_ROWS, head_current, Refused
from inventory_census import PREFIX, MAX_OBJECTS, MAX_PAGES
from repair_plan import build_plan

DEST = PREFIX + '_CATALOG/repair-plans/'
SHA = re.compile(r'^[a-f0-9]{64}$')


def require(ok, code):
    if not ok:
        raise Refused(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'duplicate_json_key')
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs,
                      parse_constant=lambda _: require(False, 'nonfinite_json'))


def authorize(request, approvals, now):
    fields = {'operation', 'source_version_id', 'source_sha256', 'cohort_id', 'policy_sha256'}
    require(type(request) is dict and set(request) == fields, 'repair_request_shape')
    require(request['operation'] == 'plan', 'repair_operation_invalid')
    require(type(request['source_version_id']) is str and
            re.fullmatch(r'[A-Za-z0-9._-]{1,1024}', request['source_version_id'])
            and request['source_version_id'] != 'null', 'repair_version_invalid')
    require(type(request['cohort_id']) is str and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,79}', request['cohort_id']), 'repair_cohort_invalid')
    require(all(type(request[k]) is str and SHA.fullmatch(request[k]) for k in ('source_sha256', 'policy_sha256')), 'repair_hash_invalid')
    require(type(approvals) is list and len(approvals) == 1, 'repair_authority_invalid')
    approval = approvals[0]
    require(type(approval) is dict and set(approval) == fields | {'expires_at', 'allow_manifest_write'}, 'repair_authority_invalid')
    require(all(approval[k] == request[k] for k in fields) and approval['allow_manifest_write'] is True, 'repair_authority_mismatch')
    expiry = datetime.fromisoformat(approval['expires_at'].replace('Z', '+00:00'))
    require(expiry.tzinfo is not None and now() < expiry, 'repair_authority_expired')


def inventory(s3, check):
    result, token, tokens = {}, None, set()
    for _ in range(MAX_PAGES):
        check()
        args = {'Bucket': BUCKET, 'Prefix': PREFIX, 'MaxKeys': 1000}
        if token:
            args['ContinuationToken'] = token
        page = s3.list_objects_v2(**args)
        objects = page.get('Contents', [])
        require(type(objects) is list and len(objects) <= 1000, 'repair_inventory_invalid')
        require(type(page.get('IsTruncated')) is bool, 'repair_inventory_invalid')
        if 'KeyCount' in page:
            require(type(page['KeyCount']) is int and page['KeyCount'] == len(objects), 'repair_inventory_invalid')
        for item in objects:
            key, size, etag, modified = item.get('Key'), item.get('Size'), item.get('ETag'), item.get('LastModified')
            require(type(key) is str and key.startswith(PREFIX) and key[len(PREFIX):] not in result,
                    'repair_inventory_invalid')
            require(type(size) is int and size >= 0 and type(etag) is str and bool(etag), 'repair_inventory_invalid')
            if isinstance(modified, datetime):
                modified = modified.isoformat()
            require(type(modified) is str and bool(modified), 'repair_inventory_invalid')
            result[key[len(PREFIX):]] = {'size': size, 'etag': etag, 'last_modified': modified}
            require(len(result) <= MAX_OBJECTS, 'repair_inventory_limit')
        if page['IsTruncated'] is False:
            require(page.get('NextContinuationToken') is None, 'repair_inventory_invalid')
            check()
            return result
        token = page.get('NextContinuationToken')
        require(type(token) is str and bool(token) and token not in tokens, 'repair_inventory_invalid')
        tokens.add(token)
    raise Refused('repair_inventory_limit')


def catalog_rows(stream):
    count = 0
    for index, raw in enumerate(iter(lambda: stream.readline(MAX_LINE + 2), b'')):
        require(len(raw.rstrip(b'\r\n')) <= MAX_LINE, 'repair_line_limit')
        if not raw.strip():
            continue
        count += 1
        require(count <= MAX_ROWS, 'repair_row_limit')
        row = strict_json(raw)
        require(type(row) is dict, 'repair_row_invalid')
        yield index, raw, row


def run(request, s3, approvals, now=lambda: datetime.now(timezone.utc)):
    state = {'manifest_write_possible': False}
    try:
        authorize(request, approvals, now)
        version = request['source_version_id']
        def check():
            authorize(request, approvals, now)
            return head_current(s3, version)
        head = check()
        response = s3.get_object(Bucket=BUCKET, Key=SOURCE, VersionId=version)
        if not (response.get('VersionId') == version and response.get('ETag') == head['ETag']
                and response.get('ContentLength') == head['ContentLength']):
            response['Body'].close()
            raise Refused('repair_source_pin_mismatch')
        with tempfile.TemporaryFile() as source:
            total, hashed = 0, hashlib.sha256()
            try:
                for chunk in response['Body'].iter_chunks(chunk_size=65536):
                    total += len(chunk)
                    require(total <= head['ContentLength'] <= MAX_BYTES, 'repair_source_length')
                    hashed.update(chunk)
                    source.write(chunk)
            finally:
                response['Body'].close()
            require(total == head['ContentLength'] and hashed.hexdigest() == request['source_sha256'], 'repair_source_hash_mismatch')
            listed = inventory(s3, check)
            source.seek(0)
            plan = build_plan(catalog_rows(source), listed, version, hashed.hexdigest())
        payload = canonical(plan)
        require(len(payload) <= 8 * 1024 * 1024, 'repair_manifest_limit')
        plan_hash = hashlib.sha256(payload).hexdigest()
        key = DEST + request['cohort_id'] + '/' + plan_hash + '.json'
        state.update(manifest_key=key, manifest_sha256=plan_hash)
        check()
        state['manifest_write_possible'] = True
        try:
            put = s3.put_object(Bucket=BUCKET, Key=key, Body=payload,
                                ContentType='application/json', IfNoneMatch='*')
        except Exception as error:
            code = getattr(error, 'response', {}).get('Error', {}).get('Code')
            if code not in ('PreconditionFailed', '412'):
                raise
        # Content-addressed manifest readback is inside the source-owned boundary.
        observed = s3.get_object(Bucket=BUCKET, Key=key)
        actual, size = hashlib.sha256(), 0
        try:
            for chunk in observed['Body'].iter_chunks(chunk_size=65536):
                size += len(chunk)
                require(size <= len(payload), 'repair_manifest_conflict')
                actual.update(chunk)
        finally:
            observed['Body'].close()
        require(size == len(payload) and actual.hexdigest() == plan_hash, 'repair_manifest_conflict')
        require(type(observed.get('VersionId')) is str and bool(observed['VersionId'])
                and observed['VersionId'] != 'null', 'repair_manifest_version_missing')
        check()
        return {'schema': 'catalog-repair-plan-receipt-v1', 'status': 'inspected', 'published': False,
                'manifest_written': True, 'manifest_key': key, 'manifest_version_id': observed.get('VersionId'),
                'manifest_sha256': plan_hash, 'manifest_bytes': size,
                'source_version_id': version, 'source_sha256': request['source_sha256'],
                'cohort_id': request['cohort_id'], 'policy_sha256': request['policy_sha256'],
                'catalog_write_performed': False, 'source_current_checked': True,
                'counts': plan['counts']}
    except Refused as error:
        return {'status': 'refused', 'published': False, 'code': str(error),
                'catalog_write_performed': False, **state}
    except Exception:
        return {'status': 'failed', 'published': False, 'code': 'repair_plan_failed',
                'catalog_write_performed': False, **state}


def main():
    import boto3
    raw = os.environ.get('CFO_CATALOG_REPAIR_REQUEST_JSON', '')
    approvals = os.environ.get('CFO_CATALOG_REPAIR_AUTHORIZATIONS_JSON', '')
    require(0 < len(raw.encode()) <= 16384 and 0 < len(approvals.encode()) <= 16384, 'repair_environment_invalid')
    return run(strict_json(raw), boto3.client('s3'), strict_json(approvals))


if __name__ == '__main__':
    try:
        result = main()
    except Exception:
        result = {'status': 'refused', 'published': False, 'code': 'repair_environment_invalid'}
    print(json.dumps(result, separators=(',', ':')), flush=True)
    sys.exit(0 if result['status'] == 'inspected' else 1)
