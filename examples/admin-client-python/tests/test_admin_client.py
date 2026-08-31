"""
sched admin API — client conformance suite (15 paths / 21 operations).

The client under test is GENERATED from the published OpenAPI spec
(`@schedjs/admin-api/openapi.json`, npm 0.2.0) with `openapi-generator`
(python generator). Every operation documented by the spec is exercised
against a LIVE daemon; error paths (400/404/409) are asserted where the spec
declares them.

All operations go through the generated TYPED client — the wrapped response
shapes ({task}/{run}/{schedule}, RunLogChunk, PauseResult) that previously
required the `raw_ops.py` raw-transport workaround are now declared by the
spec (F&F round 2, @schedjs/admin-api 0.2.0) and deserialize natively.

Run against a live stand:

    SCHED_ADMIN_URL=http://127.0.0.1:8127/api python -m pytest tests/ -v

Stand used during the F&F round 2 retest: published `@schedjs/daemon` 0.3.5
started with `--admin-port 8127` (NO AUTH, scratch sqlite db).
"""

from __future__ import annotations

import os
import threading
import time
import uuid

import pytest

from sched_admin_client import ApiClient, Configuration
from sched_admin_client.api import HealthApi, RunsApi, SchedulesApi, TasksApi
from sched_admin_client.exceptions import ApiException
from sched_admin_client.models import (
    CreateScheduleRequest,
    PatchScheduleBody,
    ScheduleEntry,
    TaskDefinition,
)

BASE_URL = os.environ.get("SCHED_ADMIN_URL", "http://127.0.0.1:8127/api")
UNIQ = uuid.uuid4().hex[:8]
TASK = f"acpy-{UNIQ}"
LONG_TASK = f"acpy-long-{UNIQ}"

FAST_CMD = ["node", "-e", "console.log('admin-client ok')"]
LONG_CMD = ["node", "-e", "setTimeout(()=>console.log('long done'), 300000)"]


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def client() -> ApiClient:
    return ApiClient(Configuration(host=BASE_URL))


@pytest.fixture(scope="module")
def apis(client):
    return HealthApi(client), TasksApi(client), RunsApi(client), SchedulesApi(client)


@pytest.fixture(scope="module", autouse=True)
def seed(client, apis):
    """One fast task + one long task for the whole module (idempotent upsert)."""
    _, tasks, runs, _ = apis
    tasks.upsert_task(TaskDefinition(name=TASK, runner="process", config={"command": FAST_CMD}))
    tasks.upsert_task(TaskDefinition(name=LONG_TASK, runner="process", config={"command": LONG_CMD}))
    yield
    # cleanup: cancel in-flight long runs, drop the seeded tasks
    try:
        for run in runs_of(runs, LONG_TASK):
            if run.status.value in ("queued", "running"):
                try:
                    runs.cancel_run(run.id)
                except ApiException:
                    pass
        tasks.delete_task(LONG_TASK)
        tasks.delete_task(TASK)
    except ApiException:
        pass


def runs_of(runs: RunsApi, task: str):
    resp = runs.list_runs(task=task)
    return resp.runs or []


def wait_terminal(runs: RunsApi, run_id: str, timeout: float = 30.0) -> str:
    """Poll GET /runs/{id} until the run leaves queued/running."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        run = runs.get_run(run_id)
        if run.status.value not in ("queued", "running"):
            return run.status.value
        time.sleep(0.5)
    raise AssertionError(f"run {run_id} did not reach a terminal state in {timeout}s")


def trigger_in_background(client, tasks: TasksApi, name: str):
    """POST /tasks/{name}/run blocks until the process exits (sync dispatch) —
    fire it from a thread so the suite can cancel the run in flight."""
    holder: dict = {}

    def worker():
        try:
            holder["run"] = tasks.trigger_task(name).run
        except Exception as exc:  # noqa: BLE001 — surfaced via holder
            holder["err"] = exc

    th = threading.Thread(target=worker, daemon=True)
    th.start()
    return th, holder


def wait_running_run(runs: RunsApi, task: str, timeout: float = 30.0) -> str:
    """Wait until the daemon has a queued/running run for `task`."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        for run in runs_of(runs, task):
            if run.status.value in ("queued", "running"):
                return run.id
        time.sleep(0.5)
    raise AssertionError(f"no running run for {task} within {timeout}s")


def new_schedule(apis, dedup: str):
    """POST /schedules via the typed client; returns (status, ScheduleRecord)."""
    _, tasks, _, scheds = apis
    resp = scheds.create_schedule_with_http_info(
        CreateScheduleRequest(task_name=TASK, schedule=ScheduleEntry(cron="*/5 * * * *", dedup_key=dedup))
    )
    return resp.status_code, resp.data.schedule


# ---------------------------------------------------------------------------
# GET /health
# ---------------------------------------------------------------------------

def test_health(apis):
    """GET /health — typed Health200Response (const:true gone in 0.2.0)."""
    health, _, _, _ = apis
    h = health.health()
    assert h.ok is True
    assert h.uptime_ms > 0
    assert isinstance(h.version, str) and h.version


# ---------------------------------------------------------------------------
# /tasks (GET /tasks, POST /tasks, GET/DELETE /tasks/{name}, run|pause|resume)
# ---------------------------------------------------------------------------

def test_list_tasks(apis):
    _, tasks, _, _ = apis
    resp = tasks.list_tasks()
    names = [t.name for t in resp.tasks]
    assert TASK in names  # seeded task is visible


def test_upsert_task_201_then_200(apis):
    """POST /tasks — 201 on create, 200 on idempotent upsert of the same body."""
    _, tasks, _, _ = apis
    name = f"acpy-up-{UNIQ}"
    body = TaskDefinition(name=name, runner="process", config={"command": FAST_CMD})
    r1 = tasks.upsert_task_with_http_info(body)
    assert r1.status_code == 201
    assert r1.data.task.name == name
    r2 = tasks.upsert_task_with_http_info(body)
    assert r2.status_code == 200
    assert r2.data.task.name == name
    tasks.delete_task(name)


def test_get_task(apis):
    _, tasks, _, _ = apis
    rec = tasks.get_task(TASK)
    assert rec.name == TASK
    assert rec.runner == "process"


def test_trigger_run(apis):
    """POST /tasks/{name}/run — sync process dispatch: the returned run is already terminal."""
    _, tasks, runs, _ = apis
    run = tasks.trigger_task(TASK).run
    assert run.task_name == TASK
    assert run.status.value in ("queued", "running", "succeeded", "failed", "cancelled")
    assert run.trigger.value == "manual"
    assert wait_terminal(runs, run.id, timeout=15) == "succeeded"


def test_pause_resume_task(apis):
    """POST /tasks/{name}/pause → paused:true; /resume → paused:false."""
    _, tasks, _, _ = apis
    p = tasks.pause_task(TASK)
    assert p.ok is True and p.paused is True
    assert tasks.get_task(TASK).paused is True
    r = tasks.resume_task(TASK)
    assert r.ok is True and r.paused is False
    assert tasks.get_task(TASK).paused is False


def test_404_task(apis):
    """GET /tasks/{missing} → 404 with the spec Error shape."""
    _, tasks, _, _ = apis
    with pytest.raises(ApiException) as ei:
        tasks.get_task(f"acpy-missing-{UNIQ}")
    assert ei.value.status == 404
    assert "error" in (ei.value.body or "").lower()


def test_400_invalid_task(apis):
    """POST /tasks with a body that fails server validation → 400."""
    _, tasks, _, _ = apis
    body = TaskDefinition(name=f"acpy-bad-{UNIQ}", runner="no-such-runner")
    with pytest.raises(ApiException) as ei:
        tasks.upsert_task(body)
    assert ei.value.status == 400
    assert "error" in (ei.value.body or "").lower()


def test_delete_task(apis):
    """DELETE /tasks/{name} → 204, then 404."""
    _, tasks, _, _ = apis
    name = f"acpy-del-{UNIQ}"
    tasks.upsert_task(TaskDefinition(name=name, runner="process", config={"command": FAST_CMD}))
    resp = tasks.delete_task_with_http_info(name)
    assert resp.status_code == 204
    with pytest.raises(ApiException) as ei:
        tasks.get_task(name)
    assert ei.value.status == 404


# ---------------------------------------------------------------------------
# /runs (GET /runs, GET/DELETE /runs/{id}, retry, cancel, artifacts)
# ---------------------------------------------------------------------------

def test_list_runs(apis):
    """GET /runs — list + task filter."""
    _, _, runs, _ = apis
    resp = runs.list_runs()
    assert isinstance(resp.runs, list)
    filtered = runs.list_runs(task=TASK)
    assert all(r.task_name == TASK for r in filtered.runs)
    assert len(filtered.runs) >= 1  # the trigger test seeded at least one run


def test_get_run(apis):
    """GET /runs/{id} — full RunRecord of a finished run."""
    _, tasks, runs, _ = apis
    run = tasks.trigger_task(TASK).run
    assert wait_terminal(runs, run.id) == "succeeded"
    rec = runs.get_run(run.id)
    assert rec.id == run.id
    assert rec.task_name == TASK
    assert rec.status.value == "succeeded"
    assert rec.log is not None and "admin-client ok" in rec.log


def test_get_run_log_offset(apis):
    """GET /runs/{id}?logFromOffset=0 — incremental log chunk shape (RunLogChunk)."""
    _, tasks, runs, _ = apis
    run = tasks.trigger_task(TASK).run
    wait_terminal(runs, run.id)
    chunk = runs.get_run(run.id, log_from_offset=0)
    assert chunk.log_chunk == "admin-client ok\n"
    assert chunk.log_total_length == len("admin-client ok\n")
    assert chunk.log is None


def test_retry_run(apis):
    """POST /runs/{id}/retry — new run, same task."""
    _, tasks, runs, _ = apis
    orig = tasks.trigger_task(TASK).run
    wait_terminal(runs, orig.id)
    retried = runs.retry_run(orig.id).run
    assert retried.id != orig.id
    assert retried.task_name == TASK
    wait_terminal(runs, retried.id)
    assert runs.get_run(retried.id).status.value == "succeeded"


def test_delete_run(apis):
    """DELETE /runs/{id} — terminal run → 204, then 404."""
    _, tasks, runs, _ = apis
    run = tasks.trigger_task(TASK).run
    wait_terminal(runs, run.id)
    resp = runs.delete_run_with_http_info(run.id)
    assert resp.status_code == 204
    with pytest.raises(ApiException) as ei:
        runs.get_run(run.id)
    assert ei.value.status == 404


def test_cancel_run_and_409(apis):
    """POST /runs/{id}/cancel on an in-flight run → 200 cancelled;
    DELETE on the same active run → 409 first."""
    _, tasks, runs, _ = apis
    th, holder = trigger_in_background(None, tasks, LONG_TASK)
    run_id = wait_running_run(runs, LONG_TASK, timeout=30)

    with pytest.raises(ApiException) as ei:
        runs.delete_run(run_id)
    assert ei.value.status == 409

    cancelled = runs.cancel_run(run_id).run
    assert cancelled.id == run_id
    assert wait_terminal(runs, run_id, timeout=30) == "cancelled"

    th.join(timeout=30)
    assert not th.is_alive(), "trigger request did not return after cancel"
    assert holder.get("run") is not None and holder["run"].status.value == "cancelled"


def test_cancel_finished_409(apis):
    """POST /runs/{id}/cancel on a finished run → 409 (already finished)."""
    _, tasks, runs, _ = apis
    run = tasks.trigger_task(TASK).run
    wait_terminal(runs, run.id)
    with pytest.raises(ApiException) as ei:
        runs.cancel_run(run.id)
    assert ei.value.status == 409


def test_get_run_artifact_404(apis):
    """GET /runs/{id}/artifacts/{idx} — run without artifacts → 404 (validated error path)."""
    _, tasks, runs, _ = apis
    run = tasks.trigger_task(TASK).run
    wait_terminal(runs, run.id)
    with pytest.raises(ApiException) as ei:
        runs.get_run_artifact(run.id, 0)
    assert ei.value.status == 404


# ---------------------------------------------------------------------------
# /schedules (GET/POST /schedules, GET/PATCH/DELETE /schedules/{id}, pause|resume)
# ---------------------------------------------------------------------------

def test_list_schedules(apis):
    _, _, _, scheds = apis
    resp = scheds.list_schedules()
    assert isinstance(resp.schedules, list)


def test_create_schedule_201(apis):
    """POST /schedules → 201 with a ScheduleRecord (flat Schedule rule)."""
    st, rec = new_schedule(apis, dedup=f"acpy-dk-{UNIQ}-a")
    assert st == 201
    assert rec.id
    assert rec.task_name == TASK
    assert rec.schedule.kind == "cron"
    assert rec.schedule.cron == "*/5 * * * *"
    _, _, _, scheds = apis
    scheds.delete_schedule(rec.id)


def test_create_schedule_dedup_upsert(apis):
    """POST /schedules with the same dedupKey → 200, SAME id, rule updated."""
    _, _, _, scheds = apis
    dk = f"acpy-dk-{UNIQ}-b"
    st1, rec1 = new_schedule(apis, dedup=dk)
    assert st1 == 201
    resp = scheds.create_schedule_with_http_info(
        CreateScheduleRequest(task_name=TASK, schedule=ScheduleEntry(cron="*/11 * * * *", dedup_key=dk))
    )
    assert resp.status_code == 200
    rec2 = resp.data.schedule
    assert rec2.id == rec1.id
    assert rec2.schedule.cron == "*/11 * * * *"
    scheds.delete_schedule(rec1.id)


def test_get_schedule(apis):
    """GET /schedules/{id} — the record comes back raw; generated client reads it fine."""
    _, _, _, scheds = apis
    st, rec = new_schedule(apis, dedup=f"acpy-dk-{UNIQ}-c")
    assert st == 201
    got = scheds.get_schedule(rec.id)
    assert got.id == rec.id
    assert got.task_name == TASK
    scheds.delete_schedule(rec.id)


def test_patch_schedule(apis):
    """PATCH /schedules/{id} — rule change in place (RFC 7396 merge)."""
    _, _, _, scheds = apis
    st, rec = new_schedule(apis, dedup=f"acpy-dk-{UNIQ}-d")
    resp = scheds.patch_schedule_with_http_info(
        rec.id, PatchScheduleBody(schedule=ScheduleEntry(cron="*/10 * * * *"))
    )
    assert resp.status_code == 200
    patched = resp.data.schedule
    assert patched.id == rec.id
    assert patched.schedule.cron == "*/10 * * * *"
    scheds.delete_schedule(rec.id)


def test_pause_resume_schedule(apis):
    """POST /schedules/{id}/pause|resume — effective pause flips."""
    _, _, _, scheds = apis
    st, rec = new_schedule(apis, dedup=f"acpy-dk-{UNIQ}-e")
    p = scheds.pause_schedule(rec.id)
    assert p.ok is True and p.paused is True
    assert scheds.get_schedule(rec.id).paused is True
    r = scheds.resume_schedule(rec.id)
    assert r.ok is True and r.paused is False
    assert scheds.get_schedule(rec.id).paused is False
    scheds.delete_schedule(rec.id)


def test_delete_schedule(apis):
    """DELETE /schedules/{id} → 204, then 404."""
    _, _, _, scheds = apis
    st, rec = new_schedule(apis, dedup=f"acpy-dk-{UNIQ}-f")
    assert st == 201
    resp = scheds.delete_schedule_with_http_info(rec.id)
    assert resp.status_code == 204
    with pytest.raises(ApiException) as ei:
        scheds.get_schedule(rec.id)
    assert ei.value.status == 404
