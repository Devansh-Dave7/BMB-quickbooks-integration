#!/usr/bin/env node
/**
 * One-off script: Parse BMB's Excel inventory file and POST to /api/inventory/add.
 *
 * Usage:
 *   node scripts/import-inventory.js [--dry-run] [--url http://localhost:3000]
 *
 * Options:
 *   --dry-run   Print the JSON payload without sending it
 *   --url       API base URL (default: http://localhost:3000)
 */

const XLSX = require('xlsx');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────

const EXCEL_PATH = path.resolve(
  'C:/Users/Devansh/Desktop/ProductServiceList__9341456488494003_03_04_2026.xlsx',
);

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const urlIdx = args.indexOf('--url');
const BASE_URL = urlIdx !== -1 ? args[urlIdx + 1] : 'http://localhost:3000';
const API_KEY = process.env.API_KEY || process.env.BMB_API_KEY;

// ─── Smart name shortener (QB 31-char limit) ────────────────────

function smartTruncate(name) {
  let n = name;

  // Remove '-71' suffix from model numbers
  n = n.replace(/-71$/, '');

  // Abbreviate common words
  n = n.replace('SEER2 ', 'S2 ');
  n = n.replace('Better', 'Btr');
  n = n.replace('(Variable Speed)', '(VS)');
  n = n.replace('(Split System (w/ Breaker))', '(SS+Brk)');
  n = n.replace('(Split System)', '(SS)');
  n = n.replace('(Package Unit)', '(PU)');
  n = n.replace('Inverter ', 'Inv ');
  n = n.replace('Good ', 'Gd ');
  n = n.replace('Best ', 'Bst ');

  // Compact separator
  n = n.replace(' - ', '-');
  n = n.trim();

  if (n.length > 31) {
    n = n.substring(0, 31);
  }

  return n;
}

// ─── Read & transform Excel ─────────────────────────────────────

console.log(`Reading: ${EXCEL_PATH}`);
const wb = XLSX.readFile(EXCEL_PATH);
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);

// Filter to inventory items only (skip Service types)
const inventoryRows = rows.filter((r) => r.Type === 'Inventory');
console.log(`Found ${rows.length} total rows, ${inventoryRows.length} Inventory items`);

const items = inventoryRows.map((r) => {
  const originalName = r['Product/Service Name'];
  const name = smartTruncate(originalName);

  return {
    name,
    original_name: originalName,
    sales_description: r['Sales Description'] || '',
    sales_price: Number(r['Sales Price / Rate']) || 0,
    purchase_description: r['Purchase Description'] || '',
    purchase_cost: Number(r['Purchase Cost']) || 0,
    income_account: 'Construction Income:Materials Income',
    cogs_account: r['Expense Account'] || 'Cost of Goods Sold',
    asset_account: r['Inventory Asset Account'] || 'Inventory Asset',
    quantity_on_hand: Number(r['Quantity On Hand']) || 0,
    is_taxable: String(r['Taxable']).toLowerCase() === 'yes',
  };
});

// Verify no duplicate names
const nameSet = new Set();
const dupes = [];
items.forEach((item) => {
  if (nameSet.has(item.name)) dupes.push(item.name);
  nameSet.add(item.name);
});

if (dupes.length > 0) {
  console.error('ERROR: Duplicate names after truncation:', dupes);
  process.exit(1);
}

console.log(`Mapped ${items.length} items (0 duplicate names)\n`);

// ─── Dry run or send ────────────────────────────────────────────

if (DRY_RUN) {
  console.log('=== DRY RUN — JSON payload ===\n');
  console.log(JSON.stringify({ items }, null, 2));
  console.log(`\n${items.length} items would be sent to ${BASE_URL}/api/inventory/add`);
  process.exit(0);
}

if (!API_KEY) {
  console.error('ERROR: Set API_KEY or BMB_API_KEY env variable before running.');
  console.error('  Example: API_KEY=your-key node scripts/import-inventory.js');
  process.exit(1);
}

async function send() {
  const url = `${BASE_URL}/api/inventory/add`;
  console.log(`POSTing ${items.length} items to ${url} ...`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
    },
    body: JSON.stringify({ items }),
  });

  const body = await res.json();

  if (!res.ok) {
    console.error(`HTTP ${res.status}:`, JSON.stringify(body, null, 2));
    process.exit(1);
  }

  console.log(`\nSuccess! HTTP ${res.status}`);
  console.log(`  Items queued: ${body.item_count}`);
  console.log(`  Queue IDs: ${body.queue_ids.length}`);

  if (body.warnings && body.warnings.length > 0) {
    console.log(`\n  Warnings (${body.warnings.length}):`);
    body.warnings.forEach((w) => {
      console.log(`    ${w.name}: ${w.warnings.join(', ')}`);
    });
  }

  console.log(`\n${body.message}`);
}

send().catch((err) => {
  console.error('Request failed:', err.message);
  process.exit(1);
});
