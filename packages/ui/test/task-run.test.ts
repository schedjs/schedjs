// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { render } from 'lit';
import { SchedTaskRun } from '../src/sched-task-run.js';
import { SchedStatus } from '../src/sched-status.js';

// Register so nested <sched-status> stamps upgrade in the happy-dom document.
customElements.define('sched-status', SchedStatus);

/** Stateful instance without the custom-element lifecycle (ui.test.ts pattern). */
function stateful<T>(proto: object, state: Partial<T>): T {
  const obj = { ...state } as object;
  Object.setPrototypeOf(obj, proto);
  return obj as T;
}

const mkRun = (overrides: Record<string, unknown>) => ({
  id: 'r1',
  taskName: 'sync',
  status: 'succeeded',
  startedAt: '2026-08-16T09:00:00Z',
  finishedAt: '2026-08-16T09:01:00Z',
  error: null,
  runner: 'http',
  data: null,
  result: null,
  progress: null,
  log: null,
  artifacts: null,
  workerRef: null,
  ...overrides,
});

describe('sched-task-run log rendering (prod defect 5: migrated runs carry log as an object)', () => {
  it('renders a plain-string log verbatim', () => {
    const el = stateful(SchedTaskRun.prototype, { run: mkRun({ log: 'line1\nline2' }) }) as unknown as {
      run: Record<string, unknown>;
      render(): unknown;
    };
    const container = document.createElement('div');
    render(el.render() as never, container);
    const pre = container.querySelector('pre.log');
    expect(pre?.textContent).toBe('line1\nline2');
  });

  it('renders an object log as JSON instead of [object Object]', () => {
    const el = stateful(SchedTaskRun.prototype, { run: mkRun({ log: { stdout: 'line1' } }) }) as unknown as {
      run: Record<string, unknown>;
      render(): unknown;
    };
    const container = document.createElement('div');
    render(el.render() as never, container);
    const pre = container.querySelector('pre.log');
    expect(pre?.textContent).toBe(JSON.stringify({ stdout: 'line1' }, null, 2));
  });

  it('omits the log block for a null/empty log', () => {
    const el = stateful(SchedTaskRun.prototype, { run: mkRun({ log: null }) }) as unknown as {
      run: Record<string, unknown>;
      render(): unknown;
    };
    const container = document.createElement('div');
    render(el.render() as never, container);
    expect(container.querySelector('pre.log')).toBeNull();
  });
});
