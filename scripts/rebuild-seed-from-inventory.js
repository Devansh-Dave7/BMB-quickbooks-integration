#!/usr/bin/env node
/**
 * Rebuild pricing-seed.json by matching our items to real QB inventory names.
 *
 * After the client connects their QuickBooks via QBWC, this script:
 * 1. Fetches real inventory from the Railway server (GET /api/inventory)
 * 2. For each item in pricing-seed.json, finds the matching QB item by model number
 * 3. Replaces qb_item_name with the real QB name
 * 4. Outputs an updated pricing-seed.json
 *
 * Usage:
 *   node scripts/rebuild-seed-from-inventory.js [--dry-run] [--url <server-url>]
 *
 * Options:
 *   --dry-run   Show matches without writing the file
 *   --url       Server URL (default: Railway production URL)
 */

const fs = require('fs');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const urlIdx = args.indexOf('--url');
const BASE_URL = urlIdx !== -1
  ? args[urlIdx + 1]
  : 'https://bmb-quickbooks-integration-production-50b4.up.railway.app';

const API_KEY = process.env.API_KEY || process.env.BMB_API_KEY;

const SEED_FILE = path.join(__dirname, '..', 'data', 'pricing-seed.json');
const BACKUP_FILE = SEED_FILE.replace('.json', '-backup.json');

// ─── Model Number Extraction ─────────────────────────────────────

/**
 * Extract searchable model numbers from a pricing item.
 * Returns { primary, secondary } — primary is the most unique identifier.
 */
function extractModelNumbers(item) {
  switch (item.category) {
    case 'heat_pump':
    case 'ac':
    case 'inverter':
      // Indoor model (strip -71 suffix) is the primary key.
      // Outdoor model disambiguates when same indoor model appears in AC vs HP.
      return {
        primary: item.indoor_model ? item.indoor_model.replace(/-71$/, '') : null,
        secondary: item.outdoor_model || null,
      };

    case 'package_unit':
      // Outdoor model is the only model for package units
      return {
        primary: item.outdoor_model || null,
        secondary: null,
      };

    case 'heat_kit': {
      // Extract model from qb_item_name: "Heat Kit-ECB45-5-P (SS)" → "ECB45-5-P"
      const m = item.qb_item_name.match(/Heat Kit-(.+?)\s*\(/);
      return {
        primary: m ? m[1] : null,
        secondary: null,
      };
    }

    default:
      // warranty and anything else — no model numbers
      return { primary: null, secondary: null };
  }
}

/**
 * Search text across all useful fields of an inventory item.
 */
function inventorySearchText(inv) {
  return [inv.name, inv.full_name, inv.sku, inv.description]
    .filter(Boolean)
    .join(' ');
}

/**
 * Find matching inventory item(s) for a given pricing item.
 * Multi-pass approach (from strictest to loosest):
 *   1. Strict — requires BOTH primary + secondary model in search text
 *   2. Loose  — requires only primary model
 *   3. Category — disambiguate by system type keywords
 * Returns the narrowest non-empty match set.
 */
function findMatches(pricingItem, inventoryItems) {
  const { primary, secondary } = extractModelNumbers(pricingItem);
  if (!primary) return [];

  const primaryUpper = primary.toUpperCase();

  // Pass 1: if we have both models, try strict match first (both must appear)
  if (secondary) {
    const secondaryUpper = secondary.toUpperCase();
    const strict = inventoryItems.filter(inv => {
      const text = inventorySearchText(inv).toUpperCase();
      return text.includes(primaryUpper) && text.includes(secondaryUpper);
    });
    if (strict.length > 0) return strict;
  }

  // Pass 2: find all items containing the primary model
  const primaryMatches = inventoryItems.filter(inv => {
    return inventorySearchText(inv).toUpperCase().includes(primaryUpper);
  });

  if (primaryMatches.length <= 1) return primaryMatches;

  // Pass 3: try to disambiguate by category keywords in the QB name
  const categoryKeywords = {
    heat_pump: ['HP', 'HEAT PUMP'],
    ac: ['AC', 'AIR COND'],
    inverter: ['INV', 'INVERTER'],
    package_unit: ['PKG', 'PACKAGE'],
    heat_kit: ['HEAT KIT', 'HK'],
  };
  const keywords = categoryKeywords[pricingItem.category];
  if (keywords) {
    const byCategory = primaryMatches.filter(inv => {
      const text = inventorySearchText(inv).toUpperCase();
      return keywords.some(kw => text.includes(kw));
    });
    if (byCategory.length > 0 && byCategory.length < primaryMatches.length) {
      return byCategory;
    }
  }

  return primaryMatches;
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  console.log('=== Rebuild pricing-seed.json from QB inventory ===\n');

  // 1. Load current seed file
  if (!fs.existsSync(SEED_FILE)) {
    console.error('ERROR: pricing-seed.json not found at', SEED_FILE);
    process.exit(1);
  }

  const pricingItems = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  console.log(`Loaded ${pricingItems.length} items from pricing-seed.json`);

  // 2. Fetch real inventory from server
  if (!API_KEY) {
    console.error('ERROR: Set API_KEY or BMB_API_KEY env variable.');
    console.error('  Example: API_KEY=your-key node scripts/rebuild-seed-from-inventory.js');
    process.exit(1);
  }

  console.log(`Fetching inventory from ${BASE_URL}/api/inventory ...\n`);

  let res;
  try {
    res = await fetch(`${BASE_URL}/api/inventory`, {
      headers: { 'X-API-Key': API_KEY },
    });
  } catch (err) {
    console.error(`ERROR: Could not connect to ${BASE_URL}`);
    console.error(`  ${err.message}`);
    console.error('\nMake sure the server is running and accessible.');
    process.exit(1);
  }

  if (!res.ok) {
    console.error(`ERROR: HTTP ${res.status} from server`);
    const body = await res.text();
    console.error(body);
    process.exit(1);
  }

  const data = await res.json();
  const inventory = data.items || [];
  console.log(`Fetched ${inventory.length} inventory items (last sync: ${data.last_sync || 'never'})\n`);

  if (inventory.length === 0) {
    console.error('ERROR: No inventory items found on the server.');
    console.error('Has the client connected QuickBooks and completed a sync?');
    process.exit(1);
  }

  // 3. Match each pricing item to a QB inventory item
  let matched = 0;
  let unchanged = 0;
  let unmatched = 0;
  let ambiguous = 0;
  let skipped = 0;

  const unmatchedItems = [];
  const ambiguousItems = [];

  for (const item of pricingItems) {
    // Skip warranty items — they're service items, not inventory
    if (item.category === 'warranty') {
      skipped++;
      continue;
    }

    let matches = findMatches(item, inventory);

    // If multiple matches, disambiguate
    if (matches.length > 1) {
      // Prefer exact match with our current name
      const exact = matches.find(inv => inv.name === item.qb_item_name);
      if (exact) {
        matches = [exact];
      } else {
        // Pick the match with the longest common prefix to our current name
        const scored = matches.map(inv => {
          let common = 0;
          const a = item.qb_item_name, b = inv.name;
          while (common < a.length && common < b.length && a[common] === b[common]) common++;
          return { inv, common };
        });
        scored.sort((a, b) => b.common - a.common);
        // Only pick the best if it's clearly better (at least 5 chars more in common)
        if (scored[0].common >= 5 && scored[0].common > scored[1].common + 4) {
          matches = [scored[0].inv];
        }
      }
    }

    if (matches.length === 1) {
      const realName = matches[0].name;
      if (realName === item.qb_item_name) {
        unchanged++;
      } else {
        console.log(`  MATCH  ${item.category}`);
        console.log(`    old: ${item.qb_item_name}`);
        console.log(`    new: ${realName}\n`);
        item.qb_item_name = realName;
        matched++;
      }
    } else if (matches.length === 0) {
      unmatched++;
      unmatchedItems.push(item);
    } else {
      ambiguous++;
      ambiguousItems.push({ item, matches });
    }
  }

  // 4. Summary
  console.log('=== Summary ===');
  console.log(`  Updated:             ${matched}`);
  console.log(`  Already correct:     ${unchanged}`);
  console.log(`  Unmatched (0 hits):  ${unmatched}`);
  console.log(`  Ambiguous (2+ hits): ${ambiguous}`);
  console.log(`  Skipped (warranty):  ${skipped}`);
  console.log(`  Total:               ${pricingItems.length}`);

  if (unmatchedItems.length > 0) {
    console.log('\n--- Unmatched items (no QB match found) ---');
    for (const item of unmatchedItems) {
      const { primary, secondary } = extractModelNumbers(item);
      const models = [primary, secondary].filter(Boolean).join(', ');
      console.log(`  [${item.category}] ${item.qb_item_name}`);
      console.log(`    searched for: ${models}`);
    }
  }

  if (ambiguousItems.length > 0) {
    console.log('\n--- Ambiguous items (multiple QB matches) ---');
    for (const { item, matches } of ambiguousItems) {
      console.log(`  [${item.category}] ${item.qb_item_name}`);
      for (const m of matches) {
        console.log(`    → "${m.name}" (qty: ${m.qty_on_hand})`);
      }
    }
  }

  // 5. Write updated seed file
  if (DRY_RUN) {
    console.log('\n[DRY RUN] No files changed.');
    return;
  }

  if (matched === 0) {
    console.log('\nNo name changes needed — all names already match (or had no match).');
    return;
  }

  // Backup original
  fs.copyFileSync(SEED_FILE, BACKUP_FILE);
  console.log(`\nBacked up original → ${path.basename(BACKUP_FILE)}`);

  // Write updated seed
  fs.writeFileSync(SEED_FILE, JSON.stringify(pricingItems, null, 2));
  console.log(`Updated ${path.basename(SEED_FILE)} (${matched} names changed)`);

  console.log('\nNext steps:');
  console.log('  1. Review changes:  git diff data/pricing-seed.json');
  console.log('  2. Commit & push:   git add data/pricing-seed.json && git commit -m "fix: update QB item names from live inventory" && git push');
  console.log('  3. Railway auto-redeploys → all items will be qb_synced: true');
}

main().catch(err => {
  console.error('\nScript failed:', err.message);
  process.exit(1);
});
