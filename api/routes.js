const express = require('express');
const { apiKeyAuth, validate, errorHandler } = require('./middleware');
const { validateOrderPayload, validateQueryPayload, validateInventoryAddPayload } = require('./validators');
const queue = require('../db/queue');
const cache = require('../db/cache');
const pricing = require('../db/pricing');
const log = require('../db/log');
const templates = require('../qbxml/templates');
const {
  resolveOrderItems, validateItemsExist, formatFollowupLine, attemptAutoMatch,
  isCatalogValid, normalizeFabricatedName,
} = require('./item-resolver');
const callHistory = require('../db/call-history');

const router = express.Router();

// Fix 3 kill switch. When false, mandatory-staff_followup_notes enforcement
// is bypassed — existing 2026-05-20 auto-promote behaviour is preserved.
// Default ON; set REQUIRE_FOLLOWUP_NOTES=0 in Railway env to disable.
const REQUIRE_FOLLOWUP_NOTES = process.env.REQUIRE_FOLLOWUP_NOTES !== '0';

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
 * Three-tier rescue + gate for create_quickbooks_order items[].
 *
 * For each item, in order of preference:
 *   1. CATALOG-DIRECT  — name matches pricing_metadata or inventory_cache
 *      → item passes (Sophia copied a real qb_item_name from a [QB_DATA]
 *      block, which is the canonical path).
 *   2. LOOKUP-EVIDENCE — name appears in this call_id's call_lookup_history
 *      (i.e. Sophia called lookup_part for this caller item earlier in the
 *      same call) → item passes (Fix 1 — Sophia did the right thing).
 *   3. AUTO-MATCH      — synonym map (searchParts) finds a close catalog
 *      match for Sophia's fabricated phrasing → item passes BUT we log a
 *      warning and (per Fix 3 when REQUIRE_FOLLOWUP_NOTES=1) demand that
 *      staff_followup_notes was populated, so ops sees what got rescued.
 *   4. NO MATCH        — Sophia's phrasing has no synonym either; the line
 *      is promoted into staff_followup_notes verbatim with quantity.
 *
 * If the result has zero items[] AND zero auto-matches the request is
 * rejected with HTTP 400. If auto-match was used and notes are empty,
 * Fix 3 returns HTTP 422 with a Sophia-actionable directive so she
 * resubmits with the required notes rather than telling the caller
 * "success".
 */
function rescueAndPartitionItems(items, existingFollowupNotes, opts = {}) {
  const call_id = opts.call_id || null;
  let staffFollowupNotes = existingFollowupNotes;

  const valid = [];                  // tier 1 hits
  const lookupGated = [];            // tier 2 hits
  const autoMatched = [];            // tier 3 hits ({ original, name, sales_price, qty, audit_line })
  const stillUnmatched = [];         // tier 4 (followup-only)
  const suggestions = {};
  const invalidNames = [];           // names that didn't pass tier 1 (for audit)

  // Compile fuzzy-suggestion lookup once for performance; only used for
  // the 400 reject path. Same query as validateItemsExist.
  const { getDb } = require('../db/schema');
  const db = getDb();
  const stmtFuzzy = db.prepare(`
    SELECT name, full_name, sales_price FROM inventory_cache
    WHERE is_active = 1 AND (name LIKE ? COLLATE NOCASE OR full_name LIKE ? COLLATE NOCASE)
    ORDER BY CASE WHEN qty_on_hand > 0 THEN 0 ELSE 1 END, name COLLATE NOCASE
    LIMIT 5
  `);

  for (const item of items || []) {
    const name = item && item.name;
    if (!name) continue;

    if (isCatalogValid(name)) {
      valid.push(item);
      continue;
    }
    invalidNames.push(name);

    // Tier 2: lookup_part evidence for this call_id (Fix 1)
    if (call_id && callHistory.hasLookupHitForCall(call_id, name)) {
      lookupGated.push(item);
      continue;
    }

    // Tier 3: fuzzy auto-match fallback
    const m = attemptAutoMatch(item);
    if (m) { autoMatched.push(m); continue; }

    // Tier 4: unmatched → followup
    stillUnmatched.push(item);
    const pattern = `%${name.replace(/[%_]/g, '')}%`;
    const matches = stmtFuzzy.all(pattern, pattern);
    if (matches.length > 0) {
      suggestions[name] = matches.map((mm) => ({
        full_name: mm.full_name || mm.name,
        sales_price: mm.sales_price,
      }));
    }
  }

  // 400 path: nothing salvageable on any tier.
  if (valid.length === 0 && lookupGated.length === 0 && autoMatched.length === 0) {
    return {
      reject: true,
      rejectStatus: 400,
      itemsForOrder: [],
      autoMatchedItems: [],
      autoFollowupItems: [],
      staffFollowupNotes,
      rejectPayload: {
        error: 'Invalid items',
        message:
          'No line items matched a known QuickBooks product, none had lookup_part ' +
          'evidence for this call, and none could be resolved via fuzzy catalog ' +
          'lookup. Use the lookup_part tool for each material, or move them all ' +
          'to staff_followup_notes.',
        invalid_items: invalidNames,
        suggestions,
      },
      logDetail: {
        reason: 'no_valid_items_after_all_tiers',
        invalid: invalidNames,
        suggestions,
        call_id,
      },
    };
  }

  // 422 path (Fix 3): auto-match or auto-followup occurred AND
  // staff_followup_notes is empty AND the kill switch is on. Reject with a
  // structured retry directive so Sophia repopulates notes instead of
  // telling the caller "all set".
  const notesEmpty = !staffFollowupNotes || !String(staffFollowupNotes).trim();
  const rescueTriggered = autoMatched.length > 0 || stillUnmatched.length > 0;
  if (REQUIRE_FOLLOWUP_NOTES && rescueTriggered && notesEmpty) {
    return {
      reject: true,
      rejectStatus: 422,
      itemsForOrder: [],
      autoMatchedItems: autoMatched.map((m) => ({
        original: m.original, resolved_name: m.name, resolved_price: m.sales_price,
      })),
      autoFollowupItems: stillUnmatched.map((i) => i.name),
      staffFollowupNotes,
      rejectPayload: {
        error: 'staff_followup_notes_required',
        message:
          `Order NOT placed. ${autoMatched.length} item(s) were auto-matched from ` +
          `caller wording and ${stillUnmatched.length} could not be matched. ` +
          `You MUST populate staff_followup_notes with the caller's verbatim wording ` +
          `(plus quantities) for the questionable items so the team can verify ` +
          `pricing, then resubmit create_quickbooks_order with the SAME items[]. ` +
          `Do NOT tell the caller "all set" yet.`,
        auto_matched_items: autoMatched.map((m) => ({ original: m.original, resolved_name: m.name, resolved_price: m.sales_price })),
        auto_followup_candidates: stillUnmatched.map((i) => i.name),
      },
      logDetail: {
        reason: 'staff_followup_notes_required',
        auto_matched_count: autoMatched.length,
        promoted_to_followup_count: stillUnmatched.length,
        call_id,
      },
    };
  }

  // Build final items list. Tier-3 matches replace Sophia's fabricated
  // name/rate with the catalog hit's full_name + sales_price.
  const matchedAsLineItems = autoMatched.map((m) => ({
    name: m.name,
    description: m.original,
    qty: m.qty,
    rate: m.sales_price,
  }));
  const itemsForOrder = [...valid, ...lookupGated, ...matchedAsLineItems];

  // Build audit-line + followup-line memo segments.
  const auditLines = autoMatched.map((m) => m.audit_line);
  const followupLines = stillUnmatched.map(formatFollowupLine);
  const allNoteSegments = [...auditLines, ...followupLines].filter(Boolean);
  if (allNoteSegments.length > 0) {
    const joined = allNoteSegments.join('; ');
    staffFollowupNotes = staffFollowupNotes
      ? `${joined}; ${String(staffFollowupNotes).trim()}`
      : joined;
  }

  // Did this submission depend on any tier other than tier-1 catalog?
  const wasGated = lookupGated.length > 0 || autoMatched.length > 0 || stillUnmatched.length > 0;

  return {
    reject: false,
    itemsForOrder,
    autoMatchedItems: autoMatched.map((m) => ({
      original: m.original,
      resolved_name: m.name,
      resolved_price: m.sales_price,
    })),
    lookupGatedItems: lookupGated.map((i) => i.name),
    autoFollowupItems: stillUnmatched.map((i) => i.name),
    staffFollowupNotes,
    logDetail: wasGated ? {
      catalog_direct_count: valid.length,
      lookup_gated_count: lookupGated.length,
      auto_matched_count: autoMatched.length,
      promoted_to_followup: stillUnmatched.map((i) => i.name),
      suggestions,
      call_id,
    } : null,
  };
}

// ─── POST /api/order — Queue a sales order ──────────────────────

router.post('/order', validate(validateOrderPayload), (req, res) => {
  const { customer_name, customer_ref, po_number, items, memo, callback_url,
    is_new_customer, company_name, customer_phone, customer_email, first_name, last_name,
    call_id } = req.body;
  let { staff_followup_notes } = req.body;

  const rescue = rescueAndPartitionItems(items, staff_followup_notes, { call_id });
  if (rescue.reject) {
    const evt = rescue.rejectStatus === 422
      ? 'order_rejected_followup_notes_required'
      : 'order_rejected_no_valid_items';
    log.logEvent({
      event: evt,
      call_id,
      detail: { customer_name, company_name, po_number, ...rescue.logDetail },
    });
    return res.status(rescue.rejectStatus || 400).json(rescue.rejectPayload);
  }
  const validatedItems = rescue.itemsForOrder;
  const autoFollowupItems = rescue.autoFollowupItems;
  const autoMatchedItems = rescue.autoMatchedItems;
  const lookupGatedItems = rescue.lookupGatedItems || [];
  staff_followup_notes = rescue.staffFollowupNotes;
  if (rescue.logDetail) {
    log.logEvent({
      event: 'order_auto_resolved_invalid_items',
      call_id,
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

  if (lookupGatedItems.length > 0) {
    response.lookup_gated_items = lookupGatedItems;
  }

  res.status(202).json(response);
});

// ─── POST /api/invoice — Queue an invoice ───────────────────────

router.post('/invoice', validate(validateOrderPayload), (req, res) => {
  const { customer_name, customer_ref, po_number, items, memo, callback_url,
    is_new_customer, company_name, customer_phone, customer_email, first_name, last_name,
    call_id } = req.body;
  let { staff_followup_notes } = req.body;

  const rescue = rescueAndPartitionItems(items, staff_followup_notes, { call_id });
  if (rescue.reject) {
    const evt = rescue.rejectStatus === 422
      ? 'invoice_rejected_followup_notes_required'
      : 'invoice_rejected_no_valid_items';
    log.logEvent({
      event: evt,
      call_id,
      detail: { customer_name, company_name, po_number, ...rescue.logDetail },
    });
    return res.status(rescue.rejectStatus || 400).json(rescue.rejectPayload);
  }
  const validatedItems = rescue.itemsForOrder;
  const autoFollowupItems = rescue.autoFollowupItems;
  const autoMatchedItems = rescue.autoMatchedItems;
  const lookupGatedItems = rescue.lookupGatedItems || [];
  staff_followup_notes = rescue.staffFollowupNotes;
  if (rescue.logDetail) {
    log.logEvent({
      event: 'invoice_auto_resolved_invalid_items',
      call_id,
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

  if (lookupGatedItems.length > 0) {
    invoiceResponse.lookup_gated_items = lookupGatedItems;
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
  const qRaw = (req.query.q || req.query.query || '').toString().trim();
  if (!qRaw) {
    return res.status(400).json({ error: 'Missing required query param `q`' });
  }
  const limit = Math.min(parseInt(req.query.limit, 10) || 25, 50);
  const call_id = (req.query.call_id || '').toString().trim() || null;
  // Defensive: if Sophia accidentally queries with one of her slug
  // placeholders ("Accessory-Flex-4in"), run it through the same decoder
  // the auto-match path uses. Caller-words queries are unchanged.
  const qNorm = normalizeFabricatedName(qRaw);
  const q = qNorm || qRaw;
  const items = cache.searchParts(q, { limit });

  // Fix 1: record each lookup_part hit against the call_id so a later
  // create_quickbooks_order can verify Sophia did the lookup. Wrapped in
  // try/catch — a DB hiccup here must not break the search response that
  // Sophia is waiting on.
  if (call_id && items.length > 0) {
    try {
      items.forEach((i, idx) => {
        callHistory.recordLookupHit({
          call_id,
          qb_item_name: i.full_name || i.name,
          source: 'lookup_part',
          search_query: q,
          sales_price: i.sales_price,
          rank: idx,
        });
      });
    } catch (err) {
      log.logEvent({
        event: 'call_history_record_failed',
        call_id,
        detail: { query: q, error: String(err && err.message || err) },
      });
    }
  }

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

// ─── GET /api/admin/call-history/:call_id — Inspect lookup_part hits ──
//
// Returns every lookup_part hit recorded for this Retell call_id, so we
// can tell whether the lookup-evidence gate at /api/order would pass any
// item. Useful when Sophia submits an order and we want to know what
// she actually looked up vs. fabricated.

router.get('/admin/call-history/:call_id', (req, res) => {
  const hits = callHistory.getHitsForCall(req.params.call_id);
  res.json({
    call_id: req.params.call_id,
    hit_count: hits.length,
    hits,
  });
});

// ─── POST /api/admin/call-history/cleanup?days=14 — Prune old hits ────

router.post('/admin/call-history/cleanup', (req, res) => {
  const days = Math.max(parseInt(req.query.days, 10) || 14, 1);
  const removed = callHistory.cleanupOldHits(days);
  res.json({ status: 'ok', removed, days_old_threshold: days });
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
