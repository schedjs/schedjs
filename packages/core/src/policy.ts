import type { RetryPolicy, ScheduleRecord, TaskRecord } from './types.js';

/**
 * Effective schedule policy — `schedule.override ?? task.default`, resolved as a
 * WHOLE (never a partial merge): a schedule either carries its own full
 * `retry`/`priority` or inherits the task's, nothing in between (decision
 * 2026-08-18 — a half-merged policy blurs the audit).
 *
 * Declarative schedules (tasks.json) have the effective policy materialized
 * onto the row at sync (entry ?? task default, see toSchedules), so for them
 * this resolves to what the row already carries. Imperative schedules (admin
 * API) carry only their own policy — the task defaults fall out here at
 * dispatch/retry-planning time (резолв при чтении).
 */
export function resolveSchedulePolicy(
  task: TaskRecord,
  schedule: ScheduleRecord,
): { retry: RetryPolicy | null; priority: number } {
  return {
    retry: schedule.retry ?? task.retry,
    priority: schedule.priority ?? task.priority,
  };
}
