const { getDb } = require('./schema');

// ─── Inventory Cache ────────────────────────────────────────────

/**
 * Upsert a single inventory item into cache.
 */
function upsertInventoryItem(item) {
  const db = getDb();
  db.prepare(`
    INSERT INTO inventory_cache
      (list_id, name, full_name, sku, description, qty_on_hand, qty_on_order,
       qty_on_sales_order, sales_price, cost, item_type, is_active, raw_data, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(list_id) DO UPDATE SET
      name = excluded.name,
      full_name = excluded.full_name,
      sku = excluded.sku,
      description = excluded.description,
      qty_on_hand = excluded.qty_on_hand,
      qty_on_order = excluded.qty_on_order,
      qty_on_sales_order = excluded.qty_on_sales_order,
      sales_price = excluded.sales_price,
      cost = excluded.cost,
      item_type = excluded.item_type,
      is_active = excluded.is_active,
      raw_data = excluded.raw_data,
      synced_at = datetime('now')
  `).run(
    item.listId,
    item.name,
    item.fullName || null,
    item.sku || null,
    item.description || null,
    item.qtyOnHand || 0,
    item.qtyOnOrder || 0,
    item.qtyOnSalesOrder || 0,
    item.salesPrice || null,
    item.cost || null,
    item.itemType || null,
    item.isActive !== undefined ? (item.isActive ? 1 : 0) : 1,
    item.rawData ? JSON.stringify(item.rawData) : null
  );
}

/**
 * Bulk upsert inventory items inside a transaction for performance.
 */
function bulkUpsertInventory(items) {
  const db = getDb();
  db.exec('BEGIN');
  try {
    for (const item of items) {
      upsertInventoryItem(item);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return items.length;
}

/**
 * Get all active inventory items.
 */
function getAllInventory() {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM inventory_cache WHERE is_active = 1 ORDER BY name COLLATE NOCASE
  `).all();
}

/**
 * Search inventory by name or SKU (case-insensitive partial match).
 */
function searchInventory(query) {
  const db = getDb();
  const pattern = `%${query}%`;
  return db.prepare(`
    SELECT * FROM inventory_cache
    WHERE is_active = 1
      AND (name LIKE ? COLLATE NOCASE OR sku LIKE ? COLLATE NOCASE OR full_name LIKE ? COLLATE NOCASE)
    ORDER BY name COLLATE NOCASE
  `).all(pattern, pattern, pattern);
}

/**
 * Get a single inventory item by exact name or SKU.
 * Falls back to partial match if exact match not found.
 */
function getInventoryItem(nameOrSku) {
  const db = getDb();

  // Try exact match first
  let item = db.prepare(`
    SELECT * FROM inventory_cache
    WHERE is_active = 1 AND (name = ? COLLATE NOCASE OR sku = ? COLLATE NOCASE)
    LIMIT 1
  `).get(nameOrSku, nameOrSku);

  if (item) return item;

  // Fall back to partial match
  const pattern = `%${nameOrSku}%`;
  return db.prepare(`
    SELECT * FROM inventory_cache
    WHERE is_active = 1
      AND (name LIKE ? COLLATE NOCASE OR sku LIKE ? COLLATE NOCASE OR full_name LIKE ? COLLATE NOCASE)
    ORDER BY name COLLATE NOCASE
    LIMIT 1
  `).get(pattern, pattern, pattern);
}

/**
 * Get the timestamp of the last inventory sync.
 */
function getInventorySyncTime() {
  const db = getDb();
  const row = db.prepare(`
    SELECT MAX(synced_at) as last_sync FROM inventory_cache
  `).get();
  return row ? row.last_sync : null;
}

// ─── Customer Cache ─────────────────────────────────────────────

/**
 * Upsert a single customer into cache.
 */
function upsertCustomer(customer) {
  const db = getDb();
  db.prepare(`
    INSERT INTO customer_cache
      (list_id, name, full_name, company_name, phone, email, balance,
       credit_limit, terms, is_active, billing_address, shipping_address, raw_data, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(list_id) DO UPDATE SET
      name = excluded.name,
      full_name = excluded.full_name,
      company_name = excluded.company_name,
      phone = excluded.phone,
      email = excluded.email,
      balance = excluded.balance,
      credit_limit = excluded.credit_limit,
      terms = excluded.terms,
      is_active = excluded.is_active,
      billing_address = excluded.billing_address,
      shipping_address = excluded.shipping_address,
      raw_data = excluded.raw_data,
      synced_at = datetime('now')
  `).run(
    customer.listId,
    customer.name,
    customer.fullName || null,
    customer.companyName || null,
    customer.phone || null,
    customer.email || null,
    customer.balance || 0,
    customer.creditLimit || null,
    customer.terms || null,
    customer.isActive !== undefined ? (customer.isActive ? 1 : 0) : 1,
    customer.billingAddress ? JSON.stringify(customer.billingAddress) : null,
    customer.shippingAddress ? JSON.stringify(customer.shippingAddress) : null,
    customer.rawData ? JSON.stringify(customer.rawData) : null
  );
}

/**
 * Bulk upsert customers inside a transaction.
 */
function bulkUpsertCustomers(customers) {
  const db = getDb();
  db.exec('BEGIN');
  try {
    for (const customer of customers) {
      upsertCustomer(customer);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return customers.length;
}

/**
 * Get all active customers.
 */
function getAllCustomers() {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM customer_cache WHERE is_active = 1 ORDER BY name COLLATE NOCASE
  `).all();
}

/**
 * Search customers by name, company, or phone (case-insensitive partial match).
 */
function searchCustomers(query) {
  const db = getDb();
  const pattern = `%${query}%`;
  return db.prepare(`
    SELECT * FROM customer_cache
    WHERE is_active = 1
      AND (name LIKE ? COLLATE NOCASE
        OR company_name LIKE ? COLLATE NOCASE
        OR full_name LIKE ? COLLATE NOCASE
        OR phone LIKE ?)
    ORDER BY name COLLATE NOCASE
  `).all(pattern, pattern, pattern, pattern);
}

/**
 * Get a single customer by name (exact first, then fuzzy).
 */
function getCustomer(name) {
  const db = getDb();

  // Try exact match first
  let customer = db.prepare(`
    SELECT * FROM customer_cache
    WHERE is_active = 1 AND (name = ? COLLATE NOCASE OR full_name = ? COLLATE NOCASE)
    LIMIT 1
  `).get(name, name);

  if (customer) return customer;

  // Fall back to partial match
  const pattern = `%${name}%`;
  return db.prepare(`
    SELECT * FROM customer_cache
    WHERE is_active = 1
      AND (name LIKE ? COLLATE NOCASE OR full_name LIKE ? COLLATE NOCASE OR company_name LIKE ? COLLATE NOCASE)
    ORDER BY name COLLATE NOCASE
    LIMIT 1
  `).get(pattern, pattern, pattern);
}

/**
 * Get the timestamp of the last customer sync.
 */
function getCustomerSyncTime() {
  const db = getDb();
  const row = db.prepare(`
    SELECT MAX(synced_at) as last_sync FROM customer_cache
  `).get();
  return row ? row.last_sync : null;
}

// ─── Order Responses ────────────────────────────────────────────

/**
 * Store a QB order/invoice response.
 */
function storeOrderResponse(response) {
  const db = getDb();
  db.prepare(`
    INSERT INTO order_responses
      (id, queue_id, type, txn_id, txn_number, customer_name, total, status, callback_url, raw_response)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    response.id,
    response.queueId || null,
    response.type,
    response.txnId,
    response.txnNumber || null,
    response.customerName || null,
    response.total || null,
    response.status || 'created',
    response.callbackUrl || null,
    response.rawResponse ? JSON.stringify(response.rawResponse) : null
  );
}

/**
 * Get recent order responses.
 */
function getRecentOrders(limit = 50) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM order_responses ORDER BY created_at DESC LIMIT ?
  `).all(limit);
}

/**
 * Get an order response by queue_id.
 */
function getOrderByQueueId(queueId) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM order_responses WHERE queue_id = ?
  `).get(queueId);
}

/**
 * Mark callback as sent for an order response.
 */
function markCallbackSent(id) {
  const db = getDb();
  db.prepare(`
    UPDATE order_responses SET callback_sent = 1 WHERE id = ?
  `).run(id);
}

/**
 * Get order responses with pending callbacks.
 */
function getPendingCallbacks() {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM order_responses
    WHERE callback_url IS NOT NULL AND callback_url != '' AND callback_sent = 0
  `).all();
}

module.exports = {
  // Inventory
  upsertInventoryItem,
  bulkUpsertInventory,
  getAllInventory,
  searchInventory,
  getInventoryItem,
  getInventorySyncTime,
  // Customers
  upsertCustomer,
  bulkUpsertCustomers,
  getAllCustomers,
  searchCustomers,
  getCustomer,
  getCustomerSyncTime,
  // Orders
  storeOrderResponse,
  getRecentOrders,
  getOrderByQueueId,
  markCallbackSent,
  getPendingCallbacks,
};
