/**
 * Thin HTTP client for the sched admin REST API — the @schedjs/cli projection
 * of the contract (see packages/core/src/admin-api.ts; the daemon mounts it
 * at /api). Zero dependencies: node:fetch only. The CLI never opens storage —
 * the daemon stays the single owner of state (precedent: @schedjs/mcp).
 */

export interface RunStatusFilter {
  task?: string;
  status?: string;
  limit?: number;
  offset?: number;
  /** Start of the `startedAt` window, ISO-8601 (inclusive). */
  since?: string;
  /** End of the `startedAt` window, ISO-8601 (inclusive). */
  until?: string;
  /** Exact runner match ('docker', 'http', …). */
  runner?: string;
}

/** Partial result of a bulk cancel/retry (R3) — never atomic, one entry per failed id. */
export interface BulkResult {
  ok: string[];
  failed: Array<{ id: string; reason: string }>;
}

/** Wire shape of `GET /queue` (R2): `pausedAt` is an ISO string, null when active. */
export interface QueueState {
  paused: boolean;
  pausedAt: string | null;
  startPaused: boolean;
}

/** Page size for the schedule sweep — matches the storage cap (`listSchedules` clamps to 1000), so one request per 1000 rows. */
const SCHEDULES_PAGE = 1000;
/** Sweep ceiling — a server that ignores `offset` must be caught, not spun on forever. */
const SCHEDULES_MAX_PAGES = 1000;

/** API error surfaced to the operator (message only, no stack). */
export class AdminApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

export class AdminApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined = undefined,
  ) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      init.headers = { ...headers, 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, init);
    } catch (err) {
      throw new Error(
        `cannot reach admin api at ${this.baseUrl} (${err instanceof Error ? err.message : String(err)}) — is the daemon running? (schedd --admin-port)`,
      );
    }
    if (res.status === 204) return undefined as T;
    const parsed = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) {
      throw new AdminApiError(res.status, parsed?.error ?? `admin api responded ${res.status}`);
    }
    return parsed as T;
  }

  async health(): Promise<{ ok: boolean; uptimeMs: number; version: string }> {
    return this.req<{ ok: boolean; uptimeMs: number; version: string }>('GET', '/health');
  }

  async listTasks(): Promise<Array<Record<string, unknown>>> {
    const body = await this.req<{ tasks: Array<Record<string, unknown>> }>('GET', '/tasks');
    return body.tasks;
  }

  async listRuns(filter: RunStatusFilter = {}): Promise<Array<Record<string, unknown>>> {
    const params = new URLSearchParams();
    if (filter.task !== undefined) params.set('task', filter.task);
    if (filter.status !== undefined) params.set('status', filter.status);
    if (filter.limit !== undefined) params.set('limit', String(filter.limit));
    if (filter.offset !== undefined) params.set('offset', String(filter.offset));
    if (filter.since !== undefined) params.set('since', filter.since);
    if (filter.until !== undefined) params.set('until', filter.until);
    if (filter.runner !== undefined) params.set('runner', filter.runner);
    const qs = params.toString();
    const body = await this.req<{ runs: Array<Record<string, unknown>> }>('GET', `/runs${qs ? `?${qs}` : ''}`);
    return body.runs;
  }

  async getQueue(): Promise<QueueState> {
    return this.req<QueueState>('GET', '/queue');
  }

  /** Bulk cancel/retry (R3): partial result, never atomic. */
  async bulkRuns(action: 'cancel' | 'retry', ids: string[]): Promise<BulkResult> {
    return this.req<BulkResult>('POST', `/runs/bulk/${action}`, { ids });
  }

  async listSchedules(): Promise<Array<Record<string, unknown>>> {
    const body = await this.req<{ schedules: Array<Record<string, unknown>> }>('GET', '/schedules');
    return body.schedules;
  }

  /**
   * Every schedule, paged (R1 follow-up). `GET /schedules` caps one response at
   * a server-side limit (default 100, storage cap 1000), so a single request
   * silently truncates a longer board — a caller that aggregates a per-task
   * total would print a number that is too small. The loop takes page-size
   * chunks until a short page; an exact multiple of the page size costs one
   * extra (empty) request, which is cheaper than a wrong number. Bounded: a
   * server that ignores `offset` (older daemon) would return the same full page
   * forever, so the sweep throws instead of hanging the CLI.
   */
  async listAllSchedules(): Promise<Array<Record<string, unknown>>> {
    const all: Array<Record<string, unknown>> = [];
    for (let page = 0; ; page += 1) {
      const body = await this.req<{ schedules: Array<Record<string, unknown>> }>(
        'GET',
        `/schedules?limit=${SCHEDULES_PAGE}&offset=${page * SCHEDULES_PAGE}`,
      );
      all.push(...body.schedules);
      if (body.schedules.length < SCHEDULES_PAGE) return all;
      if (page + 1 >= SCHEDULES_MAX_PAGES) {
        throw new Error(
          `schedules list did not converge after ${SCHEDULES_MAX_PAGES} pages — the admin api ignored limit/offset (daemon older than pagination?)`,
        );
      }
    }
  }

  async getSchedule(id: string): Promise<Record<string, unknown>> {
    return this.req<Record<string, unknown>>('GET', `/schedules/${encodeURIComponent(id)}`);
  }

  async triggerTask(name: string, data?: unknown): Promise<Record<string, unknown>> {
    const body = await this.req<{ run: Record<string, unknown> }>(
      'POST',
      `/tasks/${encodeURIComponent(name)}/run`,
      data !== undefined ? { data } : undefined,
    );
    return body.run;
  }

  async pauseTask(name: string): Promise<void> {
    await this.req('POST', `/tasks/${encodeURIComponent(name)}/pause`);
  }

  async resumeTask(name: string): Promise<void> {
    await this.req('POST', `/tasks/${encodeURIComponent(name)}/resume`);
  }

  async pauseSchedule(id: string): Promise<void> {
    await this.req('POST', `/schedules/${encodeURIComponent(id)}/pause`);
  }

  async resumeSchedule(id: string): Promise<void> {
    await this.req('POST', `/schedules/${encodeURIComponent(id)}/resume`);
  }
}
