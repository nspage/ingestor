#!/usr/bin/env python3
"""Chrome native messaging host: start/stop the local pipeline server."""

import json
import os
import struct
import subprocess
import sys
import urllib.error
import urllib.request

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HEALTH = "http://127.0.0.1:3000/api/extension/health"
LOG = os.path.join(os.path.expanduser("~"), "Library", "Logs", "yt-pipeline.log")
PIDFILE = os.path.join(os.path.expanduser("~"), "Library", "Logs", "yt-pipeline.pid")


def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if not raw_len:
        sys.exit(0)
    length = struct.unpack("<I", raw_len)[0]
    return json.loads(sys.stdin.buffer.read(length))


def send_message(payload):
    encoded = json.dumps(payload).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def is_up():
    try:
        with urllib.request.urlopen(HEALTH, timeout=1.5) as res:
            return res.status == 200
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def start_server():
    if is_up():
        return {"ok": True, "alreadyRunning": True}

    starter = os.path.join(PROJECT, "scripts", "start-server.sh")
    subprocess.Popen(
        ["/bin/zsh", starter],
        cwd=PROJECT,
        start_new_session=True,
    )
    return {"ok": True, "started": True}


def main():
    try:
        msg = read_message()
    except Exception as err:
        send_message({"ok": False, "error": str(err)})
        return

    action = (msg or {}).get("action", "start")
    if action == "status":
        send_message({"ok": True, "running": is_up()})
        return
    if action == "start":
        try:
            send_message(start_server())
        except Exception as err:
            send_message({"ok": False, "error": str(err)})
        return
    send_message({"ok": False, "error": f"unknown action: {action}"})


if __name__ == "__main__":
    main()
