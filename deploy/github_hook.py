#!/usr/bin/env python3
"""Signed GitHub push receiver. Queues identifiers, never executes payload text."""
import argparse
import hashlib
import hmac
import json
import os
import re
import tempfile
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


def atomic(file, data, mode=0o600):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=file.parent, prefix=".write-")
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "w") as stream:
            json.dump(data, stream, ensure_ascii=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, file)
        directory = os.open(file.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Receiver:
    def __init__(self, config, secret):
        self.config, self.secret = config, secret
        self.root = Path(config["queue_root"])
        for name in ("pending", "received", "results"):
            (self.root / name).mkdir(parents=True, exist_ok=True)

    def accept(self, raw, headers):
        expected = "sha256=" + hmac.new(self.secret.encode(), raw, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, headers.get("X-Hub-Signature-256", "")):
            return 403, {"ok": False, "error": "signature"}
        delivery = headers.get("X-GitHub-Delivery", "")
        if not re.fullmatch(r"[0-9a-fA-F-]{36}", delivery):
            return 400, {"ok": False, "error": "delivery"}
        try:
            data = json.loads(raw)
        except (ValueError, UnicodeError):
            return 400, {"ok": False, "error": "json"}
        if not isinstance(data, dict) or data.get("repository", {}).get("full_name") != self.config["repository"]:
            return 403, {"ok": False, "error": "repository"}
        event = headers.get("X-GitHub-Event")
        if event == "ping":
            return 200, {"ok": True, "event": "ping"}
        if event != "push" or data.get("ref") != self.config["ref"] or data.get("deleted"):
            return 202, {"ok": True, "ignored": True}
        sha = data.get("after", "")
        if not re.fullmatch(r"[0-9a-f]{40}", sha) or sha == "0" * 40:
            return 400, {"ok": False, "error": "commit"}
        record = {"delivery": delivery, "sha": sha, "received_at": time.time(), "repository": self.config["repository"], "ref": self.config["ref"]}
        seen, pending = self.root / "received" / (delivery + ".json"), self.root / "pending" / (delivery + ".json")
        if seen.exists():
            previous = json.loads(seen.read_text())
            if previous["sha"] != sha:
                return 409, {"ok": False, "error": "delivery_conflict"}
            return 202, {"ok": True, "duplicate": True, "delivery": delivery}
        # Queue first: a crash before the receipt can at worst requeue the same event.
        atomic(pending, record, 0o640)
        atomic(seen, record, 0o640)
        return 202, {"ok": True, "queued": True, "delivery": delivery}


def handler(receiver):
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            self.connection.settimeout(10)
            if self.path != "/hooks/github":
                return self.reply(404, {"ok": False})
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if size <= 0 or size > 2_097_152:
                    return self.reply(413, {"ok": False})
                raw = self.rfile.read(size)
                if len(raw) != size:
                    return self.reply(400, {"ok": False})
                status, result = receiver.accept(raw, self.headers)
                self.reply(status, result)
            except (ValueError, TypeError, TimeoutError):
                self.reply(400, {"ok": False, "error": "invalid_request"})
            except Exception as error:
                print(json.dumps({"event": "receiver_error", "type": type(error).__name__}), flush=True)
                self.reply(500, {"ok": False})

        def reply(self, status, result):
            payload = json.dumps(result).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args):
            pass
    return Handler


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="/etc/handover-ui/deploy.json")
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    secret = os.environ.get("HANDOVER_WEBHOOK_SECRET") or Path(config["webhook_secret_file"]).read_text().strip()
    if len(secret) < 32:
        raise SystemExit("webhook secret too short")
    HTTPServer(("127.0.0.1", config["hook_port"]), handler(Receiver(config, secret))).serve_forever()
