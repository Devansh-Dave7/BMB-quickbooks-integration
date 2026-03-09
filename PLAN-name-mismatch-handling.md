# Plan: Handle Item & Customer Name Mismatches

## Context
When the Retell AI agent places an order, the server queues it and returns "order placed" (202) immediately. The actual QB sync happens 1-5 minutes later via QBWC. If the item name or customer name doesn't match what's in QuickBooks, the sync **fails silently** — the customer thinks their order was placed but it never makes it into QB.

## Solution: Two layers of protection

### Layer 1: Pre-validate names at order time (immediate feedback)
Before queuing, check item/customer names against the cache. If the cache is populated and a name isn't found, return **422 error immediately** so n8n can tell the Retell agent, which tells the customer.

If the cache is empty (first run, no sync yet), allow the order through with a warning.

### Layer 2: Fire error callbacks on sync failure (post-sync notification)
When a queued order fails during QB sync, fire the per-request `callback_url` with the error details so n8n gets notified.

---

## Changes (4 files)

### 1. `db/cache.js` — Add cache population checks
Add two functions:
- `isInventoryCachePopulated()` — returns true if inventory_cache has rows
- `isCustomerCachePopulated()` — returns true if customer_cache has rows
- Export both

### 2. `api/routes.js` — Add pre-validation to `/order` and `/invoice`
Add a `preValidateNames()` helper that:
- Checks each `items[].name` against `cache.getInventoryItem()` (already does exact + fuzzy matching)
- Checks `customer_name` against `cache.getCustomer()` (already does full_name + company + partial)
- If cache populated + not found → collect errors
- If cache empty → collect warnings (allow order through)
- Returns 422 with details if any errors, 202 with warnings if only warnings

Also resolves names to their exact QB `full_name` so even slight variations get corrected.

### 3. `soap/service.js` — Fire error callback in catch block (line 344)
Add ~5 lines to the existing catch block: if the failed queue item has a `callback_url`, fire it with `{ status: 'error', error: err.message }` so the original caller (n8n) knows the order failed.

### 4. `test/api-routes.test.js` — Add test cases
- 422 when item name not found (cache populated)
- 422 when customer name not found (cache populated)
- 202 with warnings when cache is empty
- 202 with resolved names when fuzzy match succeeds

## How n8n handles it
The n8n "Format Response" node already checks `if (result.status === 'queued')` for success and has an else branch for errors. A 422 response will hit the else branch and tell the customer: "Sorry, there was an issue placing the order."

## Verification
1. Run `npm test` to verify all existing + new tests pass
2. Test with curl: POST /api/order with a valid item name → 202
3. Test with curl: POST /api/order with an invalid item name (after cache is populated) → 422
