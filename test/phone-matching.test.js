/**
 * Phone-first customer matching (2026-07-08).
 *
 * Incident: caller from +19048819453 ("Chris Anthony" of "Mikey's main" per
 * ASR) was quoted list price $2112 for 7HP14F24P because the garbled company
 * name had no exact match against the QB record "Cash Account Mikey's
 * Maintenance" — whose phone field ("904-881-9453  Mike C") matches the
 * caller ID exactly. Dealer price (PerItem level) was $1462.
 *
 * Phone matching must:
 *   - normalize messy QB phone free-text and E.164 caller IDs to last-10-digits
 *   - require a UNIQUE match (shared lines don't get price levels)
 *   - outrank company/person name matching in findCustomerForPricing
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { setupTestDb, teardownTestDb, clearAllTables } = require('./_setup');
const cache = require('../db/cache');
const pricing = require('../db/pricing');

describe('normalizePhone', () => {
  it('strips E.164 to last 10 digits', () => {
    assert.equal(pricing.normalizePhone('+19048819453'), '9048819453');
  });

  it('handles QB free-text phone fields', () => {
    assert.equal(pricing.normalizePhone('904-881-9453  Mike C'), '9048819453');
    assert.equal(pricing.normalizePhone('(904) 880-7925'), '9048807925');
  });

  it('returns null for short/empty values', () => {
    assert.equal(pricing.normalizePhone('881-9453'), null);
    assert.equal(pricing.normalizePhone(''), null);
    assert.equal(pricing.normalizePhone(null), null);
  });
});

describe('findCustomerByPhone / findCustomerForPricing phone tier', () => {
  before(() => setupTestDb());
  after(() => teardownTestDb());
  beforeEach(() => clearAllTables());

  function seedMikeys() {
    cache.upsertCustomer({
      listId: 'C-MIKEYS', name: "Cash Account Mikey's Maintenance",
      fullName: "Cash Account Mikey's Maintenance",
      companyName: "Cash Account-Mikey's Maintenance",
      phone: '904-881-9453  Mike C',
      isActive: true,
    });
  }

  it('matches E.164 caller ID against messy QB phone text', () => {
    seedMikeys();
    const m = pricing.findCustomerByPhone('+19048819453');
    assert.ok(m, 'expected a match');
    assert.equal(m.customer.name, "Cash Account Mikey's Maintenance");
    assert.equal(m.matched_on, 'phone');
  });

  it('phone outranks garbled company name in findCustomerForPricing', () => {
    seedMikeys();
    // "Mikey's main" (ASR garble) matches nothing by name; phone saves it.
    const m = pricing.findCustomerForPricing('Chris Anthony', "Mikey's main", '+19048819453');
    assert.ok(m);
    assert.equal(m.matched_on, 'phone');
    assert.equal(m.customer.name, "Cash Account Mikey's Maintenance");
  });

  it('no phone -> falls back to company exact match (unchanged behaviour)', () => {
    seedMikeys();
    const m = pricing.findCustomerForPricing(null, "Cash Account-Mikey's Maintenance", null);
    assert.ok(m);
    assert.equal(m.matched_on, 'company_name');
  });

  it('ambiguous phone (two customers share the line) -> no phone match', () => {
    seedMikeys();
    cache.upsertCustomer({
      listId: 'C-OTHER', name: 'Other Guy Same Office',
      fullName: 'Other Guy Same Office',
      companyName: 'Other Guy LLC',
      phone: '9048819453',
      isActive: true,
    });
    assert.equal(pricing.findCustomerByPhone('+19048819453'), null);
    // findCustomerForPricing then falls through to name tiers (also no match here)
    const m = pricing.findCustomerForPricing('Chris Anthony', "Mikey's main", '+19048819453');
    assert.equal(m, null);
  });

  it('inactive customers are not matched by phone', () => {
    cache.upsertCustomer({
      listId: 'C-GONE', name: 'Closed Account',
      fullName: 'Closed Account', companyName: 'Closed LLC',
      phone: '904-881-9453', isActive: false,
    });
    assert.equal(pricing.findCustomerByPhone('+19048819453'), null);
  });
});
