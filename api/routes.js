const express = require('express');
const { apiKeyAuth, validate, errorHandler } = require('./middleware');
const { validateOrderPayload, validateQueryPayload } = require('./validators');
const queue = require('../db/queue');
const cache = require('../db/cache');
const log = require('../db/log');
const templates = require('../qbxml/templates');

const router = express.Router();

// All REST routes require API key
router.use(apiKeyAuth);

// ─── POST /api/order — Queue a sales order ──────────────────────

router.post('/order', validate(validateOrderPayload), (req, res) => {
  const { customer_name, customer_ref, po_number, items, memo, callback_url } = req.body;

  // Resolve customer name: look up in cache by FullName, then CompanyName, then partial
  // This handles cases where caller sends company name but QB stores by person name
  let resolvedCustomerName = customer_name;
  let customerMatch = null;
  if (!customer_ref) {
    customerMatch = cache.getCustomer(customer_name);
    if (customerMatch) {
      resolvedCustomerName = customerMatch.full_name || customerMatch.name;
    }
  }

  const qbxml = templates.buildSalesOrderAdd({
    customerName: resolvedCustomerName,
    customerRef: customer_ref,
    poNumber: po_number,
    memo: memo || 'Phone order via Sophia AI',
    items: items.map((i) => ({
      name: i.name,
      description: i.description,
      qty: i.qty || 1,
      rate: i.rate,
    })),
  });

  const queueId = queue.addToQueue({
    type: 'SalesOrderAdd',
    qbxml,
    priority: queue.PRIORITY.USER_ACTION,
    callbackUrl: callback_url,
    metadata: req.body,
  });

  const response = {
    status: 'queued',
    queue_id: queueId,
    message: 'Sales order queued for next QBWC sync',
    estimated_sync: '1-5 minutes',
  };

  // Include resolved customer info so caller knows what was matched
  if (customerMatch && resolvedCustomerName !== customer_name) {
    response.resolved_customer = resolvedCustomerName;
    response.original_customer = customer_name;
  }

  res.status(202).json(response);
});

// ─── POST /api/invoice — Queue an invoice ───────────────────────

router.post('/invoice', validate(validateOrderPayload), (req, res) => {
  const { customer_name, customer_ref, po_number, items, memo, callback_url } = req.body;

  // Resolve customer name (same logic as /order)
  let resolvedCustomerName = customer_name;
  let customerMatch = null;
  if (!customer_ref) {
    customerMatch = cache.getCustomer(customer_name);
    if (customerMatch) {
      resolvedCustomerName = customerMatch.full_name || customerMatch.name;
    }
  }

  const qbxml = templates.buildInvoiceAdd({
    customerName: resolvedCustomerName,
    customerRef: customer_ref,
    poNumber: po_number,
    memo: memo || 'Phone order via Sophia AI',
    items: items.map((i) => ({
      name: i.name,
      description: i.description,
      qty: i.qty || 1,
      rate: i.rate,
    })),
  });

  const queueId = queue.addToQueue({
    type: 'InvoiceAdd',
    qbxml,
    priority: queue.PRIORITY.USER_ACTION,
    callbackUrl: callback_url,
    metadata: req.body,
  });

  const invoiceResponse = {
    status: 'queued',
    queue_id: queueId,
    message: 'Invoice queued for next QBWC sync',
    estimated_sync: '1-5 minutes',
  };

  if (customerMatch && resolvedCustomerName !== customer_name) {
    invoiceResponse.resolved_customer = resolvedCustomerName;
    invoiceResponse.original_customer = customer_name;
  }

  res.status(202).json(invoiceResponse);
});

// ─── POST /api/query — Queue an ad-hoc QB query ────────────────

router.post('/query', validate(validateQueryPayload), (req, res) => {
  const { type, params, callback_url } = req.body;

  const builderMap = {
    CustomerQuery: templates.buildCustomerQuery,
    ItemQuery: templates.buildItemQuery,
    ItemInventoryQuery: templates.buildItemInventoryQuery,
    SalesOrderQuery: templates.buildSalesOrderQuery,
    InvoiceQuery: templates.buildInvoiceQuery,
  };

  const builder = builderMap[type];
  if (!builder) {
    return res.status(400).json({ error: `Unsupported query type: ${type}` });
  }

  const qbxml = builder(params || {});

  const queueId = queue.addToQueue({
    type,
    qbxml,
    priority: queue.PRIORITY.QUERY,
    callbackUrl: callback_url,
    metadata: req.body,
  });

  res.status(202).json({
    status: 'queued',
    queue_id: queueId,
    message: `${type} queued for next QBWC sync`,
    estimated_sync: '1-5 minutes',
  });
});

// ─── GET /api/inventory — Full cached inventory ─────────────────

router.get('/inventory', (req, res) => {
  const { search } = req.query;

  const items = search
    ? cache.searchInventory(search)
    : cache.getAllInventory();

  res.json({
    count: items.length,
    last_sync: cache.getInventorySyncTime(),
    items,
  });
});

// ─── GET /api/inventory/:name_or_sku — Single item lookup ───────

router.get('/inventory/:name_or_sku', (req, res) => {
  const item = cache.getInventoryItem(req.params.name_or_sku);

  if (!item) {
    return res.status(404).json({ error: 'Item not found', query: req.params.name_or_sku });
  }

  res.json(item);
});

// ─── GET /api/customers — Full cached customer list ─────────────

router.get('/customers', (req, res) => {
  const { search } = req.query;

  const customers = search
    ? cache.searchCustomers(search)
    : cache.getAllCustomers();

  res.json({
    count: customers.length,
    last_sync: cache.getCustomerSyncTime(),
    customers,
  });
});

// ─── GET /api/customer/:name — Single customer lookup ───────────

router.get('/customer/:name', (req, res) => {
  const customer = cache.getCustomer(req.params.name);

  if (!customer) {
    return res.status(404).json({ error: 'Customer not found', query: req.params.name });
  }

  res.json(customer);
});

// ─── GET /api/orders — Recent order responses ───────────────────

router.get('/orders', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const orders = cache.getRecentOrders(limit);

  res.json({
    count: orders.length,
    orders,
  });
});

// ─── GET /api/status — Server health + sync info ────────────────

router.get('/status', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    uptime: Math.floor(process.uptime()),
    queue_depth: queue.getQueueDepth(),
    last_sync: log.getLastSyncTime(),
    cache_freshness: {
      inventory: cache.getInventorySyncTime(),
      customers: cache.getCustomerSyncTime(),
    },
  });
});

// Error handler (must be last)
router.use(errorHandler);

module.exports = router;
