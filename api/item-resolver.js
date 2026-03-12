/**
 * Item Resolver — Expands combined system names into individual QB parts.
 *
 * When an order comes in with a combined name like "1.5T 14.3 S2 HP Gd-7AH1AC18PX",
 * we need to resolve it to individual QB inventory items:
 *   Line 1: outdoor unit (e.g. "Allied Res:Split HP:7HP14F18P") at QB outdoor price
 *   Line 2: indoor unit (e.g. "Allied Res:A/H's:7AH1AC18PX-71") at QB indoor price
 *
 * Uses inventory_cache full_name (hierarchical QB name) for order line items.
 */
const { getDb } = require('../db/schema');

/**
 * Look up a pricing_metadata row by its qb_item_name, then resolve
 * outdoor_model / indoor_model against inventory_cache for full_name + price.
 */
function resolveItem(itemName) {
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
      result.parts.push({
        name: ic.full_name || ic.name,
        description: `Outdoor unit - ${pm.qb_item_name}`,
        rate: ic.sales_price,
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
      result.parts.push({
        name: ic.full_name || ic.name,
        description: `Indoor unit - ${pm.qb_item_name}`,
        rate: ic.sales_price,
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
 * Process an array of order items, expanding combined system names
 * into individual QB parts where possible.
 *
 * Items that can't be resolved (no QB match) pass through unchanged.
 *
 * @param {Array} items - Order items [{name, description, qty, rate}]
 * @returns {Array} Resolved items with individual QB parts
 */
function resolveOrderItems(items) {
  const resolved = [];

  for (const item of items) {
    const expansion = resolveItem(item.name);

    if (expansion && expansion.parts.length > 0) {
      // Expand into individual QB parts
      for (const part of expansion.parts) {
        resolved.push({
          name: part.name,
          description: part.description,
          qty: item.qty || 1,
          rate: part.rate,
        });
      }
    } else {
      // Pass through unchanged — item either isn't in our metadata
      // or doesn't have QB matches (AC units, warranty, etc.)
      resolved.push(item);
    }
  }

  return resolved;
}

module.exports = { resolveItem, resolveOrderItems };
