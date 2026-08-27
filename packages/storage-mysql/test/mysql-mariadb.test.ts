import { runMysqlContractSuite } from './mysql-helper.js';

// Contract suite against MariaDB 11 (docker: sched-mariadb-test, port 3307).
runMysqlContractSuite('MariaDB 11', process.env.MARIADB_URL ?? 'mysql://root:test@127.0.0.1:3307/sched_test');
