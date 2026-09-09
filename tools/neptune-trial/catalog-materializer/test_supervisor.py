import json
import os
import subprocess
import sys
import time
import unittest

from supervisor import supervise


class SupervisorTests(unittest.TestCase):
    def launch(self, program, timeout=2, grace=.2):
        def factory(command, **kwargs):
            return subprocess.Popen([sys.executable, "-c", program], **kwargs)
        return supervise(factory, timeout=timeout, grace=grace)

    def test_valid_child_result_and_no_raw_stderr(self):
        result = self.launch("import sys; print('source must never be forwarded',file=sys.stderr); print('{\"status\":\"inspected\",\"published\":false}')")
        self.assertEqual(result, {"status": "inspected", "published": False})

    def test_nonzero_cannot_claim_success_and_malformed_output_is_unknown(self):
        for program in ("print('{\"status\":\"published\",\"published\":true}'); raise SystemExit(1)",
                        "print('unstructured protected source must not escape')", "print('x'*65537)"):
            with self.subTest(program=program[:16]):
                result = self.launch(program)
                self.assertEqual(result["status"], "publication_unknown")
                self.assertIsNone(result["published"])
                self.assertNotIn("source", json.dumps(result))

    def test_hanging_child_is_stopped_by_parent_deadline(self):
        start = time.monotonic()
        result = self.launch("import time; time.sleep(60)", timeout=.2, grace=.2)
        self.assertEqual(result["status"], "publication_unknown")
        self.assertLess(time.monotonic() - start, 4)

    def test_streaming_oversize_output_is_killed_before_deadline(self):
        for size in (65537, 2097152):
            with self.subTest(size=size):
                start = time.monotonic()
                result = self.launch(f"import sys,time; sys.stdout.write('x'*{size}); sys.stdout.flush(); time.sleep(60)", timeout=10, grace=.2)
                self.assertEqual(result["status"], "publication_unknown")
                self.assertLess(time.monotonic() - start, 4)

    @unittest.skipUnless(os.name == "posix", "Production Linux process-group signal behavior")
    def test_child_ignoring_term_is_killed_after_grace(self):
        start = time.monotonic()
        result = self.launch("import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(60)", timeout=.3, grace=.2)
        self.assertEqual(result["status"], "publication_unknown")
        self.assertLess(time.monotonic() - start, 4)

    @unittest.skipUnless(os.name == "posix", "Production Linux process-group signal behavior")
    def test_child_catching_term_cannot_reset_deadline_or_claim_success(self):
        result = self.launch("import signal,time; signal.signal(signal.SIGTERM,lambda a,b:None); time.sleep(60)", timeout=.3, grace=.2)
        self.assertEqual(result["status"], "publication_unknown")
        result = self.launch("import signal,time,sys; signal.signal(signal.SIGTERM,lambda a,b:(print('{\"status\":\"inspected\",\"published\":false}',flush=True),sys.exit(0))); time.sleep(60)", timeout=.3, grace=.2)
        self.assertEqual(result["status"], "publication_unknown")


if __name__ == "__main__":
    unittest.main()
