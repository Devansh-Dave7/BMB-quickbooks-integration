const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const session = require('../soap/session');

// Reset sessions between tests by creating fresh ones.
// The module uses a global Map so we need to clean up manually.

describe('session management', () => {
  let ticket;

  beforeEach(() => {
    // Create a fresh session for each test
    ticket = session.createSession();
  });

  it('createSession returns a UUID string', () => {
    assert.ok(typeof ticket === 'string');
    assert.match(ticket, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('isValidSession returns true for active session', () => {
    assert.equal(session.isValidSession(ticket), true);
  });

  it('isValidSession returns false for unknown ticket', () => {
    assert.equal(session.isValidSession('bogus-ticket'), false);
  });

  it('getSession returns session object', () => {
    const sess = session.getSession(ticket);
    assert.ok(sess);
    assert.equal(sess.ticket, ticket);
    assert.equal(sess.requestsSent, 0);
    assert.equal(sess.responsesReceived, 0);
    assert.equal(sess.lastError, null);
    assert.ok(sess.createdAt);
  });

  it('getSession returns null for unknown ticket', () => {
    assert.equal(session.getSession('nope'), null);
  });

  it('setLastError and getLastError work', () => {
    session.setLastError(ticket, 'Something broke');
    assert.equal(session.getLastError(ticket), 'Something broke');
  });

  it('getLastError returns null when no error set', () => {
    assert.equal(session.getLastError(ticket), null);
  });

  it('incrementRequestsSent increments counter', () => {
    session.incrementRequestsSent(ticket);
    session.incrementRequestsSent(ticket);
    const sess = session.getSession(ticket);
    assert.equal(sess.requestsSent, 2);
  });

  it('incrementResponsesReceived increments counter', () => {
    session.incrementResponsesReceived(ticket);
    const sess = session.getSession(ticket);
    assert.equal(sess.responsesReceived, 1);
  });

  it('destroySession removes session', () => {
    session.destroySession(ticket);
    assert.equal(session.isValidSession(ticket), false);
    assert.equal(session.getSession(ticket), null);
  });

  it('nextSyncCycle increments and returns cycle', () => {
    const c1 = session.nextSyncCycle();
    const c2 = session.nextSyncCycle();
    assert.equal(c2, c1 + 1);
  });

  it('getSyncCycleCount returns current cycle', () => {
    const c = session.nextSyncCycle();
    assert.equal(session.getSyncCycleCount(), c);
  });
});
