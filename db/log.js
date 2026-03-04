const { getDb } = require('./schema');

/**
 * Log a sync event.
 */
function logEvent({ ticket = null, event, requestType = null, detail = null }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO sync_log (ticket, event, request_type, detail)
    VALUES (?, ?, ?, ?)
  `).run(
    ticket,
    event,
    requestType,
    detail && typeof detail === 'object' ? JSON.stringify(detail) : detail
  );
}

/**
 * Get recent log entries.
 */
function getRecentLogs(limit = 100) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM sync_log ORDER BY created_at DESC LIMIT ?
  `).all(limit);
}

/**
 * Get logs for a specific sync session (ticket).
 */
function getLogsByTicket(ticket) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM sync_log WHERE ticket = ? ORDER BY created_at ASC
  `).all(ticket);
}

/**
 * Get error logs.
 */
function getErrorLogs(limit = 50) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM sync_log WHERE event = 'error' ORDER BY created_at DESC LIMIT ?
  `).all(limit);
}

/**
 * Get the timestamp of the last successful sync close.
 */
function getLastSyncTime() {
  const db = getDb();
  const row = db.prepare(`
    SELECT created_at FROM sync_log
    WHERE event = 'close'
    ORDER BY created_at DESC
    LIMIT 1
  `).get();
  return row ? row.created_at : null;
}

/**
 * Clean up old log entries (older than N days).
 */
function cleanup(daysOld = 30) {
  const db = getDb();
  const result = db.prepare(`
    DELETE FROM sync_log
    WHERE created_at < datetime('now', ?)
  `).run(`-${daysOld} days`);
  return result.changes;
}

module.exports = {
  logEvent,
  getRecentLogs,
  getLogsByTicket,
  getErrorLogs,
  getLastSyncTime,
  cleanup,
};
