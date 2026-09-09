"""Check the actual COPY inputs survive the deliberately strict build context."""
from pathlib import Path
import shlex
import unittest


class DockerContextTests(unittest.TestCase):
    def test_every_copy_source_exists_and_is_allowed_in_context(self):
        root = Path(__file__).resolve().parent
        patterns = [line.strip() for line in (root / ".dockerignore").read_text().splitlines()
                    if line.strip() and not line.lstrip().startswith("#")]
        self.assertEqual(patterns[0], "*")
        self.assertTrue(all(p.startswith("!") and not any(c in p[1:] for c in "*?[]/")
                            for p in patterns[1:]), "Review any change to the exact-file context policy")
        allowed = {p[1:] for p in patterns[1:]}
        copied = []
        for line in (root / "Dockerfile").read_text().splitlines():
            words = shlex.split(line, comments=True)
            if words and words[0].upper() == "COPY":
                self.assertGreaterEqual(len(words), 3)
                copied.extend(words[1:-1])
        self.assertTrue(copied, "No COPY inputs checked")
        for name in copied:
            with self.subTest(source=name):
                self.assertEqual(Path(name).name, name)
                self.assertTrue((root / name).is_file(), "Docker COPY source is missing")
                self.assertIn(name, allowed, "Docker COPY source is excluded by .dockerignore")


if __name__ == "__main__":
    unittest.main()
