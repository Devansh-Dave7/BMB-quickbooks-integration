#!/usr/bin/env node
/**
 * Patch n8n workflow JSONs:
 * 1. Update all 6 pricing agent system prompts to use QB_Item_Name column
 * 2. Fix Railway URL in order creation workflow
 */
const fs = require('fs');
const path = require('path');

const DOWNLOADS = 'C:/Users/Devansh/Downloads';
const OUTPUT = path.join(DOWNLOADS, 'updated');

if (!fs.existsSync(OUTPUT)) fs.mkdirSync(OUTPUT, { recursive: true });

// ─── 1. Patch Pricing Lookups Workflow ────────────────────────

const pricingPath = path.join(DOWNLOADS, 'BMB Enterprises - All Pricing Lookups.json');
const pricing = JSON.parse(fs.readFileSync(pricingPath, 'utf8'));

// The QB_DATA instruction block to inject into each system prompt
const QB_DATA_INSTRUCTION = `## STRUCTURED DATA OUTPUT (CRITICAL)
After your voice-friendly response, you MUST append a structured data block on a new line. This block will be parsed by the ordering system to match the exact QuickBooks inventory item. The customer will not hear this part.

Format:
[QB_DATA]{"item_name":"<EXACT value from QB_Item_Name column>","unit_price":<number>,"indoor_model":"<indoor unit model number>","outdoor_model":"<outdoor unit model number>","ahri":"<AHRI reference number>","tier":"<Good|Better|Best>"}[/QB_DATA]

Rules:
- The "item_name" MUST be copied EXACTLY from the QB_Item_Name column in the data table — do NOT construct, abbreviate, or modify it in any way
- Include one [QB_DATA] block for EACH option/tier you present
- If presenting Good/Better/Best, include three [QB_DATA] blocks, one per tier
- unit_price must be a number with no dollar sign or commas
- If a field is not applicable (e.g., no indoor model for package units), use an empty string`;

// Examples per product type
const EXAMPLES = {
  'Heat Pump': `Example:
"For a 2-ton heat pump, your standard option runs twenty-nine eighty-nine with AHRI reference two-fifteen, seven-ten, nine-forty-three..."
[QB_DATA]{"item_name":"2T 14.3 S2 HP Gd-7AH1AC24PX","unit_price":2989,"indoor_model":"7AH1AC24PX-71","outdoor_model":"7HP14F24P","ahri":"215710943","tier":"Good"}[/QB_DATA]
[QB_DATA]{"item_name":"2T 15.5 S2 HP Bst-7AH1AV30PX","unit_price":3644,"indoor_model":"7AH1AV30PX-71","outdoor_model":"7HP14F24P","ahri":"215710948","tier":"Best"}[/QB_DATA]`,

  'AC': `Example:
"For a 2-ton AC, your standard option runs twenty-nine thirty-three with AHRI reference two-fifteen, five-ninety-five, one-fifty-five..."
[QB_DATA]{"item_name":"2T 15.5 S2 AC Gd-7AH1AC24PX","unit_price":2933,"indoor_model":"7AH1AC24PX-71","outdoor_model":"7AC14F24P","ahri":"215595155","tier":"Good"}[/QB_DATA]
[QB_DATA]{"item_name":"2T 16 S2 AC Bst-7AH1AV24PX","unit_price":3391,"indoor_model":"7AH1AV24PX-71","outdoor_model":"7AC14F24P","ahri":"215595158","tier":"Best"}[/QB_DATA]`,

  'Inverter': `Example:
"For a 2-ton inverter heat pump, the standard option runs fifty-seven fifty-two..."
[QB_DATA]{"item_name":"2-Ton 15.5 S2 Inv HP-Gd (PSC)","unit_price":5752,"indoor_model":"7AH1AC30PX-71","outdoor_model":"7HP19V36P","ahri":"217455593","tier":"Good"}[/QB_DATA]
[QB_DATA]{"item_name":"2-Ton 19 S2 Inv HP-Bst (VS)","unit_price":6159,"indoor_model":"7AH1AV24PX-71","outdoor_model":"7HP19V36P","ahri":"217202436","tier":"Best"}[/QB_DATA]`,

  'Package': `Example:
"For a 3-ton package AC, that runs forty forty-six..."
[QB_DATA]{"item_name":"3T 13.4 S2 Pkg AC-RPACE-71336P","unit_price":4046,"indoor_model":"","outdoor_model":"RPACE-71336P","ahri":"216763326","tier":""}[/QB_DATA]`,

  'Heat Kit': `Example:
"The 5 kW split system heat kit runs one twenty-nine..."
[QB_DATA]{"item_name":"Heat Kit-ECB45-5-P (SS)","unit_price":129,"indoor_model":"ECB45-5-P","outdoor_model":"","ahri":"","tier":""}[/QB_DATA]`,

  'Warranty': `Example:
"The 5-year labor plus 10-year parts plan runs three hundred per system..."
[QB_DATA]{"item_name":"SystemShield Level B","unit_price":300,"indoor_model":"","outdoor_model":"","ahri":"","tier":"B"}[/QB_DATA]`
};

// Map agent node names to product types
const AGENT_TYPE_MAP = {
  'AI Agent - Heat Pump1': 'Heat Pump',
  'AI Agent - AC1': 'AC',
  'AI Agent - Inverter1': 'Inverter',
  'AI Agent - Package Units1': 'Package',
  'AI Agent - Heat Kits1': 'Heat Kit',
  'AI Agent - Warranty1': 'Warranty',
};

let patchedCount = 0;

for (const node of pricing.nodes) {
  const productType = AGENT_TYPE_MAP[node.name];
  if (!productType) continue;

  const sysMsg = node.parameters?.options?.systemMessage;
  if (!sysMsg) continue;

  // Replace the existing STRUCTURED DATA OUTPUT section
  const oldPattern = /## STRUCTURED DATA OUTPUT \(CRITICAL\)[\s\S]*?(?=\n## NOTES|\n## (?:SPECIAL|WARRANTY)|$)/;
  const replacement = QB_DATA_INSTRUCTION + '\n' + (EXAMPLES[productType] || '') + '\n\n';

  if (oldPattern.test(sysMsg)) {
    node.parameters.options.systemMessage = sysMsg.replace(oldPattern, replacement);
    patchedCount++;
    console.log(`Patched: ${node.name} (${productType})`);
  } else {
    console.warn(`WARNING: Could not find STRUCTURED DATA section in ${node.name}`);
  }
}

fs.writeFileSync(
  path.join(OUTPUT, 'BMB Enterprises - All Pricing Lookups.json'),
  JSON.stringify(pricing, null, 2)
);
console.log(`\nPricing workflow: ${patchedCount}/6 agents patched`);

// ─── 2. Patch Order Creation Workflow ─────────────────────────

const orderPath = path.join(DOWNLOADS, 'BMB Enterprises - Create QuickBooks Desktop Order.json');
const order = JSON.parse(fs.readFileSync(orderPath, 'utf8'));

let urlFixed = false;
const oldUrl = 'bmb-quickbooks-integration-production-c1b1.up.railway.app';
const newUrl = 'bmb-quickbooks-integration-production-50b4.up.railway.app';

const orderStr = JSON.stringify(order);
if (orderStr.includes(oldUrl)) {
  const fixed = JSON.parse(orderStr.replace(new RegExp(oldUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), newUrl));
  fs.writeFileSync(
    path.join(OUTPUT, 'BMB Enterprises - Create QuickBooks Desktop Order.json'),
    JSON.stringify(fixed, null, 2)
  );
  urlFixed = true;
  console.log(`\nOrder workflow: Railway URL fixed (c1b1 → 50b4)`);
} else {
  fs.writeFileSync(
    path.join(OUTPUT, 'BMB Enterprises - Create QuickBooks Desktop Order.json'),
    JSON.stringify(order, null, 2)
  );
  console.log(`\nOrder workflow: URL already correct`);
}

console.log('\n=== All workflows patched ===');
console.log(`Output: ${OUTPUT}`);
