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
 * LEFT JOIN so items without QB matches still appear (with csv_price fallback).
 */
function getPricingByCategory(category, { tonnage, tier } = {}) {
  const db = getDb();

  let sql = `
    SELECT pm.*,
           ic.sales_price AS qb_price,
           ic.qty_on_hand,
           ic.synced_at AS price_updated_at
    FROM pricing_metadata pm
    LEFT JOIN inventory_cache ic ON pm.qb_item_name = ic.name COLLATE NOCASE
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
 * Transform flat SQL rows into clean JSON response per category.
 */
function formatPricingResponse(rows, category) {
  // Get the most recent QB sync time from any matched item
  let lastSync = null;
  for (const row of rows) {
    if (row.price_updated_at && (!lastSync || row.price_updated_at > lastSync)) {
      lastSync = row.price_updated_at;
    }
  }

  const items = rows.map(row => {
    const qbSynced = row.qb_price != null;
    const price = qbSynced ? row.qb_price : row.csv_price;

    const base = {
      qb_item_name: row.qb_item_name,
      price,
      qb_synced: qbSynced,
      csv_price: row.csv_price,
    };

    if (qbSynced) {
      base.qty_on_hand = row.qty_on_hand;
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
        outdoor_model: row.outdoor_model,
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
