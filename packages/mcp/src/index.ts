import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export { AdminApiClient, AdminApiError } from './client.js';
export type { RunListFilter } from './client.js';
export { createMcpServer } from './server.js';
export type { McpServerOptions, McpServerHandle } from './server.js';
export { TOOL_DEFS, MUTATIONS, runTool } from './tools.js';
export type { McpToolDef } from './tools.js';
export { createMcpRunner, contentToResult, resolveHeaderEnv } from './runner.js';
export type {
  McpRunnerConfig,
  McpRunnerOptions,
  McpConnection,
  McpConnectionFactory,
  McpToolResult,
} from './runner.js';

/** Пакетная версия — ОДИН источник: `package.json`. Хардкод расходился с
 * манифестом (issue:118: баннер печатал `v0.2.0` при пакете `0.5.1`), поэтому
 * читаем манифест в рантайме — как `@schedjs/cli` и `@schedjs/daemon`. */
export const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
