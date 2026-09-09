"""Fixed worker process, 600 second deadline and 30 second termination grace."""
import json
import pathlib
import os
import signal
import subprocess
import sys
import threading


def supervise(factory=subprocess.Popen, timeout=600, grace=30):
    command = [sys.executable, str(pathlib.Path(__file__).with_name("worker.py"))]
    interrupted = {"status": "publication_unknown", "published": None, "code": "worker_interrupted"}
    try:
        proc = factory(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                       start_new_session=os.name == "posix")
    except Exception:
        return interrupted
    timed_out = False
    def stop(force=False):
        if os.name == "posix":
            try:
                os.killpg(proc.pid, signal.SIGKILL if force else signal.SIGTERM)
            except ProcessLookupError:
                pass
        else:
            (proc.kill if force else proc.terminate)()
    chunks = []
    read_failed = threading.Event()
    overflow = threading.Event()
    def read_output():
        count = 0
        try:
            while True:
                chunk = proc.stdout.read1(4096)
                if not chunk:
                    return
                count += len(chunk)
                if count > 65536:
                    overflow.set()
                    stop(True)
                    return
                chunks.append(chunk)
        except Exception:
            read_failed.set()
            stop(True)
        finally:
            proc.stdout.close()
    reader = threading.Thread(target=read_output, daemon=True)
    reader.start()
    try:
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            stop()
            try:
                proc.wait(timeout=grace)
            except subprocess.TimeoutExpired:
                stop(True)
                proc.wait(timeout=5)
                return interrupted
        reader.join(timeout=grace)
        if reader.is_alive():
            stop(True)
            reader.join(timeout=5)
            return interrupted
        if overflow.is_set() or read_failed.is_set():
            return interrupted
        output = b"".join(chunks)
        result = json.loads(output)
        if (type(result) is not dict or result.get("status") not in
                ("inspected", "published", "not_ready_no_eligible_rows", "refused", "failed", "publication_unknown")):
            return interrupted
        if (timed_out or proc.returncode != 0) and result.get("status") in ("inspected", "published"):
            return interrupted
        if timed_out and result.get("status") != "publication_unknown":
            return interrupted
        return result
    except Exception:
        if proc.poll() is None:
            stop(True)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        return interrupted


if __name__ == "__main__":
    result = supervise()
    print(json.dumps(result, separators=(",", ":")), flush=True)
    sys.exit(0 if result["status"] in ("inspected", "published") else 1)
