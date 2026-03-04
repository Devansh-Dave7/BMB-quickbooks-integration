const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { setupTestDb, teardownTestDb, clearAllTables } = require('./_setup');
const cache = require('../db/cache');

describe('inventory cache', () => {
  before(() => setupTestDb());
  after(() => teardownTestDb());
  beforeEach(() => clearAllTables());

  const sampleItem = {
    listId: 'LID-001',
    name: 'Widget A',
    fullName: 'Inventory:Widget A',
    sku: 'WA-100',
    description: 'A fine widget',
    qtyOnHand: 50,
    qtyOnOrder: 10,
    qtyOnSalesOrder: 5,
    salesPrice: 19.99,
    cost: 8.50,
    itemType: 'Inventory',
    isActive: true,
    rawData: { ListID: 'LID-001' },
  };

  it('upsertInventoryItem inserts and retrieves', () => {
    cache.upsertInventoryItem(sampleItem);
    const items = cache.getAllInventory();
    assert.equal(items.length, 1);
    assert.equal(items[0].name, 'Widget A');
    assert.equal(items[0].sku, 'WA-100');
    assert.equal(items[0].qty_on_hand, 50);
  });

  it('upsertInventoryItem updates existing item', () => {
    cache.upsertInventoryItem(sampleItem);
    cache.upsertInventoryItem({ ...sampleItem, qtyOnHand: 75 });
    const items = cache.getAllInventory();
    assert.equal(items.length, 1);
    assert.equal(items[0].qty_on_hand, 75);
  });

  it('bulkUpsertInventory inserts multiple items', () => {
    const items = [
      { ...sampleItem, listId: 'LID-001', name: 'Widget A' },
      { ...sampleItem, listId: 'LID-002', name: 'Widget B', sku: 'WB-200' },
      { ...sampleItem, listId: 'LID-003', name: 'Widget C', sku: 'WC-300' },
    ];
    const count = cache.bulkUpsertInventory(items);
    assert.equal(count, 3);
    assert.equal(cache.getAllInventory().length, 3);
  });

  it('getAllInventory returns only active items', () => {
    cache.upsertInventoryItem(sampleItem);
    cache.upsertInventoryItem({ ...sampleItem, listId: 'LID-002', name: 'Inactive', isActive: false });
    const items = cache.getAllInventory();
    assert.equal(items.length, 1);
    assert.equal(items[0].name, 'Widget A');
  });

  it('searchInventory matches by name (case insensitive)', () => {
    cache.upsertInventoryItem(sampleItem);
    const results = cache.searchInventory('widget');
    assert.equal(results.length, 1);
  });

  it('searchInventory matches by SKU', () => {
    cache.upsertInventoryItem(sampleItem);
    const results = cache.searchInventory('WA-100');
    assert.equal(results.length, 1);
  });

  it('searchInventory returns empty for no match', () => {
    cache.upsertInventoryItem(sampleItem);
    const results = cache.searchInventory('nonexistent');
    assert.equal(results.length, 0);
  });

  it('getInventoryItem finds by exact name', () => {
    cache.upsertInventoryItem(sampleItem);
    const item = cache.getInventoryItem('Widget A');
    assert.ok(item);
    assert.equal(item.name, 'Widget A');
  });

  it('getInventoryItem finds by exact SKU', () => {
    cache.upsertInventoryItem(sampleItem);
    const item = cache.getInventoryItem('WA-100');
    assert.ok(item);
  });

  it('getInventoryItem falls back to partial match', () => {
    cache.upsertInventoryItem(sampleItem);
    const item = cache.getInventoryItem('Widget');
    assert.ok(item);
    assert.equal(item.name, 'Widget A');
  });

  it('getInventoryItem returns undefined for no match', () => {
    const item = cache.getInventoryItem('nonexistent');
    assert.equal(item, undefined);
  });

  it('getInventorySyncTime returns timestamp after insert', () => {
    cache.upsertInventoryItem(sampleItem);
    const syncTime = cache.getInventorySyncTime();
    assert.ok(syncTime);
  });

  it('getInventorySyncTime returns null when empty', () => {
    assert.equal(cache.getInventorySyncTime(), null);
  });
});

describe('customer cache', () => {
  before(() => setupTestDb());
  after(() => teardownTestDb());
  beforeEach(() => clearAllTables());

  const sampleCustomer = {
    listId: 'CLID-001',
    name: 'Acme Corp',
    fullName: 'Acme Corp',
    companyName: 'Acme Corporation',
    phone: '555-0100',
    email: 'acme@test.com',
    balance: 1500,
    creditLimit: 10000,
    terms: 'Net 30',
    isActive: true,
    billingAddress: { addr1: '123 Main', city: 'Springfield' },
    shippingAddress: null,
    rawData: { ListID: 'CLID-001' },
  };

  it('upsertCustomer inserts and retrieves', () => {
    cache.upsertCustomer(sampleCustomer);
    const customers = cache.getAllCustomers();
    assert.equal(customers.length, 1);
    assert.equal(customers[0].name, 'Acme Corp');
    assert.equal(customers[0].phone, '555-0100');
  });

  it('upsertCustomer updates existing customer', () => {
    cache.upsertCustomer(sampleCustomer);
    cache.upsertCustomer({ ...sampleCustomer, balance: 2000 });
    const customers = cache.getAllCustomers();
    assert.equal(customers.length, 1);
    assert.equal(customers[0].balance, 2000);
  });

  it('bulkUpsertCustomers inserts multiple', () => {
    const customers = [
      { ...sampleCustomer },
      { ...sampleCustomer, listId: 'CLID-002', name: 'Beta Inc' },
    ];
    const count = cache.bulkUpsertCustomers(customers);
    assert.equal(count, 2);
  });

  it('searchCustomers matches by name', () => {
    cache.upsertCustomer(sampleCustomer);
    const results = cache.searchCustomers('acme');
    assert.equal(results.length, 1);
  });

  it('searchCustomers matches by phone', () => {
    cache.upsertCustomer(sampleCustomer);
    const results = cache.searchCustomers('555-0100');
    assert.equal(results.length, 1);
  });

  it('getCustomer finds by exact name', () => {
    cache.upsertCustomer(sampleCustomer);
    const c = cache.getCustomer('Acme Corp');
    assert.ok(c);
    assert.equal(c.name, 'Acme Corp');
  });

  it('getCustomer falls back to partial match', () => {
    cache.upsertCustomer(sampleCustomer);
    const c = cache.getCustomer('Acme');
    assert.ok(c);
  });

  it('getCustomerSyncTime returns timestamp', () => {
    cache.upsertCustomer(sampleCustomer);
    assert.ok(cache.getCustomerSyncTime());
  });
});

describe('order responses', () => {
  before(() => setupTestDb());
  after(() => teardownTestDb());
  beforeEach(() => clearAllTables());

  const sampleOrder = {
    id: 'or_test001',
    queueId: 'q_test001',
    type: 'SalesOrder',
    txnId: 'TXN-001',
    txnNumber: 'SO-1001',
    customerName: 'Acme Corp',
    total: 199.90,
    status: 'created',
    callbackUrl: 'https://example.com/cb',
    rawResponse: { TxnID: 'TXN-001' },
  };

  it('storeOrderResponse and getRecentOrders', () => {
    cache.storeOrderResponse(sampleOrder);
    const orders = cache.getRecentOrders();
    assert.equal(orders.length, 1);
    assert.equal(orders[0].txn_id, 'TXN-001');
    assert.equal(orders[0].customer_name, 'Acme Corp');
  });

  it('getOrderByQueueId returns matching order', () => {
    cache.storeOrderResponse(sampleOrder);
    const order = cache.getOrderByQueueId('q_test001');
    assert.ok(order);
    assert.equal(order.queue_id, 'q_test001');
  });

  it('getOrderByQueueId returns undefined for no match', () => {
    assert.equal(cache.getOrderByQueueId('q_nonexist'), undefined);
  });

  it('markCallbackSent updates flag', () => {
    cache.storeOrderResponse(sampleOrder);
    cache.markCallbackSent('or_test001');
    const order = cache.getOrderByQueueId('q_test001');
    assert.equal(order.callback_sent, 1);
  });

  it('getPendingCallbacks returns unsent callbacks', () => {
    cache.storeOrderResponse(sampleOrder);
    const pending = cache.getPendingCallbacks();
    assert.equal(pending.length, 1);

    cache.markCallbackSent('or_test001');
    assert.equal(cache.getPendingCallbacks().length, 0);
  });

  it('getRecentOrders respects limit', () => {
    for (let i = 0; i < 5; i++) {
      cache.storeOrderResponse({ ...sampleOrder, id: `or_${i}`, queueId: `q_${i}` });
    }
    const orders = cache.getRecentOrders(3);
    assert.equal(orders.length, 3);
  });
});
