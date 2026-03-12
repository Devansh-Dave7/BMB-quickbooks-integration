#!/usr/bin/env node
/**
 * Seed pricing metadata from BMB pricing CSVs.
 * Reads all 6 CSVs, constructs QB item names, extracts metadata,
 * and outputs data/pricing-seed.json for the server to auto-seed on startup.
 */
const fs = require('fs');
const path = require('path');

const DOWNLOADS = 'C:/Users/Devansh/Downloads';
const OUTPUT = path.join(__dirname, '..', 'data', 'pricing-seed.json');

// ─── CSV Helpers ────────────────────────────────────────────────

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

// ─── QB Name Construction (reused from generate-updated-csvs.js) ─

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
  const n = parseFloat(t);
  if (n === Math.floor(n)) return `${Math.floor(n)}T`;
  return `${n}T`;
}

function buildSplitSystemQbName(row, systemType) {
  const t = tonnageLabel(row.Tonnage);
  const seer = row.SEER2;
  const type = systemType === 'AC' ? 'AC' : 'HP';
  const tier = tierAbbrev(row.Efficiency_Tier);
  const indoor = indoorNoSuffix(row.Indoor_Model);
  return `${t} ${seer} S2 ${type} ${tier}-${indoor}`;
}

function buildInverterQbName(row) {
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
  const tonnageStr = row.Tonnage.replace('T', '');
  const n = parseFloat(tonnageStr);
  const t = n === Math.floor(n) ? `${Math.floor(n)}T` : `${n}T`;
  const seer = row.SEER2;
  const type = row.System_Type.includes('AC') ? 'AC' : 'HP';
  const model = row.Outdoor_Model;
  return `${t} ${seer} S2 Pkg ${type}-${model}`;
}

function buildHeatKitQbName(row) {
  const model = row.Model;
  let typeAbbrev = '';
  if (row.Type === 'Split System') typeAbbrev = 'SS';
  else if (row.Type.includes('Breaker')) typeAbbrev = 'SS+Brk';
  else if (row.Type === 'Package Unit') typeAbbrev = 'PU';
  return `Heat Kit-${model} (${typeAbbrev})`;
}

/**
 * Extract the actual QB inventory item name for a heat kit.
 * Split system kits use the model as-is (e.g. "ECB45-5-P").
 * Package unit kits have a "-1" suffix in QB (e.g. "PHK05BP-1").
 */
function extractHeatKitQbModel(row) {
  const model = row.Model;
  if (row.Type === 'Package Unit') {
    return `${model}-1`;
  }
  return model;
}

function tierName(efficiencyTier) {
  if (efficiencyTier.includes('Good')) return 'Good';
  if (efficiencyTier.includes('Better')) return 'Better';
  if (efficiencyTier.includes('Best')) return 'Best';
  return efficiencyTier;
}

function parseNum(val) {
  if (!val) return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

// ─── Category Processors ────────────────────────────────────────

function processSplitSystem(csvPath, category, systemType) {
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  console.log(`  ${category}: ${rows.length} rows`);

  return rows.map(row => ({
    category,
    qb_item_name: buildSplitSystemQbName(row, systemType),
    tonnage: parseNum(row.Tonnage),
    seer2: parseNum(row.SEER2),
    tier: tierName(row.Efficiency_Tier),
    efficiency_tier: row.Efficiency_Tier,
    ahri_ref: row.AHRI_Ref || null,
    outdoor_model: row.Outdoor_Model || null,
    indoor_model: row.Indoor_Model || null,
    outdoor_price: parseNum(row.Outdoor_Price),
    indoor_price: parseNum(row.Indoor_Price),
    csv_price: parseNum(row.Total_Cost),
    condenser_dims: JSON.stringify({
      l: row.Condenser_L, w: row.Condenser_W, h: row.Condenser_H
    }),
    airhandler_dims: JSON.stringify({
      l: row.AirHandler_L, w: row.AirHandler_W, h: row.AirHandler_H
    }),
    electrical: JSON.stringify({
      mca: row.MCA, moc: row.MOC,
      lineset_liquid: row.Lineset_Liquid, lineset_suction: row.Lineset_Suction,
      filter_size: row.Filter_Size
    }),
    heat_kit_type: null,
    voltage_specs: null,
    warranty_level: null,
    warranty_program: null,
    labor_years: null,
    parts_years: null,
  }));
}

function processInverter(csvPath) {
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  console.log(`  inverter: ${rows.length} rows`);

  return rows.map(row => ({
    category: 'inverter',
    qb_item_name: buildInverterQbName(row),
    tonnage: parseNum(row.Tonnage.replace('T', '')),
    seer2: parseNum(row.SEER2),
    tier: tierName(row.Efficiency_Tier),
    efficiency_tier: row.Efficiency_Tier,
    ahri_ref: row.AHRI_Ref || null,
    outdoor_model: row.Outdoor_Model || null,
    indoor_model: row.Indoor_Model || null,
    outdoor_price: parseNum(row.Outdoor_Price),
    indoor_price: parseNum(row.Indoor_Price),
    csv_price: parseNum(row.Total_Cost),
    condenser_dims: JSON.stringify({
      l: row.Condenser_L, w: row.Condenser_W, h: row.Condenser_H
    }),
    airhandler_dims: JSON.stringify({
      l: row.AirHandler_L, w: row.AirHandler_W, h: row.AirHandler_H
    }),
    electrical: JSON.stringify({
      mca: row.MCA, moc: row.MOC,
      lineset_liquid: row.Lineset_Liquid, lineset_suction: row.Lineset_Suction,
      filter_size: row.Filter_Size
    }),
    heat_kit_type: null,
    voltage_specs: null,
    warranty_level: null,
    warranty_program: null,
    labor_years: null,
    parts_years: null,
  }));
}

function processPackageUnits(csvPath) {
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  console.log(`  package_unit: ${rows.length} rows`);

  return rows.map(row => ({
    category: 'package_unit',
    qb_item_name: buildPackageQbName(row),
    tonnage: parseNum(row.Tonnage.replace('T', '')),
    seer2: parseNum(row.SEER2),
    tier: null,
    efficiency_tier: null,
    ahri_ref: row.AHRI_Ref || null,
    outdoor_model: row.Outdoor_Model || null,
    indoor_model: null,
    outdoor_price: null,
    indoor_price: null,
    csv_price: parseNum(row.Price || row.Total_Cost),
    condenser_dims: JSON.stringify({
      l: row.Dimensions_L, w: row.Dimensions_W, h: row.Dimensions_H
    }),
    airhandler_dims: null,
    electrical: JSON.stringify({ mca: row.MCA, moc: row.MOC }),
    heat_kit_type: null,
    voltage_specs: null,
    warranty_level: null,
    warranty_program: null,
    labor_years: null,
    parts_years: null,
  }));
}

function processHeatKits(csvPath) {
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  console.log(`  heat_kit: ${rows.length} rows`);

  return rows.map(row => ({
    category: 'heat_kit',
    qb_item_name: buildHeatKitQbName(row),
    tonnage: null,
    seer2: null,
    tier: null,
    efficiency_tier: null,
    ahri_ref: null,
    outdoor_model: null,
    indoor_model: extractHeatKitQbModel(row),
    outdoor_price: null,
    indoor_price: null,
    csv_price: parseNum(row.Price),
    condenser_dims: null,
    airhandler_dims: null,
    electrical: null,
    heat_kit_type: row.Type,
    voltage_specs: JSON.stringify({
      v208: { moc: row.V208_MOC, kw: row.V208_KW },
      v220: { moc: row.V220_MOC, kw: row.V220_KW },
      v230: { moc: row.V230_MOC, kw: row.V230_KW },
      v240: { moc: row.V240_MOC, kw: row.V240_KW },
    }),
    warranty_level: null,
    warranty_program: null,
    labor_years: null,
    parts_years: null,
  }));
}

function processWarranty(csvPath) {
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  console.log(`  warranty: ${rows.length} rows`);

  return rows.map(row => {
    // Parse price: "$300" → 300, "Standard (w/ Dealer Registration)" → 0
    let price = 0;
    const priceStr = row.Price_Per_System || '';
    if (priceStr.startsWith('$')) {
      price = parseFloat(priceStr.replace(/[$,]/g, '')) || 0;
    }

    return {
      category: 'warranty',
      qb_item_name: `SystemShield Level ${row.Level}`,
      tonnage: null,
      seer2: null,
      tier: null,
      efficiency_tier: null,
      ahri_ref: null,
      outdoor_model: null,
      indoor_model: null,
      outdoor_price: null,
      indoor_price: null,
      csv_price: price,
      condenser_dims: null,
      airhandler_dims: null,
      electrical: null,
      heat_kit_type: null,
      voltage_specs: null,
      warranty_level: row.Level,
      warranty_program: row.Program,
      labor_years: parseInt(row.Labor_Years, 10) || null,
      parts_years: parseInt(row.Parts_Years, 10) || null,
    };
  });
}

// ─── Main ────────────────────────────────────────────────────────

function main() {
  console.log('Seeding pricing metadata from CSVs...\n');

  const allItems = [];

  // Heat Pump
  allItems.push(...processSplitSystem(
    path.join(DOWNLOADS, 'BMB Price table - heat pump.csv'), 'heat_pump', 'HP'
  ));

  // AC
  allItems.push(...processSplitSystem(
    path.join(DOWNLOADS, 'BMB price table - AC.csv'), 'ac', 'AC'
  ));

  // Inverter
  allItems.push(...processInverter(
    path.join(DOWNLOADS, 'BMB Enterprises - Inverter Systems.csv')
  ));

  // Package Units
  allItems.push(...processPackageUnits(
    path.join(DOWNLOADS, 'BMB Enterprises - Package Units.csv')
  ));

  // Heat Kits
  allItems.push(...processHeatKits(
    path.join(DOWNLOADS, 'BMB Enterprises - Heat Kits.csv')
  ));

  // Warranty
  allItems.push(...processWarranty(
    path.join(DOWNLOADS, 'BMB Enterprises - System Shield Warranty.csv')
  ));

  // Summary
  const byCat = {};
  for (const item of allItems) {
    byCat[item.category] = (byCat[item.category] || 0) + 1;
  }
  console.log('\nSummary:');
  for (const [cat, count] of Object.entries(byCat)) {
    console.log(`  ${cat}: ${count} items`);
  }
  console.log(`  TOTAL: ${allItems.length} items`);

  // Ensure data directory exists
  const dataDir = path.dirname(OUTPUT);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  // Write seed file
  fs.writeFileSync(OUTPUT, JSON.stringify(allItems, null, 2));
  console.log(`\nWrote ${OUTPUT}`);
}

main();
