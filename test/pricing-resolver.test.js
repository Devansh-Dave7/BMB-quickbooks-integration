const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { setupTestDb, teardownTestDb, clearAllTables, makeRequest } = require('./_setup');
const cache = require('../db/cache');
const pricing = require('../db/pricing');
const { getDb } = require('../db/schema');
const { resolveOrderItems } = require('../api/item-resolver');

// ── Fixtures ─────────────────────────────────────────────────────

function seedPricingRow(extras = {}) {
  const db = getDb();
  const defaults = {
    category: 'heat_pump',
    qb_item_name: '2T 14.3 S2 HP Gd-7AH1AC24PX',
    tonnage: 2,
    seer2: 14.3,
    tier: 'Good',
    outdoor_model: '7HP14F24P',
    indoor_model: '7AH1AC24PX-71',
    outdoor_price: 1900,
    indoor_price: 904,
    csv_price: 2804,
  };
  const row = { ...defaults, ...extras };
  db.prepare(`
    INSERT INTO pricing_metadata
      (category, qb_item_name, tonnage, seer2, tier, outdoor_model,
       indoor_model, outdoor_price, indoor_price, csv_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.category, row.qb_item_name, row.tonnage, row.seer2, row.tier,
    row.outdoor_model, row.indoor_model, row.outdoor_price, row.indoor_price, row.csv_price
  );
}

function seedInventory(name, fullName, salesPrice, qty = 10) {
  cache.upsertInventoryItem({
    listId: `INV-${name}`,
    name,
    fullName,
    salesPrice,
    qtyOnHand: qty,
    isActive: true,
  });
}

function seedCustomer({ listId, name, fullName, companyName, priceLevelListId, priceLevelName }) {
  cache.upsertCustomer({
    listId,
    name,
    fullName: fullName || null,
    companyName: companyName || null,
    isActive: true,
    priceLevelRef: priceLevelListId
      ? { listId: priceLevelListId, fullName: priceLevelName || null }
      : null,
  });
}

function seedFixedPercentageLevel(listId, name, pct) {
  cache.upsertPriceLevel({
    listId,
    name,
    isActive: true,
    levelType: 'FixedPercentage',
    fixedPercentage: pct,
    perItemData: null,
  });
}

function seedPerItemLevel(listId, name, entries) {
  cache.upsertPriceLevel({
    listId,
    name,
    isActive: true,
    levelType: 'PerItem',
    fixedPercentage: null,
    perItemData: entries,
  });
}

// ── applyPriceLevel() ────────────────────────────────────────────

describe('pricing — applyPriceLevel (FixedPercentage)', () => {
  before(() => setupTestDb());
  after(() => teardownTestDb());
  beforeEach(() => clearAllTables());

  it('applies +10% markup to all prices, rounded to 2 decimals', () => {
    const row = {
      csv_price: 2804,
      outdoor_price: 1900,
      indoor_price: 904,
      qb_outdoor_price: 1700,
      qb_indoor_price: 824,
      outdoor_full_name: 'Allied Res:Split HP:7HP14F24P',
      indoor_full_name: 'Allied Res:A/H\'s:7AH1AC24PX-71',
    };
    const pl = { level_type: 'FixedPercentage', fixed_percentage: 10 };

    const changed = pricing.applyPriceLevel(row, pl);

    assert.equal(changed, true);
    assert.equal(row.csv_price, 3084.4);
    assert.equal(row.outdoor_price, 2090);
    assert.equal(row.indoor_price, 994.4);
    assert.equal(row.qb_outdoor_price, 1870);
    assert.equal(row.qb_indoor_price, 906.4);
  });

  it('applies -15% discount across all prices', () => {
    const row = { csv_price: 1000, qb_outdoor_price: 600, qb_indoor_price: 400 };
    const pl = { level_type: 'FixedPercentage', fixed_percentage: -15 };

    pricing.applyPriceLevel(row, pl);

    assert.equal(row.csv_price, 850);
    assert.equal(row.qb_outdoor_price, 510);
    assert.equal(row.qb_indoor_price, 340);
  });

  it('preserves originals as list_* fields', () => {
    const row = { csv_price: 100, qb_outdoor_price: 60, qb_indoor_price: 40 };
    const pl = { level_type: 'FixedPercentage', fixed_percentage: -10 };

    pricing.applyPriceLevel(row, pl);

    assert.equal(row.list_csv_price, 100);
    assert.equal(row.list_qb_outdoor_price, 60);
    assert.equal(row.list_qb_indoor_price, 40);
  });
});

describe('pricing — applyPriceLevel (PerItem)', () => {
  before(() => setupTestDb());
  after(() => teardownTestDb());
  beforeEach(() => clearAllTables());

  it('overrides qb_outdoor_price when customPrice entry matches', () => {
    const row = {
      csv_price: 2804,
      qb_outdoor_price: 1700,
      qb_indoor_price: 824,
      outdoor_price: 1900,
      indoor_price: 904,
      outdoor_full_name: 'Allied Res:Split HP:7HP14F24P',
      indoor_full_name: 'Allied Res:A/H\'s:7AH1AC24PX-71',
    };
    const pl = {
      level_type: 'PerItem',
      per_item_data: [
        { itemRef: { listId: 'I1', fullName: 'Allied Res:Split HP:7HP14F24P' }, customPrice: 1500 },
      ],
    };

    const changed = pricing.applyPriceLevel(row, pl);

    assert.equal(changed, true);
    assert.equal(row.qb_outdoor_price, 1500);
    assert.equal(row.qb_indoor_price, 824); // untouched
    assert.equal(row.list_qb_outdoor_price, 1700);
    // csv_price is recomputed from components
    assert.equal(row.csv_price, 2324); // 1500 + 824
  });

  it('scales by customPricePercent', () => {
    const row = {
      csv_price: 1000,
      qb_outdoor_price: 600,
      qb_indoor_price: 400,
      outdoor_full_name: 'X:Y:Z',
      indoor_full_name: 'A:B:C',
    };
    const pl = {
      level_type: 'PerItem',
      per_item_data: [
        { itemRef: { listId: 'I1', fullName: 'X:Y:Z' }, customPricePercent: -10 },
      ],
    };

    pricing.applyPriceLevel(row, pl);

    assert.equal(row.qb_outdoor_price, 540); // 600 * 0.9
    assert.equal(row.qb_indoor_price, 400);
    assert.equal(row.csv_price, 940);
  });

  it('leaves row unchanged when no entries match', () => {
    const row = {
      csv_price: 2804,
      qb_outdoor_price: 1700,
      qb_indoor_price: 824,
      outdoor_full_name: 'Mismatch:X',
      indoor_full_name: 'Mismatch:Y',
    };
    const pl = {
      level_type: 'PerItem',
      per_item_data: [{ itemRef: { listId: 'I1', fullName: 'Other:Thing' }, customPrice: 99 }],
    };

    const changed = pricing.applyPriceLevel(row, pl);

    assert.equal(changed, false);
    assert.equal(row.csv_price, 2804);
    assert.equal(row.qb_outdoor_price, 1700);
  });

  it('adjusts only the matched component when only one matches', () => {
    const row = {
      csv_price: 2804,
      qb_outdoor_price: 1700,
      qb_indoor_price: 824,
      outdoor_full_name: 'Allied Res:Split HP:7HP14F24P',
      indoor_full_name: 'Other:Indoor:X',
    };
    const pl = {
      level_type: 'PerItem',
      per_item_data: [
        { fullName: 'Allied Res:Split HP:7HP14F24P', customPrice: 1600 },
      ],
    };

    pricing.applyPriceLevel(row, pl);

    assert.equal(row.qb_outdoor_price, 1600);
    assert.equal(row.qb_indoor_price, 824);
    assert.equal(row.csv_price, 2424); // 1600 + 824
  });
});

// ── findCustomerForPricing() ─────────────────────────────────────

describe('pricing — findCustomerForPricing', () => {
  before(() => setupTestDb());
  after(() => teardownTestDb());
  beforeEach(() => clearAllTables());

  it('prefers company match over person', () => {
    seedCustomer({ listId: 'C1', name: 'Smith', fullName: 'John Smith', companyName: null });
    seedCustomer({ listId: 'C2', name: 'Smith HVAC', fullName: 'Smith HVAC LLC', companyName: 'Smith HVAC' });

    const match = pricing.findCustomerForPricing('John Smith', 'Smith HVAC');

    assert.ok(match);
    assert.equal(match.customer.list_id, 'C2');
    assert.equal(match.matched_on, 'company_name');
  });

  it('falls back to person name when company does not match', () => {
    seedCustomer({ listId: 'C1', name: 'John Smith', fullName: 'John Smith' });

    const match = pricing.findCustomerForPricing('John Smith', 'NonexistentCo');

    assert.ok(match);
    assert.equal(match.customer.list_id, 'C1');
  });

  it('returns null when neither matches', () => {
    seedCustomer({ listId: 'C1', name: 'Alice', fullName: 'Alice' });

    const match = pricing.findCustomerForPricing('Bob', 'Unknown Co');

    assert.equal(match, null);
  });

  it('requires exact match — partial does not match', () => {
    seedCustomer({ listId: 'C1', name: 'Smith HVAC LLC', companyName: 'Smith HVAC LLC' });

    const match = pricing.findCustomerForPricing(null, 'Smith');
    assert.equal(match, null);
  });

  it('returns null when both inputs empty', () => {
    const match = pricing.findCustomerForPricing(null, null);
    assert.equal(match, null);
  });
});

// ── resolvePricingForCustomer() ──────────────────────────────────

describe('pricing — resolvePricingForCustomer', () => {
  before(() => setupTestDb());
  after(() => teardownTestDb());
  beforeEach(() => clearAllTables());

  it('returns list prices when no customer/company provided', () => {
    seedPricingRow();
    seedInventory('7HP14F24P', 'Allied Res:Split HP:7HP14F24P', 1700);
    seedInventory('7AH1AC24PX-71', 'Allied Res:A/H\'s:7AH1AC24PX-71', 824);

    const out = pricing.resolvePricingForCustomer({ category: 'heat_pump' });

    assert.equal(out.customerMatch, null);
    assert.equal(out.priceLevelApplied, null);
    assert.equal(out.rows[0].qb_outdoor_price, 1700);
  });

  it('customer found, no level — returns list prices', () => {
    seedPricingRow();
    seedInventory('7HP14F24P', 'Allied Res:Split HP:7HP14F24P', 1700);
    seedInventory('7AH1AC24PX-71', 'Allied Res:A/H\'s:7AH1AC24PX-71', 824);
    seedCustomer({ listId: 'C1', name: 'Plain Joe', companyName: 'Plain Joe' });

    const out = pricing.resolvePricingForCustomer({
      category: 'heat_pump',
      companyName: 'Plain Joe',
    });

    assert.ok(out.customerMatch);
    assert.equal(out.priceLevelApplied, null);
    assert.equal(out.rows[0].qb_outdoor_price, 1700);
  });

  it('FixedPercentage level is applied across the category', () => {
    seedPricingRow();
    seedInventory('7HP14F24P', 'Allied Res:Split HP:7HP14F24P', 1700);
    seedInventory('7AH1AC24PX-71', 'Allied Res:A/H\'s:7AH1AC24PX-71', 824);
    seedFixedPercentageLevel('PL-1', 'Wholesale 10%', -10);
    seedCustomer({
      listId: 'C1',
      name: 'Wholesale Bob',
      companyName: 'Wholesale Bob',
      priceLevelListId: 'PL-1',
      priceLevelName: 'Wholesale 10%',
    });

    const out = pricing.resolvePricingForCustomer({
      category: 'heat_pump',
      companyName: 'Wholesale Bob',
    });

    assert.ok(out.priceLevelApplied);
    assert.equal(out.priceLevelApplied.type, 'FixedPercentage');
    assert.equal(out.priceLevelApplied.adjustment_percent, -10);
    assert.equal(out.rows[0].qb_outdoor_price, 1530); // 1700 * 0.9
    assert.equal(out.rows[0].qb_indoor_price, 741.6); // 824 * 0.9
    assert.equal(out.rows[0].list_qb_outdoor_price, 1700);
  });

  it('PerItem level returns override + items_overridden count', () => {
    seedPricingRow();
    seedInventory('7HP14F24P', 'Allied Res:Split HP:7HP14F24P', 1700);
    seedInventory('7AH1AC24PX-71', 'Allied Res:A/H\'s:7AH1AC24PX-71', 824);
    seedPerItemLevel('PL-2', 'Premium', [
      { itemRef: { listId: 'I1', fullName: 'Allied Res:Split HP:7HP14F24P' }, customPrice: 1450 },
    ]);
    seedCustomer({
      listId: 'C1',
      name: 'Premium Co',
      companyName: 'Premium Co',
      priceLevelListId: 'PL-2',
    });

    const out = pricing.resolvePricingForCustomer({
      category: 'heat_pump',
      companyName: 'Premium Co',
    });

    assert.equal(out.priceLevelApplied.type, 'PerItem');
    assert.equal(out.priceLevelApplied.items_overridden, 1);
    assert.equal(out.rows[0].qb_outdoor_price, 1450);
  });

  it('level not in cache (stale ref) falls back to list + warns', () => {
    seedPricingRow();
    seedInventory('7HP14F24P', 'Allied Res:Split HP:7HP14F24P', 1700);
    seedInventory('7AH1AC24PX-71', 'Allied Res:A/H\'s:7AH1AC24PX-71', 824);
    seedCustomer({
      listId: 'C1',
      name: 'Orphan Co',
      companyName: 'Orphan Co',
      priceLevelListId: 'PL-GONE', // no matching price_level_cache row
    });

    const out = pricing.resolvePricingForCustomer({
      category: 'heat_pump',
      companyName: 'Orphan Co',
    });

    assert.ok(out.customerMatch);
    assert.equal(out.priceLevelApplied, null);

    // Verify sync_log captured the skip
    const db = getDb();
    const logs = db.prepare(`SELECT * FROM sync_log WHERE event='price_level_skipped'`).all();
    assert.ok(logs.length > 0);
    const detail = JSON.parse(logs[logs.length - 1].detail);
    assert.equal(detail.reason, 'level_not_in_cache');
  });

  it('writes a price_level_applied sync_log entry on success', () => {
    seedPricingRow();
    seedFixedPercentageLevel('PL-1', 'Wholesale 5%', -5);
    seedCustomer({
      listId: 'C1',
      name: 'Acme',
      companyName: 'Acme',
      priceLevelListId: 'PL-1',
    });

    pricing.resolvePricingForCustomer({ category: 'heat_pump', companyName: 'Acme' });

    const db = getDb();
    const logs = db.prepare(`SELECT * FROM sync_log WHERE event='price_level_applied'`).all();
    assert.equal(logs.length, 1);
    const detail = JSON.parse(logs[0].detail);
    assert.equal(detail.customer, 'Acme');
    assert.equal(detail.price_level_name, 'Wholesale 5%');
    assert.equal(detail.context, 'pricing_lookup');
  });
});

// ── resolveOrderItems() with priceLevel ──────────────────────────

describe('item-resolver — resolveOrderItems with priceLevel', () => {
  before(() => setupTestDb());
  after(() => teardownTestDb());
  beforeEach(() => clearAllTables());

  it('applies FixedPercentage to split-system components', () => {
    seedPricingRow();
    seedInventory('7HP14F24P', 'Allied Res:Split HP:7HP14F24P', 1700);
    seedInventory('7AH1AC24PX-71', 'Allied Res:A/H\'s:7AH1AC24PX-71', 824);
    const pl = { level_type: 'FixedPercentage', fixed_percentage: -10 };

    const resolved = resolveOrderItems(
      [{ name: '2T 14.3 S2 HP Gd-7AH1AC24PX', qty: 1, rate: 9999 }],
      pl,
    );

    assert.equal(resolved.length, 2);
    assert.equal(resolved[0].rate, 1530); // 1700 * 0.9
    assert.equal(resolved[1].rate, 741.6); // 824 * 0.9
  });

  it('applies PerItem override to the matching component only', () => {
    seedPricingRow();
    seedInventory('7HP14F24P', 'Allied Res:Split HP:7HP14F24P', 1700);
    seedInventory('7AH1AC24PX-71', 'Allied Res:A/H\'s:7AH1AC24PX-71', 824);
    const pl = {
      level_type: 'PerItem',
      per_item_data: [
        { itemRef: { listId: 'I1', fullName: 'Allied Res:Split HP:7HP14F24P' }, customPrice: 1500 },
      ],
    };

    const resolved = resolveOrderItems(
      [{ name: '2T 14.3 S2 HP Gd-7AH1AC24PX', qty: 1 }],
      pl,
    );

    assert.equal(resolved[0].rate, 1500);
    assert.equal(resolved[1].rate, 824); // untouched
  });

  it('passes through unresolved items untouched (price level does not double-apply)', () => {
    const pl = { level_type: 'FixedPercentage', fixed_percentage: -10 };

    const resolved = resolveOrderItems(
      [{ name: 'Unknown Item XYZ', qty: 1, rate: 500 }],
      pl,
    );

    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].rate, 500);
  });

  it('with no priceLevel behaves identically to before', () => {
    seedPricingRow();
    seedInventory('7HP14F24P', 'Allied Res:Split HP:7HP14F24P', 1700);
    seedInventory('7AH1AC24PX-71', 'Allied Res:A/H\'s:7AH1AC24PX-71', 824);

    const resolved = resolveOrderItems([{ name: '2T 14.3 S2 HP Gd-7AH1AC24PX', qty: 1 }]);

    assert.equal(resolved[0].rate, 1700);
    assert.equal(resolved[1].rate, 824);
  });
});

// ── API integration ──────────────────────────────────────────────

describe('API — pricing + customer routes with price levels', () => {
  const API_KEY = 'test-api-key-12345';
  let server;
  let port;

  before(async () => {
    setupTestDb();
    const express = require('express');
    const routes = require('../api/routes');
    const app = express();
    app.use(express.json());
    app.use('/api', routes);
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    teardownTestDb();
  });

  beforeEach(() => clearAllTables());

  it('GET /api/pricing/heat_pump (no customer) returns list prices [backward compat]', async () => {
    seedPricingRow();
    seedInventory('7HP14F24P', 'Allied Res:Split HP:7HP14F24P', 1700);
    seedInventory('7AH1AC24PX-71', 'Allied Res:A/H\'s:7AH1AC24PX-71', 824);

    const res = await makeRequest(port, 'GET', '/api/pricing/heat_pump', {
      headers: { 'x-api-key': API_KEY },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.items[0].qb_outdoor_price, 1700);
    assert.equal(res.body.price_level_applied, undefined);
  });

  it('GET /api/pricing/heat_pump?company=X returns adjusted prices', async () => {
    seedPricingRow();
    seedInventory('7HP14F24P', 'Allied Res:Split HP:7HP14F24P', 1700);
    seedInventory('7AH1AC24PX-71', 'Allied Res:A/H\'s:7AH1AC24PX-71', 824);
    seedFixedPercentageLevel('PL-1', 'Wholesale 10%', -10);
    seedCustomer({
      listId: 'C1',
      name: 'Wholesale Bob',
      companyName: 'Wholesale Bob',
      priceLevelListId: 'PL-1',
    });

    const res = await makeRequest(
      port,
      'GET',
      '/api/pricing/heat_pump?company=Wholesale+Bob',
      { headers: { 'x-api-key': API_KEY } },
    );

    assert.equal(res.statusCode, 200);
    assert.ok(res.body.price_level_applied);
    assert.equal(res.body.price_level_applied.name, 'Wholesale 10%');
    assert.equal(res.body.items[0].qb_outdoor_price, 1530);
    assert.equal(res.body.items[0].list_qb_outdoor_price, 1700);
  });

  it('GET /api/pricing/heat_pump?customer=Unknown returns list prices + null price_level_applied', async () => {
    seedPricingRow();
    seedInventory('7HP14F24P', 'Allied Res:Split HP:7HP14F24P', 1700);
    seedInventory('7AH1AC24PX-71', 'Allied Res:A/H\'s:7AH1AC24PX-71', 824);

    const res = await makeRequest(
      port,
      'GET',
      '/api/pricing/heat_pump?customer=Unknown+Person',
      { headers: { 'x-api-key': API_KEY } },
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.price_level_applied, null);
    assert.equal(res.body.items[0].qb_outdoor_price, 1700);
  });

  it('GET /api/customer/:name returns nested price_level when assigned', async () => {
    seedFixedPercentageLevel('PL-1', 'Preferred', -5);
    seedCustomer({
      listId: 'C1',
      name: 'Acme Corp',
      fullName: 'Acme Corp',
      priceLevelListId: 'PL-1',
      priceLevelName: 'Preferred',
    });

    const res = await makeRequest(port, 'GET', '/api/customer/Acme%20Corp', {
      headers: { 'x-api-key': API_KEY },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.price_level.name, 'Preferred');
    assert.equal(res.body.price_level.type, 'FixedPercentage');
    assert.equal(res.body.price_level.fixed_percentage, -5);
  });

  it('GET /api/customer/:name returns price_level=null when none assigned', async () => {
    seedCustomer({ listId: 'C1', name: 'Plain Joe', fullName: 'Plain Joe' });

    const res = await makeRequest(port, 'GET', '/api/customer/Plain%20Joe', {
      headers: { 'x-api-key': API_KEY },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.price_level, null);
  });

  it('POST /api/order with wholesale company match applies price level to line rates', async () => {
    seedPricingRow();
    seedInventory('7HP14F24P', 'Allied Res:Split HP:7HP14F24P', 1700);
    seedInventory('7AH1AC24PX-71', 'Allied Res:A/H\'s:7AH1AC24PX-71', 824);
    seedPerItemLevel('PL-1', 'Wholesale Premium', [
      { itemRef: { listId: 'IO', fullName: 'Allied Res:Split HP:7HP14F24P' }, customPrice: 1574 },
      { itemRef: { listId: 'II', fullName: 'Allied Res:A/H\'s:7AH1AC24PX-71' }, customPrice: 830 },
    ]);
    seedCustomer({
      listId: 'C-WHOLESALE',
      name: 'Alice Johnson',
      fullName: 'Alice Johnson',
      companyName: 'Wholesale Co LLC',
      priceLevelListId: 'PL-1',
    });
    seedCustomer({
      listId: 'C-OTHER',
      name: 'Alice Johnson Services',
      fullName: 'Alice Johnson Services',
      companyName: null,
      // no price level
    });

    const res = await makeRequest(port, 'POST', '/api/order', {
      headers: { 'x-api-key': API_KEY },
      body: {
        customer_name: 'Alice Johnson',
        company_name: 'Wholesale Co LLC',
        items: [{ name: '2T 14.3 S2 HP Gd-7AH1AC24PX', qty: 1 }],
      },
    });

    assert.equal(res.statusCode, 202);

    // Inspect the queued qbxml — line rates must reflect the price level
    const db = getDb();
    const row = db.prepare(
      `SELECT qbxml FROM request_queue WHERE id = ?`
    ).get(res.body.queue_id);
    assert.ok(row, 'order was queued');
    assert.match(row.qbxml, /<Rate>1574\.00<\/Rate>/, 'outdoor rate is wholesale');
    assert.match(row.qbxml, /<Rate>830\.00<\/Rate>/, 'indoor rate is wholesale');
    assert.ok(!/<Rate>1700\.00<\/Rate>/.test(row.qbxml), 'no list outdoor rate');
    assert.ok(!/<Rate>824\.00<\/Rate>/.test(row.qbxml), 'no list indoor rate');
  });

  it('POST /api/order does NOT apply price level on fuzzy-only match', async () => {
    seedPricingRow();
    seedInventory('7HP14F24P', 'Allied Res:Split HP:7HP14F24P', 1700);
    seedInventory('7AH1AC24PX-71', 'Allied Res:A/H\'s:7AH1AC24PX-71', 824);
    seedFixedPercentageLevel('PL-1', 'Wholesale 10%', -10);
    // Only exists as a fuzzy name collision — should NOT apply level
    seedCustomer({
      listId: 'C1',
      name: 'Smith HVAC Services',
      fullName: 'Smith HVAC Services',
      companyName: 'Smith HVAC Services',
      priceLevelListId: 'PL-1',
    });

    const res = await makeRequest(port, 'POST', '/api/order', {
      headers: { 'x-api-key': API_KEY },
      body: {
        customer_name: 'Smith', // partial name — fuzzy match only
        company_name: '',       // no company hint
        items: [{ name: '2T 14.3 S2 HP Gd-7AH1AC24PX', qty: 1 }],
      },
    });

    assert.equal(res.statusCode, 202);
    const db = getDb();
    const row = db.prepare(
      `SELECT qbxml FROM request_queue WHERE id = ?`
    ).get(res.body.queue_id);
    // List rates kept — fuzzy match must NOT apply the wholesale level
    assert.match(row.qbxml, /<Rate>1700\.00<\/Rate>/);
    assert.match(row.qbxml, /<Rate>824\.00<\/Rate>/);
  });

  it('POST /api/order prefers company over person when both could match', async () => {
    seedPricingRow();
    seedInventory('7HP14F24P', 'Allied Res:Split HP:7HP14F24P', 1700);
    seedInventory('7AH1AC24PX-71', 'Allied Res:A/H\'s:7AH1AC24PX-71', 824);
    seedFixedPercentageLevel('PL-RETAIL', 'Retail markup', 10);
    seedFixedPercentageLevel('PL-WHOLESALE', 'Wholesale discount', -20);
    // Person with retail level
    seedCustomer({
      listId: 'C-PERSON',
      name: 'Dave Test',
      fullName: 'Dave Test',
      priceLevelListId: 'PL-RETAIL',
    });
    // Company with wholesale level — should win
    seedCustomer({
      listId: 'C-COMPANY',
      name: 'Wholesale Co',
      fullName: 'Wholesale Co',
      companyName: 'Wholesale Co',
      priceLevelListId: 'PL-WHOLESALE',
    });

    const res = await makeRequest(port, 'POST', '/api/order', {
      headers: { 'x-api-key': API_KEY },
      body: {
        customer_name: 'Dave Test',
        company_name: 'Wholesale Co',
        items: [{ name: '2T 14.3 S2 HP Gd-7AH1AC24PX', qty: 1 }],
      },
    });

    assert.equal(res.statusCode, 202);
    const db = getDb();
    const row = db.prepare(
      `SELECT qbxml FROM request_queue WHERE id = ?`
    ).get(res.body.queue_id);
    // -20% on 1700 = 1360, -20% on 824 = 659.20
    assert.match(row.qbxml, /<Rate>1360\.00<\/Rate>/);
    assert.match(row.qbxml, /<Rate>659\.20<\/Rate>/);
  });

  it('GET /api/pricing/_/resolve-customer returns diagnostic payload', async () => {
    seedPricingRow();
    seedInventory('7HP14F24P', 'Allied Res:Split HP:7HP14F24P', 1700);
    seedInventory('7AH1AC24PX-71', 'Allied Res:A/H\'s:7AH1AC24PX-71', 824);
    seedFixedPercentageLevel('PL-1', 'Wholesale 10%', -10);
    seedCustomer({
      listId: 'C1',
      name: 'Wholesale Bob',
      companyName: 'Wholesale Bob',
      priceLevelListId: 'PL-1',
    });

    const res = await makeRequest(
      port,
      'GET',
      '/api/pricing/_/resolve-customer?company=Wholesale+Bob&category=heat_pump',
      { headers: { 'x-api-key': API_KEY } },
    );

    assert.equal(res.statusCode, 200);
    assert.ok(res.body.lookup.matched_customer);
    assert.equal(res.body.lookup.matched_customer.name, 'Wholesale Bob');
    assert.equal(res.body.lookup.price_level.name, 'Wholesale 10%');
    assert.ok(res.body.pricing_preview);
    assert.equal(res.body.pricing_preview.items_overridden, 1);
    assert.ok(res.body.pricing_preview.sample_items[0].savings_pct > 9);
  });
});
