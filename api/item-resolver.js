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
 * Sophia routinely emits split-system names with a tier abbreviation that
 * doesn't exist in pricing_metadata — typically "Std-7AH1AE42PX" when the
 * catalog actually has "Btr-7AH1AE42PX" (prompt tells her to call the
 * Better tier "Standard" to the caller, and she leaks that wording into
 * the qb_item_name). 2026-06-04 Call B (TXN 90B2BC) lost the entire
 * $3782 heat pump because of this — "3.5T 14.3 S2 HP Std-7AH1AE42PX"
 * had no pricing_metadata row so the whole bundle dropped to followup.
 *
 * This helper takes a qb_item_name and returns a list of plausible
 * canonical variants to try in order. The original name is always first.
 * Tier abbreviations BMB uses: Gd (Good/PSC), Btr (Better/ECM),
 * Bst (Best/Variable). "Std" is Sophia's invention.
 */
function canonicalizeItemName(name) {
  if (!name || typeof name !== 'string') return [name];
  const variants = [name];
  // "X Std-Y" -> ["X Std-Y", "X Btr-Y", "X Gd-Y", "X Bst-Y"]
  const stdMatch = name.match(/\bStd-/);
  if (stdMatch) {
    for (const tier of ['Btr-', 'Gd-', 'Bst-']) {
      variants.push(name.replace(/\bStd-/, tier));
    }
  }
  // Defensive: "Standard-" / "Good-" / "Better-" / "Best-" full-word forms
  const fullTier = name.match(/\b(Standard|Good|Better|Best)-/);
  if (fullTier) {
    const map = { Standard: 'Btr-', Good: 'Gd-', Better: 'Btr-', Best: 'Bst-' };
    const abbrev = map[fullTier[1]];
    if (abbrev) variants.push(name.replace(/\b(Standard|Good|Better|Best)-/, abbrev));
  }
  return variants;
}

/**
 * Look up a pricing_metadata row by its qb_item_name, then resolve
 * outdoor_model / indoor_model against inventory_cache for full_name + price.
 */
function resolveItem(itemName, priceLevel = null) {
  const db = getDb();

  // Try the original name first, then tier-canonicalized variants.
  // This is what rescues 3.5T heat pumps when Sophia uses "Std-" in the
  // qb_item_name.
  const stmt = db.prepare(`
    SELECT * FROM pricing_metadata WHERE qb_item_name = ? COLLATE NOCASE
  `);
  let pm = null;
  for (const candidate of canonicalizeItemName(itemName)) {
    pm = stmt.get(candidate);
    if (pm) break;
  }

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
      // Fall back to pricing_metadata.outdoor_price when inventory_cache hasn't
      // synced a sales_price yet (or the row is a placeholder). Without this
      // fallback the bundle lands in QB at $0.
      const listRate = ic.sales_price != null ? ic.sales_price : pm.outdoor_price;
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
      const listRate = ic.sales_price != null ? ic.sales_price : pm.indoor_price;
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
      // Catalog wins over Sophia's rate when she sends 0 (or missing).
      // Earlier behaviour preferred any non-null rate, but Sophia's bare
      // `name: 'SS2', rate: 0` submissions were landing in QB at $0
      // instead of $23.88. Treat rate <= 0 as "not provided" so the
      // catalog price always carries a legitimate inventory row.
      const sophiaRate = (item.rate != null && item.rate > 0) ? item.rate : null;
      resolved.push({
        name: direct.name,
        description: item.description,
        qty: item.qty || 1,
        rate: sophiaRate != null ? sophiaRate : direct.sales_price,
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
  // Pricing metadata: try original name + any tier-canonicalized variants
  // (Std- -> Btr-/Gd-/Bst-). Same rescue resolveItem applies.
  const stmtPm = db.prepare(`
    SELECT 1 FROM pricing_metadata WHERE qb_item_name = ? COLLATE NOCASE LIMIT 1
  `);
  for (const candidate of canonicalizeItemName(name)) {
    if (stmtPm.get(candidate)) return true;
  }
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
 * Decode Sophia's "obvious placeholder" qb_item_name patterns so the
 * synonym map gets a normal phrase to work with. She emits two families
 * of fabrications:
 *
 *   1. "Accessory: 4\" Silver Flex Bag"   — colon + caller-words (handled
 *                                          since 2026-05-06)
 *   2. "Accessory-Flex-4in"               — dash-separated CamelCase slug
 *                                          (2026-06-04 — call_e361929f).
 *                                          17 of 17 materials slipped past
 *                                          auto-match because the slug stays
 *                                          as one token and matches nothing.
 *
 * Pipeline: strip the leading marker, replace dashes/underscores with
 * spaces, split CamelCase ("TabCollar" -> "Tab Collar"), and expand the
 * compact size suffixes Sophia uses ("4in" -> "4 inch", "5ft" -> "5 foot").
 * The downstream synonym map (BMB_PARTS_ALIASES) then matches normally.
 */
function normalizeFabricatedName(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  // Strip leading marker — Accessory:, Accessory-, Accessory_, "Accessory "
  s = s.replace(/^accessory[-:_\s]+/i, '');
  // Strip any other "Accessory-" inside the string too (defensive)
  s = s.replace(/\baccessory[-_]/gi, '');
  // Dashes / underscores -> spaces so "Flex-4in" -> "Flex 4in"
  s = s.replace(/[-_]+/g, ' ');
  // Split CamelCase: insert space between lowercase->uppercase and between
  // uppercase->uppercase+lowercase (so "TabCollar" -> "Tab Collar",
  // "DrainPan" -> "Drain Pan", "FlatTap" -> "Flat Tap").
  s = s.replace(/([a-z])([A-Z])/g, '$1 $2');
  s = s.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  // Expand compact size suffixes: "4in" -> "4 inch", "5ft" -> "5 foot",
  // "10gal" -> "10 gallon". Trailing-only — don't expand "into" or similar.
  s = s.replace(/(\d+(?:\.\d+)?)\s*in\b/gi, '$1 inch');
  s = s.replace(/(\d+(?:\.\d+)?)\s*ft\b/gi, '$1 foot');
  s = s.replace(/(\d+(?:\.\d+)?)\s*gal\b/gi, '$1 gallon');
  // Collapse double spaces
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Format an unmatched line item into a single human-readable bullet for the
 * staff_followup_notes memo. Uses normalizeFabricatedName so memo lines
 * read as caller-friendly text (e.g. "2x Flex 4 inch" rather than
 * "2x Accessory-Flex-4in") and quantity is preserved.
 */
function formatFollowupLine(item) {
  const raw = normalizeFabricatedName(String((item && item.name) || ''));
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
  const rawInput = String((item && item.name) || '').trim();
  const rawName = normalizeFabricatedName(rawInput);
  if (!rawName) return null;
  const hits = cache.searchParts(rawName, { limit: 1 });
  if (!hits || hits.length === 0) return null;
  const top = hits[0];
  const fullName = top.full_name || top.name;
  const price = top.sales_price;
  // Audit line shows BOTH Sophia's original payload and the normalized
  // form we actually searched on — staff need to be able to tell whether
  // it was the slug-decoder or a literal alias that produced the match.
  return {
    original: rawInput,
    name: fullName,
    sales_price: price,
    qty: Number(item && item.qty) || 1,
    audit_line: `AUTO-MATCHED: "${rawInput}" -> ${fullName}${price != null ? ` @ $${price}` : ''}`,
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
  normalizeFabricatedName,
  canonicalizeItemName,
};
