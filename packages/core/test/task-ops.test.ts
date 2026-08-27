import { describe, expect, it } from 'vitest';
import { createTaskOps } from '../src/task-ops.js';
import { MemoryStorage } from './helpers/memory-storage.js';
import { makeSchedule, makeTask } from '../src/storage-contract.js';

describe('task ops (queue-ops, books Phase 3)', () => {
  it('pause/resume toggles the paused flag', async () => {
    const storage = new MemoryStorage();
    const ops = createTaskOps(storage);
    await storage.upsertTask(makeTask());

    await ops.pauseTask('task-a');
    expect((await storage.getTask('task-a'))!.paused).toBe(true);
    expect((await ops.listTasks())[0]!.paused).toBe(true);

    await ops.resumeTask('task-a');
    expect((await storage.getTask('task-a'))!.paused).toBe(false);
  });

  it('pauseSchedule/resumeSchedule toggle only the schedule flag (AND semantics: levels are independent)', async () => {
    const storage = new MemoryStorage();
    const ops = createTaskOps(storage);
    await storage.createSchedule(makeSchedule());

    await ops.pauseSchedule('sched-1');
    expect((await ops.getSchedule('sched-1'))!.paused).toBe(true);
    expect((await storage.getTask('task-a'))).toBeNull(); // schedule-only — the task row is untouched

    await ops.resumeSchedule('sched-1');
    expect((await ops.getSchedule('sched-1'))!.paused).toBe(false);
    // an unknown schedule is an idempotent no-op (updateSchedule contract)
    await expect(ops.pauseSchedule('nope')).resolves.toBeUndefined();
  });

  it('disable/enable toggles the disabled flag', async () => {
    const storage = new MemoryStorage();
    const ops = createTaskOps(storage);
    await storage.upsertTask(makeTask());

    await ops.disableTask('task-a');
    expect((await storage.getTask('task-a'))!.disabled).toBe(true);

    await ops.enableTask('task-a');
    expect((await storage.getTask('task-a'))!.disabled).toBe(false);
  });

  it('getTask returns null for a missing task', async () => {
    const storage = new MemoryStorage();
    const ops = createTaskOps(storage);
    expect(await ops.getTask('nope')).toBeNull();
  });

  it('deleteTask removes a task', async () => {
    const storage = new MemoryStorage();
    const ops = createTaskOps(storage);
    await storage.upsertTask(makeTask());

    await ops.deleteTask('task-a');
    expect(await ops.getTask('task-a')).toBeNull();
  });
});
