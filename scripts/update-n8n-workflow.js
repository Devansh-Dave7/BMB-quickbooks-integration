#!/usr/bin/env node
/**
 * Update the n8n pricing workflow system prompts to use correct QB_Item_Name values.
 * Reads the original workflow JSON, patches the [QB_DATA] examples and instructions,
 * writes the updated workflow to Downloads/updated/.
 */

const fs = require('fs');

const wf = JSON.parse(fs.readFileSync(
  'c:/Users/Devansh/Downloads/BMB Enterprises - All Pricing Lookups.json', 'utf8'
));

// ─── Replacement map for system prompt examples ──────────────────

const replacements = {
  // Heat Pump agent
  'AI Agent - Heat Pump1': {
    // Old example → new example in the [QB_DATA] section
    oldExample: `Example:\n\"For a 2-ton heat pump, your first option runs twenty-two sixty-nine with AHRI reference 12345678...\"\n[QB_DATA]{\"item_name\":\"2T 14.3 SEER2 HP Good - 7AH1AC24PX-71\",\"unit_price\":2269,\"indoor_model\":\"7AH1AC24PX-71\",\"outdoor_model\":\"7HP14F024P-71\",\"ahri\":\"12345678\",\"tier\":\"Good\"}[/QB_DATA]\n[QB_DATA]{\"item_name\":\"2T 15.2 SEER2 HP Better - 7AH1AE24PX-71\",\"unit_price\":2489,\"indoor_model\":\"7AH1AE24PX-71\",\"outdoor_model\":\"7HP14F024P-71\",\"ahri\":\"12345679\",\"tier\":\"Better\"}[/QB_DATA]\n[QB_DATA]{\"item_name\":\"2T 16.5 SEER2 HP Best - 7AH1AV24PX-71\",\"unit_price\":2889,\"indoor_model\":\"7AH1AV24PX-71\",\"outdoor_model\":\"7HP14F024P-71\",\"ahri\":\"12345680\",\"tier\":\"Best\"}[/QB_DATA]`,
    newExample: `Example:\n\"For a 2-ton heat pump, your standard option runs twenty-nine eighty-nine with AHRI reference 215710943...\"\n[QB_DATA]{\"item_name\":\"2T 14.3 S2 HP Gd-7AH1AC24PX\",\"unit_price\":2989,\"indoor_model\":\"7AH1AC24PX-71\",\"outdoor_model\":\"7HP14F24P\",\"ahri\":\"215710943\",\"tier\":\"Good\"}[/QB_DATA]\n[QB_DATA]{\"item_name\":\"2T 14.7 S2 HP Bst-7AH1AV24PX\",\"unit_price\":3447,\"indoor_model\":\"7AH1AV24PX-71\",\"outdoor_model\":\"7HP14F24P\",\"ahri\":\"215710947\",\"tier\":\"Best\"}[/QB_DATA]`,
    // Also update the instruction about item_name source
    oldInstruction: `- The \"item_name\" MUST match the EXACT item name as it appears in the pricing table — do not paraphrase or reformat it`,
    newInstruction: `- The \"item_name\" MUST use the value from the QB_Item_Name column in the pricing table — this is the exact name as it exists in QuickBooks Desktop. Do NOT construct or paraphrase it`,
  },

  // AC agent
  'AI Agent - AC1': {
    oldExample: `Example:\n\"For a 2-ton AC, your first option runs twenty-one forty-nine with AHRI reference 12345678...\"\n[QB_DATA]{\"item_name\":\"2T 14.3 SEER2 AC Good - 7AH1AC24PX-71\",\"unit_price\":2149,\"indoor_model\":\"7AH1AC24PX-71\",\"outdoor_model\":\"7AC14F024P-71\",\"ahri\":\"12345678\",\"tier\":\"Good\"}[/QB_DATA]\n[QB_DATA]{\"item_name\":\"2T 15.5 SEER2 AC Better - 7AH1AE24PX-71\",\"unit_price\":2349,\"indoor_model\":\"7AH1AE24PX-71\",\"outdoor_model\":\"7AC14F024P-71\",\"ahri\":\"12345679\",\"tier\":\"Better\"}[/QB_DATA]\n[QB_DATA]{\"item_name\":\"2T 16.5 SEER2 AC Best - 7AH1AV24PX-71\",\"unit_price\":2749,\"indoor_model\":\"7AH1AV24PX-71\",\"outdoor_model\":\"7AC14F024P-71\",\"ahri\":\"12345680\",\"tier\":\"Best\"}[/QB_DATA]`,
    newExample: `Example:\n\"For a 2-ton AC, your standard option runs twenty-nine thirty-three with AHRI reference 215595155...\"\n[QB_DATA]{\"item_name\":\"2T 15.5 S2 AC Gd-7AH1AC24PX\",\"unit_price\":2933,\"indoor_model\":\"7AH1AC24PX-71\",\"outdoor_model\":\"7AC14F24P\",\"ahri\":\"215595155\",\"tier\":\"Good\"}[/QB_DATA]\n[QB_DATA]{\"item_name\":\"2T 16 S2 AC Bst-7AH1AV24PX\",\"unit_price\":3391,\"indoor_model\":\"7AH1AV24PX-71\",\"outdoor_model\":\"7AC14F24P\",\"ahri\":\"215595158\",\"tier\":\"Best\"}[/QB_DATA]`,
    oldInstruction: `- The \"item_name\" MUST match the EXACT item name as it appears in the pricing table — do not paraphrase or reformat it`,
    newInstruction: `- The \"item_name\" MUST use the value from the QB_Item_Name column in the pricing table — this is the exact name as it exists in QuickBooks Desktop. Do NOT construct or paraphrase it`,
  },

  // Inverter agent
  'AI Agent - Inverter1': {
    oldExample: `Example:\n\"For a 2-ton inverter heat pump, it runs thirty-four ninety-nine with AHRI reference 12345678...\"\n[QB_DATA]{\"item_name\":\"2-Ton 15.5 SEER2 Inverter HP - Good (PSC)\",\"unit_price\":3499,\"indoor_model\":\"7AH1AC24PX-71\",\"outdoor_model\":\"7HP19V024P-71\",\"ahri\":\"12345678\",\"tier\":\"Good\"}[/QB_DATA]`,
    newExample: `Example:\n\"For a 2-ton inverter heat pump, the standard option runs fifty-seven fifty-two with AHRI reference 217455593...\"\n[QB_DATA]{\"item_name\":\"2-Ton 15.5 S2 Inv HP-Gd (PSC)\",\"unit_price\":5752,\"indoor_model\":\"7AH1AC30PX-71\",\"outdoor_model\":\"7HP19V36P\",\"ahri\":\"217455593\",\"tier\":\"Good\"}[/QB_DATA]\n[QB_DATA]{\"item_name\":\"2-Ton 19 S2 Inv HP-Bst (VS)\",\"unit_price\":6159,\"indoor_model\":\"7AH1AV24PX-71\",\"outdoor_model\":\"7HP19V36P\",\"ahri\":\"217202436\",\"tier\":\"Best\"}[/QB_DATA]`,
    oldInstruction: `- The \"item_name\" MUST match the EXACT item name as it appears in the pricing table — do not paraphrase or reformat it`,
    newInstruction: `- The \"item_name\" MUST use the value from the QB_Item_Name column in the pricing table — this is the exact name as it exists in QuickBooks Desktop. Do NOT construct or paraphrase it`,
  },

  // Package Units agent
  'AI Agent - Package Units1': {
    oldExample: `Example:\n\"For a 3-ton package heat pump, it runs thirty-seven fifty with model number RPHPE-71336P...\"\n[QB_DATA]{\"item_name\":\"3T 13.4 SEER2 Pkg HP - RPHPE-71336P\",\"unit_price\":3750,\"indoor_model\":\"\",\"outdoor_model\":\"RPHPE-71336P\",\"ahri\":\"\",\"tier\":\"\"}[/QB_DATA]`,
    newExample: `Example:\n\"For a 3-ton package heat pump, it runs fifty-oh-twenty with model number RPHPE-71336P...\"\n[QB_DATA]{\"item_name\":\"3T 13.4 S2 Pkg HP-RPHPE-71336P\",\"unit_price\":5020,\"indoor_model\":\"\",\"outdoor_model\":\"RPHPE-71336P\",\"ahri\":\"216765768\",\"tier\":\"\"}[/QB_DATA]`,
    oldInstruction: `- The \"item_name\" MUST match the EXACT item name as it appears in the pricing table — do not paraphrase or reformat it`,
    newInstruction: `- The \"item_name\" MUST use the value from the QB_Item_Name column in the pricing table — this is the exact name as it exists in QuickBooks Desktop. Do NOT construct or paraphrase it`,
  },

  // Heat Kits agent
  'AI Agent - Heat Kits1': {
    oldExample: `Example:\n\"For a seven and a half kW split system heat kit without the breaker, it's one sixty-nine...\"\n[QB_DATA]{\"item_name\":\"Heat Kit - ECB45-7.5-P (Split System)\",\"unit_price\":169,\"indoor_model\":\"ECB45-7.5-P\",\"outdoor_model\":\"\",\"ahri\":\"\",\"tier\":\"\"}[/QB_DATA]`,
    newExample: `Example:\n\"For a seven and a half kW split system heat kit without the breaker, it's one fifty-nine...\"\n[QB_DATA]{\"item_name\":\"Heat Kit-ECB45-7.5-P (SS)\",\"unit_price\":159,\"indoor_model\":\"ECB45-7.5-P\",\"outdoor_model\":\"\",\"ahri\":\"\",\"tier\":\"\"}[/QB_DATA]`,
    oldInstruction: `- The \"item_name\" MUST match the EXACT item name as it appears in the pricing table — do not paraphrase or reformat it`,
    newInstruction: `- The \"item_name\" MUST use the value from the QB_Item_Name column in the pricing table — this is the exact name as it exists in QuickBooks Desktop. Do NOT construct or paraphrase it`,
  },

  // Warranty agent
  'AI Agent - Warranty1': {
    oldExample: `Example:\n\"Plan B gives you five years of labor plus ten years of parts coverage for three hundred dollars...\"\n[QB_DATA]{\"item_name\":\"System Shield Warranty - Level B (5 Year Labor + 10 Year Parts)\",\"unit_price\":300,\"indoor_model\":\"\",\"outdoor_model\":\"\",\"ahri\":\"\",\"tier\":\"B\"}[/QB_DATA]`,
    newExample: `Example:\n\"Plan B gives you five years of labor plus ten years of parts coverage for three hundred dollars...\"\n[QB_DATA]{\"item_name\":\"SystemShield Warranty-Lvl B\",\"unit_price\":300,\"indoor_model\":\"\",\"outdoor_model\":\"\",\"ahri\":\"\",\"tier\":\"B\"}[/QB_DATA]`,
    oldInstruction: `- The \"item_name\" MUST match the EXACT item name as it appears in the pricing table — do not paraphrase or reformat it`,
    newInstruction: `- The \"item_name\" MUST use the value from the QB_Item_Name column in the pricing table (if available) — this is the exact name as it exists in QuickBooks Desktop. For warranty plans (service items), use the Program name as-is since they are not inventory items`,
  },
};

// ─── Apply replacements ──────────────────────────────────────────

let patchCount = 0;

for (const node of wf.nodes) {
  const patches = replacements[node.name];
  if (!patches) continue;

  const sysMsg = node.parameters?.options?.systemMessage;
  if (!sysMsg) {
    console.log(`WARNING: No systemMessage found for ${node.name}`);
    continue;
  }

  let updated = sysMsg;

  // Replace example
  if (patches.oldExample && updated.includes(patches.oldExample)) {
    updated = updated.replace(patches.oldExample, patches.newExample);
    patchCount++;
    console.log(`Patched example in: ${node.name}`);
  } else if (patches.oldExample) {
    console.log(`WARNING: Could not find old example in ${node.name} — skipping example patch`);
  }

  // Replace instruction
  if (patches.oldInstruction && updated.includes(patches.oldInstruction)) {
    updated = updated.replace(patches.oldInstruction, patches.newInstruction);
    patchCount++;
    console.log(`Patched instruction in: ${node.name}`);
  } else if (patches.oldInstruction) {
    console.log(`WARNING: Could not find old instruction in ${node.name} — skipping instruction patch`);
  }

  node.parameters.options.systemMessage = updated;
}

console.log(`\nTotal patches applied: ${patchCount}`);

// ─── Write updated workflow ──────────────────────────────────────

const outPath = 'c:/Users/Devansh/Downloads/updated/BMB Enterprises - All Pricing Lookups.json';
fs.writeFileSync(outPath, JSON.stringify(wf, null, 2));
console.log(`Updated workflow written to: ${outPath}`);
