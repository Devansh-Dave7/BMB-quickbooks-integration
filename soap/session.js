const { v4: uuidv4 } = require('uuid');

/**
 * In-memory session store for active QBWC sync sessions.
 * Sessions are short-lived (duration of one sync cycle) so in-memory is fine.
 */
const sessions = new Map();

// Global sync cycle counter (persists across sessions for scheduling)
let syncCycleCount = 0;

/**
 * Create a new session and return the ticket (UUID).
 */
function createSession() {
  const ticket = uuidv4();
  sessions.set(ticket, {
    ticket,
    createdAt: new Date().toISOString(),
    lastError: null,
    requestsSent: 0,
    responsesReceived: 0,
  });
  return ticket;
}

/**
 * Validate that a ticket corresponds to an active session.
 */
function isValidSession(ticket) {
  return sessions.has(ticket);
}

/**
 * Get session data for a ticket.
 */
function getSession(ticket) {
  return sessions.get(ticket) || null;
}

/**
 * Set the last error message for a session.
 */
function setLastError(ticket, errorMessage) {
  const session = sessions.get(ticket);
  if (session) {
    session.lastError = errorMessage;
  }
}

/**
 * Get the last error message for a session.
 */
function getLastError(ticket) {
  const session = sessions.get(ticket);
  return session ? session.lastError : null;
}

/**
 * Increment the request counter for a session.
 */
function incrementRequestsSent(ticket) {
  const session = sessions.get(ticket);
  if (session) session.requestsSent++;
}

/**
 * Increment the response counter for a session.
 */
function incrementResponsesReceived(ticket) {
  const session = sessions.get(ticket);
  if (session) session.responsesReceived++;
}

/**
 * Destroy a session (on closeConnection or connectionError).
 */
function destroySession(ticket) {
  sessions.delete(ticket);
}

/**
 * Get and increment the global sync cycle counter.
 * Used by the scheduler to decide when to queue customer syncs.
 */
function nextSyncCycle() {
  syncCycleCount++;
  return syncCycleCount;
}

/**
 * Get current sync cycle count.
 */
function getSyncCycleCount() {
  return syncCycleCount;
}

/**
 * Clean up stale sessions (older than 30 minutes).
 * QBWC sessions should never last this long.
 */
function cleanupStaleSessions() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [ticket, session] of sessions) {
    if (new Date(session.createdAt).getTime() < cutoff) {
      sessions.delete(ticket);
    }
  }
}

module.exports = {
  createSession,
  isValidSession,
  getSession,
  setLastError,
  getLastError,
  incrementRequestsSent,
  incrementResponsesReceived,
  destroySession,
  nextSyncCycle,
  getSyncCycleCount,
  cleanupStaleSessions,
};
