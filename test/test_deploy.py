import hashlib
import hmac
import importlib.util
import json
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "deploy"))
from github_hook import Receiver
from deploy import Deployer


class WebhookTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.config = {"queue_root": str(self.root), "repository": "test/private", "ref": "refs/heads/main"}
        self.secret = "test-signing-secret-with-at-least-32-chars"
        self.receiver = Receiver(self.config, self.secret)

    def tearDown(self):
        self.temporary.cleanup()

    def event(self, **changes):
        data = {"repository": {"full_name": "test/private"}, "ref": "refs/heads/main", "after": "a" * 40, **changes}
        raw = json.dumps(data).encode()
        return raw, {"X-Hub-Signature-256": "sha256=" + hmac.new(self.secret.encode(), raw, hashlib.sha256).hexdigest(), "X-GitHub-Event": "push", "X-GitHub-Delivery": str(uuid.uuid4())}

    def test_signature_and_repository_are_required(self):
        raw, headers = self.event()
        headers["X-Hub-Signature-256"] = "sha256=bad"
        self.assertEqual(self.receiver.accept(raw, headers)[0], 403)
        raw, headers = self.event(repository={"full_name": "other/private"})
        self.assertEqual(self.receiver.accept(raw, headers)[0], 403)
        self.assertFalse(list((self.root / "pending").iterdir()))

    def test_wrong_branch_and_deleted_branch_do_not_deploy(self):
        for change in ({"ref": "refs/heads/other"}, {"deleted": True}):
            raw, headers = self.event(**change)
            self.assertTrue(self.receiver.accept(raw, headers)[1]["ignored"])
        self.assertFalse(list((self.root / "pending").iterdir()))

    def test_delivery_is_durable_and_replay_does_not_requeue(self):
        raw, headers = self.event()
        self.assertTrue(self.receiver.accept(raw, headers)[1]["queued"])
        pending = list((self.root / "pending").iterdir())
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0].stat().st_mode & 0o777, 0o640)
        pending[0].unlink()
        restarted = Receiver(self.config, self.secret)
        self.assertTrue(restarted.accept(raw, headers)[1]["duplicate"])
        self.assertFalse(list((self.root / "pending").iterdir()))

    def test_malformed_commit_never_becomes_a_command(self):
        raw, headers = self.event(after="$(touch /tmp/should-never-exist)")
        self.assertEqual(self.receiver.accept(raw, headers)[0], 400)

    def test_failed_health_rolls_back_and_checks_previous_version(self):
        current = self.root / "current"
        old = self.root / ("a" * 40)
        new = self.root / ("b" * 40)
        old.mkdir()
        new.mkdir()
        current.symlink_to(old)
        deployer = Deployer({**self.config, "base": str(self.root), "git_ssh_command": "ssh"})
        deployer.restart = Mock()
        deployer.health = Mock(side_effect=[RuntimeError("unhealthy"), None])
        with self.assertRaisesRegex(RuntimeError, "unhealthy"):
            deployer.activate(new.name, new)
        self.assertEqual(current.resolve(), old.resolve())
        self.assertEqual(deployer.restart.call_count, 2)
        self.assertEqual([x.args[0] for x in deployer.health.call_args_list], [new.name, old.name])

    def test_failed_commit_is_not_retried_by_redelivery(self):
        pending = self.root / "pending"
        event = {"delivery": str(uuid.uuid4()), "repository": "test/private", "ref": "refs/heads/main", "sha": "a" * 40}
        (pending / (event["delivery"] + ".json")).write_text(json.dumps(event))
        (self.root / "deployment.json").write_text(json.dumps({"failed_sha": "a" * 40}))
        deployer = Deployer({**self.config, "base": str(self.root), "git_ssh_command": "ssh"})
        deployer.latest = Mock(return_value="a" * 40)
        deployer.prepare = Mock()
        deployer.execute()
        deployer.prepare.assert_not_called()
        result = json.loads(next((self.root / "results").iterdir()).read_text())
        self.assertEqual(result["status"], "blocked_failed_commit")


if __name__ == "__main__":
    unittest.main()
