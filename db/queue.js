const { v4: uuidv4 } = require('uuid');
const { getDb } = require('./schema');

const PRIORITY = {
  USER_ACTION: 1,   // orders, invoices — front of queue
  QUERY: 5,         // ad-hoc queries from REST API
  BACKGROUND: 10,   // scheduled inventory/customer syncs
};

/**
 * Add a QBXML request to the queue.
 * Returns the queue entry id.
 */
function addToQueue({ type, qbxml, priority = PRIORITY.BACKGROUND, callbackUrl = null, metadata = null }) {
  const db = getDb();
  const id = `q_${uuidv4().slice(0, 12)}`;

  db.prepare(`
    INSERT INTO request_queue (id, priority, type, qbxml, status, callback_url, metadata)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)
  `).run(id, priority, type, qbxml, callbackUrl, metadata ? JSON.stringify(metadata) : null);

  return id;
}

/**
 * Pop the next pending request (highest priority, oldest first).
 * Marks it as 'sent'.
 */
function popNext() {
  const db = getDb();

  const row = db.prepare(`
    SELECT * FROM request_queue
    WHERE status = 'pending'
    ORDER BY priority ASC, created_at ASC
    LIMIT 1
  `).get();

  if (!row) return null;

  db.prepare(`
    UPDATE request_queue
    SET status = 'sent', sent_at = datetime('now')
    WHERE id = ?
  `).run(row.id);

  return row;
}

/**
 * Mark a queue item as completed.
 */
function markCompleted(id) {
  const db = getDb();
  db.prepare(`
    UPDATE request_queue
    SET status = 'completed', completed_at = datetime('now')
    WHERE id = ?
  `).run(id);
}

/**
 * Mark a queue item as errored.
 */
function markError(id) {
  const db = getDb();
  db.prepare(`
    UPDATE request_queue
    SET status = 'error', completed_at = datetime('now')
    WHERE id = ?
  `).run(id);
}

/**
 * Get the current queue depth (pending items).
 */
function getQueueDepth() {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM request_queue WHERE status = 'pending'
  `).get();
  return row.count;
}

/**
 * Get a queue item by id.
 */
function getById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM request_queue WHERE id = ?').get(id);
}

/**
 * Get the currently sent (in-flight) item for correlation in receiveResponseXML.
 */
function getCurrentSent() {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM request_queue
    WHERE status = 'sent'
    ORDER BY sent_at DESC
    LIMIT 1
  `).get();
}

/**
 * Clean up old completed/errored items (older than N days).
 */
function cleanup(daysOld = 7) {
  const db = getDb();
  db.prepare(`
    DELETE FROM request_queue
    WHERE status IN ('completed', 'error')
    AND completed_at < datetime('now', ?)
  `).run(`-${daysOld} days`);
}

module.exports = {
  PRIORITY,
  addToQueue,
  popNext,
  markCompleted,
  markError,
  getQueueDepth,
  getById,
  getCurrentSent,
  cleanup,
};
