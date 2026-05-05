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
 * Check whether an inventory item exists by name or full_name (case-insensitive).
 * Used to validate Sophia-supplied qb_item_names that don't go through pricing_metadata.
 */
function inventoryItemExists(nameOrFullName) {
  if (!nameOrFullName) return false;
  const db = getDb();
  const row = db.prepare(`
    SELECT 1 FROM inventory_cache
    WHERE is_active = 1 AND (name = ? COLLATE NOCASE OR full_name = ? COLLATE NOCASE)
    LIMIT 1
  `).get(nameOrFullName, nameOrFullName);
  return !!row;
}

/**
 * Tokenize a search query for parts lookup. Drops noise words and unit markers
 * Sophia might add ("inch", "inches", "the") and treats `4"` as just `4`.
 */
const PARTS_NOISE_TOKENS = new Set([
  'a', 'an', 'the', 'of', 'and', 'or', 'with', 'for', 'to',
  'inch', 'inches', 'in', 'foot', 'feet', 'ft', 'pcs', 'pc', 'each', 'ea',
  'piece', 'pieces', 'bag', 'bags', 'case', 'cases', 'box', 'boxes',
  'pack', 'packs',
  'stick', 'sticks', 'joint', 'joints', 'roll', 'rolls',  // length-units, low signal
  'want', 'need', 'please', 'add', 'get', 'put',
]);
// Note: 'bucket'/'gallon' are intentionally NOT noise — for mastic,
// "bucket of mastic" must filter to gallon-sized mastic, not brushes.

const PARTS_NUMBER_WORDS = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
  seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', thirteen: '13', fourteen: '14',
  fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18',
  nineteen: '19', twenty: '20',
};

/**
 * BMB-specific aliases: caller jargon → canonical QB category (full_name prefix)
 * and/or canonical tokens. Built from Lewis's 2026-04-17 material list and the
 * 2026-05-04 call transcript. Each entry:
 *   pat:        regex with /gi
 *   category:   full_name LIKE prefix (escaped) — restricts the search
 *   removeMatch: drop the matched substring from the query so unrelated
 *                tokens don't dilute the match
 *   addTokens:  extra canonical tokens to AND into the search
 */
const BMB_PARTS_ALIASES = [
  // Float switch — many caller phrasings, all map to one QB item.
  { pat: /\b(s\s*\.?\s*s\s*\.?\s*2|s\s*\.?\s*s\s*\.?\s*two|sst?\s+float\s+switch|float\s+switch|safety\s+switch|drain\s+switch)\b/gi,
    category: 'Drain Pans&Accessories:SS2', removeMatch: true },
  // Silver flex / KM R6 bag → Flex:SLV* category.
  { pat: /\bsilver\s+flex(?:\s+bag)?\b/gi,
    category: 'Flex:SLV', removeMatch: true },
  { pat: /\b(km\s+bag|km\s+r6|r6\s+bag)\b/gi,
    category: 'Flex:SLV', removeMatch: true },
  // "silver" alone (when paired with flex elsewhere in query) — drop it; it's
  // not in any QB field for the SLV product.
  { pat: /\bsilver\b/gi, removeMatch: true },
  // Black flex variants — Flex:Black Flex *
  { pat: /\bblack\s+flex\b/gi, category: 'Flex:Black Flex', removeMatch: true },
  // Mobile-home flex variants
  { pat: /\bmobile\s+home(?:\s+flex)?\b/gi, category: 'Flex:', removeMatch: true },
  // Plain "flex" without a more specific qualifier defaults to silver/SLV —
  // the most common ask. Add this AFTER the more-specific aliases above so
  // they get a chance to remove their phrase first.
  { pat: /\bflex\b/gi, category: 'Flex:SLV', removeMatch: true },
  // Tab / flat tap / saddle tap collars — distinct categories.
  { pat: /\bflat\s+tap(?:\s+collar)?/gi, category: 'Flat Tap Collar:', removeMatch: true },
  { pat: /\bsaddle\s+tap/gi, category: 'Saddle Taps:', removeMatch: true },
  { pat: /\btab\s+collar/gi, category: 'Tab Collars:', removeMatch: true },
  // Drain pans + hurricane condenser pads.
  { pat: /\bdrain\s+pan/gi, category: 'Drain Pans&Accessories:', removeMatch: true },
  { pat: /\bhurricane\s+pad/gi, category: 'Condenser Pads:Hurricane', removeMatch: true },
  { pat: /\bcondenser\s+pad/gi, category: 'Condenser Pads:', removeMatch: true },
  { pat: /\b(pad\s+bracket|hurricane\s+bracket|cond\s+pad\s+bracket)\b/gi, category: 'Condenser Pads:Cond Pad', removeMatch: true },
  // Copper rolls.
  { pat: /\b(rolled\s+copper|copper\s+roll|copper\s+coil)\b/gi, category: 'Copper:Rolls:', removeMatch: true },
  // PVC.
  { pat: /\bpvc\b/gi, category: 'PVC:', removeMatch: true },
  // Boots.
  { pat: /\b(metal\s+top\s+boot|metal\s+boot)\b/gi, category: 'Boots:B', removeMatch: true },
  { pat: /\bboot\b/gi, category: 'Boots:', removeMatch: true },
  // Mastic + brushes.
  { pat: /\bmastic\b/gi, category: 'Mastic:', removeMatch: true },
  // Spray adhesive.
  { pat: /\bspray\s+adhesive/gi, category: 'Spray Adhesive', removeMatch: true },
  // Panduit straps.
  { pat: /\bpanduit(?:\s+strap)?/gi, category: 'Panduit Straps', removeMatch: true },
  // Tape.
  { pat: /\b(duct\s+tape|fasson(?:\s+tape)?)\b/gi, category: 'Tape:', removeMatch: true },
  // Adjustable elbows.
  { pat: /\badjustable\s+elbow/gi, category: 'Adjustable elbows:', removeMatch: true },
  // T-Fin aluminum flex duct (Builder's Best).
  { pat: /\b(t[\s-]*fin|aluminum\s+flex(?:\s+duct)?)\b/gi, category: "Builder's Best:T-Fin", removeMatch: true },
  // Air handler blocks (single item).
  { pat: /\bair\s+handler\s+block/gi, category: 'Air handler block', removeMatch: true },
];

function normalizePartsQuery(query) {
  if (!query) return { categories: [], rest: '' };
  let q = String(query).toLowerCase();
  // Spelled-out numbers → digits so '4 inch' and 'four inch' behave the same.
  q = q.replace(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/g,
    (m) => PARTS_NUMBER_WORDS[m] || m
  );
  // BMB caller idioms: "bucket of mastic" means a 1-gallon container of mastic
  // (the QB item is "Mastic:White Mastic 1 Gallon PA"). Rewriting "bucket"
  // to "gallon" lets the size token actually filter mastic results.
  q = q.replace(/\bbucket(s)?\b/g, 'gallon');
  // Dimension separators: callers say "8x4x4 boot" but the QB item is
  // "B 8x4-4". Normalise both `x` and `-` between digits to spaces so each
  // dimension becomes its own token; AND-matching across "8", "4", "4"
  // still hits the right boot. Use lookbehind + lookahead so the digits
  // themselves are not consumed (otherwise "8x4x4" only splits the first
  // pair and leaves "4x4" stuck together).
  q = q.replace(/(?<=\d)\s*[xX]\s*(?=\d)/g, ' ');
  q = q.replace(/(?<=\d)\s*-\s*(?=\d)/g, ' ');
  // Apply aliases (each pat is /gi so we can replace globally).
  const categories = new Set();
  for (const alias of BMB_PARTS_ALIASES) {
    alias.pat.lastIndex = 0;
    if (alias.pat.test(q)) {
      if (alias.category) categories.add(alias.category);
      if (alias.removeMatch) {
        alias.pat.lastIndex = 0;
        q = q.replace(alias.pat, ' ');
      }
    }
    alias.pat.lastIndex = 0;
  }
  return { categories: Array.from(categories), rest: q };
}

function tokenizePartsQuery(query) {
  if (!query) return [];
  return String(query)
    .toLowerCase()
    .replace(/["']/g, ' ')
    .replace(/[^a-z0-9/.-]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !PARTS_NOISE_TOKENS.has(t));
}

/**
 * Search inventory for parts/materials/supplies. Excludes items that are managed
 * via pricing_metadata (system bundles, system outdoor/indoor components, heat
 * kits, package units) so the result is the catalog of plain QB items the
 * pricing tools don't already cover.
 *
 * Behaviour: tokenize the query, require EVERY token to match in any of
 * name / full_name / sku / description (AND across tokens, OR across fields).
 * Rank: items whose `name` matches more tokens come first; in-stock above
 * out-of-stock; alphabetical as final tiebreaker.
 */
function searchParts(query, { limit = 25 } = {}) {
  const db = getDb();
  const { categories, rest } = normalizePartsQuery(query);
  const tokens = tokenizePartsQuery(rest);

  // Nothing matched and no category hint — caller's words don't help us.
  if (tokens.length === 0 && categories.length === 0) return [];

  // Build SQL fragments first; collect params in three buckets so we can
  // push them in the order the placeholders actually appear in the final
  // SQL text (SELECT first, then WHERE category, then WHERE token, then
  // LIMIT). Mismatched ordering silently scrambles bindings — that bug
  // bit us once already.
  const scoreParams = [];
  const tokenScore = [];
  for (const tok of tokens) {
    const pat = `%${tok}%`;
    scoreParams.push(pat, pat, pat, pat);
    tokenScore.push(
      '(CASE WHEN ic.full_name LIKE ? COLLATE NOCASE THEN 4 ELSE 0 END' +
      ' + CASE WHEN ic.name LIKE ? COLLATE NOCASE THEN 3 ELSE 0 END' +
      ' + CASE WHEN ic.sku LIKE ? COLLATE NOCASE THEN 2 ELSE 0 END' +
      ' + CASE WHEN ic.description LIKE ? COLLATE NOCASE THEN 1 ELSE 0 END)'
    );
  }
  const scoreExpr = tokenScore.length > 0 ? tokenScore.join(' + ') : '0';

  const categoryParams = [];
  let categoryClause = '';
  if (categories.length > 0) {
    const ors = categories.map((cat) => {
      categoryParams.push(`${cat}%`);
      return 'ic.full_name LIKE ? COLLATE NOCASE';
    });
    categoryClause = `AND (${ors.join(' OR ')})`;
  }

  const tokenWhereParams = [];
  const tokenWhere = [];
  for (const tok of tokens) {
    const pat = `%${tok}%`;
    tokenWhereParams.push(pat, pat, pat, pat);
    tokenWhere.push(
      '(ic.name LIKE ? COLLATE NOCASE OR ic.full_name LIKE ? COLLATE NOCASE OR ic.sku LIKE ? COLLATE NOCASE OR ic.description LIKE ? COLLATE NOCASE)'
    );
  }
  const tokenWhereClause = tokenWhere.length > 0 ? `AND ${tokenWhere.join(' AND ')}` : '';

  const params = [
    ...scoreParams,
    ...categoryParams,
    ...tokenWhereParams,
    parseInt(limit, 10) || 25,
  ];

  // Canonical SKU boost. BMB's primary part SKUs follow a short structured
  // pattern (TC04, FTC04, ST04, SLV04, AE06, DP3060) — typically ≤6 chars
  // with no spaces. Specialty / decoy variants (Brush 2", AE04 26GA, Mobile
  // Home Flex, DSO 04, Hurricane Attachment Bracket) carry trailing
  // adjectives or grade codes after a space, so they are longer. The earlier
  // GLOB-based attempt didn't work because SQLite GLOB has no regex
  // repetition — `[A-Z]*` parses as "one uppercase + any". Use a positive
  // length+space heuristic instead, plus a separate boot pattern for the
  // hyphenated boot names (e.g. "B 8x4-4").
  const skuBoost =
    "(CASE WHEN (length(ic.name) <= 6 AND ic.name NOT LIKE '% %') " +
    "       OR ic.name GLOB 'B ?x?-?' " +
    "       OR ic.name GLOB 'B ?x?-??' " +
    "       OR ic.name GLOB 'B ??x?-?' " +
    "       OR ic.name GLOB 'B ??x?-??' " +
    "       OR ic.name GLOB 'B??x?-?' " +
    "       OR ic.name GLOB 'B??x?-??' " +
    "  THEN 5 ELSE 0 END)";

  return db.prepare(`
    SELECT ic.list_id, ic.name, ic.full_name, ic.sku, ic.description,
           ic.qty_on_hand, ic.sales_price, ic.synced_at,
           (${scoreExpr}) AS match_score,
           ${skuBoost} AS sku_boost
    FROM inventory_cache ic
    WHERE ic.is_active = 1
      ${categoryClause}
      ${tokenWhereClause}
      AND NOT EXISTS (
        SELECT 1 FROM pricing_metadata pm
        WHERE pm.qb_item_name = ic.name COLLATE NOCASE
           OR pm.outdoor_model = ic.name COLLATE NOCASE
           OR pm.indoor_model  = ic.name COLLATE NOCASE
      )
    ORDER BY
      (match_score + sku_boost) DESC,
      CASE WHEN ic.qty_on_hand > 0 THEN 0 ELSE 1 END,
      length(ic.name) ASC,
      ic.full_name COLLATE NOCASE,
      ic.name COLLATE NOCASE
    LIMIT ?
  `).all(...params);
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
  const plRef = customer.priceLevelRef || {};
  db.prepare(`
    INSERT INTO customer_cache
      (list_id, name, full_name, company_name, phone, email, balance,
       credit_limit, terms, is_active, billing_address, shipping_address,
       price_level_list_id, price_level_name, raw_data, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
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
      price_level_list_id = excluded.price_level_list_id,
      price_level_name = excluded.price_level_name,
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
    plRef.listId || null,
    plRef.fullName || null,
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

// ─── Price Level Cache ──────────────────────────────────────────

function upsertPriceLevel(pl) {
  const db = getDb();
  db.prepare(`
    INSERT INTO price_level_cache
      (list_id, name, is_active, level_type, fixed_percentage, per_item_data, raw_data, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(list_id) DO UPDATE SET
      name = excluded.name,
      is_active = excluded.is_active,
      level_type = excluded.level_type,
      fixed_percentage = excluded.fixed_percentage,
      per_item_data = excluded.per_item_data,
      raw_data = excluded.raw_data,
      synced_at = datetime('now')
  `).run(
    pl.listId,
    pl.name,
    pl.isActive ? 1 : 0,
    pl.levelType || null,
    pl.fixedPercentage || null,
    pl.perItemData ? JSON.stringify(pl.perItemData) : null,
    pl.rawData ? JSON.stringify(pl.rawData) : null
  );
}

function bulkUpsertPriceLevels(priceLevels) {
  const db = getDb();
  db.exec('BEGIN');
  try {
    for (const pl of priceLevels) {
      upsertPriceLevel(pl);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return priceLevels.length;
}

function getAllPriceLevels() {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM price_level_cache WHERE is_active = 1 ORDER BY name COLLATE NOCASE
  `).all();
}

/**
 * Look up a single price level by list_id. Returns null if not found or inactive.
 * Parses per_item_data JSON into an object for direct use by resolver.
 */
function getPriceLevelByListId(listId) {
  if (!listId) return null;
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM price_level_cache WHERE list_id = ? AND is_active = 1
  `).get(listId);
  if (!row) return null;

  let perItemData = null;
  if (row.per_item_data) {
    try { perItemData = JSON.parse(row.per_item_data); }
    catch { perItemData = null; }
  }

  return {
    list_id: row.list_id,
    name: row.name,
    is_active: row.is_active === 1,
    level_type: row.level_type,
    fixed_percentage: row.fixed_percentage,
    per_item_data: perItemData,
    synced_at: row.synced_at,
  };
}

function getPriceLevelSyncTime() {
  const db = getDb();
  const row = db.prepare(`
    SELECT MAX(synced_at) as last_sync FROM price_level_cache
  `).get();
  return row ? row.last_sync : null;
}

module.exports = {
  // Inventory
  upsertInventoryItem,
  bulkUpsertInventory,
  getAllInventory,
  searchInventory,
  searchParts,
  getInventoryItem,
  inventoryItemExists,
  getInventorySyncTime,
  // Customers
  upsertCustomer,
  bulkUpsertCustomers,
  getAllCustomers,
  searchCustomers,
  getCustomer,
  getCustomerSyncTime,
  // Price Levels
  upsertPriceLevel,
  bulkUpsertPriceLevels,
  getAllPriceLevels,
  getPriceLevelByListId,
  getPriceLevelSyncTime,
  // Orders
  storeOrderResponse,
  getRecentOrders,
  getOrderByQueueId,
  markCallbackSent,
  getPendingCallbacks,
};
