import { SchedRuns } from './sched-runs.js';
import { SchedTasks } from './sched-tasks.js';
import { SchedSchedules } from './sched-schedules.js';
import { SchedTaskRun } from './sched-task-run.js';
import { SchedStatus } from './sched-status.js';
import { SchedQueue } from './sched-queue.js';
import { refreshFromSearch } from './refresh.js';

export { SchedRuns, SchedTasks, SchedSchedules, SchedTaskRun, SchedStatus, SchedQueue, refreshFromSearch };

/**
 * Register all sched custom elements. Safe to call repeatedly (idempotent).
 * Hosts can also import the classes directly and define them under their own
 * names via `customElements.define`.
 */
export function defineSchedElements(): void {
  for (const [tag, cls] of [
    ['sched-runs', SchedRuns],
    ['sched-tasks', SchedTasks],
    ['sched-schedules', SchedSchedules],
    ['sched-task-run', SchedTaskRun],
    ['sched-status', SchedStatus],
    ['sched-queue', SchedQueue],
  ] as const) {
    if (!customElements.get(tag)) customElements.define(tag, cls);
  }
}

defineSchedElements();
