#!/usr/bin/env node
/**
 * Reference worker for the sched stdio contract (process runner, `envelope: true`).
 *
 * Contract:
 *  - request: one JSON envelope `{ task: { name, config }, data }` on **stdin** (then EOF)
 *  - progress: NDJSON lines on **stdout** — intermediate `{ "status": "running", "progress": N }`
 *  - result:   one terminal line — `{ "status": "succeeded"|"failed"|"cancelled", ... }`
 *  - logs:     free-form output on **stderr** (never on stdout — stdout is the protocol)
 *
 * Run it through sched, or by hand:
 *   echo '{"task":{"name":"demo","config":{}},"data":{"workMs":200}}' | node examples/stdio-worker.mjs
 */
import { readFileSync } from 'node:fs';

const req = JSON.parse(readFileSync(0, 'utf8'));
const { task, data } = req;
const workMs = Number(data?.workMs ?? 100);
const shouldFail = data?.fail === true;

console.error(`[worker] received task "${task.name}" (workMs=${workMs}, fail=${shouldFail})`);

for (let p = 10; p < 100; p += 30) {
  await new Promise((r) => setTimeout(r, workMs / 4));
  console.error(`[worker] working… ${p}%`);
  process.stdout.write(JSON.stringify({ status: 'running', progress: p }) + '\n');
}

if (shouldFail) {
  console.error('[worker] failing on purpose');
  process.stdout.write(JSON.stringify({ status: 'failed', error: 'worker failed on purpose' }) + '\n');
} else {
  console.error('[worker] done');
  process.stdout.write(
    JSON.stringify({
      status: 'succeeded',
      result: { task: task.name, data },
      progress: 100,
      log: `task "${task.name}" completed by the reference worker`,
    }) + '\n',
  );
}
