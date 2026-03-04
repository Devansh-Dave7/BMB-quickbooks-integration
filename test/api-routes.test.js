const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { config, setupTestDb, teardownTestDb, clearAllTables, makeRequest } = require('./_setup');
const express = require('express');
const apiRoutes = require('../api/routes');
const cache = require('../db/cache');

const API_KEY = config.apiKey; // 'test-api-key-12345'

describe('REST API routes', () => {
  let server;
  let port;

  before(async () => {
    setupTestDb();

    const app = express();
    app.use(express.json());
    app.use('/api', apiRoutes);

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    teardownTestDb();
  });

  beforeEach(() => clearAllTables());

  // ─── Auth ────────────────────────────────────────────────────

  it('returns 401 without API key', async () => {
    const res = await makeRequest(port, 'GET', '/api/status');
    assert.equal(res.statusCode, 401);
    assert.ok(res.body.error.includes('Missing'));
  });

  it('returns 403 with wrong API key', async () => {
    const res = await makeRequest(port, 'GET', '/api/status', {
      headers: { 'x-api-key': 'wrong-key' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('returns 200 with valid API key', async () => {
    const res = await makeRequest(port, 'GET', '/api/status', {
      headers: { 'x-api-key': API_KEY },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'ok');
  });

  // ─── POST /api/order ────────────────────────────────────────

  it('POST /api/order returns 202 with valid payload', async () => {
    const res = await makeRequest(port, 'POST', '/api/order', {
      headers: { 'x-api-key': API_KEY },
      body: {
        customer_name: 'Acme Corp',
        items: [{ name: 'Widget A', qty: 2, rate: 10 }],
      },
    });
    assert.equal(res.statusCode, 202);
    assert.equal(res.body.status, 'queued');
    assert.ok(res.body.queue_id);
  });

  it('POST /api/order returns 400 with missing customer_name', async () => {
    const res = await makeRequest(port, 'POST', '/api/order', {
      headers: { 'x-api-key': API_KEY },
      body: { items: [{ name: 'Widget' }] },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.body.details.some(e => e.includes('customer_name')));
  });

  it('POST /api/order returns 400 with empty items', async () => {
    const res = await makeRequest(port, 'POST', '/api/order', {
      headers: { 'x-api-key': API_KEY },
      body: { customer_name: 'Acme', items: [] },
    });
    assert.equal(res.statusCode, 400);
  });

  // ─── POST /api/invoice ──────────────────────────────────────

  it('POST /api/invoice returns 202 with valid payload', async () => {
    const res = await makeRequest(port, 'POST', '/api/invoice', {
      headers: { 'x-api-key': API_KEY },
      body: {
        customer_name: 'Beta Inc',
        items: [{ name: 'Service B', qty: 1, rate: 150 }],
      },
    });
    assert.equal(res.statusCode, 202);
    assert.equal(res.body.status, 'queued');
  });

  // ─── POST /api/query ────────────────────────────────────────

  it('POST /api/query returns 202 with valid type', async () => {
    const res = await makeRequest(port, 'POST', '/api/query', {
      headers: { 'x-api-key': API_KEY },
      body: { type: 'CustomerQuery' },
    });
    assert.equal(res.statusCode, 202);
  });

  it('POST /api/query returns 400 with invalid type', async () => {
    const res = await makeRequest(port, 'POST', '/api/query', {
      headers: { 'x-api-key': API_KEY },
      body: { type: 'BogusQuery' },
    });
    assert.equal(res.statusCode, 400);
  });

  // ─── GET /api/inventory ─────────────────────────────────────

  it('GET /api/inventory returns empty list initially', async () => {
    const res = await makeRequest(port, 'GET', '/api/inventory', {
      headers: { 'x-api-key': API_KEY },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.count, 0);
    assert.deepEqual(res.body.items, []);
  });

  it('GET /api/inventory returns cached items', async () => {
    cache.upsertInventoryItem({
      listId: 'LID-001', name: 'Widget A', fullName: 'Widget A',
      sku: 'WA-100', qtyOnHand: 50, isActive: true,
    });

    const res = await makeRequest(port, 'GET', '/api/inventory', {
      headers: { 'x-api-key': API_KEY },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.count, 1);
    assert.equal(res.body.items[0].name, 'Widget A');
  });

  it('GET /api/inventory?search=widget filters results', async () => {
    cache.upsertInventoryItem({ listId: 'LID-001', name: 'Widget A', isActive: true });
    cache.upsertInventoryItem({ listId: 'LID-002', name: 'Gadget B', isActive: true });

    const res = await makeRequest(port, 'GET', '/api/inventory?search=widget', {
      headers: { 'x-api-key': API_KEY },
    });
    assert.equal(res.body.count, 1);
    assert.equal(res.body.items[0].name, 'Widget A');
  });

  it('GET /api/inventory/:name returns single item', async () => {
    cache.upsertInventoryItem({ listId: 'LID-001', name: 'Widget A', isActive: true });

    const res = await makeRequest(port, 'GET', '/api/inventory/Widget%20A', {
      headers: { 'x-api-key': API_KEY },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.name, 'Widget A');
  });

  it('GET /api/inventory/:name returns 404 for unknown', async () => {
    const res = await makeRequest(port, 'GET', '/api/inventory/Nonexistent', {
      headers: { 'x-api-key': API_KEY },
    });
    assert.equal(res.statusCode, 404);
  });

  // ─── GET /api/customers ─────────────────────────────────────

  it('GET /api/customers returns cached customers', async () => {
    cache.upsertCustomer({
      listId: 'CLID-001', name: 'Acme Corp', fullName: 'Acme Corp',
      phone: '555-0100', isActive: true,
    });

    const res = await makeRequest(port, 'GET', '/api/customers', {
      headers: { 'x-api-key': API_KEY },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.count, 1);
  });

  it('GET /api/customer/:name returns single customer', async () => {
    cache.upsertCustomer({ listId: 'CLID-001', name: 'Acme Corp', isActive: true });

    const res = await makeRequest(port, 'GET', '/api/customer/Acme%20Corp', {
      headers: { 'x-api-key': API_KEY },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.name, 'Acme Corp');
  });

  it('GET /api/customer/:name returns 404 for unknown', async () => {
    const res = await makeRequest(port, 'GET', '/api/customer/Nobody', {
      headers: { 'x-api-key': API_KEY },
    });
    assert.equal(res.statusCode, 404);
  });

  // ─── GET /api/orders ────────────────────────────────────────

  it('GET /api/orders returns recent orders', async () => {
    cache.storeOrderResponse({
      id: 'or_001', queueId: 'q_001', type: 'SalesOrder',
      txnId: 'TXN-001', txnNumber: 'SO-1001', customerName: 'Acme',
      total: 100, status: 'created',
    });

    const res = await makeRequest(port, 'GET', '/api/orders', {
      headers: { 'x-api-key': API_KEY },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.count, 1);
  });

  // ─── GET /api/status ────────────────────────────────────────

  it('GET /api/status returns system info', async () => {
    const res = await makeRequest(port, 'GET', '/api/status', {
      headers: { 'x-api-key': API_KEY },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.version, '1.0.0');
    assert.ok('queue_depth' in res.body);
    assert.ok('uptime' in res.body);
    assert.ok('cache_freshness' in res.body);
  });
});
