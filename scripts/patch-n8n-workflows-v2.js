#!/usr/bin/env node
/**
 * Patch v2:
 * 1. Pricing prompts — add product_name field to [QB_DATA] blocks
 * 2. Retell agent — update qb_item_name example + make it required
 * 3. Order workflow — already correct, just copy
 */
const fs = require('fs');
const path = require('path');

const DL = 'C:/Users/Devansh/Downloads';
const OUT = path.join(DL, 'update2');

// ─── 1. Patch Pricing Lookups ─────────────────────────────────

const pricing = JSON.parse(fs.readFileSync(path.join(DL, 'BMB Enterprises - All Pricing Lookups.json'), 'utf8'));

const QB_DATA_INSTRUCTION = `## STRUCTURED DATA OUTPUT (CRITICAL)
After your voice-friendly response, you MUST append a structured data block on a new line. This block will be parsed by the ordering system to match the exact QuickBooks inventory item. The customer will NOT hear this part — it is for internal system use only.

Format:
[QB_DATA]{"item_name":"<EXACT value from QB_Item_Name column>","product_name":"<human-readable description e.g. 2-Ton 14.3 SEER2 Heat Pump Good (PSC)>","unit_price":<number>,"indoor_model":"<indoor unit model number>","outdoor_model":"<outdoor unit model number>","ahri":"<AHRI reference number>","tier":"<Good|Better|Best>"}[/QB_DATA]

Rules:
- "item_name" MUST be copied EXACTLY from the QB_Item_Name column in the data table — do NOT construct, abbreviate, or modify it. This is the QuickBooks inventory name.
- "product_name" is a natural, human-readable name for the product (e.g. "2-Ton 14.3 SEER2 Heat Pump Good (PSC)"). This is what the customer hears and what shows in Slack notifications.
- Include one [QB_DATA] block for EACH option/tier you present
- If presenting Good/Better/Best, include three [QB_DATA] blocks, one per tier
- unit_price must be a number with no dollar sign or commas
- If a field is not applicable (e.g., no indoor model for package units), use an empty string
- NEVER read the [QB_DATA] blocks aloud — they are invisible to the customer`;

const EXAMPLES = {
  'Heat Pump': `Example:
"For a 2-ton heat pump, your standard option runs twenty-nine eighty-nine..."
[QB_DATA]{"item_name":"2T 14.3 S2 HP Gd-7AH1AC24PX","product_name":"2-Ton 14.3 SEER2 Heat Pump Good (PSC)","unit_price":2989,"indoor_model":"7AH1AC24PX-71","outdoor_model":"7HP14F24P","ahri":"215710943","tier":"Good"}[/QB_DATA]
[QB_DATA]{"item_name":"2T 15.5 S2 HP Bst-7AH1AV30PX","product_name":"2-Ton 15.5 SEER2 Heat Pump Best (Variable Speed)","unit_price":3644,"indoor_model":"7AH1AV30PX-71","outdoor_model":"7HP14F24P","ahri":"215710948","tier":"Best"}[/QB_DATA]`,

  'AC': `Example:
"For a 2-ton AC, your standard option runs twenty-nine thirty-three..."
[QB_DATA]{"item_name":"2T 15.5 S2 AC Gd-7AH1AC24PX","product_name":"2-Ton 15.5 SEER2 AC Good (PSC)","unit_price":2933,"indoor_model":"7AH1AC24PX-71","outdoor_model":"7AC14F24P","ahri":"215595155","tier":"Good"}[/QB_DATA]
[QB_DATA]{"item_name":"2T 16 S2 AC Bst-7AH1AV24PX","product_name":"2-Ton 16 SEER2 AC Best (Variable Speed)","unit_price":3391,"indoor_model":"7AH1AV24PX-71","outdoor_model":"7AC14F24P","ahri":"215595158","tier":"Best"}[/QB_DATA]`,

  'Inverter': `Example:
"For a 2-ton inverter heat pump, the standard option runs fifty-seven fifty-two..."
[QB_DATA]{"item_name":"2-Ton 15.5 S2 Inv HP-Gd (PSC)","product_name":"2-Ton 15.5 SEER2 Inverter Heat Pump Good (PSC)","unit_price":5752,"indoor_model":"7AH1AC30PX-71","outdoor_model":"7HP19V36P","ahri":"217455593","tier":"Good"}[/QB_DATA]
[QB_DATA]{"item_name":"2-Ton 19 S2 Inv HP-Bst (VS)","product_name":"2-Ton 19 SEER2 Inverter Heat Pump Best (Variable Speed)","unit_price":6159,"indoor_model":"7AH1AV24PX-71","outdoor_model":"7HP19V36P","ahri":"217202436","tier":"Best"}[/QB_DATA]`,

  'Package': `Example:
"For a 3-ton package AC, that runs forty forty-six..."
[QB_DATA]{"item_name":"3T 13.4 S2 Pkg AC-RPACE-71336P","product_name":"3-Ton 13.4 SEER2 Package AC RPACE-71336P","unit_price":4046,"indoor_model":"","outdoor_model":"RPACE-71336P","ahri":"216763326","tier":""}[/QB_DATA]`,

  'Heat Kit': `Example:
"The 5 kW split system heat kit runs one twenty-nine..."
[QB_DATA]{"item_name":"Heat Kit-ECB45-5-P (SS)","product_name":"Heat Kit ECB45-5-P Split System 4.4 KW","unit_price":129,"indoor_model":"ECB45-5-P","outdoor_model":"","ahri":"","tier":""}[/QB_DATA]`,

  'Warranty': `Example:
"The 5-year labor plus 10-year parts plan runs three hundred per system..."
[QB_DATA]{"item_name":"SystemShield Level B","product_name":"SystemShield 5 Year Labor + 10 Year Parts","unit_price":300,"indoor_model":"","outdoor_model":"","ahri":"","tier":"B"}[/QB_DATA]`
};

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

  const oldPattern = /## STRUCTURED DATA OUTPUT \(CRITICAL\)[\s\S]*?(?=\n## NOTES|\n## (?:SPECIAL|WARRANTY)|$)/;
  const replacement = QB_DATA_INSTRUCTION + '\n' + (EXAMPLES[productType] || '') + '\n\n';

  if (oldPattern.test(sysMsg)) {
    node.parameters.options.systemMessage = sysMsg.replace(oldPattern, replacement);
    patchedCount++;
    console.log(`Patched pricing: ${node.name}`);
  }
}

fs.writeFileSync(path.join(OUT, 'BMB Enterprises - All Pricing Lookups.json'), JSON.stringify(pricing, null, 2));
console.log(`Pricing: ${patchedCount}/6 agents patched\n`);

// ─── 2. Patch Retell Agent ────────────────────────────────────

const retell = JSON.parse(fs.readFileSync(path.join(DL, 'inbound agent v4 (with quickbooks Desktop).json'), 'utf8'));
const orderTool = retell.retellLlmData.general_tools.find(t => t.name === 'create_quickbooks_order');

// Update qb_item_name description with correct example
orderTool.parameters.properties.qb_item_name.description =
  "The exact QuickBooks item name from the pricing lookup response (found in the [QB_DATA] block 'item_name' field). This is the abbreviated QB inventory name, NOT the full product name. e.g., '2T 14.3 S2 HP Gd-7AH1AC24PX' or 'Heat Kit-ECB45-5-P (SS)'";

// Add product_name to required if not there, and make qb_item_name required
if (!orderTool.parameters.required.includes('qb_item_name')) {
  orderTool.parameters.required.push('qb_item_name');
  console.log('Retell: Added qb_item_name to required params');
}

// Update the Retell prompt Phase 5 to mention both product_name and qb_item_name
const prompt = retell.retellLlmData.general_prompt;
const oldPhase5Extract = `- qb_item_name: The item_name value from the [QB_DATA] block matching the customer's selected tier`;
const newPhase5Extract = `- qb_item_name: The item_name value from the [QB_DATA] block matching the customer's selected tier (this is the abbreviated QB name like "2T 14.3 S2 HP Gd-7AH1AC24PX" — do NOT speak this to the customer)
  - product_name: The product_name value from the [QB_DATA] block (this is the human-readable name like "2-Ton 14.3 SEER2 Heat Pump Good")`;

if (prompt.includes(oldPhase5Extract)) {
  retell.retellLlmData.general_prompt = prompt.replace(oldPhase5Extract, newPhase5Extract);
  console.log('Retell: Updated Phase 5 instructions for qb_item_name + product_name');
} else {
  console.log('Retell: Phase 5 extract text not found, checking alternate...');
  // Try a broader match
  const altOld = 'qb_item_name: The item_name value from the [QB_DATA] block matching the customer\'s selected tier';
  if (prompt.includes(altOld)) {
    retell.retellLlmData.general_prompt = prompt.replace(altOld,
      'qb_item_name: The item_name value from the [QB_DATA] block matching the customer\'s selected tier (this is the abbreviated QB name like "2T 14.3 S2 HP Gd-7AH1AC24PX" — do NOT speak this to the customer)\n  - product_name: The product_name value from the [QB_DATA] block (this is the human-readable name like "2-Ton 14.3 SEER2 Heat Pump Good")');
    console.log('Retell: Updated Phase 5 (alt match)');
  } else {
    console.log('Retell: WARNING - could not find Phase 5 qb_item_name instruction to update');
  }
}

fs.writeFileSync(path.join(OUT, 'inbound agent v4 (with quickbooks Desktop).json'), JSON.stringify(retell, null, 2));
console.log('Retell agent: saved\n');

// ─── 3. Copy Order Workflow (already fixed in v1) ─────────────

const orderPath = path.join(DL, 'BMB Enterprises - Create QuickBooks Desktop Order.json');
const order = JSON.parse(fs.readFileSync(orderPath, 'utf8'));
const orderStr = JSON.stringify(order);
const fixed = orderStr.replace(/bmb-quickbooks-integration-production-c1b1\.up\.railway\.app/g,
  'bmb-quickbooks-integration-production-50b4.up.railway.app');
fs.writeFileSync(path.join(OUT, 'BMB Enterprises - Create QuickBooks Desktop Order.json'), fixed);
console.log('Order workflow: URL fixed, saved');

console.log('\n=== All files in: ' + OUT + ' ===');
