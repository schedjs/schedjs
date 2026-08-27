import type { Storage } from './storage.js';
import type { RunRecord, ScheduleRecord, TaskRecord } from './types.js';

/**
 * Task operations over the {@link Storage} seam — the queue-ops surface from
 * books Phase 3 (pause/resume/disable/enable + delete). Thin read-modify-write
 * on the paused/disabled flags; fine for single-replica v1.
 *
 * Pause has TWO levels (decision 2026-08-18, AND semantics): `pauseTask` is the
 * family stop (repair window — stops every schedule of the task), `pauseSchedule`
 * stops one instance (one tenant). `resume` clears only its own level.
 */
export interface TaskOps {
  pauseTask(name: string): Promise<void>;
  resumeTask(name: string): Promise<void>;
  pauseSchedule(id: string): Promise<void>;
  resumeSchedule(id: string): Promise<void>;
  disableTask(name: string): Promise<void>;
  enableTask(name: string): Promise<void>;
  deleteTask(name: string): Promise<void>;
  getTask(name: string): Promise<TaskRecord | null>;
  getSchedule(id: string): Promise<ScheduleRecord | null>;
  listTasks(): Promise<TaskRecord[]>;
  getRun(runId: string): Promise<RunRecord | null>;
}

export function createTaskOps(storage: Storage): TaskOps {
  const setFlag = async (name: string, patch: Partial<TaskRecord>): Promise<void> => {
    const task = await storage.getTask(name);
    if (!task) return; // idempotent: pausing a missing task is a no-op
    await storage.upsertTask({ ...task, ...patch });
  };

  return {
    pauseTask: (name) => setFlag(name, { paused: true }),
    resumeTask: (name) => setFlag(name, { paused: false }),
    pauseSchedule: (id) => storage.updateSchedule(id, { paused: true }),
    resumeSchedule: (id) => storage.updateSchedule(id, { paused: false }),
    disableTask: (name) => setFlag(name, { disabled: true }),
    enableTask: (name) => setFlag(name, { disabled: false }),
    deleteTask: (name) => storage.deleteTask(name),
    getTask: (name) => storage.getTask(name),
    getSchedule: (id) => storage.getSchedule(id),
    listTasks: () => storage.listTasks(),
    getRun: (runId) => storage.getRun(runId),
  };
}
