const express = require('express');
const { apiKeyAuth, validate, errorHandler } = require('./middleware');
const { validateOrderPayload, validateQueryPayload, validateInventoryAddPayload } = require('./validators');
const queue = require('../db/queue');
const cache = require('../db/cache');
const pricing = require('../db/pricing');
const log = require('../db/log');
const templates = require('../qbxml/templates');
const { resolveOrderItems } = require('./item-resolver');

const router = express.Router();

// All REST routes require API key
router.use(apiKeyAuth);

/**
 * Locate the QB customer for order/invoice creation.
 * Prefers an exact match (company first, then person) so price level lookups
 * target the right wholesale account. Falls back to fuzzy name-only matching
 * for display purposes — but price level MUST NOT be applied to fuzzy matches,
 * which is why the result flags `isExact`.
 */
function findCustomerForOrder(customerName, companyName) {
  const exact = pricing.findCustomerForPricing(customerName, companyName);
  if (exact) {
    return { customer: exact.customer, isExact: true, matched_on: exact.matched_on };
  }
  const fuzzy = cache.getCustomer(customerName);
  if (fuzzy) {
    return { customer: fuzzy, isExact: false, matched_on: 'fuzzy' };
  }
  return null;
}

/**
 * Look up a customer's price level from cache and emit an audit log entry.
 * Returns the price level object or null. Safe to call with null customer.
 */
function resolvePriceLevelForCustomer(customerMatch, context) {
  if (!customerMatch) return null;
  if (!customerMatch.price_level_list_id) {
    log.logEvent({
      event: 'price_level_skipped',
      detail: {
        reason: 'no_level_assigned',
        context,
        customer: customerMatch.name,
      },
    });
    return null;
  }

  const priceLevel = cache.getPriceLevelByListId(customerMatch.price_level_list_id);
  if (!priceLevel) {
    log.logEvent({
      event: 'price_level_skipped',
      detail: {
        reason: 'level_not_in_cache',
        context,
        customer: customerMatch.name,
        price_level_list_id: customerMatch.price_level_list_id,
      },
    });
    return null;
  }

  log.logEvent({
    event: 'price_level_applied',
    detail: {
      context,
      customer: customerMatch.name,
      price_level_name: priceLevel.name,
      price_level_type: priceLevel.level_type,
      price_level_list_id: priceLevel.list_id,
      adjustment_percent:
        priceLevel.level_type === 'FixedPercentage' ? priceLevel.fixed_percentage : null,
    },
  });

  return priceLevel;
}

// ─── POST /api/order — Queue a sales order ──────────────────────

router.post('/order', validate(validateOrderPayload), (req, res) => {
  const { customer_name, customer_ref, po_number, items, memo, callback_url,
    is_new_customer, company_name, customer_phone, customer_email, first_name, last_name } = req.body;

  // Resolve customer: prefer an exact company-or-person match (needed for
  // accurate price level lookup), fall back to fuzzy match for display only.
  let resolvedCustomerName = customer_name;
  let customerMatch = null;
  let matchIsExact = false;
  if (!customer_ref) {
    const match = findCustomerForOrder(customer_name, company_name);
    if (match) {
      customerMatch = match.customer;
      matchIsExact = match.isExact;
      resolvedCustomerName = customerMatch.full_name || customerMatch.name;
    }
  }

  // Resolve price level — ONLY for exact matches. A fuzzy name collision
  // (e.g. "Smith HVAC" matching "Smith HVAC Services") must not pull the
  // wrong wholesale level onto someone else's order.
  const priceLevel = matchIsExact
    ? resolvePriceLevelForCustomer(customerMatch, 'order_creation')
    : null;

  // If new customer, queue a CustomerAdd first (processed before SalesOrderAdd)
  let customerQueueId = null;
  if (is_new_customer) {
    const customerQbxml = templates.buildCustomerAdd({
      name: resolvedCustomerName,
      firstName: first_name,
      lastName: last_name,
      companyName: company_name,
      phone: customer_phone,
      email: customer_email,
    });

    customerQueueId = queue.addToQueue({
      type: 'CustomerAdd',
      qbxml: customerQbxml,
      priority: queue.PRIORITY.USER_ACTION,
      metadata: { customer_name: resolvedCustomerName, source: 'auto_create' },
    });
  }

  // Resolve combined system names into individual QB parts
  const resolvedItems = resolveOrderItems(items, priceLevel);

  const qbxml = templates.buildSalesOrderAdd({
    customerName: resolvedCustomerName,
    customerRef: customer_ref,
    poNumber: po_number,
    memo: memo || 'Phone order via Sophia AI',
    items: resolvedItems.map((i) => ({
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

  if (customerQueueId) {
    response.auto_customer_queued = true;
    response.customer_queue_id = customerQueueId;
  }

  res.status(202).json(response);
});

// ─── POST /api/invoice — Queue an invoice ───────────────────────

router.post('/invoice', validate(validateOrderPayload), (req, res) => {
  const { customer_name, customer_ref, po_number, items, memo, callback_url,
    is_new_customer, company_name, customer_phone, customer_email, first_name, last_name } = req.body;

  // Same exact-first, fuzzy-fallback strategy as /api/order.
  let resolvedCustomerName = customer_name;
  let customerMatch = null;
  let matchIsExact = false;
  if (!customer_ref) {
    const match = findCustomerForOrder(customer_name, company_name);
    if (match) {
      customerMatch = match.customer;
      matchIsExact = match.isExact;
      resolvedCustomerName = customerMatch.full_name || customerMatch.name;
    }
  }

  // Price level only on exact matches (same rationale as /order).
  const priceLevel = matchIsExact
    ? resolvePriceLevelForCustomer(customerMatch, 'invoice_creation')
    : null;

  // If new customer, queue a CustomerAdd first (processed before InvoiceAdd)
  let customerQueueId = null;
  if (is_new_customer) {
    const customerQbxml = templates.buildCustomerAdd({
      name: resolvedCustomerName,
      firstName: first_name,
      lastName: last_name,
      companyName: company_name,
      phone: customer_phone,
      email: customer_email,
    });

    customerQueueId = queue.addToQueue({
      type: 'CustomerAdd',
      qbxml: customerQbxml,
      priority: queue.PRIORITY.USER_ACTION,
      metadata: { customer_name: resolvedCustomerName, source: 'auto_create' },
    });
  }

  // Resolve combined system names into individual QB parts
  const resolvedItems = resolveOrderItems(items, priceLevel);

  const qbxml = templates.buildInvoiceAdd({
    customerName: resolvedCustomerName,
    customerRef: customer_ref,
    poNumber: po_number,
    memo: memo || 'Phone order via Sophia AI',
    items: resolvedItems.map((i) => ({
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

  if (customerQueueId) {
    invoiceResponse.auto_customer_queued = true;
    invoiceResponse.customer_queue_id = customerQueueId;
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
    PriceLevelQuery: templates.buildPriceLevelQuery,
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

// ─── POST /api/inventory/add — Queue inventory items for QB ─────

router.post('/inventory/add', validate(validateInventoryAddPayload), (req, res) => {
  const { items, callback_url } = req.body;

  const queueIds = [];
  const allWarnings = [];

  for (const item of items) {
    const { qbxml, warnings } = templates.buildItemInventoryAdd(item);

    if (warnings.length > 0) {
      allWarnings.push({ name: item.name, warnings });
    }

    const queueId = queue.addToQueue({
      type: 'ItemInventoryAdd',
      qbxml,
      priority: queue.PRIORITY.USER_ACTION,
      callbackUrl: callback_url,
      metadata: item,
    });

    queueIds.push(queueId);
  }

  const response = {
    status: 'queued',
    queue_ids: queueIds,
    item_count: items.length,
    message: `${items.length} inventory item(s) queued for next QBWC sync`,
    estimated_sync: '1-5 minutes',
  };

  if (allWarnings.length > 0) {
    response.warnings = allWarnings;
  }

  res.status(202).json(response);
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

  let priceLevelInfo = null;
  if (customer.price_level_list_id) {
    const pl = cache.getPriceLevelByListId(customer.price_level_list_id);
    if (pl) {
      priceLevelInfo = {
        list_id: pl.list_id,
        name: pl.name,
        type: pl.level_type,
        fixed_percentage: pl.fixed_percentage,
        per_item_count: pl.per_item_data ? pl.per_item_data.length : 0,
      };
    }
  }

  res.json({ ...customer, price_level: priceLevelInfo });
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

// ─── GET /api/pricing — List pricing categories ─────────────────

router.get('/pricing', (req, res) => {
  const categories = pricing.getPricingCategories();
  res.json({ categories });
});

// ─── GET /api/pricing/_/resolve-customer — Diagnostic trace ─────
//
// Registered BEFORE /api/pricing/:category so Express matches the literal
// "_" segment first. Returns the customer match, price level, and a small
// pricing preview when `category` is provided.

router.get('/pricing/_/resolve-customer', (req, res) => {
  const { customer, company, category } = req.query;
  const personName = customer || null;
  const companyName = company || null;

  const match = pricing.findCustomerForPricing(personName, companyName);

  const out = {
    lookup: {
      customer_query: personName,
      company_query: companyName,
      matched_customer: null,
      price_level: null,
    },
  };

  if (match) {
    out.lookup.matched_customer = {
      list_id: match.customer.list_id,
      name: match.customer.name,
      full_name: match.customer.full_name,
      company_name: match.customer.company_name,
      matched_on: match.matched_on,
    };

    if (match.customer.price_level_list_id) {
      const pl = cache.getPriceLevelByListId(match.customer.price_level_list_id);
      if (pl) {
        out.lookup.price_level = {
          list_id: pl.list_id,
          name: pl.name,
          type: pl.level_type,
          fixed_percentage: pl.fixed_percentage,
          per_item_count: pl.per_item_data ? pl.per_item_data.length : 0,
        };
      }
    }
  }

  if (category) {
    const validCategories = ['heat_pump', 'ac', 'inverter', 'package_unit', 'heat_kit', 'warranty'];
    if (!validCategories.includes(category)) {
      return res.status(400).json({
        error: `Invalid category: ${category}`,
        valid_categories: validCategories,
      });
    }

    const resolved = pricing.resolvePricingForCustomer({
      category,
      personName,
      companyName,
    });
    const formatted = pricing.formatPricingResponse(resolved.rows, category, {
      customerMatch: resolved.customerMatch,
      priceLevelApplied: resolved.priceLevelApplied,
    });

    const sample = formatted.items.slice(0, 5).map((item) => {
      const list = item.list_csv_price != null ? item.list_csv_price : item.csv_price;
      const adjusted = item.price;
      const adjustedComponents = [];
      if (item.list_qb_outdoor_price != null) adjustedComponents.push('outdoor');
      if (item.list_qb_indoor_price != null) adjustedComponents.push('indoor');
      return {
        qb_item_name: item.qb_item_name,
        list_price: list,
        adjusted_price: adjusted,
        savings: list != null && adjusted != null ? Math.round((list - adjusted) * 100) / 100 : null,
        savings_pct:
          list != null && adjusted != null && list > 0
            ? Math.round(((list - adjusted) / list) * 10000) / 100
            : null,
        components_adjusted: adjustedComponents,
      };
    });

    out.pricing_preview = {
      category,
      items_count: formatted.items.length,
      items_overridden: resolved.priceLevelApplied ? resolved.priceLevelApplied.items_overridden : 0,
      sample_items: sample,
    };
  }

  res.json(out);
});

// ─── GET /api/pricing/:category — Get items in a category ───────

router.get('/pricing/:category', (req, res) => {
  const { category } = req.params;
  const { tonnage, tier, customer, company } = req.query;

  const validCategories = ['heat_pump', 'ac', 'inverter', 'package_unit', 'heat_kit', 'warranty'];
  if (!validCategories.includes(category)) {
    return res.status(400).json({
      error: `Invalid category: ${category}`,
      valid_categories: validCategories,
    });
  }

  const hasCustomerQuery =
    (customer && String(customer).trim()) || (company && String(company).trim());

  if (hasCustomerQuery) {
    const resolved = pricing.resolvePricingForCustomer({
      category,
      personName: customer,
      companyName: company,
      tonnage,
      tier,
    });
    const response = pricing.formatPricingResponse(resolved.rows, category, {
      customerMatch: resolved.customerMatch,
      priceLevelApplied: resolved.priceLevelApplied,
      customerQuery: { person: customer, company },
    });
    return res.json(response);
  }

  const rows = pricing.getPricingByCategory(category, { tonnage, tier });
  const response = pricing.formatPricingResponse(rows, category);
  res.json(response);
});

// ─── GET /api/price-levels — Cached price levels ────────────────

router.get('/price-levels', (req, res) => {
  const priceLevels = cache.getAllPriceLevels();
  res.json({
    count: priceLevels.length,
    last_sync: cache.getPriceLevelSyncTime(),
    price_levels: priceLevels,
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
      price_levels: cache.getPriceLevelSyncTime(),
    },
  });
});

// Error handler (must be last)
router.use(errorHandler);

module.exports = router;
