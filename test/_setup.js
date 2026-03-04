/**
 * Shared test helper — NOT a test file (prefixed with _).
 * Override config before any DB module loads to use in-memory SQLite.
 */
const config = require('../config');

// Override for test environment
config.dbPath = ':memory:';
config.qbwc.username = 'test_user';
config.qbwc.password = 'test_pass';
config.qbwc.companyFile = 'C:\\Test\\Company.qbw';
config.qbwc.xmlVersion = '16.0';
config.apiKey = 'test-api-key-12345';
config.nodeEnv = 'test';
config.sync.inventoryEveryN = 1;
config.sync.customerEveryN = 5;
config.webhooks.orderCreated = '';
config.webhooks.invoiceCreated = '';
config.webhooks.inventoryUpdated = '';
config.webhooks.syncError = '';

const { getDb, closeDb } = require('../db/schema');

/** Initialize in-memory DB with schema. Call in before(). */
function setupTestDb() {
  getDb(); // triggers table creation
}

/** Close DB. Call in after(). */
function teardownTestDb() {
  closeDb();
}

/** Delete all rows from all tables without dropping schema. */
function clearAllTables() {
  const db = getDb();
  db.exec('DELETE FROM request_queue');
  db.exec('DELETE FROM inventory_cache');
  db.exec('DELETE FROM customer_cache');
  db.exec('DELETE FROM order_responses');
  db.exec('DELETE FROM sync_log');
}

/**
 * Create a mock webhook dispatcher that records calls.
 * Returns { dispatcher, calls } where calls is the array of recorded invocations.
 */
function createMockWebhookDispatcher() {
  const calls = [];
  const dispatcher = {
    fireOrderCreated(payload) { calls.push({ event: 'order_created', payload }); },
    fireInvoiceCreated(payload) { calls.push({ event: 'invoice_created', payload }); },
    fireInventoryUpdated(payload) { calls.push({ event: 'inventory_updated', payload }); },
    fireSyncError(payload) { calls.push({ event: 'sync_error', payload }); },
    fireCallback(url, payload) { calls.push({ event: 'callback', url, payload }); },
  };
  return { dispatcher, calls };
}

/**
 * Minimal HTTP request helper using node:http.
 * Returns { statusCode, headers, body (parsed JSON or string) }.
 */
function makeRequest(port, method, path, opts = {}) {
  const http = require('node:http');
  return new Promise((resolve, reject) => {
    const headers = { ...(opts.headers || {}) };
    let bodyStr = null;

    if (opts.body) {
      bodyStr = JSON.stringify(opts.body);
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(bodyStr);
    }

    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let body;
        try { body = JSON.parse(raw); } catch { body = raw; }
        resolve({ statusCode: res.statusCode, headers: res.headers, body });
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

module.exports = {
  config,
  setupTestDb,
  teardownTestDb,
  clearAllTables,
  createMockWebhookDispatcher,
  makeRequest,
};
