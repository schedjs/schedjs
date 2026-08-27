import { describe, expect, it, beforeEach } from 'vitest';
import { storageContractTests } from '../src/storage-contract.js';
import { MemoryStorage } from './helpers/memory-storage.js';

/**
 * Pins the docs claim: "MemoryStorage ... passes the suite" (07.storage/09.custom.md,
 * "Build your own adapter" — the reference example). The contract suite runs against
 * every shipped adapter (sqlite/mysql/pg/mongo); this file runs it against the
 * in-memory reference too, so the docs example can't drift into a lie.
 */
describe('memory adapter (docs reference)', () => {
  storageContractTests({ describe, it, expect, beforeEach }, 'memory', () => new MemoryStorage());
});
