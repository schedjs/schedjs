/**
 * Type declarations for the fixture worker (worker.mjs) — keeps typecheck
 * green without a build step for the fixture.
 */
import type { Server } from 'node:http';

export interface WorkerFixtureOptions {
  apiKey?: string;
  hangAsync?: boolean;
  brokenSync?: boolean;
}

export interface WorkerFixture {
  server: Server;
  listen(): Promise<number>;
  port(): number;
  close(): Promise<void>;
}

export function createWorkerFixture(options?: WorkerFixtureOptions): WorkerFixture;
