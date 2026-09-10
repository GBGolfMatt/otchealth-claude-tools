"""Static contract for the manual catalog-materializer image workflow."""
from pathlib import Path
import json
import re
import unittest


WORKFLOW = Path(__file__).resolve().parents[3] / ".github/workflows/build-cfo-catalog-materializer-ecr.yml"


class BuildWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW.read_text(encoding="utf-8")

    def test_is_dispatch_only_and_main_ref_gated(self):
        self.assertRegex(self.text, r"(?m)^on:\n  workflow_dispatch:\s*$")
        self.assertNotRegex(self.text, r"(?m)^  (push|pull_request|schedule|workflow_run):")
        self.assertIn("if: github.ref == 'refs/heads/main'", self.text)

    def test_uses_clean_exact_inputs_and_existing_builder(self):
        for required in (
            "git status --porcelain=v1 --untracked-files=all",
            'test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"',
            'git ls-files --error-unmatch',
            'bash "$COMPONENT/build-worker.sh"',
            "linux/amd64,linux/arm64",
            "docker buildx build",
        ):
            with self.subTest(required=required):
                worker = Path(__file__).resolve().parent.joinpath("build-worker.sh").read_text()
                self.assertIn(required, worker if required in ("linux/amd64,linux/arm64", "docker buildx build") else self.text)

    def test_runs_linux_signal_tests_before_build(self):
        tests = self.text.index("Run all source-worker tests, including Linux signal-group tests")
        build = self.text.index("Build and push the immutable multiarch worker image")
        self.assertLess(tests, build)
        self.assertIn("python3 -m unittest discover -s \"$COMPONENT\" -p 'test_*.py' -v", self.text)

    def test_uses_dedicated_aws_oidc_role_without_static_credentials(self):
        self.assertIn("arn:aws:iam::900915535335:role/otchealth-github-ecr-push-catalog-materializer", self.text)
        self.assertIn("otchealth-github-ecr-push-catalog-materializer", self.text)
        self.assertNotRegex(self.text, r"BREAKGLASS|AWS_RECOVERY|ECR_AWS_ACCESS_KEY|aws-access-key-id|aws-secret-access-key")
        self.assertNotIn("DEPOT_TOKEN", self.text)
        self.assertIn("id-token: write", self.text)
        self.assertIn("docker/setup-qemu-action@v3", self.text)
        self.assertIn("docker/setup-buildx-action@v3", self.text)
        self.assertNotIn("depot/setup-action", self.text)

    def test_prepared_role_is_cto_main_only_and_registry_only(self):
        root = Path(__file__).resolve().parents[3]
        trust = json.loads((root / "infra/oidc/policies/trust-catalog-materializer-ecr-push.json").read_text())
        permissions = json.loads((root / "infra/oidc/policies/permissions-catalog-materializer-ecr-push.json").read_text())
        subject = trust["Statement"][0]["Condition"]["StringEquals"]["token.actions.githubusercontent.com:sub"]
        self.assertEqual(subject, "repo:InnerScopeHearing/otchealth-cto:ref:refs/heads/main")
        actions = {action for statement in permissions["Statement"] for action in ([statement["Action"]] if isinstance(statement["Action"], str) else statement["Action"])}
        self.assertTrue(actions.issubset({
            "ecr:GetAuthorizationToken", "ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer",
            "ecr:BatchGetImage", "ecr:PutImage", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
            "ecr:CompleteLayerUpload", "ecr:DescribeRepositories", "ecr:DescribeImages",
        }))
        self.assertIn("arn:aws:ecr:us-east-1:__ACCOUNT_ID__:repository/doc-indexer", json.dumps(permissions))
        self.assertNotIn("s3:", json.dumps(permissions).lower())
        self.assertNotIn("iam:", json.dumps(permissions).lower())

    def test_uploads_only_sanitized_receipt_files(self):
        upload = self.text[self.text.index("Upload sanitized immutable build receipt"):]
        for name in ("receipt.json", "receipt.sha256", "manifest.json", "build-metadata.json"):
            self.assertIn(name, upload)
        self.assertNotIn("materialize.py", upload)
        self.assertNotIn("catalog.jsonl", upload)
        self.assertIn("overwrite: false", upload)
        self.assertIn("retention-days: 30", upload)


if __name__ == "__main__":
    unittest.main()
