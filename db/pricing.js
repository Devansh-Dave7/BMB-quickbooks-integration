const path = require('path');
const fs = require('fs');
const { getDb } = require('./schema');

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
 */
function formatPricingResponse(rows, category) {
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

    if (qbSynced) {
      base.qty_on_hand = qty;
    }

    // Include QB component prices when available
    if (row.qb_outdoor_price != null) {
      base.qb_outdoor_price = row.qb_outdoor_price;
      base.outdoor_full_name = row.outdoor_full_name;
    }
    if (row.qb_indoor_price != null) {
      base.qb_indoor_price = row.qb_indoor_price;
      base.indoor_full_name = row.indoor_full_name;
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

  return {
    category,
    label: CATEGORY_LABELS[category] || category,
    count: items.length,
    last_qb_sync: lastSync,
    items,
  };
}

function safeJsonParse(str) {
  if (!str) return null;
  try { return JSON.parse(str); }
  catch { return null; }
}

module.exports = {
  ensurePricingSeeded,
  getPricingByCategory,
  getPricingCategories,
  formatPricingResponse,
};
