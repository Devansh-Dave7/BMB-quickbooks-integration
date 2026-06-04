/**
 * Synonym-map fixes shipped 2026-06-02 after Lewis flagged:
 *  - silver tape -> should be Tape:Fasson UL181 2.5" 0800 (was returning the
 *    parent "Tape" folder row with null price, which then leaked into the
 *    qb_item_name Sophia sent on the next submission)
 *  - SS3 float switch (existed but no alias; was being eaten by the SS2 alias)
 *  - 8" saddle tap collar (alias dropped "saddle tap" but left "collar" which
 *    AND-failed against Saddle Taps:ST08 etc.)
 *  - 8" flat top collar (ASR mishear of "flat tap collar")
 *  - Parent-folder rows (sales_price=null) leaking into both searchParts AND
 *    isCatalogValid
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { setupTestDb, teardownTestDb, clearAllTables } = require('./_setup');
const cache = require('../db/cache');
const { isCatalogValid } = require('../api/item-resolver');

function seed() {
  // Silver tape catalog
  cache.upsertInventoryItem({ listId: 'T1', name: 'Tape', fullName: 'Tape',
    salesPrice: null, isActive: true }); // PARENT FOLDER (the bug)
  cache.upsertInventoryItem({ listId: 'T2', name: 'Tape Squeegee',
    fullName: 'Tape:Tape Squeegee', salesPrice: 1.71, isActive: true });
  cache.upsertInventoryItem({ listId: 'T3', name: 'Fasson UL181 2.5" 0800',
    fullName: 'Tape:Fasson UL181 2.5" 0800', salesPrice: 17, isActive: true });
  cache.upsertInventoryItem({ listId: 'T4', name: 'Black DC UL 181B Flex Pro',
    fullName: 'Tape:Black DC UL 181B Flex Pro', salesPrice: 13.75, isActive: true });

  // SS2 + SS3
  cache.upsertInventoryItem({ listId: 'SS2', name: 'SS2',
    fullName: 'Drain Pans&Accessories:SS2', salesPrice: 23.88, isActive: true });
  cache.upsertInventoryItem({ listId: 'SS3', name: 'SS3',
    fullName: 'Drain Pans&Accessories:SS3', salesPrice: 13.97, isActive: true });

  // Saddle Taps (parent folder + ST04..ST10)
  cache.upsertInventoryItem({ listId: 'STP', name: 'Saddle Taps',
    fullName: 'Saddle Taps', salesPrice: null, isActive: true });
  for (const s of ['04', '06', '08', '10']) {
    cache.upsertInventoryItem({ listId: `ST${s}`, name: `ST${s}`,
      fullName: `Saddle Taps:ST${s}`, salesPrice: 5 + parseInt(s, 10) / 4, isActive: true });
  }

  // Flat Tap Collar
  for (const s of ['04', '06', '08', '12']) {
    cache.upsertInventoryItem({ listId: `FTC${s}`, name: `FTC${s}`,
      fullName: `Flat Tap Collar:FTC${s}`, salesPrice: 3 + parseInt(s, 10) / 4, isActive: true });
  }
}

describe('searchParts — synonym map fixes 2026-06-02', () => {
  before(() => setupTestDb());
  after(() => teardownTestDb());
  beforeEach(() => { clearAllTables(); seed(); });

  it('silver tape -> Tape:Fasson UL181 (not the parent Tape folder)', () => {
    const hits = cache.searchParts('silver tape', { limit: 5 });
    assert.ok(hits.length > 0, 'expected non-empty results');
    const top = hits[0].full_name;
    assert.ok(/Fasson UL181/i.test(top), `expected Fasson UL181 top hit, got: ${top}`);
  });

  it('silver tape roll -> Tape:Fasson UL181 (not parent Tape, not Squeegee)', () => {
    const hits = cache.searchParts('Silver Tape Roll', { limit: 5 });
    assert.ok(hits.length > 0);
    const top = hits[0].full_name;
    assert.ok(/Fasson UL181/i.test(top), `expected Fasson UL181, got: ${top}`);
  });

  it('SS3 float switch -> Drain Pans&Accessories:SS3 (not SS2)', () => {
    const hits = cache.searchParts('SS3 Float Switch', { limit: 3 });
    assert.ok(hits.length > 0);
    assert.equal(hits[0].full_name, 'Drain Pans&Accessories:SS3');
  });

  it('SS-3 (with hyphen) -> SS3', () => {
    const hits = cache.searchParts('SS-3', { limit: 3 });
    assert.ok(hits.length > 0);
    assert.equal(hits[0].full_name, 'Drain Pans&Accessories:SS3');
  });

  it('SS2 still resolves correctly (regression check on SS3 ordering)', () => {
    const hits = cache.searchParts('SS2 float switch', { limit: 3 });
    assert.ok(hits.length > 0);
    assert.equal(hits[0].full_name, 'Drain Pans&Accessories:SS2');
  });

  it('8 inch saddle tap collar -> Saddle Taps:ST08', () => {
    const hits = cache.searchParts('8 inch saddle tap collar', { limit: 3 });
    assert.ok(hits.length > 0, 'expected at least one result');
    assert.equal(hits[0].full_name, 'Saddle Taps:ST08');
  });

  it('8 saddle taps (plural, no "collar") -> Saddle Taps:ST08', () => {
    const hits = cache.searchParts('8 saddle taps', { limit: 3 });
    assert.ok(hits.length > 0);
    assert.equal(hits[0].full_name, 'Saddle Taps:ST08');
  });

  it('8 flat top collar (ASR mishear) -> Flat Tap Collar:FTC08', () => {
    const hits = cache.searchParts('8 inch flat top collar', { limit: 3 });
    assert.ok(hits.length > 0);
    assert.equal(hits[0].full_name, 'Flat Tap Collar:FTC08');
  });

  it('6 flat tap collar still works (regression)', () => {
    const hits = cache.searchParts('6 inch flat tap collar', { limit: 3 });
    assert.ok(hits.length > 0);
    assert.equal(hits[0].full_name, 'Flat Tap Collar:FTC06');
  });

  it('parent-folder row "Tape" is excluded from search results', () => {
    const hits = cache.searchParts('tape', { limit: 10 });
    const hitFullNames = hits.map((h) => h.full_name);
    assert.equal(hitFullNames.includes('Tape'), false,
      `expected parent "Tape" folder to be filtered, got: ${hitFullNames.join(', ')}`);
  });

  it('parent-folder row "Saddle Taps" is excluded from search results', () => {
    const hits = cache.searchParts('saddle taps', { limit: 10 });
    const fullNames = hits.map((h) => h.full_name);
    assert.equal(fullNames.includes('Saddle Taps'), false,
      `expected parent "Saddle Taps" folder to be filtered, got: ${fullNames.join(', ')}`);
  });
});

describe('normalizeFabricatedName — slug decoder 2026-06-04', () => {
  const { normalizeFabricatedName } = require('../api/item-resolver');

  it('strips Accessory: prefix (colon form)', () => {
    assert.equal(normalizeFabricatedName('Accessory: 4" Silver Flex Bag'),
      '4" Silver Flex Bag');
  });

  it('strips Accessory- prefix (dash form)', () => {
    assert.equal(normalizeFabricatedName('Accessory-Flex-4in'), 'Flex 4 inch');
  });

  it('splits CamelCase compound words', () => {
    assert.equal(normalizeFabricatedName('Accessory-TabCollar-10in'), 'Tab Collar 10 inch');
    assert.equal(normalizeFabricatedName('Accessory-DrainPan-30x50'), 'Drain Pan 30x50');
    assert.equal(normalizeFabricatedName('Accessory-FlatTap-8in'), 'Flat Tap 8 inch');
    assert.equal(normalizeFabricatedName('Accessory-SaddleTap-6in'), 'Saddle Tap 6 inch');
  });

  it('preserves dimensional sizes (8x4x4, 32x32)', () => {
    assert.equal(normalizeFabricatedName('Accessory-Boot-8x4x4'), 'Boot 8x4x4');
    assert.equal(normalizeFabricatedName('Accessory-Pad-32x32'), 'Pad 32x32');
  });

  it('expands compact unit suffixes (in/ft/gal)', () => {
    assert.equal(normalizeFabricatedName('Accessory-Stand-21.5in'), 'Stand 21.5 inch');
    assert.equal(normalizeFabricatedName('Pipe-5ft'), 'Pipe 5 foot');
    assert.equal(normalizeFabricatedName('Mastic-1gal'), 'Mastic 1 gallon');
  });

  it('handles plain category-only slugs', () => {
    assert.equal(normalizeFabricatedName('Accessory-Mastic'), 'Mastic');
    assert.equal(normalizeFabricatedName('Accessory-Brush'), 'Brush');
  });

  it('round-trips through searchParts for the 2026-06-04 call slugs', () => {
    // Seed enough inventory to verify each major resolution.
    cache.upsertInventoryItem({ listId: 'SLV04', name: 'SLV04',
      fullName: 'Flex:SLV04', salesPrice: 37.97, isActive: true });
    cache.upsertInventoryItem({ listId: 'SLV10', name: 'SLV10',
      fullName: 'Flex:SLV10', salesPrice: 71.97, isActive: true });
    cache.upsertInventoryItem({ listId: 'TC10', name: 'TC10',
      fullName: 'Tab Collars:TC10', salesPrice: 2.14, isActive: true });
    cache.upsertInventoryItem({ listId: 'B844', name: 'B 8x4-4',
      fullName: 'Boots:B 8x4-4', salesPrice: 9.47, isActive: true });

    // Sophia's slugs -> normalized -> searchParts top hit
    const f4 = cache.searchParts(normalizeFabricatedName('Accessory-Flex-4in'), { limit: 1 });
    assert.equal(f4[0].full_name, 'Flex:SLV04');

    const f10 = cache.searchParts(normalizeFabricatedName('Accessory-Flex-10in'), { limit: 1 });
    assert.equal(f10[0].full_name, 'Flex:SLV10');

    const tc10 = cache.searchParts(normalizeFabricatedName('Accessory-TabCollar-10in'), { limit: 1 });
    assert.equal(tc10[0].full_name, 'Tab Collars:TC10');

    const boot = cache.searchParts(normalizeFabricatedName('Accessory-Boot-8x4x4'), { limit: 1 });
    assert.equal(boot[0].full_name, 'Boots:B 8x4-4');
  });
});

describe('attemptAutoMatch — handles Sophia slug payloads 2026-06-04', () => {
  const { attemptAutoMatch } = require('../api/item-resolver');

  it('resolves an Accessory- slug end-to-end', () => {
    cache.upsertInventoryItem({ listId: 'SLV04', name: 'SLV04',
      fullName: 'Flex:SLV04', salesPrice: 37.97, isActive: true });
    const result = attemptAutoMatch({ name: 'Accessory-Flex-4in', qty: 2 });
    assert.ok(result, 'expected non-null match');
    assert.equal(result.name, 'Flex:SLV04');
    assert.equal(result.sales_price, 37.97);
    assert.equal(result.original, 'Accessory-Flex-4in');
    assert.ok(/AUTO-MATCHED.*Accessory-Flex-4in.*Flex:SLV04/.test(result.audit_line));
  });
});

describe('isCatalogValid — folder-row guard 2026-06-02', () => {
  before(() => setupTestDb());
  after(() => teardownTestDb());
  beforeEach(() => { clearAllTables(); seed(); });

  it('parent-folder "Tape" (sales_price=null) is NOT catalog valid', () => {
    assert.equal(isCatalogValid('Tape'), false);
  });

  it('parent-folder "Saddle Taps" (sales_price=null) is NOT catalog valid', () => {
    assert.equal(isCatalogValid('Saddle Taps'), false);
  });

  it('real items with prices are still catalog valid', () => {
    assert.equal(isCatalogValid('Tape:Fasson UL181 2.5" 0800'), true);
    assert.equal(isCatalogValid('Saddle Taps:ST08'), true);
    assert.equal(isCatalogValid('Drain Pans&Accessories:SS3'), true);
  });
});
