#!/usr/bin/env python3
"""sched HTTP worker example — Python 3 stdlib (http.server), zero dependencies.

Implements the sched runner protocol (docs/content/docs/05.protocol.md):
  - POST /            dispatch envelope { task: { name, config }, data }
  - GET /status/:id   async poll endpoint (same outbound auth)

Tasks:
  - "ping"  sync:  200 { status: "succeeded"|"failed", ... }
  - "long"  async: 202 { status: "accepted", statusUrl, pollIntervalMs } ->
                    GET statusUrl -> running with progress -> terminal envelope

Auth (G1): when SCHED_API_KEY is set, every endpoint requires `x-sched-api-key`
to match (else 401). Unset -> validation skipped.
Idempotency: results are stored by `x-sched-run-id`; a redelivery of the same
run id answers with the saved outcome instead of re-executing.

Run: python3 worker.py   (Windows: py worker.py; port: SCHED_PORT, default 8081)
"""

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

API_KEY = os.environ.get("SCHED_API_KEY", "")
BASE_URL = os.environ.get("SCHED_BASE_URL", "").rstrip("/")
PORT = int(os.environ.get("SCHED_PORT", "8081"))

_lock = threading.Lock()
_runs = {}  # run_id -> state dict


def base_url(handler):
    if BASE_URL:
        return BASE_URL
    return "http://" + (handler.headers.get("Host") or "localhost")


def auth_ok(handler):
    return not API_KEY or handler.headers.get("x-sched-api-key") == API_KEY


def work_ms(data, default):
    try:
        ms = int(data.get("workMs", default))
        return ms if ms > 0 else default
    except (TypeError, ValueError):
        return default


def should_fail(data):
    return data.get("fail") is True


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quieter access log
        print("[worker] %s %s" % (self.command, self.path), flush=True)

    # -- plumbing ----------------------------------------------------------

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_envelope(self):
        try:
            length = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            return json.loads(raw.decode("utf-8") or "{}")
        except (ValueError, json.JSONDecodeError):
            return None

    # -- endpoints ---------------------------------------------------------

    def do_POST(self):
        if not auth_ok(self):
            self._json(401, {"error": "unauthorized"})
            return
        env = self._read_envelope()
        if env is None:
            self._json(400, {"error": "invalid JSON envelope"})
            return
        run_id = self.headers.get("x-sched-run-id")
        if not run_id:
            run_id = "anon-%d" % time.time_ns()
        task_name = (env.get("task") or {}).get("name", "")
        if task_name == "long":
            self._async(env, run_id)
        else:
            self._sync(env, run_id)

    def do_GET(self):
        if not auth_ok(self):
            self._json(401, {"error": "unauthorized"})
            return
        if not self.path.startswith("/status/"):
            self._json(404, {"error": "not found"})
            return
        run_id = self.path[len("/status/"):]
        with _lock:
            state = _runs.get(run_id)
        if state is None:
            self._json(404, {"error": "unknown run id"})
            return
        self._json(200, state)

    # -- task handlers -----------------------------------------------------

    def _sync(self, env, run_id):
        data = env.get("data") or {}
        with _lock:
            existing = _runs.get(run_id)
        if existing is not None:  # redelivery -> saved outcome
            self._json(200, existing)
            return
        time.sleep(work_ms(data, 100) / 1000.0)
        if should_fail(data):
            state = {
                "status": "failed",
                "progress": 100,
                "error": "worker failed on purpose (data.fail=true)",
                "log": "ping failed as requested",
            }
        else:
            state = {
                "status": "succeeded",
                "progress": 100,
                "result": {"task": (env.get("task") or {}).get("name"), "data": data, "echo": "pong"},
                "log": "ping ok",
            }
        with _lock:
            _runs[run_id] = state
        self._json(200, state)

    def _async(self, env, run_id):
        data = env.get("data") or {}
        with _lock:
            existing = _runs.get(run_id)
            if existing is None:
                state = {"status": "queued", "progress": 0, "log": "accepted"}
                _runs[run_id] = state
        if existing is not None:  # redelivery of an in-flight or finished run
            if existing["status"] in ("queued", "running"):
                self._json(202, {"status": "accepted", "statusUrl": "%s/status/%s" % (base_url(self), run_id), "pollIntervalMs": 500})
            else:
                self._json(200, existing)
            return
        status_url = "%s/status/%s" % (base_url(self), run_id)
        ms = work_ms(data, 150)
        fail = should_fail(data)
        task_name = (env.get("task") or {}).get("name")

        def work():
            for p in range(20, 101, 20):
                time.sleep(ms / 1000.0)
                with _lock:
                    state["status"] = "running"
                    state["progress"] = p
                    state["log"] = "working… %d%%" % p
            with _lock:
                if fail:
                    state["status"] = "failed"
                    state["error"] = "worker failed on purpose (data.fail=true)"
                    state["log"] = "long task failed as requested"
                else:
                    state["status"] = "succeeded"
                    state["result"] = {"task": task_name, "workMs": ms, "ok": True}
                    state["log"] = "long task completed"
                state["progress"] = 100

        threading.Thread(target=work, daemon=True).start()
        self._json(202, {"status": "accepted", "statusUrl": status_url, "pollIntervalMs": 500})


def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("[worker] sched example worker (Python) listening on :%d" % PORT, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
