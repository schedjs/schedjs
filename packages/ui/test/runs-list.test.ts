// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { render } from 'lit';
import { SchedRuns } from '../src/sched-runs.js';
import { SchedStatus } from '../src/sched-status.js';

// Register so nested <sched-status> stamps upgrade in the happy-dom document.
// (happy-dom can't run the full LitElement lifecycle — no shadow roots, and it
// drops <tr> wrappers from lit templates — so the regression is asserted on
// sched-status NODE IDENTITY + status attributes: the property that guarantees
// a correct shadow render in a real browser.)
customElements.define('sched-status', SchedStatus);

const mk = (id: string, status: string) => ({
  id,
  taskName: 't',
  status,
  startedAt: '2026-08-16T09:00:00Z',
  finishedAt: null,
  error: null,
  runner: 'http',
  data: null,
  result: null,
  progress: null,
  log: null,
  artifacts: null,
  workerRef: null,
});

/** Stateful instance without the custom-element lifecycle (ui.test.ts pattern). */
function stateful<T>(proto: object, state: Partial<T>): T {
  const obj = { ...state } as object;
  Object.setPrototypeOf(obj, proto);
  return obj as T;
}

describe('sched-runs list identity (F&F r2 regression)', () => {
  it('a run keeps its own <sched-status> node across a refresh that prepends a new run', () => {
    // prettier-ignore
    const el = stateful(SchedRuns.prototype, { runs: [
      mk('a', 'failed'), mk('b', 'succeeded'), mk('c', 'failed'),
    ] }) as { runs: ReturnType<typeof mk>[]; render(): unknown };

    const container = document.createElement('div');
    render(el.render() as never, container);

    const statuses = () => [...container.querySelectorAll('sched-status')];
    const aNode = statuses()[0]!; // run 'a' is newest-first on top
    expect(aNode.getAttribute('status')).toBe('failed');

    // Poll refresh: a new run lands on top. An UNKEYED list reuses the node of
    // the old top row for the new run — run 'a' silently moves to a shifted
    // node and, with nested custom elements, its rendered status goes stale
    // (the admin's shift-by-one). A keyed list keeps each run's own node.
    el.runs = [mk('d', 'succeeded'), mk('a', 'failed'), mk('b', 'succeeded'), mk('c', 'failed')];
    render(el.render() as never, container);

    const after = statuses();
    expect(after).toHaveLength(4);
    // identity: run 'a' kept its own node (now at position 1), not a recycled one
    expect(after[1]).toBe(aNode);
    // statuses match data row by row
    expect(after.map((s) => s.getAttribute('status'))).toEqual([
      'succeeded',
      'failed',
      'succeeded',
      'failed',
    ]);
  });
});

describe('progress label mapping (succeeded→100, failed keeps %, null→—)', () => {
  it('renders 100% for a succeeded run even without a progress value', () => {
    const el = stateful(SchedRuns.prototype, {
      runs: [mk('a', 'succeeded')], // progress null
    }) as { runs: ReturnType<typeof mk>[]; render(): unknown };
    const container = document.createElement('div');
    render(el.render() as never, container);
    expect(container.querySelector('table')?.textContent ?? '').toContain('100%');
    container.remove();
  });

  it('keeps the % where a failed run stopped when it reported progress', () => {
    const el = stateful(SchedRuns.prototype, {
      runs: [{ ...mk('a', 'failed'), progress: 42 }],
    }) as unknown as { runs: ReturnType<typeof mk>[]; render(): unknown };
    const container = document.createElement('div');
    render(el.render() as never, container);
    const text = container.querySelector('table')?.textContent ?? '';
    expect(text).toContain('42%');
    expect(text).not.toContain('100%');
    container.remove();
  });

  it('shows a dash for a failed run that reported no progress', () => {
    const el = stateful(SchedRuns.prototype, {
      runs: [mk('a', 'failed')], // progress null
    }) as { runs: ReturnType<typeof mk>[]; render(): unknown };
    const container = document.createElement('div');
    render(el.render() as never, container);
    const text = container.querySelector('table')?.textContent ?? '';
    expect(text).not.toMatch(/\d+%/);
    container.remove();
  });
});

describe('sched-runs progress column (long-task visual tracking)', () => {
  it('renders the progress % for a run that carries a progress value', () => {
    const el = stateful(SchedRuns.prototype, {
      runs: [
        { ...mk('x', 'running'), progress: 75 },
        mk('y', 'succeeded'),
      ],
    }) as { runs: ReturnType<typeof mk>[]; render(): unknown };

    const container = document.createElement('div');
    document.body.appendChild(container);
    render(el.render() as never, container);

    // happy-dom drops <tr> wrappers from lit templates — assert on the table's
    // text content instead of row count/row structure.
    const text = container.querySelector('table')?.textContent ?? '';
    // run 'x' (progress 75%) shows its percentage; run 'y' (no progress) does not
    expect(text).toContain('75%');
    // 'y' row must not contain a bogus percentage
    const yIdx = text.indexOf('y');
    const afterY = text.slice(yIdx, yIdx + 40);
    expect(afterY).not.toContain('75%');
    container.remove();
  });
});
