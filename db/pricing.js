const path = require('path');
const fs = require('fs');
const { getDb } = require('./schema');
const cache = require('./cache');
const log = require('./log');

const SEED_FILE = path.join(__dirname, '..', 'data', 'pricing-seed.json');

const CATEGORY_LABELS = {
  heat_pump: 'Heat Pumps',
  ac: 'Air Conditioners',
  inverter: 'Inverter Systems',
  package_unit: 'Package Units',
  heat_kit: 'Heat Kits',
  warranty: 'System Shield Warranty',
};

// ─── Auto-Seed ──────────────────────────────────────────────────

/**
 * On startup, if pricing_metadata is empty, bulk-insert from pricing-seed.json.
 * Handles Railway's ephemeral filesystem — re-seeds on every fresh deploy.
 */
function ensurePricingSeeded() {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as cnt FROM pricing_metadata').get();

  if (row.cnt > 0) {
    console.log(`[PRICING] pricing_metadata already seeded (${row.cnt} rows)`);
    return;
  }

  if (!fs.existsSync(SEED_FILE)) {
    console.warn('[PRICING] No seed file found at', SEED_FILE);
    return;
  }

  const items = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  console.log(`[PRICING] Seeding ${items.length} items from pricing-seed.json...`);

  const stmt = db.prepare(`
    INSERT INTO pricing_metadata
      (category, qb_item_name, tonnage, seer2, tier, efficiency_tier,
       ahri_ref, outdoor_model, indoor_model, outdoor_price, indoor_price,
       csv_price, condenser_dims, airhandler_dims, electrical,
       heat_kit_type, voltage_specs, warranty_level, warranty_program,
       labor_years, parts_years)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec('BEGIN');
  try {
    for (const item of items) {
      stmt.run(
        item.category,
        item.qb_item_name,
        item.tonnage,
        item.seer2,
        item.tier,
        item.efficiency_tier,
        item.ahri_ref,
        item.outdoor_model,
        item.indoor_model,
        item.outdoor_price,
        item.indoor_price,
        item.csv_price,
        item.condenser_dims,
        item.airhandler_dims,
        item.electrical,
        item.heat_kit_type,
        item.voltage_specs,
        item.warranty_level,
        item.warranty_program,
        item.labor_years,
        item.parts_years
      );
    }
    db.exec('COMMIT');
    console.log(`[PRICING] Seeded ${items.length} items successfully`);
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('[PRICING] Seed failed:', err.message);
    throw err;
  }
}

// ─── Query Functions ────────────────────────────────────────────

/**
 * Get pricing items by category with live QB prices from inventory_cache.
 * Double LEFT JOIN: outdoor_model → ic_out, indoor_model → ic_in.
 * Items without QB matches still appear (with csv_price fallback).
 */
function getPricingByCategory(category, { tonnage, tier } = {}) {
  const db = getDb();

  let sql = `
    SELECT pm.*,
           ic_out.sales_price AS qb_outdoor_price,
           ic_out.qty_on_hand AS outdoor_qty,
           ic_out.full_name   AS outdoor_full_name,
           ic_out.synced_at   AS outdoor_synced_at,
           ic_in.sales_price  AS qb_indoor_price,
           ic_in.qty_on_hand  AS indoor_qty,
           ic_in.full_name    AS indoor_full_name,
           ic_in.synced_at    AS indoor_synced_at
    FROM pricing_metadata pm
    LEFT JOIN inventory_cache ic_out ON pm.outdoor_model = ic_out.name COLLATE NOCASE
    LEFT JOIN inventory_cache ic_in  ON pm.indoor_model  = ic_in.name  COLLATE NOCASE
    WHERE pm.category = ?
  `;
  const params = [category];

  if (tonnage != null) {
    sql += ' AND pm.tonnage = ?';
    params.push(parseFloat(tonnage));
  }
  if (tier) {
    sql += ' AND pm.tier = ? COLLATE NOCASE';
    params.push(tier);
  }

  sql += ' ORDER BY pm.tonnage ASC, pm.seer2 ASC, pm.tier ASC';

  return db.prepare(sql).all(...params);
}

/**
 * Get list of categories with item counts.
 */
function getPricingCategories() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT category, COUNT(*) as count FROM pricing_metadata GROUP BY category ORDER BY category
  `).all();

  return rows.map(r => ({
    id: r.category,
    label: CATEGORY_LABELS[r.category] || r.category,
    count: r.count,
  }));
}

/**
 * Determine qb_synced status and effective price for a row based on category.
 *
 * | Category              | Synced when                    | Price source              | Stock              |
 * |-----------------------|--------------------------------|---------------------------|--------------------|
 * | heat_pump / inverter  | both outdoor + indoor found    | QB outdoor + indoor       | MIN(out, in)       |
 * | ac                    | never (not in QB)              | csv_price                 | n/a                |
 * | package_unit (HP)     | outdoor found                  | QB outdoor                | outdoor qty        |
 * | package_unit (AC)     | never (not in QB)              | csv_price                 | n/a                |
 * | heat_kit              | indoor found                   | QB indoor                 | indoor qty         |
 * | warranty              | never                          | csv_price                 | n/a                |
 */
function resolveSync(row, category) {
  // AC condensers — never in QB
  if (category === 'ac') {
    return { qbSynced: false, price: row.csv_price, qty: null };
  }

  // Warranty — not inventory items
  if (category === 'warranty') {
    return { qbSynced: false, price: row.csv_price, qty: null };
  }

  // Heat pump / inverter — need BOTH outdoor + indoor
  if (category === 'heat_pump' || category === 'inverter') {
    const hasOut = row.qb_outdoor_price != null;
    const hasIn = row.qb_indoor_price != null;
    if (hasOut && hasIn) {
      return {
        qbSynced: true,
        price: row.qb_outdoor_price + row.qb_indoor_price,
        qty: Math.min(row.outdoor_qty ?? 0, row.indoor_qty ?? 0),
      };
    }
    return { qbSynced: false, price: row.csv_price, qty: null };
  }

  // Package unit — HP models sync, AC models don't
  if (category === 'package_unit') {
    const isHP = (row.qb_item_name || '').includes('Pkg HP');
    if (isHP && row.qb_outdoor_price != null) {
      return {
        qbSynced: true,
        price: row.qb_outdoor_price,
        qty: row.outdoor_qty ?? 0,
      };
    }
    return { qbSynced: false, price: row.csv_price, qty: null };
  }

  // Heat kit — match on indoor_model
  if (category === 'heat_kit') {
    if (row.qb_indoor_price != null) {
      return {
        qbSynced: true,
        price: row.qb_indoor_price,
        qty: row.indoor_qty ?? 0,
      };
    }
    return { qbSynced: false, price: row.csv_price, qty: null };
  }

  // Fallback
  return { qbSynced: false, price: row.csv_price, qty: null };
}

/**
 * Transform flat SQL rows into clean JSON response per category.
 *
 * When `options.customerMatch` / `options.priceLevelApplied` are supplied
 * (from resolvePricingForCustomer), the response also carries customer and
 * price_level_applied metadata, and each item emits `list_*` fields for any
 * price that was adjusted by the level.
 */
function formatPricingResponse(rows, category, options = {}) {
  // Get the most recent QB sync time from any matched item
  let lastSync = null;
  for (const row of rows) {
    for (const ts of [row.outdoor_synced_at, row.indoor_synced_at]) {
      if (ts && (!lastSync || ts > lastSync)) {
        lastSync = ts;
      }
    }
  }

  const items = rows.map(row => {
    const { qbSynced, price, qty } = resolveSync(row, category);

    const base = {
      qb_item_name: row.qb_item_name,
      price,
      qb_synced: qbSynced,
      csv_price: row.csv_price,
    };

    if (row.list_csv_price != null && row.list_csv_price !== row.csv_price) {
      base.list_csv_price = row.list_csv_price;
    }

    if (qbSynced) {
      base.qty_on_hand = qty;
    }

    // Include QB component prices when available
    if (row.qb_outdoor_price != null) {
      base.qb_outdoor_price = row.qb_outdoor_price;
      base.outdoor_full_name = row.outdoor_full_name;
      if (row.list_qb_outdoor_price != null && row.list_qb_outdoor_price !== row.qb_outdoor_price) {
        base.list_qb_outdoor_price = row.list_qb_outdoor_price;
      }
    }
    if (row.qb_indoor_price != null) {
      base.qb_indoor_price = row.qb_indoor_price;
      base.indoor_full_name = row.indoor_full_name;
      if (row.list_qb_indoor_price != null && row.list_qb_indoor_price !== row.qb_indoor_price) {
        base.list_qb_indoor_price = row.list_qb_indoor_price;
      }
    }

    // Category-specific fields
    if (category === 'heat_pump' || category === 'ac' || category === 'inverter') {
      Object.assign(base, {
        tonnage: row.tonnage,
        seer2: row.seer2,
        tier: row.tier,
        efficiency_tier: row.efficiency_tier,
        ahri_ref: row.ahri_ref,
        outdoor_model: row.outdoor_model,
        indoor_model: row.indoor_model,
        outdoor_price: row.outdoor_price,
        indoor_price: row.indoor_price,
        dimensions: {
          condenser: safeJsonParse(row.condenser_dims),
          air_handler: safeJsonParse(row.airhandler_dims),
        },
        electrical: safeJsonParse(row.electrical),
      });
    } else if (category === 'package_unit') {
      Object.assign(base, {
        tonnage: row.tonnage,
        seer2: row.seer2,
        ahri_ref: row.ahri_ref,
        outdoor_model: row.outdoor_model,
        dimensions: safeJsonParse(row.condenser_dims),
        electrical: safeJsonParse(row.electrical),
      });
    } else if (category === 'heat_kit') {
      Object.assign(base, {
        indoor_model: row.indoor_model,
        heat_kit_type: row.heat_kit_type,
        voltage_specs: safeJsonParse(row.voltage_specs),
      });
    } else if (category === 'warranty') {
      Object.assign(base, {
        warranty_level: row.warranty_level,
        warranty_program: row.warranty_program,
        labor_years: row.labor_years,
        parts_years: row.parts_years,
      });
    }

    return base;
  });

  const response = {
    category,
    label: CATEGORY_LABELS[category] || category,
    count: items.length,
    last_qb_sync: lastSync,
    items,
  };

  if (options.customerMatch) {
    const c = options.customerMatch.customer;
    response.customer = {
      matched_on: options.customerMatch.matched_on,
      customer_name: c.name,
      qb_full_name: c.full_name,
      company_name: c.company_name,
    };
  } else if (options.customerQuery) {
    response.customer = {
      matched_on: null,
      customer_query: options.customerQuery.person || null,
      company_query: options.customerQuery.company || null,
    };
  }

  if (options.priceLevelApplied) {
    response.price_level_applied = options.priceLevelApplied;
  } else if (options.customerMatch || options.customerQuery) {
    response.price_level_applied = null;
  }

  return response;
}

function safeJsonParse(str) {
  if (!str) return null;
  try { return JSON.parse(str); }
  catch { return null; }
}

// ─── Price Level Resolution ─────────────────────────────────────

function round2(n) {
  if (n == null) return n;
  return Math.round(n * 100) / 100;
}

/**
 * Locate the QB customer that should drive pricing resolution.
 * Company match is preferred (wholesale accounts usually carry price levels);
 * person name is the fallback. Exact matches only — wrong customer → wrong
 * price is worse than quoting list.
 *
 * @returns {{customer: object, matched_on: string} | null}
 */
function findCustomerForPricing(personName, companyName) {
  const db = getDb();

  if (companyName && String(companyName).trim()) {
    const q = String(companyName).trim();
    const byCompany = db.prepare(`
      SELECT * FROM customer_cache
      WHERE is_active = 1 AND company_name = ? COLLATE NOCASE
      LIMIT 1
    `).get(q);
    if (byCompany) return { customer: byCompany, matched_on: 'company_name' };
  }

  if (personName && String(personName).trim()) {
    const q = String(personName).trim();
    const byFullName = db.prepare(`
      SELECT * FROM customer_cache
      WHERE is_active = 1 AND full_name = ? COLLATE NOCASE
      LIMIT 1
    `).get(q);
    if (byFullName) return { customer: byFullName, matched_on: 'full_name' };

    const byName = db.prepare(`
      SELECT * FROM customer_cache
      WHERE is_active = 1 AND name = ? COLLATE NOCASE
      LIMIT 1
    `).get(q);
    if (byName) return { customer: byName, matched_on: 'name' };
  }

  return null;
}

/**
 * Adjust a single numeric price by a price level (used for order line items).
 * Returns the original price if level doesn't apply.
 */
function applyPriceLevelToItem(price, itemFullName, priceLevel) {
  if (price == null || !priceLevel) return price;

  if (priceLevel.level_type === 'FixedPercentage') {
    const pct = priceLevel.fixed_percentage;
    if (pct == null) return price;
    return round2(price * (1 + pct / 100));
  }

  if (priceLevel.level_type === 'PerItem') {
    if (!itemFullName || !priceLevel.per_item_data) return price;
    const target = String(itemFullName).toLowerCase();
    const entry = priceLevel.per_item_data.find(
      (e) => e.fullName && String(e.fullName).toLowerCase() === target
    );
    if (!entry) return price;
    if (entry.customPrice != null) return round2(entry.customPrice);
    if (entry.customPricePercent != null) {
      return round2(price * (1 + entry.customPricePercent / 100));
    }
  }

  return price;
}

/**
 * Mutate a pricing row in-place with price-level-adjusted figures.
 * Preserves original values on `list_*` fields so responses can show both.
 * Returns true if any price on the row was actually changed.
 */
function applyPriceLevel(row, priceLevel) {
  if (!priceLevel) return false;

  // Snapshot originals
  row.list_csv_price = row.csv_price;
  row.list_outdoor_price = row.outdoor_price;
  row.list_indoor_price = row.indoor_price;
  row.list_qb_outdoor_price = row.qb_outdoor_price;
  row.list_qb_indoor_price = row.qb_indoor_price;

  if (priceLevel.level_type === 'FixedPercentage') {
    const pct = priceLevel.fixed_percentage;
    if (pct == null) return false;
    const mult = 1 + pct / 100;

    if (row.csv_price != null) row.csv_price = round2(row.csv_price * mult);
    if (row.outdoor_price != null) row.outdoor_price = round2(row.outdoor_price * mult);
    if (row.indoor_price != null) row.indoor_price = round2(row.indoor_price * mult);
    if (row.qb_outdoor_price != null) row.qb_outdoor_price = round2(row.qb_outdoor_price * mult);
    if (row.qb_indoor_price != null) row.qb_indoor_price = round2(row.qb_indoor_price * mult);
    return true;
  }

  if (priceLevel.level_type === 'PerItem') {
    const entries = priceLevel.per_item_data || [];
    if (entries.length === 0) return false;

    const map = {};
    for (const entry of entries) {
      if (entry.fullName) map[String(entry.fullName).toLowerCase()] = entry;
    }

    let changed = false;

    // Outdoor component
    if (row.outdoor_full_name) {
      const entry = map[String(row.outdoor_full_name).toLowerCase()];
      if (entry) {
        if (entry.customPrice != null) {
          row.qb_outdoor_price = round2(entry.customPrice);
          row.outdoor_price = round2(entry.customPrice);
          changed = true;
        } else if (entry.customPricePercent != null) {
          const mult = 1 + entry.customPricePercent / 100;
          if (row.qb_outdoor_price != null) row.qb_outdoor_price = round2(row.qb_outdoor_price * mult);
          if (row.outdoor_price != null) row.outdoor_price = round2(row.outdoor_price * mult);
          changed = true;
        }
      }
    }

    // Indoor component
    if (row.indoor_full_name) {
      const entry = map[String(row.indoor_full_name).toLowerCase()];
      if (entry) {
        if (entry.customPrice != null) {
          row.qb_indoor_price = round2(entry.customPrice);
          row.indoor_price = round2(entry.customPrice);
          changed = true;
        } else if (entry.customPricePercent != null) {
          const mult = 1 + entry.customPricePercent / 100;
          if (row.qb_indoor_price != null) row.qb_indoor_price = round2(row.qb_indoor_price * mult);
          if (row.indoor_price != null) row.indoor_price = round2(row.indoor_price * mult);
          changed = true;
        }
      }
    }

    // Keep csv_price in sync when both components available
    if (changed) {
      const out = row.qb_outdoor_price ?? row.outdoor_price;
      const inn = row.qb_indoor_price ?? row.indoor_price;
      if (out != null && inn != null) {
        row.csv_price = round2(out + inn);
      } else if (out != null && row.indoor_model == null) {
        row.csv_price = round2(out);
      } else if (inn != null && row.outdoor_model == null) {
        row.csv_price = round2(inn);
      }
    }

    return changed;
  }

  return false;
}

/**
 * Full end-to-end resolver: looks up customer, fetches their price level,
 * applies it to every row in the category. Returns metadata suitable for
 * populating API responses.
 *
 * Fails open: missing customer / no level / stale cache all return list prices.
 */
function resolvePricingForCustomer({ category, personName, companyName, tonnage, tier }) {
  const rows = getPricingByCategory(category, { tonnage, tier });

  const emptyQuery =
    (!personName || !String(personName).trim()) &&
    (!companyName || !String(companyName).trim());

  if (emptyQuery) {
    return { rows, customerMatch: null, priceLevelApplied: null };
  }

  const match = findCustomerForPricing(personName, companyName);
  if (!match) {
    log.logEvent({
      event: 'price_level_skipped',
      detail: {
        reason: 'no_customer_match',
        context: 'pricing_lookup',
        person: personName || null,
        company: companyName || null,
        category,
      },
    });
    return { rows, customerMatch: null, priceLevelApplied: null };
  }

  if (!match.customer.price_level_list_id) {
    log.logEvent({
      event: 'price_level_skipped',
      detail: {
        reason: 'no_level_assigned',
        context: 'pricing_lookup',
        customer: match.customer.name,
        matched_on: match.matched_on,
        category,
      },
    });
    return { rows, customerMatch: match, priceLevelApplied: null };
  }

  const priceLevel = cache.getPriceLevelByListId(match.customer.price_level_list_id);
  if (!priceLevel) {
    log.logEvent({
      event: 'price_level_skipped',
      detail: {
        reason: 'level_not_in_cache',
        context: 'pricing_lookup',
        customer: match.customer.name,
        price_level_list_id: match.customer.price_level_list_id,
        category,
      },
    });
    return { rows, customerMatch: match, priceLevelApplied: null };
  }

  let itemsOverridden = 0;
  for (const row of rows) {
    if (applyPriceLevel(row, priceLevel)) itemsOverridden++;
  }

  log.logEvent({
    event: 'price_level_applied',
    detail: {
      context: 'pricing_lookup',
      customer: match.customer.name,
      matched_on: match.matched_on,
      price_level_name: priceLevel.name,
      price_level_type: priceLevel.level_type,
      price_level_list_id: priceLevel.list_id,
      category,
      items_overridden: itemsOverridden,
      adjustment_percent:
        priceLevel.level_type === 'FixedPercentage' ? priceLevel.fixed_percentage : null,
    },
  });

  return {
    rows,
    customerMatch: match,
    priceLevelApplied: {
      list_id: priceLevel.list_id,
      name: priceLevel.name,
      type: priceLevel.level_type,
      fixed_percentage: priceLevel.fixed_percentage,
      per_item_count: priceLevel.per_item_data ? priceLevel.per_item_data.length : 0,
      items_overridden: itemsOverridden,
      adjustment_percent:
        priceLevel.level_type === 'FixedPercentage' ? priceLevel.fixed_percentage : null,
    },
  };
}

module.exports = {
  ensurePricingSeeded,
  getPricingByCategory,
  getPricingCategories,
  formatPricingResponse,
  applyPriceLevel,
  applyPriceLevelToItem,
  findCustomerForPricing,
  resolvePricingForCustomer,
};
