#!/usr/bin/env python3
"""Fixed-repository release executor; root-owned configuration and ops code only."""
import argparse
import fcntl
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.request
from pathlib import Path
from github_hook import atomic


class Deployer:
    def __init__(self, config):
        self.c = config
        self.base = Path(config["base"])
        self.queue = Path(config["queue_root"])
        self.repo = self.base / "repo.git"
        self.current = self.base / "current"
        self.state_file = self.base / "deployment.json"
        self.env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_SSH_COMMAND": config["git_ssh_command"]}

    def run(self, command, cwd=None, timeout=180):
        return subprocess.run(command, cwd=cwd, env=self.env, check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout).stdout.strip()

    def git(self, *args):
        return self.run(["git", "--git-dir=" + str(self.repo), *args])

    def latest(self):
        self.git("fetch", "--no-tags", "origin", "+" + self.c["ref"] + ":refs/remotes/origin/main")
        sha = self.git("rev-parse", "refs/remotes/origin/main^{commit}")
        if not re.fullmatch(r"[0-9a-f]{40}", sha):
            raise RuntimeError("invalid remote commit")
        return sha

    def prepare(self, sha):
        release = self.base / "releases" / sha
        if (release / ".ready").exists():
            return release
        if release.exists():
            shutil.rmtree(release)
        release.mkdir(parents=True)
        with tempfile.TemporaryFile() as archive:
            subprocess.run(["git", "--git-dir=" + str(self.repo), "archive", sha], env=self.env, check=True, stdout=archive)
            archive.seek(0)
            with tarfile.open(fileobj=archive) as package:
                package.extractall(release, filter="data")
        (release / "VERSION").write_text(sha + "\n")
        self.run(["chown", "-R", self.c["app_user"] + ":" + self.c["app_user"], str(release)])
        # Dependencies and repository tests run with no privileged credentials.
        base = ["runuser", "-u", self.c["app_user"], "--"]
        self.run([*base, "npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=release, timeout=240)
        result = self.run([*base, "npm", "test"], cwd=release, timeout=240)
        print(json.dumps({"event": "release_tests_passed", "sha": sha, "summary": result[-600:]}), flush=True)
        (release / ".ready").touch()
        # Runtime is read-only; persistent data is outside every release.
        self.run(["chown", "-R", "root:root", str(release)])
        return release

    def switch(self, target):
        temporary = self.base / (".current-" + str(os.getpid()))
        temporary.unlink(missing_ok=True)
        temporary.symlink_to(target)
        os.replace(temporary, self.current)

    def restart(self):
        self.run(["systemctl", "restart", self.c["service"]], timeout=40)

    def health(self, sha):
        for _ in range(25):
            try:
                with urllib.request.urlopen(self.c["health_url"], timeout=2) as reply:
                    body = json.load(reply)
                    if body.get("ok") and body.get("version") == sha:
                        return
            except (OSError, ValueError):
                pass
            time.sleep(0.4)
        raise RuntimeError("health check failed")

    def activate(self, sha, release):
        previous = self.current.resolve() if self.current.exists() else None
        try:
            self.switch(release)
            self.restart()
            self.health(sha)
        except Exception:
            if previous:
                self.switch(previous)
                self.restart()
                self.health(previous.name)
                print(json.dumps({"event": "rolled_back", "sha": previous.name}), flush=True)
            else:
                self.current.unlink(missing_ok=True)
                self.run(["systemctl", "stop", self.c["service"]], timeout=40)
            raise

    def execute(self):
        self.base.mkdir(parents=True, exist_ok=True)
        with (self.base / "deploy.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            while True:
                pending = sorted((self.queue / "pending").glob("*.json"))
                if not pending:
                    return
                records = [json.loads(p.read_text()) for p in pending]
                state = json.loads(self.state_file.read_text()) if self.state_file.exists() else {}
                sha = None
                try:
                    if any(x["repository"] != self.c["repository"] or x["ref"] != self.c["ref"] for x in records):
                        raise RuntimeError("queue identity mismatch")
                    sha = self.latest()
                    # The notification is a trigger; only the verified current branch is published.
                    # Even a redelivered old push can never switch back to its old commit.
                    if state.get("failed_sha") == sha:
                        result = {"status": "blocked_failed_commit", "sha": sha}
                    elif self.current.exists() and self.current.resolve().name == sha:
                        self.health(sha)
                        result = {"status": "unchanged", "sha": sha}
                    else:
                        release = self.prepare(sha)
                        if self.latest() != sha:
                            continue  # Build was superseded; prepare the latest branch instead.
                        self.activate(sha, release)
                        state = {"status": "success", "current": sha, "successful_sha": sha, "updated_at": time.time(), "deliveries": [x["delivery"] for x in records]}
                        atomic(self.state_file, state, 0o644)
                        result = {"status": "success", "sha": sha}
                except Exception as error:
                    result = {"status": "failed", "sha": sha, "error": type(error).__name__}
                    state.update({"status": "failed", "failed_sha": sha, "updated_at": time.time(), "error": type(error).__name__})
                    atomic(self.state_file, state, 0o644)
                    # Sanitized diagnostics: subprocess output may contain only fixed Git URLs and build logs.
                    detail = getattr(error, "stdout", "") or str(error)
                    print(json.dumps({"event": "deploy_failed", **result, "detail": detail[-4000:]}), flush=True)
                for file, event in zip(pending, records):
                    atomic(self.queue / "results" / file.name, {**event, **result, "finished_at": time.time()}, 0o644)
                    file.unlink(missing_ok=True)
                print(json.dumps({"event": "deployment", **result, "deliveries": [x["delivery"] for x in records]}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="/etc/handover-ui/deploy.json")
    args = parser.parse_args()
    Deployer(json.loads(Path(args.config).read_text())).execute()
