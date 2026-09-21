/**
 * Type declarations for the fixture admin api (admin.mjs) — keeps typecheck
 * green without a build step for the fixture.
 */
import type { Server } from 'node:http';

export interface FixtureRequestLogEntry {
  method: string;
  path: string;
  auth: boolean;
}

export interface SeedState {
  tasks?: unknown[];
  runs?: unknown[];
  schedules?: unknown[];
  queue?: { paused: boolean; pausedAt: string | null; startPaused: boolean };
}

export interface AdminFixture {
  server: Server;
  listen(): Promise<number>;
  seed(s: SeedState): void;
  clearLog(): void;
  requests(): FixtureRequestLogEntry[];
  close(): Promise<void>;
}

export function createAdminFixture(options?: { key?: string }): AdminFixture;
