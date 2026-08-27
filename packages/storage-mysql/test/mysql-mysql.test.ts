import { runMysqlContractSuite } from './mysql-helper.js';

// Contract suite against MySQL 8 (docker: sched-mysql-test, port 3308) —
// same driver (mysql2), second dialect.
runMysqlContractSuite('MySQL 8', process.env.MYSQL_URL ?? 'mysql://root:test@127.0.0.1:3308/sched_test');
