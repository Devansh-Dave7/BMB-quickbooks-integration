const express = require('express');
const { apiKeyAuth, validate, errorHandler } = require('./middleware');
const { validateOrderPayload, validateQueryPayload, validateInventoryAddPayload } = require('./validators');
const queue = require('../db/queue');
const cache = require('../db/cache');
const pricing = require('../db/pricing');
const log = require('../db/log');
const templates = require('../qbxml/templates');
const { resolveOrderItems, validateItemsExist, formatFollowupLine, attemptAutoMatch } = require('./item-resolver');

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

/**
 * Two-stage rescue for items[] when Sophia's `qb_item_name` doesn't match
 * the catalog:
 *   1. validateItemsExist splits items into known-good / unknown.
 *   2. For each unknown, attemptAutoMatch runs `searchParts` (same synonym
 *      map the `lookup_part` tool uses) and substitutes a catalog hit when
 *      found. Catalog price replaces Sophia's $0 fabrication.
 * Whatever still can't be resolved is appended to `staff_followup_notes` so
 * the order still lands and staff can bill the unmatched items separately.
 *
 * Returns:
 *   - reject:               true if there's literally nothing to put on the order
 *   - itemsForOrder:        merged valid + auto-matched items (the QB line items)
 *   - autoMatchedItems:     [{original, resolved_name, resolved_price}] for caller-facing response
 *   - autoFollowupItems:    [name] of items that couldn't be matched and went to followup
 *   - staffFollowupNotes:   updated notes string with audit + followup lines prepended
 *   - logDetail:            extra context for the audit log entry
 */
function rescueAndPartitionItems(items, existingFollowupNotes) {
  const validation = validateItemsExist(items);
  let staffFollowupNotes = existingFollowupNotes;

  if (validation.ok) {
    return {
      reject: false,
      itemsForOrder: items,
      autoMatchedItems: [],
      autoFollowupItems: [],
      staffFollowupNotes,
      logDetail: null,
    };
  }

  const matched = [];
  const stillUnmatched = [];
  for (const inv of validation.invalid) {
    const m = attemptAutoMatch(inv);
    if (m) matched.push(m); else stillUnmatched.push(inv);
  }

  // Nothing salvageable — the caller will see a 400 and we'll log why.
  if (validation.valid.length === 0 && matched.length === 0) {
    return {
      reject: true,
      itemsForOrder: [],
      autoMatchedItems: [],
      autoFollowupItems: [],
      staffFollowupNotes,
      rejectPayload: {
        error: 'Invalid items',
        message:
          'No line items matched a known QuickBooks product, and none could be ' +
          'resolved via fuzzy catalog lookup. Use the lookup_part tool, or move ' +
          'them all to staff_followup_notes.',
        invalid_items: validation.invalid_names,
        suggestions: validation.suggestions,
      },
      logDetail: {
        reason: 'no_valid_items_after_auto_match',
        invalid: validation.invalid_names,
        suggestions: validation.suggestions,
      },
    };
  }

  const matchedAsLineItems = matched.map((m) => ({
    name: m.name,
    description: m.original,
    qty: m.qty,
    rate: m.sales_price,
  }));
  const itemsForOrder = [...validation.valid, ...matchedAsLineItems];

  // Auto-match audit lines go FIRST in followup notes so the memo shows
  // "AUTO-MATCHED: …" before "Nx unmatched (caller's wording…)" entries.
  const auditLines = matched.map((m) => m.audit_line);
  const followupLines = stillUnmatched.map(formatFollowupLine);
  const allNoteSegments = [...auditLines, ...followupLines].filter(Boolean);
  if (allNoteSegments.length > 0) {
    const joined = allNoteSegments.join('; ');
    staffFollowupNotes = staffFollowupNotes
      ? `${joined}; ${String(staffFollowupNotes).trim()}`
      : joined;
  }

  return {
    reject: false,
    itemsForOrder,
    autoMatchedItems: matched.map((m) => ({
      original: m.original,
      resolved_name: m.name,
      resolved_price: m.sales_price,
    })),
    autoFollowupItems: stillUnmatched.map((i) => i.name),
    staffFollowupNotes,
    logDetail: {
      auto_matched_count: matched.length,
      promoted_to_followup: stillUnmatched.map((i) => i.name),
      suggestions: validation.suggestions,
      valid_count: validation.valid.length,
    },
  };
}

// ─── POST /api/order — Queue a sales order ──────────────────────

router.post('/order', validate(validateOrderPayload), (req, res) => {
  const { customer_name, customer_ref, po_number, items, memo, callback_url,
    is_new_customer, company_name, customer_phone, customer_email, first_name, last_name } = req.body;
  let { staff_followup_notes } = req.body;

  const rescue = rescueAndPartitionItems(items, staff_followup_notes);
  if (rescue.reject) {
    log.logEvent({
      event: 'order_rejected_no_valid_items',
      detail: { customer_name, company_name, po_number, ...rescue.logDetail },
    });
    return res.status(400).json(rescue.rejectPayload);
  }
  const validatedItems = rescue.itemsForOrder;
  const autoFollowupItems = rescue.autoFollowupItems;
  const autoMatchedItems = rescue.autoMatchedItems;
  staff_followup_notes = rescue.staffFollowupNotes;
  if (rescue.logDetail) {
    log.logEvent({
      event: 'order_auto_resolved_invalid_items',
      detail: { customer_name, company_name, po_number, ...rescue.logDetail },
    });
  }

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
  const resolvedItems = resolveOrderItems(validatedItems, priceLevel);

  const baseMemo = memo || 'Phone order via Sophia AI';
  const finalMemo = staff_followup_notes
    ? `STAFF FOLLOWUP NEEDED: ${String(staff_followup_notes).trim()} | ${baseMemo}`
    : baseMemo;

  const qbxml = templates.buildSalesOrderAdd({
    customerName: resolvedCustomerName,
    customerRef: customer_ref,
    poNumber: po_number,
    memo: finalMemo,
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

  if (staff_followup_notes) {
    response.staff_followup_recorded = true;
  }

  if (autoFollowupItems.length > 0) {
    response.auto_followup_items = autoFollowupItems;
  }

  if (autoMatchedItems.length > 0) {
    response.auto_matched_items = autoMatchedItems;
  }

  res.status(202).json(response);
});

// ─── POST /api/invoice — Queue an invoice ───────────────────────

router.post('/invoice', validate(validateOrderPayload), (req, res) => {
  const { customer_name, customer_ref, po_number, items, memo, callback_url,
    is_new_customer, company_name, customer_phone, customer_email, first_name, last_name } = req.body;
  let { staff_followup_notes } = req.body;

  const rescue = rescueAndPartitionItems(items, staff_followup_notes);
  if (rescue.reject) {
    log.logEvent({
      event: 'invoice_rejected_no_valid_items',
      detail: { customer_name, company_name, po_number, ...rescue.logDetail },
    });
    return res.status(400).json(rescue.rejectPayload);
  }
  const validatedItems = rescue.itemsForOrder;
  const autoFollowupItems = rescue.autoFollowupItems;
  const autoMatchedItems = rescue.autoMatchedItems;
  staff_followup_notes = rescue.staffFollowupNotes;
  if (rescue.logDetail) {
    log.logEvent({
      event: 'invoice_auto_resolved_invalid_items',
      detail: { customer_name, company_name, po_number, ...rescue.logDetail },
    });
  }

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
  const resolvedItems = resolveOrderItems(validatedItems, priceLevel);

  const baseMemo = memo || 'Phone order via Sophia AI';
  const finalMemo = staff_followup_notes
    ? `STAFF FOLLOWUP NEEDED: ${String(staff_followup_notes).trim()} | ${baseMemo}`
    : baseMemo;

  const qbxml = templates.buildInvoiceAdd({
    customerName: resolvedCustomerName,
    customerRef: customer_ref,
    poNumber: po_number,
    memo: finalMemo,
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

  if (staff_followup_notes) {
    invoiceResponse.staff_followup_recorded = true;
  }

  if (autoFollowupItems.length > 0) {
    invoiceResponse.auto_followup_items = autoFollowupItems;
  }

  if (autoMatchedItems.length > 0) {
    invoiceResponse.auto_matched_items = autoMatchedItems;
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

// ─── GET /api/parts/search — Material/parts/supplies catalog lookup ─
//
// Returns inventory_cache items NOT covered by pricing_metadata (so this
// surface is the "everything except heat pumps / heat kits / etc." catalog).
// Used by the Retell `lookup_part` tool so Sophia can quote real materials
// (mastic, flex, line sets, accessories...) instead of fabricating QB names.

router.get('/parts/search', (req, res) => {
  const q = (req.query.q || req.query.query || '').toString().trim();
  if (!q) {
    return res.status(400).json({ error: 'Missing required query param `q`' });
  }
  const limit = Math.min(parseInt(req.query.limit, 10) || 25, 50);
  const items = cache.searchParts(q, { limit });
  res.json({
    query: q,
    count: items.length,
    last_qb_sync: cache.getInventorySyncTime(),
    items: items.map((i) => ({
      qb_item_name: i.full_name || i.name,
      name: i.name,
      sku: i.sku,
      description: i.description,
      sales_price: i.sales_price,
      qty_on_hand: i.qty_on_hand,
    })),
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

// ─── GET /api/admin/diagnose — QBWC connectivity / queue snapshot ──
//
// When orders are queued but not landing in QB, this endpoint surfaces the
// state without needing DB access: pending queue items, recent sync events
// (so we can tell whether QBWC is even attempting to connect), and the
// last successful sync close. If `last_sync` is hours old or the most
// recent events have no `authenticate` entries, QBWC on the BMB office
// machine is offline — not a server issue.

router.get('/admin/diagnose', (req, res) => {
  const db = require('../db/schema').getDb();
  const pending = db.prepare(`
    SELECT id, type, status, created_at, sent_at, completed_at,
           substr(qbxml, 1, 200) as qbxml_preview
    FROM request_queue
    WHERE status IN ('pending', 'sent')
    ORDER BY created_at DESC
    LIMIT 25
  `).all();
  const recentEvents = log.getRecentLogs(40).map((e) => ({
    created_at: e.created_at,
    event: e.event,
    ticket: e.ticket,
    request_type: e.request_type,
    detail: e.detail ? String(e.detail).slice(0, 200) : null,
  }));
  const recentErrors = log.getErrorLogs(15).map((e) => ({
    created_at: e.created_at,
    detail: e.detail ? String(e.detail).slice(0, 400) : null,
  }));
  res.json({
    last_successful_sync_close: log.getLastSyncTime(),
    queue_depth_pending: pending.filter((p) => p.status === 'pending').length,
    queue_depth_in_flight: pending.filter((p) => p.status === 'sent').length,
    pending_items: pending,
    recent_events: recentEvents,
    recent_errors: recentErrors,
  });
});

// ─── POST /api/admin/queue/cleanup-stuck — Clear stale in-flight items ──
//
// An item lands in `status=sent` when QBWC asks for the next request and we
// hand it over. The status should flip back to `completed`/`error` when
// QBWC posts the response. If QBWC dies mid-cycle (connection drop, QB
// crash, computer reboot), the item stays `sent` forever and shows up in
// the diagnose snapshot as "in-flight" even though nothing is actually
// happening. Marks any `sent` row whose sent_at is older than the cutoff
// (default 10 minutes) as `error` so the queue snapshot stays accurate.

router.post('/admin/queue/cleanup-stuck', (req, res) => {
  const minutes = parseInt(req.query.older_than_minutes, 10) || 10;
  const db = require('../db/schema').getDb();
  const stale = db.prepare(`
    SELECT id, type, sent_at FROM request_queue
    WHERE status = 'sent' AND sent_at < datetime('now', ?)
  `).all(`-${minutes} minutes`);
  const result = db.prepare(`
    UPDATE request_queue
    SET status = 'error', completed_at = datetime('now')
    WHERE status = 'sent' AND sent_at < datetime('now', ?)
  `).run(`-${minutes} minutes`);
  res.json({
    status: 'ok',
    cleared: result.changes,
    older_than_minutes: minutes,
    items: stale.map((s) => ({ id: s.id, type: s.type, sent_at: s.sent_at })),
  });
});

// ─── POST /api/admin/seed-pricing — Force ensurePricingSeeded ─────
//
// Manual trigger for ensurePricingSeeded(). Needed when Railway has
// hot-loaded new code without restarting the process (so the startup
// hook never re-runs). Re-running is idempotent — the function bails
// early when pricing_metadata already has rows.

router.post('/admin/seed-pricing', (req, res) => {
  try {
    const { ensurePricingSeeded } = require('../db/pricing');
    const before = require('../db/schema').getDb()
      .prepare('SELECT COUNT(*) as cnt FROM pricing_metadata').get();
    ensurePricingSeeded();
    const after = require('../db/schema').getDb()
      .prepare('SELECT COUNT(*) as cnt FROM pricing_metadata').get();
    res.json({
      status: 'ok',
      rows_before: before.cnt,
      rows_after: after.cnt,
      message: before.cnt === after.cnt && after.cnt > 0
        ? 'Already seeded (no change)'
        : `Seeded ${after.cnt - before.cnt} rows`,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message, stack: err.stack });
  }
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
