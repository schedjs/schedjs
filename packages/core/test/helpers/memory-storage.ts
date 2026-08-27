import type { CompleteResult, RunFinish, RunUpdate, ScheduleListFilter, Storage } from '../../src/storage.js';
import type { RunRecord, ScheduleRecord, TaskRecord } from '../../src/types.js';

/**
 * In-memory Storage fake for engine tests. Mirrors the semantics pinned by the
 * shared contract suite (test/storage-contract.ts) — the engine tests exercise
 * state-machine logic against this, while adapter correctness is the contract's
 * job. Exposes the maps for direct inspection.
 */
export class MemoryStorage implements Storage {
  tasks = new Map<string, TaskRecord>();
  runs = new Map<string, RunRecord>();
  schedules = new Map<string, ScheduleRecord>();

  async upsertTask(task: TaskRecord): Promise<void> {
    this.tasks.set(task.name, { ...task });
  }

  async getTask(name: string): Promise<TaskRecord | null> {
    return this.tasks.get(name) ?? null;
  }

  async listTasks(filter: { limit?: number; offset?: number } = {}): Promise<TaskRecord[]> {
    const list = [...this.tasks.values()].sort((a, b) => a.name.localeCompare(b.name));
    return list.slice(filter.offset ?? 0, (filter.offset ?? 0) + (filter.limit ?? 100));
  }

  async deleteTask(name: string): Promise<void> {
    this.tasks.delete(name);
  }

  async createSchedule(schedule: ScheduleRecord): Promise<ScheduleRecord> {
    // dedupKey is the stable handle: a create whose dedupKey exists updates
    // that row (id preserved), never a duplicate — mirrors the SQL adapters.
    if (schedule.dedupKey !== null && schedule.dedupKey !== undefined) {
      for (const [id, s] of this.schedules) {
        if (s.dedupKey === schedule.dedupKey && id !== schedule.id) {
          const merged = { ...s, ...schedule, id };
          this.schedules.set(id, { ...merged, data: structuredClone(merged.data) });
          return merged;
        }
      }
    }
    const stored = { ...schedule, data: structuredClone(schedule.data) };
    this.schedules.set(schedule.id, stored);
    return stored;
  }

  async getSchedule(id: string): Promise<ScheduleRecord | null> {
    const s = this.schedules.get(id);
    return s ? { ...s, data: structuredClone(s.data) } : null;
  }

  async updateSchedule(id: string, patch: Partial<ScheduleRecord>): Promise<void> {
    const s = this.schedules.get(id);
    if (!s) return; // idempotent no-op
    const { id: _id, ...rest } = patch; // id is the identity, never patchable
    this.schedules.set(id, { ...s, ...rest, data: structuredClone(rest.data ?? s.data) });
  }

  async deleteSchedule(id: string): Promise<void> {
    this.schedules.delete(id);
  }

  async listSchedules(filter: ScheduleListFilter = {}): Promise<ScheduleRecord[]> {
    let list = [...this.schedules.values()];
    if (filter.taskName !== undefined) list = list.filter((s) => s.taskName === filter.taskName);
    list.sort((a, b) => a.id.localeCompare(b.id));
    return list.slice(filter.offset ?? 0, (filter.offset ?? 0) + (filter.limit ?? 100));
  }

  // --- schedule tick loop ---
  async listDueSchedules(now: Date): Promise<ScheduleRecord[]> {
    // per-task ceiling: a task's schedules are serialized — nothing is due while
    // any sibling schedule of the same task is locked.
    const lockedTasks = new Set(
      [...this.schedules.values()].filter((s) => s.lockedAt !== null).map((s) => s.taskName),
    );
    return [...this.schedules.values()]
      .filter(
        (s) =>
          s.nextRunAt !== null &&
          s.nextRunAt <= now &&
          s.lockedAt === null &&
          !s.paused &&
          !s.disabled &&
          !lockedTasks.has(s.taskName),
      )
      .sort((a, b) => b.priority - a.priority || a.nextRunAt!.getTime() - b.nextRunAt!.getTime());
  }

  async claimSchedule(id: string, now: Date): Promise<boolean> {
    const s = this.schedules.get(id);
    if (!s || s.lockedAt !== null || s.paused || s.disabled) return false;
    for (const other of this.schedules.values()) {
      if (other.taskName === s.taskName && other.lockedAt !== null) return false; // per-task ceiling 1
    }
    s.lockedAt = now;
    return true;
  }

  async completeSchedule(id: string, result: CompleteResult): Promise<void> {
    const s = this.schedules.get(id);
    if (!s) return;
    s.nextRunAt = result.nextRunAt;
    s.lastRunAt = result.lastRunAt;
    s.lockedAt = null;
    if (result.failed) s.failCount += 1;
    if (result.retryCount !== undefined) s.retryCount = result.retryCount;
    if (result.lastRunId !== undefined) s.lastRunId = result.lastRunId;
  }

  async reapZombieScheduleLocks(olderThan: Date): Promise<number> {
    let count = 0;
    for (const s of this.schedules.values()) {
      if (s.lockedAt !== null && s.lockedAt < olderThan) {
        s.lockedAt = null;
        s.failCount += 1;
        count += 1;
      }
    }
    return count;
  }

  async refreshScheduleLock(id: string, now: Date): Promise<void> {
    const s = this.schedules.get(id);
    if (!s || s.lockedAt === null) return; // never re-locks a reaped/finished schedule
    s.lockedAt = now;
  }

  async clearScheduleLocks(): Promise<number> {
    let count = 0;
    for (const s of this.schedules.values()) {
      if (s.lockedAt !== null) {
        s.lockedAt = null;
        count += 1;
      }
    }
    return count;
  }

  async listDueTasks(now: Date): Promise<TaskRecord[]> {
    return [...this.tasks.values()]
      .filter(
        (t) => t.nextRunAt !== null && t.nextRunAt <= now && t.lockedAt === null && !t.paused && !t.disabled,
      )
      .sort((a, b) => b.priority - a.priority || a.nextRunAt!.getTime() - b.nextRunAt!.getTime());
  }

  async claimTask(name: string, now: Date): Promise<boolean> {
    const t = this.tasks.get(name);
    if (!t || t.lockedAt !== null || t.paused || t.disabled) return false;
    t.lockedAt = now;
    return true;
  }

  async completeTask(name: string, result: CompleteResult): Promise<void> {
    const t = this.tasks.get(name);
    if (!t) return;
    t.nextRunAt = result.nextRunAt;
    t.lastRunAt = result.lastRunAt;
    t.lockedAt = null;
    if (result.failed) t.failCount += 1;
    if (result.retryCount !== undefined) t.retryCount = result.retryCount;
    if (result.lastRunId !== undefined) t.lastRunId = result.lastRunId;
  }

  async reapZombieLocks(olderThan: Date): Promise<number> {
    let count = 0;
    for (const t of this.tasks.values()) {
      if (t.lockedAt !== null && t.lockedAt < olderThan) {
        t.lockedAt = null;
        t.failCount += 1;
        count += 1;
      }
    }
    return count;
  }

  async refreshLock(name: string, now: Date): Promise<void> {
    const t = this.tasks.get(name);
    if (!t || t.lockedAt === null) return; // never re-locks a reaped/finished task
    t.lockedAt = now;
  }

  async clearLocks(): Promise<number> {
    let count = 0;
    for (const t of this.tasks.values()) {
      if (t.lockedAt !== null) {
        t.lockedAt = null;
        count += 1;
      }
    }
    return count;
  }

  async createRun(run: RunRecord): Promise<void> {
    this.runs.set(run.id, { ...run, data: structuredClone(run.data), result: structuredClone(run.result) });
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return this.runs.get(runId) ?? null;
  }

  async updateRun(runId: string, patch: RunUpdate): Promise<void> {
    const r = this.runs.get(runId);
    if (!r) return;
    this.runs.set(runId, { ...r, ...patch });
  }

  async finishRun(runId: string, finish: RunFinish): Promise<void> {
    const r = this.runs.get(runId);
    if (!r) return;
    const { status, ...rest } = finish;
    this.runs.set(runId, { ...r, ...rest, status, finishedAt: new Date() });
  }

  async deleteRun(runId: string): Promise<void> {
    this.runs.delete(runId);
  }

  async pruneRuns(filter: { olderThan: Date; temporary: boolean }): Promise<number> {
    const terminal = new Set(['succeeded', 'failed', 'cancelled']);
    let count = 0;
    for (const [id, r] of [...this.runs]) {
      if (
        r.finishedAt !== null &&
        r.finishedAt < filter.olderThan &&
        r.temporary === filter.temporary &&
        terminal.has(r.status)
      ) {
        this.runs.delete(id);
        count += 1;
      }
    }
    return count;
  }

  async listRuns(filter: { taskName?: string; status?: string; limit?: number; offset?: number } = {}): Promise<RunRecord[]> {
    let list = [...this.runs.values()];
    if (filter.taskName !== undefined) list = list.filter((r) => r.taskName === filter.taskName);
    if (filter.status !== undefined) list = list.filter((r) => r.status === filter.status);
    list.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    return list.slice(filter.offset ?? 0, (filter.offset ?? 0) + (filter.limit ?? 100));
  }
}
