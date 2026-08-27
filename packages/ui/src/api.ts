/**
 * Minimal fetch client for the sched admin api (/api/*). Components pass
 * `base` (mount path) and optional `token` (Bearer) as properties — the same
 * component works against the daemon morda, a books-hosted mount, or any
 * embed that proxies the api.
 */
export async function apiGet(base: string, path: string, token?: string): Promise<unknown> {
  return apiSend(base, path, token, 'GET');
}

export async function apiPost(base: string, path: string, token: string | undefined, body: unknown): Promise<unknown> {
  return apiSend(base, path, token, 'POST', body);
}

export async function apiPatch(base: string, path: string, token: string | undefined, body: unknown): Promise<unknown> {
  return apiSend(base, path, token, 'PATCH', body);
}

export async function apiDelete(base: string, path: string, token?: string): Promise<unknown> {
  return apiSend(base, path, token, 'DELETE');
}

export async function apiSend(
  base: string,
  path: string,
  token: string | undefined,
  method: string,
  body?: unknown,
): Promise<unknown> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401) throw new Error('unauthorized — check token');
  if (res.status === 204) return null;
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const b = (await res.json()) as { error?: string };
      if (b.error) detail = b.error;
    } catch {
      /* non-json body */
    }
    throw new Error(detail);
  }
  return res.json();
}
