#!/usr/bin/env node
/**
 * Patch: Add is_new_customer support to Retell agent + n8n order workflow.
 *
 * 1. Retell agent — add is_new_customer to create_quickbooks_order tool + Phase 5 prompt
 * 2. n8n order workflow — forward is_new_customer + customer details in orderPayload
 *
 * Usage: node scripts/patch-new-customer.js
 * Outputs patched files to ~/Downloads/update-new-customer/
 */
const fs = require('fs');
const path = require('path');

const DL = 'C:/Users/Devansh/Downloads';
const OUT = path.join(DL, 'update-new-customer');

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

// ─── 1. Patch Retell Agent ──────────────────────────────────────

const agentFile = path.join(DL, 'inbound agent v4 (with quickbooks Desktop).json');
const agent = JSON.parse(fs.readFileSync(agentFile, 'utf8'));

// Find the create_quickbooks_order tool (tools live in retellLlmData.general_tools)
const toolsList = (agent.retellLlmData && agent.retellLlmData.general_tools) || agent.tools || [];
const orderTool = toolsList.find(
  (t) => t.name === 'create_quickbooks_order'
);

if (!orderTool) {
  console.error('ERROR: create_quickbooks_order tool not found in agent');
  process.exit(1);
}

// Get the parameters object (handle both Retell schema shapes)
const params = orderTool.parameters || (orderTool.function && orderTool.function.parameters);
if (!params || !params.properties) {
  console.error('ERROR: Could not find parameters.properties on create_quickbooks_order');
  process.exit(1);
}

// Add is_new_customer parameter
params.properties.is_new_customer = {
  type: 'boolean',
  description: 'Set to true if this is a new customer (contactId is empty). Set to false if the customer already exists in the system.',
};

// Add to required array
if (params.required && !params.required.includes('is_new_customer')) {
  params.required.push('is_new_customer');
}

// Patch the general_prompt — add is_new_customer instruction to Phase 5
const IS_NEW_INSTRUCTION = `\n  - is_new_customer: Set to true if {{contactId}} is empty (new prospect), false if contactId has a value (existing customer)`;

const promptObj = agent.retellLlmData || agent;
if (promptObj.general_prompt && !promptObj.general_prompt.includes('is_new_customer')) {
  // Insert after the is_urgent line in the execution section
  promptObj.general_prompt = promptObj.general_prompt.replace(
    /- is_urgent: Set to true ONLY if the customer mentioned a system is down/,
    `- is_urgent: Set to true ONLY if the customer mentioned a system is down${IS_NEW_INSTRUCTION}`
  );
}

const agentOut = path.join(OUT, 'inbound agent v4 (with quickbooks Desktop).json');
fs.writeFileSync(agentOut, JSON.stringify(agent, null, 2));
console.log(`✓ Retell agent patched → ${agentOut}`);

// ─── 2. Patch n8n Order Workflow ────────────────────────────────

const workflowFile = path.join(DL, 'BMB Enterprises - Create QuickBooks Desktop Order.json');
const workflow = JSON.parse(fs.readFileSync(workflowFile, 'utf8'));

// Find the "Build Order Payload" node
const buildNode = workflow.nodes.find(
  (n) => n.name === 'Build Order Payload' || (n.parameters && n.parameters.jsCode && n.parameters.jsCode.includes('orderPayload'))
);

if (!buildNode) {
  console.error('ERROR: Build Order Payload node not found in workflow');
  process.exit(1);
}

const codeField = buildNode.parameters.jsCode !== undefined ? 'jsCode' : 'code';
let code = buildNode.parameters[codeField];

if (!code.includes('is_new_customer')) {
  // Add is_new_customer + customer details to the orderPayload object
  code = code.replace(
    /const orderPayload = \{/,
    `// Determine if new customer (contactId empty = new prospect)
const isNewCustomer = args.is_new_customer || false;

const orderPayload = {`
  );

  // Insert new fields into orderPayload after items array
  code = code.replace(
    /items: \[\{[\s\S]*?\}\]\s*\}/,
    (match) => {
      // Remove the trailing } and add new fields
      const withoutClose = match.slice(0, -1);
      return `${withoutClose},
  is_new_customer: isNewCustomer,
  company_name: customerCompany,
  customer_phone: args.customer_phone || '',
  customer_email: args.customer_email || '',
  first_name: firstName,
  last_name: lastName
}`;
    }
  );

  buildNode.parameters[codeField] = code;
}

const workflowOut = path.join(OUT, 'BMB Enterprises - Create QuickBooks Desktop Order.json');
fs.writeFileSync(workflowOut, JSON.stringify(workflow, null, 2));
console.log(`✓ n8n order workflow patched → ${workflowOut}`);

console.log('\n── Done ──');
console.log('Next steps:');
console.log('  1. Import the patched Retell agent JSON into Retell');
console.log('  2. Import the patched n8n workflow JSON into n8n');
console.log('  3. Deploy the QBWC server (it already has the server-side changes)');
