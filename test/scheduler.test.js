const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { config, setupTestDb, teardownTestDb, clearAllTables } = require('./_setup');
const { queueBackgroundSyncs } = require('../sync/scheduler');
const { getQueueDepth } = require('../db/queue');

describe('scheduler — queueBackgroundSyncs', () => {
  before(() => setupTestDb());
  after(() => teardownTestDb());
  beforeEach(() => clearAllTables());

  it('queues inventory sync on every cycle (inventoryEveryN=1)', () => {
    config.sync.inventoryEveryN = 1;
    const queued = queueBackgroundSyncs(1);
    assert.ok(queued >= 1);
    assert.ok(getQueueDepth() >= 1);
  });

  it('queues customer sync on cycle divisible by customerEveryN', () => {
    config.sync.inventoryEveryN = 1;
    config.sync.customerEveryN = 5;
    const queued = queueBackgroundSyncs(5);
    assert.equal(queued, 2); // inventory + customer
  });

  it('skips customer sync on non-divisible cycle', () => {
    config.sync.inventoryEveryN = 1;
    config.sync.customerEveryN = 5;
    const queued = queueBackgroundSyncs(3);
    assert.equal(queued, 1); // inventory only
  });

  it('does not duplicate pending syncs', () => {
    config.sync.inventoryEveryN = 1;
    queueBackgroundSyncs(1); // queues inventory
    const queued = queueBackgroundSyncs(2); // should skip duplicate
    assert.equal(queued, 0);
  });

  it('queues 0 when no syncs due', () => {
    config.sync.inventoryEveryN = 3;
    config.sync.customerEveryN = 5;
    const queued = queueBackgroundSyncs(2); // not divisible by 3 or 5
    assert.equal(queued, 0);
  });

  it('returns count of syncs queued', () => {
    config.sync.inventoryEveryN = 1;
    config.sync.customerEveryN = 1;
    const queued = queueBackgroundSyncs(1);
    assert.equal(queued, 2);
  });
});
