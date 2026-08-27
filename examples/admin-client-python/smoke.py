"""
Live smoke of the sched admin API through the generated python client —
one F&F row per documented path (15 paths / 21 operations).

    python smoke.py [--url http://127.0.0.1:8127/api]

Prints: path | method | expected (from the spec) | got | verdict.
Exits non-zero if any path fails.

Everything goes through the generated TYPED client (spec 0.2.0): the wrapped
response shapes that previously needed the `raw_ops.py` raw-transport
workaround now deserialize natively.
"""

from __future__ import annotations

import argparse
import sys
import time
import uuid

from sched_admin_client import ApiClient, Configuration
from sched_admin_client.api import HealthApi, RunsApi, SchedulesApi, TasksApi
from sched_admin_client.exceptions import ApiException
from sched_admin_client.models import (
    CreateScheduleRequest,
    PatchScheduleBody,
    ScheduleEntry,
    TaskDefinition,
)

UNIQ = uuid.uuid4().hex[:8]
TASK = f"acpy-smoke-{UNIQ}"
FAST_CMD = ["node", "-e", "console.log('smoke ok')"]

ROWS: list[dict] = []


def row(path: str, method: str, expected: str, got: str, ok: bool):
    ROWS.append({"path": path, "method": method, "expected": expected, "got": got, "ok": ok})
    print(f"{'PASS' if ok else 'FAIL'}  {method:6} {path:32} exp={expected:48} got={got}")


def wait_terminal(runs: RunsApi, run_id: str, timeout: float = 30.0) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = runs.get_run(run_id)
        if r.status.value not in ("queued", "running"):
            return r.status.value
        time.sleep(0.5)
    return "timeout"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=None)
    args = ap.parse_args()
    base = args.url or "http://127.0.0.1:8127/api"

    client = ApiClient(Configuration(host=base))
    health, tasks, runs, scheds = HealthApi(client), TasksApi(client), RunsApi(client), SchedulesApi(client)

    # seed a task
    tasks.upsert_task(TaskDefinition(name=TASK, runner="process", config={"command": FAST_CMD}))

    # 1. GET /health
    try:
        h = health.health()
        row("/health", "GET", "200 ok=true uptimeMs>0 version", f"200 ok={h.ok} v={h.version}", h.ok is True)
    except Exception as e:  # noqa: BLE001
        row("/health", "GET", "200", f"ERR {e}", False)

    # 2. GET /tasks
    try:
        resp = tasks.list_tasks()
        names = [t.name for t in resp.tasks]
        row("/tasks", "GET", "200 {tasks[]}", f"200 {len(names)} tasks, seeded={TASK in names}", TASK in names)
    except Exception as e:  # noqa: BLE001
        row("/tasks", "GET", "200 {tasks[]}", f"ERR {e}", False)

    # 3. POST /tasks
    try:
        st = tasks.upsert_task_with_http_info(
            TaskDefinition(name=TASK, runner="process", config={"command": FAST_CMD})
        ).status_code
        row("/tasks", "POST", "200/201 upsert", f"{st} (idempotent upsert)", st in (200, 201))
    except Exception as e:  # noqa: BLE001
        row("/tasks", "POST", "200/201", f"ERR {e}", False)

    # 4. GET /tasks/{name}
    try:
        rec = tasks.get_task(TASK)
        row("/tasks/{name}", "GET", "200 TaskRecord", f"200 {rec.name}/{rec.runner}", rec.name == TASK)
    except Exception as e:  # noqa: BLE001
        row("/tasks/{name}", "GET", "200", f"ERR {e}", False)

    # 5. POST /tasks/{name}/run
    try:
        run = tasks.trigger_task(TASK).run
        st_term = wait_terminal(runs, run.id)
        row("/tasks/{name}/run", "POST", "200 {run}", f"200 status={st_term}", st_term == "succeeded")
    except Exception as e:  # noqa: BLE001
        row("/tasks/{name}/run", "POST", "200", f"ERR {e}", False)

    # 6. POST /tasks/{name}/pause  ·  7. resume
    try:
        p = tasks.pause_task(TASK)
        r = tasks.resume_task(TASK)
        ok = p.paused is True and r.paused is False
        row("/tasks/{name}/pause|resume", "POST", "200 paused flips", f"200 {p.paused}->{r.paused}", ok)
    except Exception as e:  # noqa: BLE001
        row("/tasks/{name}/pause|resume", "POST", "200", f"ERR {e}", False)

    # 8. GET /runs
    try:
        resp = runs.list_runs(task=TASK)
        row("/runs", "GET", "200 {runs[]}", f"200 {len(resp.runs)} runs", len(resp.runs) >= 1)
    except Exception as e:  # noqa: BLE001
        row("/runs", "GET", "200 {runs[]}", f"ERR {e}", False)

    # 9. GET /runs/{id} (+ logFromOffset)
    try:
        r2 = tasks.trigger_task(TASK).run
        wait_terminal(runs, r2.id)
        rec = runs.get_run(r2.id)
        chunk = runs.get_run(r2.id, log_from_offset=0)
        ok = rec.status.value == "succeeded" and "smoke ok" in chunk.log_chunk
        row("/runs/{id}", "GET", "200 RunRecord (+logFromOffset)", f"200 {rec.status.value}, chunk={bool(chunk.log_chunk)}", ok)
    except Exception as e:  # noqa: BLE001
        row("/runs/{id}", "GET", "200", f"ERR {e}", False)

    # 10. POST /runs/{id}/retry
    try:
        retried = runs.retry_run(r2.id).run
        row("/runs/{id}/retry", "POST", "200 {run}", f"200 new_id={retried.id != r2.id}", retried.id != r2.id)
    except Exception as e:  # noqa: BLE001
        row("/runs/{id}/retry", "POST", "200", f"ERR {e}", False)

    # 11. POST /runs/{id}/cancel (409 when finished)
    try:
        try:
            runs.cancel_run(r2.id)
            got = "200 (unexpected)"
            ok = False
        except ApiException as e:
            got = f"{e.status} already finished"
            ok = e.status == 409
        row("/runs/{id}/cancel", "POST", "200 | 409 finished", got, ok)
    except Exception as e:  # noqa: BLE001
        row("/runs/{id}/cancel", "POST", "200/409", f"ERR {e}", False)

    # 12. DELETE /runs/{id}
    try:
        resp = runs.delete_run_with_http_info(retried.id)
        ok = resp.status_code == 204
        row("/runs/{id}", "DELETE", "204", f"{resp.status_code}", ok)
    except Exception as e:  # noqa: BLE001
        row("/runs/{id}", "DELETE", "204", f"ERR {e}", False)

    # 13. GET /runs/{id}/artifacts/{idx}
    try:
        try:
            runs.get_run_artifact(r2.id, 0)
            got, ok = "200 (unexpected)", False
        except ApiException as e:
            got, ok = f"{e.status} no artifacts", e.status == 404
        row("/runs/{id}/artifacts/{idx}", "GET", "200 bytes | 404", got, ok)
    except Exception as e:  # noqa: BLE001
        row("/runs/{id}/artifacts/{idx}", "GET", "200/404", f"ERR {e}", False)

    # 14. GET /schedules
    try:
        resp = scheds.list_schedules()
        row("/schedules", "GET", "200 {schedules[]}", f"200 {len(resp.schedules)} schedules", isinstance(resp.schedules, list))
    except Exception as e:  # noqa: BLE001
        row("/schedules", "GET", "200", f"ERR {e}", False)

    # 15. POST /schedules (+ dedup upsert)
    try:
        dk = f"acpy-dk-{UNIQ}"
        resp1 = scheds.create_schedule_with_http_info(
            CreateScheduleRequest(task_name=TASK, schedule=ScheduleEntry(cron="*/5 * * * *", dedup_key=dk))
        )
        resp2 = scheds.create_schedule_with_http_info(
            CreateScheduleRequest(task_name=TASK, schedule=ScheduleEntry(cron="*/7 * * * *", dedup_key=dk))
        )
        s1 = scheds.get_schedule(resp1.data.schedule.id)
        ok = resp1.status_code == 201 and resp2.status_code == 200 and resp1.data.schedule.id == resp2.data.schedule.id
        row("/schedules", "POST", "201 create / 200 dedup-upsert", f"{resp1.status_code}->{resp2.status_code} same_id={resp1.data.schedule.id == resp2.data.schedule.id}", ok)
    except Exception as e:  # noqa: BLE001
        row("/schedules", "POST", "201/200", f"ERR {e}", False)

    # 16. GET /schedules/{id}
    try:
        got = scheds.get_schedule(s1.id)
        row("/schedules/{id}", "GET", "200 ScheduleRecord", f"200 {got.id[:8]}", got.id == s1.id)
    except Exception as e:  # noqa: BLE001
        row("/schedules/{id}", "GET", "200", f"ERR {e}", False)

    # 17. PATCH /schedules/{id}
    try:
        patched = scheds.patch_schedule(s1.id, PatchScheduleBody(schedule=ScheduleEntry(cron="*/10 * * * *"))).schedule
        ok = patched.schedule.cron == "*/10 * * * *"
        row("/schedules/{id}", "PATCH", "200 rule updated", f"200 cron={patched.schedule.cron}", ok)
    except Exception as e:  # noqa: BLE001
        row("/schedules/{id}", "PATCH", "200", f"ERR {e}", False)

    # 18. POST /schedules/{id}/pause  ·  19. resume
    try:
        scheds.pause_schedule(s1.id)
        paused = scheds.get_schedule(s1.id).paused
        scheds.resume_schedule(s1.id)
        resumed = scheds.get_schedule(s1.id).paused
        ok = paused is True and resumed is False
        row("/schedules/{id}/pause|resume", "POST", "200 paused flips", f"200 {paused}->{resumed}", ok)
    except Exception as e:  # noqa: BLE001
        row("/schedules/{id}/pause|resume", "POST", "200", f"ERR {e}", False)

    # 20. DELETE /schedules/{id}
    try:
        resp = scheds.delete_schedule_with_http_info(s1.id)
        row("/schedules/{id}", "DELETE", "204", f"{resp.status_code}", resp.status_code == 204)
    except Exception as e:  # noqa: BLE001
        row("/schedules/{id}", "DELETE", "204", f"ERR {e}", False)

    # 21. DELETE /tasks/{name} (cleanup, last)
    try:
        resp = tasks.delete_task_with_http_info(TASK)
        row("/tasks/{name}", "DELETE", "204", f"{resp.status_code}", resp.status_code == 204)
    except Exception as e:  # noqa: BLE001
        row("/tasks/{name}", "DELETE", "204", f"ERR {e}", False)

    failed = [r for r in ROWS if not r["ok"]]
    print(f"\npaths exercised: {len(ROWS)}  |  passed: {len(ROWS) - len(failed)}  |  failed: {len(failed)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
