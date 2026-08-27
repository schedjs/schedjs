import { runPostgresContractSuite } from './pg-helper.js';

// Contract suite against Postgres 16 (docker: sched-postgres-test, port 5433).
runPostgresContractSuite('Postgres 16', process.env.POSTGRES_URL ?? 'postgres://postgres:test@127.0.0.1:5433/sched_test');
