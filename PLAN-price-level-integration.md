# Price Level Integration Plan — Approach A Phase 1 (Railway Server)

**Status:** APPROVED, pending implementation
**Date approved:** 2026-04-18
**Owner:** Devansh / Claude
**Goal:** Customer-specific pricing end-to-end, from the voice quote through the QuickBooks sales order.

---

## Background

BMB Enterprises has 22 Price Levels configured in QuickBooks Desktop Enterprise 24.0. 211 out of 395 customers are assigned a price level (either FixedPercentage or PerItem). Today, Sophia (Retell voice agent) quotes list prices to every caller regardless of their QB price level, and the resulting Sales Orders record list prices too.

This plan adds price level awareness so:
1. When a known customer calls, Sophia quotes THEIR price (not list price).
2. When the order is created, the QB Sales Order records prices that match what was quoted.

## Approach chosen: A (customer-aware pricing, server-side)

Two alternative approaches were considered and rejected:
- **Approach B** (send `<PriceLevelRef>` on the order, let QB resolve): fixes the QB record but Sophia still quotes list price on the phone — poor UX.
- **Approach C** (inject price level as awareness-only dynamic variable): awkward script "your pricing may vary" — customers still don't hear their real price.

**Approach A** resolves prices server-side at both the pricing lookup and the order creation. Sophia hears the adjusted price from the pricing tool response and passes it through. The order endpoint also applies the same adjustment to each line item so QB records the correct per-component rates.

## Critical constraint (why live QB fetching won't work)

QBWC sync cycles run every ~60s. If the pricing tool hit QB live per call, the customer would wait 60-120s on the phone. **All price level resolution must happen from the local SQLite cache**, not from live QB queries.

This is already the model for inventory and customer data. We're just extending the same pattern to price levels, which were synced into `price_level_cache` on 2026-04-17.

## Pre-requisites (already complete)

From the 2026-04-17 sync layer work:
- `price_level_cache` table — 22 levels synced from QB
- `customer_cache.price_level_list_id` + `customer_cache.price_level_name` — 211/395 customers linked
- `PriceLevelQuery` added to QBWC sync cycle (every 5 cycles)
- `CustomerQuery` parser extracts `PriceLevelRef` into customer rows
- `GET /api/price-levels` endpoint + `cache_freshness.price_levels` in `/api/status`

## Key discovery — order creation bypasses Sophia's `unit_price`

Traced in `api/item-resolver.js`: when Sophia sends `items: [{ name: "2.5T 14.3 S2 HP Gd-7AH1AC30PX", qty: 1, rate: 3157 }]`, `resolveOrderItems()` **ignores `rate`** and looks up component prices from `inventory_cache.sales_price`:

- Line 1: outdoor unit at `ic.sales_price` (from QB)
- Line 2: indoor unit at `ic.sales_price` (from QB)

**Implication:** If only the pricing lookup is updated, Sophia quotes the adjusted price but QB records list components. The order endpoint MUST also be updated to apply the price level adjustment when splitting the item into components. This is why the scope includes `api/item-resolver.js` and `/api/order`.

---

## Scope — Phase 1 (Railway server)

### Files touched

| File | Change | New / Modified |
|---|---|---|
| `db/cache.js` | Add `getPriceLevelByListId()` | Modified |
| `db/pricing.js` | Add `applyPriceLevel()` helper + `resolvePricingForCustomer()` + customer lookup | Modified |
| `api/item-resolver.js` | Add optional `priceLevel` param to `resolveItem()` / `resolveOrderItems()` | Modified |
| `api/routes.js` | Update `/api/pricing/:category`, `/api/order`, `/api/customer/:name` + new diagnostic endpoint | Modified |
| `test/pricing-resolver.test.js` | Unit + integration tests | NEW |

No schema changes (already migrated yesterday). No qbXML, SOAP, or scheduler changes.

---

## Design decisions (approved)

1. **Rounding:** round to 2 decimals (matches QB's native behavior).
2. **Customer matching:** exact match only. No fuzzy/partial matching for pricing resolution — wrong customer → wrong price risk is too high.
3. **Sophia passes both names:** the pricing tool schemas will accept both `customer_name` (person: first + last) and `customer_company`. Server tries company first, then person.
4. **Audit logging:** every price level resolution writes a `sync_log` entry.
5. **Diagnostic endpoint:** `/api/pricing/_/resolve-customer` added for debugging.

## Customer lookup strategy

```js
function findCustomerForPricing(personName, companyName) {
  // Try company first (wholesale accounts usually have a price level)
  if (companyName) {
    const byCompany = db.prepare(
      `SELECT * FROM customer_cache
       WHERE company_name = ? COLLATE NOCASE LIMIT 1`
    ).get(companyName);
    if (byCompany) return byCompany;
  }

  // Fall back to person name
  if (personName) {
    const byName = db.prepare(
      `SELECT * FROM customer_cache
       WHERE full_name = ? COLLATE NOCASE
          OR name = ? COLLATE NOCASE LIMIT 1`
    ).get(personName, personName);
    if (byName) return byName;
  }

  return null;
}
```

Exact matches only. If no match → fall back to list prices silently (no error).

---

## Pricing resolution algorithm

```
resolvePricingForCustomer(category, personName, companyName):

1. If both names empty → return list prices, priceLevelApplied: null
2. Look up customer via findCustomerForPricing(personName, companyName)
3. If not found OR customer has no price_level_list_id
   → return list prices, priceLevelApplied: null
   → log event: { event: 'price_level_skipped', reason: 'no_level_assigned' }
4. Fetch price level via cache.getPriceLevelByListId(customer.price_level_list_id)
5. If price level not found in cache (stale reference?)
   → return list prices, log warning
6. Fetch pricing_metadata rows for the category via getPricingByCategory()
7. For each row, call applyPriceLevel(row, priceLevel)
8. Return adjusted rows + priceLevelApplied metadata
9. Log sync_log entry: 'price_level_applied' with context
```

## applyPriceLevel() logic

```
FixedPercentage case (pct, e.g. -10 = 10% off, +20 = 20% markup):
  multiplier = 1 + (pct / 100)
  adjust ALL of:
    csv_price       × multiplier
    outdoor_price   × multiplier   (CSV component fallback)
    indoor_price    × multiplier   (CSV component fallback)
    qb_outdoor_price × multiplier  (live QB component)
    qb_indoor_price  × multiplier  (live QB component)
  (round each to 2 decimals)
  preserve originals as list_csv_price, list_outdoor_price, etc.

PerItem case:
  build lookup map from per_item_data:
    { fullName: { customPrice, customPricePercent } }

  for outdoor component (match row.outdoor_full_name against map):
    if entry.customPrice → qb_outdoor_price = customPrice
                         → outdoor_price = customPrice (keep consistent)
    if entry.customPricePercent → multiply qb_outdoor_price and outdoor_price
                                → by (1 + pct/100)
    if no match → keep list price (PerItem levels only cover some items)

  for indoor component (match row.indoor_full_name against map):
    (same logic)

  for heat_kit (indoor only), package_unit (outdoor only):
    apply to the relevant component

  for warranty / ac (not in QB inventory_cache):
    → PerItem cannot apply (no FullName to match)
    → fall through with list prices

  recompute csv_price = outdoor_price + indoor_price (or appropriate for category)
```

**Important:** always preserve original prices as `list_csv_price`, `list_outdoor_price`, etc. so the response shows both list and adjusted prices for transparency.

---

## API endpoint changes

### Modified: `GET /api/pricing/:category`

Accepts new optional query params: `?customer=<name>&company=<name>`

**Without customer/company params** → existing behavior (list prices).

**With params** → calls resolver, returns adjusted data:

```json
{
  "category": "heat_pump",
  "label": "Heat Pumps",
  "count": 12,
  "customer": {
    "matched_on": "company_name",
    "customer_name": "Smith HVAC",
    "qb_full_name": "Smith HVAC LLC"
  },
  "price_level_applied": {
    "list_id": "80000041-1706557158",
    "name": "PREM EQUIP SEL MAT",
    "type": "PerItem",
    "items_overridden": 3,
    "adjustment_percent": null
  },
  "last_qb_sync": "2026-04-17 14:29:35",
  "items": [
    {
      "qb_item_name": "2T 14.3 S2 HP Gd-7AH1AC24PX",
      "price": 2524,
      "qb_synced": true,
      "csv_price": 2524,
      "list_csv_price": 2804,
      "qb_outdoor_price": 1700,
      "list_qb_outdoor_price": 1900,
      "qb_indoor_price": 824,
      "list_qb_indoor_price": 904,
      "outdoor_full_name": "Allied Res:Split HP:7HP14F24P",
      "indoor_full_name": "Allied Res:A/H's:7AH1AC24PX-71",
      ...
    }
  ]
}
```

**Customer not found / no level** → prices unchanged, `price_level_applied: null`, `customer.matched_on: null`.

### Enhanced: `GET /api/customer/:name`

Existing customer response plus nested `price_level` object:

```json
{
  "list_id": "...",
  "name": "Smith HVAC",
  "full_name": "Smith HVAC LLC",
  "company_name": "Smith HVAC",
  "phone": "+19041234567",
  ...existing fields...,
  "price_level": {
    "list_id": "80000041-1706557158",
    "name": "PREM EQUIP SEL MAT",
    "type": "PerItem",
    "fixed_percentage": null,
    "per_item_count": 800
  }
}
```

`price_level` is `null` if customer has no price level assigned.

### Modified: `POST /api/order`

When resolving the customer, also resolve their price level and pass it into `resolveOrderItems()`:

```js
let customerMatch = cache.getCustomer(customer_name);
let priceLevel = null;
if (customerMatch?.price_level_list_id) {
  priceLevel = cache.getPriceLevelByListId(customerMatch.price_level_list_id);
}

const resolvedItems = resolveOrderItems(items, priceLevel);
```

`resolveOrderItems` adjusts the component rates before returning parts. The SalesOrderAdd qbXML gets adjusted rates. Log sync_log entry: `price_level_applied` with `context: 'order_creation'`.

### NEW: `GET /api/pricing/_/resolve-customer`

Diagnostic endpoint. Query params: `customer`, `company`, `category` (optional).

Returns detailed resolution trace:

```json
{
  "lookup": {
    "customer_query": "Dave Tyler",
    "company_query": "Target Dial",
    "matched_customer": {
      "list_id": "...",
      "name": "Target Dial",
      "full_name": "Target Dial LLC",
      "matched_on": "company_name"
    },
    "price_level": {
      "list_id": "...",
      "name": "PREM EQUIP SEL MAT",
      "type": "PerItem",
      "per_item_count": 800
    }
  },
  "pricing_preview": {
    "category": "heat_pump",
    "items_count": 12,
    "sample_items": [
      {
        "qb_item_name": "2T 14.3 S2 HP Gd-7AH1AC24PX",
        "list_price": 2804,
        "adjusted_price": 2524,
        "savings": 280,
        "savings_pct": 9.99,
        "components_adjusted": ["outdoor", "indoor"]
      }
    ]
  }
}
```

Helpful for Lewis/Devansh to debug "why did customer X get wrong price quoted."

---

## Sync log audit entries

Every price level resolution writes one entry:

```js
log.logEvent({
  event: 'price_level_applied',
  detail: {
    customer: 'Smith HVAC',
    matched_on: 'company_name',
    price_level_name: 'PREM EQUIP SEL MAT',
    price_level_type: 'PerItem',
    price_level_list_id: '80000041-...',
    context: 'pricing_lookup', // or 'order_creation'
    category: 'heat_pump',     // pricing_lookup only
    qb_item_name: '...',       // order_creation only
    items_overridden: 3,       // PerItem only
    adjustment_percent: -10,    // FixedPercentage only
  }
});
```

Skip/fallback cases also logged with `event: 'price_level_skipped'` and a `reason` field (`no_customer_match`, `no_level_assigned`, `level_not_in_cache`, `empty_query`).

---

## Test plan

New file: `test/pricing-resolver.test.js`

### Unit tests for `applyPriceLevel()`
1. FixedPercentage markup (+10%) → all prices × 1.10, rounded to 2 decimals
2. FixedPercentage discount (-15%) → all prices × 0.85
3. PerItem with `customPrice` override → specific component overridden
4. PerItem with `customPricePercent` override → that component scaled by pct
5. PerItem with NO match for item → list price kept (no blanket adjustment)
6. PerItem applied to split system where only ONE component matches → partial adjustment
7. Originals preserved as `list_*` fields

### Unit tests for `findCustomerForPricing()`
1. Company match preferred over person match
2. Fall back to person name when company not found
3. No match for either → returns null
4. Exact match only — partial "Smith" does not match "Smith HVAC LLC"

### Unit tests for `resolvePricingForCustomer()`
1. No customer → list prices, `priceLevelApplied: null`
2. Customer found, no level → list prices, `priceLevelApplied: null`
3. Customer found with FixedPercentage level → adjusted prices
4. Customer found with PerItem level → adjusted prices + overrides count
5. Customer found, level not in cache (edge case) → list prices + warning logged

### Integration tests for API routes
1. `GET /api/pricing/heat_pump` (no customer) — backward compat, returns list data
2. `GET /api/pricing/heat_pump?customer=Smith+HVAC` — returns adjusted data
3. `GET /api/pricing/heat_pump?company=Smith+HVAC+LLC` — matches by company
4. `GET /api/pricing/heat_pump?customer=Unknown` — returns list prices
5. `GET /api/customer/:name` — includes price_level nested object when present
6. `GET /api/pricing/_/resolve-customer?customer=X` — returns diagnostic payload
7. `POST /api/order` with customer having price level → items adjusted

### Verify sync_log entries
1. Each API call above writes expected audit log entry
2. Skip cases log with reason

---

## Deployment + verification sequence

1. Commit all file changes.
2. Push to `personal/main`. Railway auto-deploys.
3. Verify deploy via `GET /api/status` (uptime resets).
4. Test diagnostic endpoint with known customer:
   ```
   GET /api/pricing/_/resolve-customer?customer=BMB+Enterprises&category=heat_pump
   ```
5. Test regular pricing endpoint with a known wholesale customer:
   ```
   GET /api/pricing/heat_pump?company=MULTIFAMILY-WIL+customer
   ```
6. Place a test order via `/api/order` with a customer that has a PriceLevel — verify QB Sales Order shows the adjusted component prices.
7. Inspect `sync_log` via raw SQL to confirm audit entries land.

---

## What's intentionally OUT of Phase 1 (Railway)

These stay untouched:
- qbXML templates (`templates.js`) — order rates are passed numerically, no `<PriceLevelRef>` needed
- qbXML parsers
- SOAP service / QBWC handshake
- Scheduler cycle
- DB schema
- PriceLevelQuery template (already built)

---

## Phase 2 — Retell + n8n changes (out of scope for this plan, next phase)

For completeness, the follow-up phases are:

**Phase 2a — Retell tool schema updates** (for all 6 pricing tools):
- Add `customer_name` parameter (optional string, "first last" form)
- Add `customer_company` parameter (optional string)
- Update tool descriptions explaining these are passed for customer-specific pricing

**Phase 2b — Retell system prompt update:**
- Tell Sophia to pass both `{{firstName}} {{lastName}}` and `{{company}}` to every pricing tool call
- For new/unknown customers, pass empty strings (server falls back to list prices — fine)

**Phase 2c — n8n pricing workflows** (6 webhooks, all 6 product categories):
- Update the "Fetch - Heat Pump" etc. HTTP Request nodes to forward customer name + company to Railway as query params
- Server URL becomes: `https://...railway.app/api/pricing/heat_pump?customer=X&company=Y`

**Phase 2d — Inbound callback (optional enhancement):**
- After CRM lookup, call Railway `GET /api/customer/:name` to fetch price level
- Include `priceLevelName` in the dynamic variables Retell receives
- Lets Sophia acknowledge "I see you're on our Premium Equipment pricing"

**Phase 2e — Order creation is unchanged on Retell/n8n side:**
- Sophia already passes `unit_price` from the [QB_DATA] block
- With Phase 1 complete, that `unit_price` is already customer-adjusted (from the pricing tool response)
- Server applies the same price level to the order via `resolveOrderItems(items, priceLevel)` — redundant but ensures consistency if Sophia ever deviates

---

## Rollback plan

If something breaks:
1. Revert the commit on `main` and force-push (or revert + new commit).
2. Railway auto-rollback.
3. Backward compat is built in — `/api/pricing/:category` without customer params returns list prices exactly as today. Same for `/api/order` — if `cache.getPriceLevelByListId()` returns null, `resolveOrderItems` uses list component prices like today.

---

## Timeline estimate

- Cache function: 20 min
- Pricing resolver logic: 2 hours (most complex)
- Item resolver update: 30 min
- Route updates: 1 hour
- Diagnostic endpoint: 30 min
- Tests: 2 hours
- Deploy + verify: 30 min
- **Total: ~6-7 hours of focused work**

---

## Open items / future considerations

- **Cache staleness:** price level cache updates every 5 sync cycles (~5 min worst case). If Lewis changes a price level mid-call, there's a small window where Sophia quotes the old price. Acceptable for voice ordering.
- **Price level removed in QB:** if a customer's price level is deleted but the customer still has the reference, `getPriceLevelByListId()` returns null → fall back to list. No error. Sync_log records the skip.
- **Multi-currency:** out of scope. BMB operates USD only.
- **Sales Rep / customer class:** not affected by this work. Those remain at QB defaults.
- **Order already placed but wrong price:** after deployment, past orders are not retroactively adjusted. Only new orders benefit.
