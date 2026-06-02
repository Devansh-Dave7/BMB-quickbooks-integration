const { getDb } = require('./schema');

/**
 * Record a single lookup_part hit so that create_quickbooks_order can
 * later verify the caller's items[] came from real searches (not Sophia's
 * imagination). No-op when call_id or qb_item_name is missing — Retell
 * sometimes invokes tools in test mode without a stable call_id, and we
 * never want a missing field to break the lookup response.
 */
function recordLookupHit({ call_id, qb_item_name, source = 'lookup_part', search_query = null, sales_price = null, rank = null }) {
  if (!call_id || !qb_item_name) return false;
  const db = getDb();
  db.prepare(`
    INSERT INTO call_lookup_history (call_id, qb_item_name, source, search_query, sales_price, rank)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(String(call_id), String(qb_item_name), source, search_query, sales_price, rank);
  return true;
}

/**
 * Return true iff this call_id has at least one recorded hit whose
 * qb_item_name matches `name` case-insensitively. When call_id is empty
 * we treat the gate as disabled (back-compat for old n8n payloads).
 */
function hasLookupHitForCall(call_id, name) {
  if (!call_id || !name) return false;
  const db = getDb();
  const row = db.prepare(`
    SELECT 1 FROM call_lookup_history
    WHERE call_id = ? AND qb_item_name = ? COLLATE NOCASE
    LIMIT 1
  `).get(String(call_id), String(name));
  return !!row;
}

/**
 * Debug: list all hits for a call (most recent first).
 */
function getHitsForCall(call_id) {
  if (!call_id) return [];
  const db = getDb();
  return db.prepare(`
    SELECT call_id, qb_item_name, source, search_query, sales_price, rank, created_at
    FROM call_lookup_history
    WHERE call_id = ?
    ORDER BY created_at DESC
  `).all(String(call_id));
}

/**
 * Prune hits older than N days. Returns rows removed.
 */
function cleanupOldHits(daysOld = 14) {
  const db = getDb();
  const result = db.prepare(`
    DELETE FROM call_lookup_history
    WHERE created_at < datetime('now', ?)
  `).run(`-${daysOld} days`);
  return result.changes;
}

module.exports = {
  recordLookupHit,
  hasLookupHitForCall,
  getHitsForCall,
  cleanupOldHits,
};
