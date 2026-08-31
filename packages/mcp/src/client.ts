import type { RunRecord, RunStatus, TaskRecord } from '@schedjs/core';

/** Admin API error surfaced as an MCP tool error (message only, no stack). */
export class AdminApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

export interface RunListFilter {
  task?: string;
  status?: RunStatus;
  limit?: number;
  offset?: number;
}

/**
 * Minimal client for sched's admin REST API (see @schedjs/core admin-api.ts).
 * The MCP server is a thin projection of this API — the daemon stays the
 * single owner of state; this client never opens storage itself.
 */
export class AdminApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  private async req<T>(method: string, path: string, reqBody?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
    const res = await fetch(this.baseUrl + path, {
      method,
      headers,
      ...(reqBody !== undefined ? { body: JSON.stringify(reqBody) } : {}),
    });
    if (res.status === 204) return undefined as T;
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) {
      throw new AdminApiError(res.status, body?.error ?? `admin api responded ${res.status}`);
    }
    return body as T;
  }

  async listTasks(): Promise<TaskRecord[]> {
    const body = await this.req<{ tasks: TaskRecord[] }>('GET', '/tasks');
    return body.tasks;
  }

  async getTask(name: string): Promise<TaskRecord> {
    return this.req<TaskRecord>('GET', `/tasks/${encodeURIComponent(name)}`);
  }

  async listSchedules(): Promise<Array<Record<string, unknown>>> {
    const body = await this.req<{ schedules: Array<Record<string, unknown>> }>('GET', '/schedules');
    return body.schedules;
  }

  async getSchedule(scheduleId: string): Promise<Record<string, unknown>> {
    return this.req<Record<string, unknown>>('GET', `/schedules/${encodeURIComponent(scheduleId)}`);
  }

  /** Create/upsert a schedule (by dedupKey) — the admin API's POST /schedules body verbatim. */
  async createSchedule(body: { taskName: string; schedule: Record<string, unknown>; tz?: string }): Promise<Record<string, unknown>> {
    const res = await this.req<{ schedule: Record<string, unknown> }>('POST', '/schedules', body);
    return res.schedule;
  }

  /** Partial merge over { schedule?, tz? } — absent fields keep their current value. */
  async updateSchedule(scheduleId: string, patch: { schedule?: Record<string, unknown>; tz?: string }): Promise<Record<string, unknown>> {
    const res = await this.req<{ schedule: Record<string, unknown> }>('PATCH', `/schedules/${encodeURIComponent(scheduleId)}`, patch);
    return res.schedule;
  }

  async pauseSchedule(scheduleId: string): Promise<void> {
    await this.req('POST', `/schedules/${encodeURIComponent(scheduleId)}/pause`);
  }

  async resumeSchedule(scheduleId: string): Promise<void> {
    await this.req('POST', `/schedules/${encodeURIComponent(scheduleId)}/resume`);
  }

  async deleteSchedule(scheduleId: string): Promise<void> {
    await this.req('DELETE', `/schedules/${encodeURIComponent(scheduleId)}`);
  }

  async deleteTask(name: string): Promise<void> {
    await this.req('DELETE', `/tasks/${encodeURIComponent(name)}`);
  }

  async cancelRun(runId: string): Promise<RunRecord> {
    const body = await this.req<{ run: RunRecord }>('POST', `/runs/${encodeURIComponent(runId)}/cancel`);
    return body.run;
  }

  async retryRun(runId: string, triggeredBy?: string): Promise<RunRecord> {
    const body = await this.req<{ run: RunRecord }>('POST', `/runs/${encodeURIComponent(runId)}/retry`, {
      ...(triggeredBy !== undefined ? { triggeredBy } : {}),
    });
    return body.run;
  }

  async listRuns(filter: RunListFilter = {}): Promise<RunRecord[]> {
    const params = new URLSearchParams();
    if (filter.task !== undefined) params.set('task', filter.task);
    if (filter.status !== undefined) params.set('status', filter.status);
    if (filter.limit !== undefined) params.set('limit', String(filter.limit));
    if (filter.offset !== undefined) params.set('offset', String(filter.offset));
    const qs = params.toString();
    const body = await this.req<{ runs: RunRecord[] }>('GET', `/runs${qs ? `?${qs}` : ''}`);
    return body.runs;
  }

  async getRun(runId: string): Promise<RunRecord> {
    return this.req<RunRecord>('GET', `/runs/${encodeURIComponent(runId)}`);
  }

  async triggerTask(name: string, data?: unknown): Promise<RunRecord> {
    const body = await this.req<{ run: RunRecord }>('POST', `/tasks/${encodeURIComponent(name)}/run`, {
      ...(data !== undefined ? { data } : {}),
    });
    return body.run;
  }

  async pauseTask(name: string): Promise<void> {
    await this.req('POST', `/tasks/${encodeURIComponent(name)}/pause`);
  }

  async resumeTask(name: string): Promise<void> {
    await this.req('POST', `/tasks/${encodeURIComponent(name)}/resume`);
  }

  async deleteRun(runId: string): Promise<void> {
    await this.req('DELETE', `/runs/${encodeURIComponent(runId)}`);
  }
}
