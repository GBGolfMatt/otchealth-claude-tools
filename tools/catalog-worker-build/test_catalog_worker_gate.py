"""Keep the source-owned workflow-test exclusion narrow and visible."""
from pathlib import Path
import re
import unittest


WORKFLOW = Path(__file__).resolve().parents[2] / ".github/workflows/catalog-worker-checks.yml"


class CatalogWorkerGateTests(unittest.TestCase):
    def test_excludes_only_the_cto_owned_workflow_test(self):
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn('test -f "$COMPONENT/test_build_workflow.py"', text)
        self.assertIn("CTO source hosted gates own it", text)
        exclusions = re.findall(r'if \[\[ "\$\(basename "\$test"\)" == "([^"]+)" \]\]; then\n\s+continue', text)
        self.assertEqual(exclusions, ["test_build_workflow.py"])
        self.assertEqual(text.count("continue"), 1)
        self.assertIn('for test in "$COMPONENT"/test_*.py; do', text)


if __name__ == "__main__":
    unittest.main()
