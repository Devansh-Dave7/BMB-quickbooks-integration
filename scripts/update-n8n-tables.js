#!/usr/bin/env node
/**
 * Generate updated n8n data table CSVs with QB_Item_Name column.
 * This column contains the EXACT item name as it exists in QuickBooks Desktop
 * (after smartTruncate was applied during import).
 */

const fs = require('fs');
const path = require('path');

const QB_NAME_MAX = 31;

// ─── Smart truncate (same rules as import-inventory.js) ──────────
function smartTruncate(name) {
  let n = name;
  n = n.replace(/-71$/, '');
  n = n.replace('SEER2 ', 'S2 ');
  n = n.replace('Better', 'Btr');
  n = n.replace('(Variable Speed)', '(VS)');
  n = n.replace('(Split System (w/ Breaker))', '(SS+Brk)');
  n = n.replace('(Split System)', '(SS)');
  n = n.replace('(Package Unit)', '(PU)');
  n = n.replace('Inverter ', 'Inv ');
  n = n.replace('Good ', 'Gd ');
  n = n.replace('Best ', 'Bst ');
  n = n.replace(' - ', '-');
  n = n.trim();
  if (n.length > QB_NAME_MAX) n = n.substring(0, QB_NAME_MAX);
  return n;
}

// ─── Tier abbreviation helpers ───────────────────────────────────
function tierShort(tier) {
  if (tier.startsWith('Good')) return 'Gd';
  if (tier.startsWith('Better')) return 'Btr';
  if (tier.startsWith('Best')) return 'Bst';
  return tier;
}

function tierMotor(tier) {
  if (tier.includes('PSC')) return 'PSC';
  if (tier.includes('ECM')) return 'ECM';
  if (tier.includes('Variable')) return 'VS';
  return '';
}

function stripModel71(model) {
  return model.replace(/-71$/, '');
}

// ─── Parse CSV (simple — no quoted commas in these files) ────────
function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',');
    const row = {};
    headers.forEach((h, j) => { row[h] = vals[j] || ''; });
    rows.push(row);
  }
  return { headers, rows };
}

function toCSV(headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map(h => row[h] || '').join(','));
  }
  return lines.join('\n');
}

// ─── Generate QB names per table ─────────────────────────────────

function tierBase(tier) {
  // Extract just the tier word: "Good (PSC)" → "Good", "Best (Variable Speed)" → "Best"
  return tier.split(' (')[0].split('(')[0].trim();
}

function genHeatPumpName(row) {
  // Original Excel format: "{Ton}T {SEER2} SEER2 HP {Good|Better|Best} - {IndoorModel}"
  // NO motor type in parentheses for HP/AC items
  const ton = row.Tonnage;
  const seer = row.SEER2;
  const tier = tierBase(row.Efficiency_Tier); // "Good", "Better", "Best"
  const original = `${ton}T ${seer} SEER2 HP ${tier} - ${row.Indoor_Model}`;
  return smartTruncate(original);
}

function genACName(row) {
  // Same pattern as HP but with "AC"
  const ton = row.Tonnage;
  const seer = row.SEER2;
  const tier = tierBase(row.Efficiency_Tier);
  const original = `${ton}T ${seer} SEER2 AC ${tier} - ${row.Indoor_Model}`;
  return smartTruncate(original);
}

function genInverterName(row) {
  // Original Excel format: "{Ton}-Ton {SEER2} SEER2 Inverter HP - {Tier} ({Motor})"
  // Inverters DO include the motor type in parentheses
  const ton = row.Tonnage.replace('T', ''); // "2T" → "2"
  const seer = row.SEER2;
  const original = `${ton}-Ton ${seer} SEER2 Inverter HP - ${row.Efficiency_Tier}`;
  return smartTruncate(original);
}

function genPackageName(row) {
  // Pattern: "{Ton} {SEER2} SEER2 Pkg {HP|AC} - {Model}"
  const ton = row.Tonnage; // "2T", "2.5T", etc.
  const seer = row.SEER2;
  const isHP = row.System_Type.includes('Heat Pump');
  const typeTag = isHP ? 'HP' : 'AC';
  const model = row.Outdoor_Model;
  const original = `${ton} ${seer} SEER2 Pkg ${typeTag} - ${model}`;
  return smartTruncate(original);
}

function genHeatKitName(row) {
  // Pattern: "Heat Kit - {Model} ({Type})"
  const model = row.Model;
  const type = row.Type;
  const original = `Heat Kit - ${model} (${type})`;
  return smartTruncate(original);
}

// ─── Process each table ──────────────────────────────────────────

const DL = 'c:/Users/Devansh/Downloads';
const OUT = 'c:/Users/Devansh/Downloads/updated';

// Create output dir
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const allQBNames = [];

// 1. Heat Pump
{
  const csv = parseCSV(fs.readFileSync(path.join(DL, 'BMB Price table - heat pump.csv'), 'utf8'));
  const newHeaders = [...csv.headers, 'QB_Item_Name'];
  for (const row of csv.rows) {
    const qbName = genHeatPumpName(row);
    row.QB_Item_Name = qbName;
    allQBNames.push({ table: 'Heat Pump', id: row.id, qbName, len: qbName.length });
  }
  fs.writeFileSync(path.join(OUT, 'BMB Price table - heat pump.csv'), toCSV(newHeaders, csv.rows));
  console.log(`Heat Pump: ${csv.rows.length} rows processed`);
}

// 2. AC
{
  const csv = parseCSV(fs.readFileSync(path.join(DL, 'BMB price table - AC.csv'), 'utf8'));
  const newHeaders = [...csv.headers, 'QB_Item_Name'];
  for (const row of csv.rows) {
    const qbName = genACName(row);
    row.QB_Item_Name = qbName;
    allQBNames.push({ table: 'AC', id: row.id, qbName, len: qbName.length });
  }
  fs.writeFileSync(path.join(OUT, 'BMB price table - AC.csv'), toCSV(newHeaders, csv.rows));
  console.log(`AC: ${csv.rows.length} rows processed`);
}

// 3. Inverter
{
  const csv = parseCSV(fs.readFileSync(path.join(DL, 'BMB Enterprises - Inverter Systems.csv'), 'utf8'));
  const newHeaders = [...csv.headers, 'QB_Item_Name'];
  for (const row of csv.rows) {
    const qbName = genInverterName(row);
    row.QB_Item_Name = qbName;
    allQBNames.push({ table: 'Inverter', id: row.id, qbName, len: qbName.length });
  }
  fs.writeFileSync(path.join(OUT, 'BMB Enterprises - Inverter Systems.csv'), toCSV(newHeaders, csv.rows));
  console.log(`Inverter: ${csv.rows.length} rows processed`);
}

// 4. Package Units
{
  const csv = parseCSV(fs.readFileSync(path.join(DL, 'BMB Enterprises - Package Units.csv'), 'utf8'));
  const newHeaders = [...csv.headers, 'QB_Item_Name'];
  for (const row of csv.rows) {
    const qbName = genPackageName(row);
    row.QB_Item_Name = qbName;
    allQBNames.push({ table: 'Package', id: row.id, qbName, len: qbName.length });
  }
  fs.writeFileSync(path.join(OUT, 'BMB Enterprises - Package Units.csv'), toCSV(newHeaders, csv.rows));
  console.log(`Package Units: ${csv.rows.length} rows processed`);
}

// 5. Heat Kits
{
  const csv = parseCSV(fs.readFileSync(path.join(DL, 'BMB Enterprises - Heat Kits.csv'), 'utf8'));
  const newHeaders = [...csv.headers, 'QB_Item_Name'];
  for (const row of csv.rows) {
    const qbName = genHeatKitName(row);
    row.QB_Item_Name = qbName;
    allQBNames.push({ table: 'Heat Kit', id: row.id, qbName, len: qbName.length });
  }
  fs.writeFileSync(path.join(OUT, 'BMB Enterprises - Heat Kits.csv'), toCSV(newHeaders, csv.rows));
  console.log(`Heat Kits: ${csv.rows.length} rows processed`);
}

// 6. Warranty — not inventory items in QB, keep as service items
{
  const csv = parseCSV(fs.readFileSync(path.join(DL, 'BMB Enterprises - System Shield Warranty.csv'), 'utf8'));
  // Warranty plans aren't inventory items — they're service items
  // Copy as-is (no QB_Item_Name needed for now)
  fs.writeFileSync(path.join(OUT, 'BMB Enterprises - System Shield Warranty.csv'),
    fs.readFileSync(path.join(DL, 'BMB Enterprises - System Shield Warranty.csv'), 'utf8'));
  console.log(`Warranty: ${csv.rows.length} rows (service items — not in QB inventory, copied as-is)`);
}

// ─── Summary & verification ──────────────────────────────────────
console.log('\n=== Generated QB_Item_Name values ===\n');

const overLimit = allQBNames.filter(n => n.len > QB_NAME_MAX);
if (overLimit.length > 0) {
  console.log('WARNING: Names exceeding 31 chars:');
  overLimit.forEach(n => console.log(`  [${n.table} #${n.id}] "${n.qbName}" (${n.len} chars)`));
} else {
  console.log('All names are within 31-char QB limit.');
}

// Check for duplicates
const nameSet = new Set();
const dupes = [];
for (const n of allQBNames) {
  if (nameSet.has(n.qbName)) dupes.push(n);
  nameSet.add(n.qbName);
}
if (dupes.length > 0) {
  console.log('\nDuplicate QB names (expected — same item can appear in HP & AC tables):');
  dupes.forEach(n => console.log(`  [${n.table} #${n.id}] "${n.qbName}"`));
}

console.log(`\nTotal: ${allQBNames.length} items across all tables`);
console.log(`\nUpdated CSVs written to: ${OUT}/`);

// Print all names for verification
console.log('\n=== All QB_Item_Names ===\n');
for (const n of allQBNames) {
  console.log(`[${n.table.padEnd(10)}] ${n.qbName}`);
}
