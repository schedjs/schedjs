/**
 * Unified sandbox allowlist — the single matcher for every runner's
 * `allowedTools` (decision: runner-sandbox-hardening, 2026-08-17).
 *
 * Pattern format is uniform across runners: exact match or trailing-`*`
 * prefix (`node`, `alpine:*`, `read_*`). Omitted / empty `allowedTools` =
 * allow all (opt-in security — a task that declares nothing keeps today's
 * behaviour). The matcher used to be copy-pasted into docker / process / mcp;
 * this module is the one home for it.
 */

/**
 * Exact or trailing-`*` prefix match. Empty or omitted list → allow all.
 * Leading wildcards are not supported (`*node` matches literally).
 */
export function matchesPattern(value: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((p) => (p.endsWith('*') ? value.startsWith(p.slice(0, -1)) : value === p));
}

/**
 * Ceiling check: every task-declared tool must be covered by the runner-level
 * `allowedTools` (a task cannot grant itself more than the runner allows).
 * Omitted task list or ceiling → pass.
 */
export function isSubsetOf(taskTools: string[] | undefined, ceiling: string[] | undefined): boolean {
  if (!taskTools || taskTools.length === 0) return true; // nothing declared → nothing to check
  if (!ceiling || ceiling.length === 0) return true; // no ceiling → any declaration is fine
  return taskTools.every((t) => matchesPattern(t, ceiling));
}

/**
 * Read + validate the per-task `config.allowedTools`. Returns undefined when
 * absent (allow-all by default). Throws a runner-scoped error when malformed —
 * call sites translate the throw into a load-time config failure or a failed
 * run (never a crash).
 */
export function taskAllowedTools(
  cfg: Record<string, unknown> | undefined,
  runner: string,
  taskName: string,
): string[] | undefined {
  if (!cfg) return undefined;
  const t = cfg.allowedTools;
  if (t === undefined) return undefined;
  if (!Array.isArray(t) || t.some((x) => typeof x !== 'string' || x.length === 0)) {
    throw new Error(
      `${runner} runner: task "${taskName}": config.allowedTools must be an array of non-empty strings`,
    );
  }
  return t as string[];
}

/** A docker tool-spec split into its two dimensions. */
export interface DockerTool {
  /** Image pattern (`alpine`, `alpine:*`, `*`). */
  image: string;
  /** Command pattern, or undefined when the spec restricts only the image. */
  command?: string;
}

/**
 * Parse a docker tool-spec `image@cmd`. The separator is `@` — image tags
 * contain `:` (`alpine:latest`), so `image:cmd` would be ambiguous. Split on
 * the LAST `@` (neither image refs nor shell commands contain `@`). A spec
 * without `@` restricts only the image (any command inside).
 */
export function parseDockerTool(spec: string): DockerTool {
  const at = spec.lastIndexOf('@');
  if (at === -1) return { image: spec };
  return { image: spec.slice(0, at), command: spec.slice(at + 1) };
}

/**
 * Is this docker invocation (image + optional explicit command) allowed by the
 * runner's `allowedTools`? The image must match (an exact `alpine` spec also
 * matches the resolved `alpine:latest` — the `:latest`-candidate trick from
 * the old `isImageAllowed`); a spec that carries a command (`alpine@echo`)
 * additionally requires the invocation to carry a command and match it.
 * `alpine` (no `@`) covers any command, including the image default.
 */
export function dockerToolAllowed(
  image: string,
  command: string | undefined,
  patterns: string[] | undefined,
): boolean {
  if (!patterns || patterns.length === 0) return true;
  const candidates = image.endsWith(':latest') ? [image, image.slice(0, -7)] : [image];
  return patterns.some((p) => {
    const tool = parseDockerTool(p);
    if (!candidates.some((img) => matchesPattern(img, [tool.image]))) return false;
    if (tool.command !== undefined) {
      if (command === undefined) return false; // spec requires an explicit command, invocation has none
      return matchesPattern(command, [tool.command]);
    }
    return true;
  });
}

/** An mcp tool-spec `server:tool` split on the LAST colon (URLs/ports carry `:`). */
export interface McpToolSpec {
  server: string;
  tool: string;
}

/**
 * Parse `server:tool` on the last colon, so http servers with ports work
 * (`https://mcp.example.com:8443:read_data`). A spec WITHOUT a colon defaults
 * to tool `*` — any tool on that server. Caveat: an http URL carries `:`
 * (`https://…`), so a server-only http spec must be written explicitly as
 * `url:*` (`https://mcp.example.com` alone would parse as server `https`).
 */
export function parseMcpTool(spec: string): McpToolSpec {
  const colon = spec.lastIndexOf(':');
  if (colon === -1) return { server: spec, tool: '*' };
  return { server: spec.slice(0, colon), tool: spec.slice(colon + 1) };
}

/** Is this server:tool invocation allowed? Server must match, then the tool. */
export function mcpToolAllowed(
  server: string,
  tool: string,
  patterns: string[] | undefined,
): boolean {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((p) => {
    const spec = parseMcpTool(p);
    if (!matchesPattern(server, [spec.server])) return false;
    return matchesPattern(tool, [spec.tool]);
  });
}

/**
 * Fail-fast guard for mcp `server:tool` specs: an http server-only spec must
 * carry a tool dimension (`url:*` or `url:tool`). A bare `https://host` splits
 * on the last colon into server `https` + tool `//host`, which never matches a
 * real server identity (the full URL) — a silent no-match on a security
 * allowlist is worse than a loud error, so reject it at load.
 */
export function assertValidMcpToolSpecs(patterns: string[] | undefined): void {
  if (!patterns || patterns.length === 0) return;
  for (const p of patterns) {
    if (!/^https?:\/\//.test(p)) continue;
    const { server, tool } = parseMcpTool(p);
    // server-only http spec (no tool dimension): either the host itself was
    // split off (server === "https"), or a numeric port was eaten into the
    // tool dimension (server keeps the host, tool === "8443").
    if (!server.includes('://') || /^\d+$/.test(tool)) {
      throw new Error(
        `invalid mcp allowedTools spec '${p}': http server spec must include a tool dimension ('url:*' or 'url:tool')`,
      );
    }
  }
}
