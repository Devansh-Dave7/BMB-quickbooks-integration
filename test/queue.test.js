const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { setupTestDb, teardownTestDb, clearAllTables } = require('./_setup');
const { PRIORITY, addToQueue, popNext, markCompleted, markError, getQueueDepth, getById, getCurrentSent } = require('../db/queue');

describe('queue operations', () => {
  before(() => setupTestDb());
  after(() => teardownTestDb());
  beforeEach(() => clearAllTables());

  it('addToQueue returns an id starting with q_', () => {
    const id = addToQueue({ type: 'CustomerQuery', qbxml: '<test/>' });
    assert.ok(id.startsWith('q_'));
  });

  it('getById returns the queued item', () => {
    const id = addToQueue({ type: 'CustomerQuery', qbxml: '<test/>' });
    const item = getById(id);
    assert.equal(item.id, id);
    assert.equal(item.type, 'CustomerQuery');
    assert.equal(item.qbxml, '<test/>');
    assert.equal(item.status, 'pending');
    assert.equal(item.priority, PRIORITY.BACKGROUND);
  });

  it('addToQueue respects custom priority', () => {
    const id = addToQueue({ type: 'SalesOrderAdd', qbxml: '<so/>', priority: PRIORITY.USER_ACTION });
    const item = getById(id);
    assert.equal(item.priority, 1);
  });

  it('addToQueue stores callbackUrl and metadata', () => {
    const id = addToQueue({
      type: 'InvoiceAdd',
      qbxml: '<inv/>',
      callbackUrl: 'https://example.com/cb',
      metadata: { foo: 'bar' },
    });
    const item = getById(id);
    assert.equal(item.callback_url, 'https://example.com/cb');
    assert.equal(JSON.parse(item.metadata).foo, 'bar');
  });

  it('getQueueDepth counts pending items', () => {
    assert.equal(getQueueDepth(), 0);
    addToQueue({ type: 'A', qbxml: '<a/>' });
    addToQueue({ type: 'B', qbxml: '<b/>' });
    assert.equal(getQueueDepth(), 2);
  });

  it('popNext returns highest priority first', () => {
    addToQueue({ type: 'Background', qbxml: '<bg/>', priority: PRIORITY.BACKGROUND });
    addToQueue({ type: 'UserAction', qbxml: '<ua/>', priority: PRIORITY.USER_ACTION });
    addToQueue({ type: 'Query', qbxml: '<q/>', priority: PRIORITY.QUERY });

    const first = popNext();
    assert.equal(first.type, 'UserAction');
    const second = popNext();
    assert.equal(second.type, 'Query');
    const third = popNext();
    assert.equal(third.type, 'Background');
  });

  it('popNext returns oldest first within same priority', () => {
    addToQueue({ type: 'First', qbxml: '<1/>' });
    addToQueue({ type: 'Second', qbxml: '<2/>' });

    const first = popNext();
    assert.equal(first.type, 'First');
  });

  it('popNext marks item as sent', () => {
    const id = addToQueue({ type: 'Test', qbxml: '<t/>' });
    popNext();
    const item = getById(id);
    assert.equal(item.status, 'sent');
    assert.ok(item.sent_at);
  });

  it('popNext returns null when queue empty', () => {
    assert.equal(popNext(), null);
  });

  it('popNext skips non-pending items', () => {
    const id = addToQueue({ type: 'Test', qbxml: '<t/>' });
    popNext(); // marks as sent
    assert.equal(popNext(), null); // no more pending
  });

  it('markCompleted updates status', () => {
    const id = addToQueue({ type: 'Test', qbxml: '<t/>' });
    popNext();
    markCompleted(id);
    const item = getById(id);
    assert.equal(item.status, 'completed');
    assert.ok(item.completed_at);
  });

  it('markError updates status', () => {
    const id = addToQueue({ type: 'Test', qbxml: '<t/>' });
    popNext();
    markError(id);
    const item = getById(id);
    assert.equal(item.status, 'error');
  });

  it('getCurrentSent returns a sent item', () => {
    addToQueue({ type: 'A', qbxml: '<a/>' });
    popNext(); // A becomes sent

    const sent = getCurrentSent();
    assert.ok(sent);
    assert.equal(sent.status, 'sent');
    assert.equal(sent.type, 'A');
  });

  it('getQueueDepth does not count sent items', () => {
    addToQueue({ type: 'A', qbxml: '<a/>' });
    addToQueue({ type: 'B', qbxml: '<b/>' });
    popNext();
    assert.equal(getQueueDepth(), 1);
  });
});
