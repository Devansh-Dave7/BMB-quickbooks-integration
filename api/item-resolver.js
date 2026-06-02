/**
 * Item Resolver — Expands combined system names into individual QB parts.
 *
 * When an order comes in with a combined name like "1.5T 14.3 S2 HP Gd-7AH1AC18PX",
 * we need to resolve it to individual QB inventory items:
 *   Line 1: outdoor unit (e.g. "Allied Res:Split HP:7HP14F18P") at QB outdoor price
 *   Line 2: indoor unit (e.g. "Allied Res:A/H's:7AH1AC18PX-71") at QB indoor price
 *
 * Uses inventory_cache full_name (hierarchical QB name) for order line items.
 *
 * When a `priceLevel` is supplied, each resolved component's rate is adjusted
 * via the level (FixedPercentage or PerItem) before being returned.
 */
const { getDb } = require('../db/schema');
const { applyPriceLevelToItem } = require('../db/pricing');
const cache = require('../db/cache');

/**
 * Look up a pricing_metadata row by its qb_item_name, then resolve
 * outdoor_model / indoor_model against inventory_cache for full_name + price.
 */
function resolveItem(itemName, priceLevel = null) {
  const db = getDb();

  // Find the pricing metadata entry
  const pm = db.prepare(`
    SELECT * FROM pricing_metadata WHERE qb_item_name = ? COLLATE NOCASE
  `).get(itemName);

  if (!pm) return null;

  // Split systems (heat_pump, ac, inverter) need BOTH outdoor + indoor.
  // If either component is missing from QB inventory, don't expand —
  // pass through unchanged so we don't create a partial order.
  const needsBoth = ['heat_pump', 'ac', 'inverter'].includes(pm.category);

  const result = { category: pm.category, parts: [] };
  let outdoorFound = false;
  let indoorFound = false;

  // Resolve outdoor component
  if (pm.outdoor_model) {
    const ic = db.prepare(`
      SELECT name, full_name, sales_price, qty_on_hand FROM inventory_cache
      WHERE name = ? COLLATE NOCASE
    `).get(pm.outdoor_model);

    if (ic) {
      outdoorFound = true;
      const fullName = ic.full_name || ic.name;
      const listRate = ic.sales_price;
      const rate = applyPriceLevelToItem(listRate, fullName, priceLevel);
      result.parts.push({
        name: fullName,
        description: `Outdoor unit - ${pm.qb_item_name}`,
        rate,
        list_rate: rate !== listRate ? listRate : undefined,
        qty_available: ic.qty_on_hand,
      });
    }
  }

  // Resolve indoor component
  if (pm.indoor_model) {
    const ic = db.prepare(`
      SELECT name, full_name, sales_price, qty_on_hand FROM inventory_cache
      WHERE name = ? COLLATE NOCASE
    `).get(pm.indoor_model);

    if (ic) {
      indoorFound = true;
      const fullName = ic.full_name || ic.name;
      const listRate = ic.sales_price;
      const rate = applyPriceLevelToItem(listRate, fullName, priceLevel);
      result.parts.push({
        name: fullName,
        description: `Indoor unit - ${pm.qb_item_name}`,
        rate,
        list_rate: rate !== listRate ? listRate : undefined,
        qty_available: ic.qty_on_hand,
      });
    }
  }

  // For split systems, require both components — don't create partial orders
  if (needsBoth && (!outdoorFound || !indoorFound)) {
    return null;
  }

  return result.parts.length > 0 ? result : null;
}

/**
 * Look up an inventory_cache row by `name` or `full_name` (case-insensitive).
 * Used for direct QB items (parts, supplies, heat kits) that aren't system bundles
 * managed via pricing_metadata.
 */
function resolveInventoryDirect(itemName, priceLevel = null) {
  const db = getDb();

  const ic = db.prepare(`
    SELECT name, full_name, sales_price, qty_on_hand FROM inventory_cache
    WHERE is_active = 1 AND (name = ? COLLATE NOCASE OR full_name = ? COLLATE NOCASE)
    LIMIT 1
  `).get(itemName, itemName);

  if (!ic) return null;

  const fullName = ic.full_name || ic.name;
  return { name: fullName, sales_price: ic.sales_price };
}

/**
 * Process an array of order items, expanding combined system names
 * into individual QB parts where possible.
 *
 * Resolution order per item:
 *   1. pricing_metadata system bundle → expand into outdoor + indoor parts
 *   2. direct inventory_cache match (real QB FullName like "Mastic:White Mastic …")
 *      → swap to canonical full_name, trust caller-supplied rate
 *   3. otherwise → unresolved (validateItemsExist will already have rejected it)
 *
 * @param {Array} items - Order items [{name, description, qty, rate}]
 * @param {object} [priceLevel] - Cached price level
 * @returns {Array} Resolved items
 */
function resolveOrderItems(items, priceLevel = null) {
  const resolved = [];

  for (const item of items) {
    const expansion = resolveItem(item.name, priceLevel);

    if (expansion && expansion.parts.length > 0) {
      for (const part of expansion.parts) {
        resolved.push({
          name: part.name,
          description: part.description,
          qty: item.qty || 1,
          rate: part.rate,
        });
      }
      continue;
    }

    const direct = resolveInventoryDirect(item.name, priceLevel);
    if (direct) {
      resolved.push({
        name: direct.name,
        description: item.description,
        qty: item.qty || 1,
        rate: item.rate != null ? item.rate : direct.sales_price,
      });
      continue;
    }

    // Pass-through fallback — should be unreachable when route-level
    // validateItemsExist runs first, but keeps behaviour safe in tests.
    resolved.push(item);
  }

  return resolved;
}

/**
 * Partition supplied items into those that match a known QB product and those
 * that don't. Unknown items are returned with their full payload so callers
 * can promote them to staff_followup_notes for human review.
 *
 * Returns { ok, valid: [items], invalid: [items], invalid_names: [], suggestions: {name: [...]}}.
 * `ok` is true iff every item matched.
 */
/**
 * Per-item check: does this name match a known QB product directly?
 * (pricing_metadata.qb_item_name OR inventory_cache.name/full_name)
 *
 * Extracted from validateItemsExist so the routes.js gate can mix it
 * with other checks (e.g. call_lookup_history) without paying for the
 * full batch's fuzzy-suggestion query on every item.
 */
function isCatalogValid(name) {
  if (!name || typeof name !== 'string') return false;
  const db = getDb();
  const pm = db.prepare(`
    SELECT 1 FROM pricing_metadata WHERE qb_item_name = ? COLLATE NOCASE LIMIT 1
  `).get(name);
  if (pm) return true;
  // Require sales_price IS NOT NULL — exclude parent-category folder rows
  // like "Tape" / "Saddle Taps" which QB syncs as null-priced inventory
  // headers. Without this guard Sophia could fabricate "Tape" as a
  // qb_item_name and the order would land at $0 with no real product.
  const ic = db.prepare(`
    SELECT 1 FROM inventory_cache
    WHERE is_active = 1
      AND sales_price IS NOT NULL
      AND (name = ? COLLATE NOCASE OR full_name = ? COLLATE NOCASE)
    LIMIT 1
  `).get(name, name);
  return !!ic;
}

function validateItemsExist(items) {
  const db = getDb();
  const valid = [];
  const invalid = [];
  const invalidNames = [];
  const suggestions = {};

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
    invalid.push(item);
    invalidNames.push(name);
    const pattern = `%${name.replace(/[%_]/g, '')}%`;
    const matches = stmtFuzzy.all(pattern, pattern);
    if (matches.length > 0) {
      suggestions[name] = matches.map((m) => ({
        full_name: m.full_name || m.name,
        sales_price: m.sales_price,
      }));
    }
  }

  return { ok: invalid.length === 0, valid, invalid, invalid_names: invalidNames, suggestions };
}

/**
 * Format an unmatched line item into a single human-readable bullet for the
 * staff_followup_notes memo. Strips the "Accessory:" prefix Sophia sometimes
 * fabricates and includes the quantity so staff know how many to bill.
 */
function formatFollowupLine(item) {
  const raw = String((item && item.name) || '').replace(/^accessory:\s*/i, '').trim();
  const qty = Number(item && item.qty) || 1;
  return `${qty}x ${raw} (caller's wording, not in catalog)`;
}

/**
 * Last-resort recovery for items Sophia hallucinated. Pipes the caller's-
 * words `name` through the same `searchParts` synonym map / scorer used by
 * the `lookup_part` tool — so '4" Flex Duct Bag' becomes Flex:SLV04, 'Tab
 * Collar 12 inch' becomes Tab Collars:TC12, etc. Returns the substitute
 * with catalog price and a one-line audit string for the memo, or null
 * if even the synonym map can't make sense of the phrase.
 *
 * Important: we ignore Sophia's `rate` (she sets it to 0 when fabricating)
 * and use the catalog `sales_price` so the QB ticket has the right number.
 * Quantity carries through.
 */
function attemptAutoMatch(item) {
  const rawName = String((item && item.name) || '').replace(/^accessory:\s*/i, '').trim();
  if (!rawName) return null;
  const hits = cache.searchParts(rawName, { limit: 1 });
  if (!hits || hits.length === 0) return null;
  const top = hits[0];
  const fullName = top.full_name || top.name;
  const price = top.sales_price;
  return {
    original: rawName,
    name: fullName,
    sales_price: price,
    qty: Number(item && item.qty) || 1,
    audit_line: `AUTO-MATCHED: "${rawName}" → ${fullName}${price != null ? ` @ $${price}` : ''}`,
  };
}

module.exports = {
  resolveItem,
  resolveOrderItems,
  resolveInventoryDirect,
  isCatalogValid,
  validateItemsExist,
  formatFollowupLine,
  attemptAutoMatch,
};
