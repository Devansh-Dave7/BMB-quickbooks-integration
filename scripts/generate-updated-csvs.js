#!/usr/bin/env node
/**
 * Generate updated CSVs with QB_Item_Name column.
 * Reads original CSVs + QB inventory from Railway API, maps each row
 * to its actual QB item name, outputs new CSVs ready for n8n import.
 */
const fs = require('fs');
const path = require('path');

const DOWNLOADS = 'C:/Users/Devansh/Downloads';
const OUTPUT = path.join(DOWNLOADS, 'updated');

// QB inventory data (fetched from Railway API and saved)
const QB_DATA_FILE = path.join(OUTPUT, 'qb-inventory.json');

// ─── Helpers ──────────────────────────────────────────────────

function parseCsv(text) {
  const lines = text.trim().split('\n');
  const headers = parseRow(lines[0]);
  return lines.slice(1).map(line => {
    const vals = parseRow(line);
    const obj = {};
    headers.forEach((h, i) => obj[h] = vals[i] || '');
    return obj;
  });
}

function parseRow(line) {
  const vals = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      vals.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  vals.push(current.trim());
  return vals;
}

function writeCsv(filepath, rows, headers) {
  const lines = [headers.join(',')];
  for (const row of rows) {
    const vals = headers.map(h => {
      const v = row[h] || '';
      return v.includes(',') || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v;
    });
    lines.push(vals.join(','));
  }
  fs.writeFileSync(filepath, lines.join('\n') + '\n');
  console.log(`Wrote ${rows.length} rows → ${filepath}`);
}

// ─── QB Name Construction ────────────────────────────────────

function tierAbbrev(tier) {
  if (tier.includes('Good') || tier.includes('PSC')) return 'Gd';
  if (tier.includes('Better') || tier.includes('ECM')) return 'Btr';
  if (tier.includes('Best') || tier.includes('Variable')) return 'Bst';
  return tier;
}

function indoorNoSuffix(model) {
  return model.replace(/-71$/, '');
}

function tonnageLabel(t) {
  // Normalize: "1.5" → "1.5T", "2" → "2T", etc.
  const n = parseFloat(t);
  if (n === Math.floor(n)) return `${Math.floor(n)}T`;
  return `${n}T`;
}

function buildSplitSystemQbName(row, systemType) {
  // Pattern: {tonnage}T {seer2} S2 {AC|HP} {tier}-{indoor_no_71}
  const t = tonnageLabel(row.Tonnage);
  const seer = row.SEER2;
  const type = systemType === 'AC' ? 'AC' : 'HP';
  const tier = tierAbbrev(row.Efficiency_Tier);
  const indoor = indoorNoSuffix(row.Indoor_Model);
  return `${t} ${seer} S2 ${type} ${tier}-${indoor}`;
}

function buildInverterQbName(row) {
  // Pattern: {N}-Ton {seer2} S2 Inv HP-{tier} ({motor})
  const n = parseFloat(row.Tonnage);
  const t = `${Math.floor(n)}-Ton`;
  const seer = row.SEER2;
  const tier = tierAbbrev(row.Efficiency_Tier);
  let motor = '';
  if (row.Efficiency_Tier.includes('PSC')) motor = 'PSC';
  else if (row.Efficiency_Tier.includes('ECM')) motor = 'ECM';
  else if (row.Efficiency_Tier.includes('Variable')) motor = 'VS';
  return `${t} ${seer} S2 Inv HP-${tier} (${motor})`;
}

function buildPackageQbName(row) {
  // Pattern: {tonnage}T {seer2} S2 Pkg {AC|HP}-{model}
  const tonnageStr = row.Tonnage.replace('T', '');
  const n = parseFloat(tonnageStr);
  const t = n === Math.floor(n) ? `${Math.floor(n)}T` : `${n}T`;
  const seer = row.SEER2;
  const type = row.System_Type.includes('AC') ? 'AC' : 'HP';
  const model = row.Outdoor_Model;
  return `${t} ${seer} S2 Pkg ${type}-${model}`;
}

function buildHeatKitQbName(row) {
  // Pattern: Heat Kit-{model} ({type_abbrev})
  const model = row.Model;
  let typeAbbrev = '';
  if (row.Type === 'Split System') typeAbbrev = 'SS';
  else if (row.Type.includes('Breaker')) typeAbbrev = 'SS+Brk';
  else if (row.Type === 'Package Unit') typeAbbrev = 'PU';
  return `Heat Kit-${model} (${typeAbbrev})`;
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  // Ensure output dir exists
  if (!fs.existsSync(OUTPUT)) fs.mkdirSync(OUTPUT, { recursive: true });

  // Fetch QB inventory from Railway
  console.log('Fetching QB inventory from Railway...');
  let qbItems;
  if (fs.existsSync(QB_DATA_FILE)) {
    qbItems = JSON.parse(fs.readFileSync(QB_DATA_FILE, 'utf8'));
    console.log(`Using cached QB data: ${qbItems.length} items`);
  } else {
    const resp = await fetch('https://bmb-quickbooks-integration-production-50b4.up.railway.app/api/inventory', {
      headers: { 'x-api-key': 'P5aFfoLkv-yaw74G1m8rVTVuai-2C-_3rm4Oq9s7Nb8' }
    });
    const data = await resp.json();
    qbItems = data.items;
    fs.writeFileSync(QB_DATA_FILE, JSON.stringify(qbItems, null, 2));
    console.log(`Fetched and cached ${qbItems.length} QB items`);
  }

  // Build lookup: QB full_name → item (for verification)
  const qbByName = new Map();
  for (const item of qbItems) {
    if (item.full_name) qbByName.set(item.full_name, item);
  }

  let mismatches = 0;

  // ─── AC CSV ─────────────────────────────────────
  console.log('\n--- AC ---');
  const acRows = parseCsv(fs.readFileSync(path.join(DOWNLOADS, 'BMB price table - AC.csv'), 'utf8'));
  for (const row of acRows) {
    const qbName = buildSplitSystemQbName(row, 'AC');
    row.QB_Item_Name = qbName;
    if (!qbByName.has(qbName)) {
      console.warn(`  NOT IN QB: ${qbName} (Total_Cost=${row.Total_Cost})`);
      mismatches++;
    }
  }
  const acHeaders = [...Object.keys(acRows[0])];
  writeCsv(path.join(OUTPUT, 'BMB price table - AC.csv'), acRows, acHeaders);

  // ─── Heat Pump CSV ──────────────────────────────
  console.log('\n--- Heat Pump ---');
  const hpRows = parseCsv(fs.readFileSync(path.join(DOWNLOADS, 'BMB Price table - heat pump.csv'), 'utf8'));
  for (const row of hpRows) {
    const qbName = buildSplitSystemQbName(row, 'HP');
    row.QB_Item_Name = qbName;
    if (!qbByName.has(qbName)) {
      console.warn(`  NOT IN QB: ${qbName} (Total_Cost=${row.Total_Cost})`);
      mismatches++;
    }
  }
  const hpHeaders = [...Object.keys(hpRows[0])];
  writeCsv(path.join(OUTPUT, 'BMB Price table - heat pump.csv'), hpRows, hpHeaders);

  // ─── Inverter CSV ───────────────────────────────
  console.log('\n--- Inverter ---');
  const invRows = parseCsv(fs.readFileSync(path.join(DOWNLOADS, 'BMB Enterprises - Inverter Systems.csv'), 'utf8'));
  for (const row of invRows) {
    const qbName = buildInverterQbName(row);
    row.QB_Item_Name = qbName;
    if (!qbByName.has(qbName)) {
      console.warn(`  NOT IN QB: ${qbName} (Total_Cost=${row.Total_Cost})`);
      mismatches++;
    }
  }
  const invHeaders = [...Object.keys(invRows[0])];
  writeCsv(path.join(OUTPUT, 'BMB Enterprises - Inverter Systems.csv'), invRows, invHeaders);

  // ─── Package Units CSV ──────────────────────────
  console.log('\n--- Package Units ---');
  const pkgRows = parseCsv(fs.readFileSync(path.join(DOWNLOADS, 'BMB Enterprises - Package Units.csv'), 'utf8'));
  for (const row of pkgRows) {
    const qbName = buildPackageQbName(row);
    row.QB_Item_Name = qbName;
    if (!qbByName.has(qbName)) {
      console.warn(`  NOT IN QB: ${qbName} (Total_Cost=${row.Total_Cost})`);
      mismatches++;
    }
  }
  const pkgHeaders = [...Object.keys(pkgRows[0])];
  writeCsv(path.join(OUTPUT, 'BMB Enterprises - Package Units.csv'), pkgRows, pkgHeaders);

  // ─── Heat Kits CSV ──────────────────────────────
  console.log('\n--- Heat Kits ---');
  const hkRows = parseCsv(fs.readFileSync(path.join(DOWNLOADS, 'BMB Enterprises - Heat Kits.csv'), 'utf8'));
  for (const row of hkRows) {
    const qbName = buildHeatKitQbName(row);
    row.QB_Item_Name = qbName;
    if (!qbByName.has(qbName)) {
      console.warn(`  NOT IN QB: ${qbName} (Total_Cost=${row.Price})`);
      mismatches++;
    }
  }
  const hkHeaders = [...Object.keys(hkRows[0])];
  writeCsv(path.join(OUTPUT, 'BMB Enterprises - Heat Kits.csv'), hkRows, hkHeaders);

  // ─── Warranty CSV (no QB mapping — these aren't inventory items) ──
  console.log('\n--- Warranty (no QB mapping) ---');
  const warRows = parseCsv(fs.readFileSync(path.join(DOWNLOADS, 'BMB Enterprises - System Shield Warranty.csv'), 'utf8'));
  const warHeaders = [...Object.keys(warRows[0])];
  writeCsv(path.join(OUTPUT, 'BMB Enterprises - System Shield Warranty.csv'), warRows, warHeaders);

  console.log(`\n=== Done. ${mismatches} mismatches found. ===`);
  console.log(`Output directory: ${OUTPUT}`);
}

main().catch(err => { console.error(err); process.exit(1); });
