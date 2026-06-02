const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { setupTestDb, teardownTestDb, clearAllTables } = require('./_setup');
const callHistory = require('../db/call-history');

describe('db/call-history', () => {
  before(() => setupTestDb());
  after(() => teardownTestDb());
  beforeEach(() => clearAllTables());

  it('recordLookupHit + hasLookupHitForCall round-trip', () => {
    callHistory.recordLookupHit({
      call_id: 'call_X',
      qb_item_name: 'Flex:SLV04',
      search_query: '4 inch silver flex',
      sales_price: 37.97,
      rank: 0,
    });
    assert.equal(callHistory.hasLookupHitForCall('call_X', 'Flex:SLV04'), true);
  });

  it('hasLookupHitForCall is case-insensitive on qb_item_name', () => {
    callHistory.recordLookupHit({ call_id: 'call_X', qb_item_name: 'Flex:SLV04' });
    assert.equal(callHistory.hasLookupHitForCall('call_X', 'flex:slv04'), true);
    assert.equal(callHistory.hasLookupHitForCall('call_X', 'FLEX:SLV04'), true);
  });

  it('hasLookupHitForCall returns false when the call_id has no hits', () => {
    callHistory.recordLookupHit({ call_id: 'call_X', qb_item_name: 'Flex:SLV04' });
    assert.equal(callHistory.hasLookupHitForCall('call_Y', 'Flex:SLV04'), false);
  });

  it('recordLookupHit is a no-op when call_id is empty', () => {
    const ok = callHistory.recordLookupHit({ call_id: '', qb_item_name: 'Flex:SLV04' });
    assert.equal(ok, false);
    assert.equal(callHistory.hasLookupHitForCall('', 'Flex:SLV04'), false);
  });

  it('recordLookupHit is a no-op when qb_item_name is empty', () => {
    const ok = callHistory.recordLookupHit({ call_id: 'call_X', qb_item_name: '' });
    assert.equal(ok, false);
  });

  it('hasLookupHitForCall returns false when call_id is null/undefined (gate disabled)', () => {
    assert.equal(callHistory.hasLookupHitForCall(null, 'Flex:SLV04'), false);
    assert.equal(callHistory.hasLookupHitForCall(undefined, 'Flex:SLV04'), false);
  });

  it('getHitsForCall returns all hits for a call, newest first', () => {
    callHistory.recordLookupHit({ call_id: 'call_X', qb_item_name: 'Flex:SLV04' });
    callHistory.recordLookupHit({ call_id: 'call_X', qb_item_name: 'Tab Collars:TC06' });
    const hits = callHistory.getHitsForCall('call_X');
    assert.equal(hits.length, 2);
    assert.ok(hits.some((h) => h.qb_item_name === 'Flex:SLV04'));
    assert.ok(hits.some((h) => h.qb_item_name === 'Tab Collars:TC06'));
  });

  it('cleanupOldHits prunes hits older than threshold; recent stay', () => {
    // Insert a fresh hit (now) and one backdated by 30 days.
    const { getDb } = require('../db/schema');
    const db = getDb();
    callHistory.recordLookupHit({ call_id: 'call_recent', qb_item_name: 'Flex:SLV04' });
    db.prepare(`
      INSERT INTO call_lookup_history (call_id, qb_item_name, created_at)
      VALUES (?, ?, datetime('now', '-30 days'))
    `).run('call_old', 'Tab Collars:TC06');

    const removed = callHistory.cleanupOldHits(14);
    assert.equal(removed, 1);
    assert.equal(callHistory.hasLookupHitForCall('call_recent', 'Flex:SLV04'), true);
    assert.equal(callHistory.hasLookupHitForCall('call_old', 'Tab Collars:TC06'), false);
  });
});
