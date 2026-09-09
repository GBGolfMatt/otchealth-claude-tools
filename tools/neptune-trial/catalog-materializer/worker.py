"""Bounded ECS entry point. Requests and authority are deployment-owned metadata."""
import json
import os
import signal
import sys

from materialize import handler


def run():
    raw = os.environ.get("CFO_CATALOG_MATERIALIZER_REQUEST_JSON", "")
    if not raw or len(raw.encode("utf-8")) > 16384:
        return {"status": "refused", "published": False, "code": "request_invalid"}
    try:
        request = json.loads(raw)
    except ValueError:
        return {"status": "refused", "published": False, "code": "request_invalid"}
    return handler(request)


def deadline(signum, frame):
    raise TimeoutError("worker_deadline")


if __name__ == "__main__":
    # Linux worker only. A timeout inside materialize preserves uncertain-write semantics.
    signal.signal(signal.SIGALRM, deadline)
    signal.signal(signal.SIGTERM, deadline)
    signal.alarm(600)
    try:
        result = run()
    except Exception:
        # At process-boundary interruption the write state cannot be known safely.
        result = {"status": "publication_unknown", "published": None, "code": "worker_interrupted"}
    finally:
        signal.alarm(0)
    print(json.dumps(result, separators=(",", ":")), flush=True)
    sys.exit(0 if result["status"] in ("inspected", "published") else 1)
