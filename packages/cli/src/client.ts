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
}

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
    const qs = params.toString();
    const body = await this.req<{ runs: Array<Record<string, unknown>> }>('GET', `/runs${qs ? `?${qs}` : ''}`);
    return body.runs;
  }

  async listSchedules(): Promise<Array<Record<string, unknown>>> {
    const body = await this.req<{ schedules: Array<Record<string, unknown>> }>('GET', '/schedules');
    return body.schedules;
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
