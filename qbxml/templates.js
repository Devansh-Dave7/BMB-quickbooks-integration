const { wrapInEnvelope } = require('./envelope');

/**
 * Escape XML special characters.
 */
function escXml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ─── Customer Queries ───────────────────────────────────────────

/**
 * Build a CustomerQueryRq.
 * params.fullName  — exact customer full name
 * params.nameFilter — { matchCriterion: 'StartsWith'|'Contains'|'EndsWith', name: '...' }
 * params.activeStatus — 'ActiveOnly' | 'InactiveOnly' | 'All' (default: ActiveOnly)
 * params.maxReturned — max results (default: 500)
 */
function buildCustomerQuery(params = {}) {
  const parts = ['<CustomerQueryRq>'];

  if (params.fullName) {
    parts.push(`  <FullName>${escXml(params.fullName)}</FullName>`);
  } else {
    parts.push(`  <MaxReturned>${parseInt(params.maxReturned, 10) || 500}</MaxReturned>`);
    parts.push(`  <ActiveStatus>${escXml(params.activeStatus || 'ActiveOnly')}</ActiveStatus>`);
    if (params.nameFilter) {
      parts.push('  <NameFilter>');
      parts.push(`    <MatchCriterion>${escXml(params.nameFilter.matchCriterion || 'Contains')}</MatchCriterion>`);
      parts.push(`    <Name>${escXml(params.nameFilter.name)}</Name>`);
      parts.push('  </NameFilter>');
    }
  }

  parts.push('</CustomerQueryRq>');

  return wrapInEnvelope(parts.join('\n    '));
}

// ─── Item Queries ───────────────────────────────────────────────

/**
 * Build an ItemQueryRq (queries all item types).
 * params.fullName — exact item full name
 * params.nameFilter — { matchCriterion, name }
 * params.activeStatus — default 'ActiveOnly'
 * params.maxReturned — default 500
 */
function buildItemQuery(params = {}) {
  const parts = ['<ItemQueryRq>'];

  if (params.fullName) {
    parts.push(`  <FullName>${escXml(params.fullName)}</FullName>`);
  } else {
    parts.push(`  <MaxReturned>${parseInt(params.maxReturned, 10) || 500}</MaxReturned>`);
    parts.push(`  <ActiveStatus>${escXml(params.activeStatus || 'ActiveOnly')}</ActiveStatus>`);
    if (params.nameFilter) {
      parts.push('  <NameFilter>');
      parts.push(`    <MatchCriterion>${escXml(params.nameFilter.matchCriterion || 'Contains')}</MatchCriterion>`);
      parts.push(`    <Name>${escXml(params.nameFilter.name)}</Name>`);
      parts.push('  </NameFilter>');
    }
  }

  parts.push('</ItemQueryRq>');

  return wrapInEnvelope(parts.join('\n    '));
}

/**
 * Build an ItemInventoryQueryRq (inventory items only, includes QtyOnHand).
 * params.fullName — exact item full name
 * params.nameFilter — { matchCriterion, name }
 * params.activeStatus — default 'ActiveOnly'
 * params.maxReturned — default 500
 */
function buildItemInventoryQuery(params = {}) {
  const parts = ['<ItemInventoryQueryRq>'];

  if (params.fullName) {
    parts.push(`  <FullName>${escXml(params.fullName)}</FullName>`);
  } else {
    parts.push(`  <MaxReturned>${parseInt(params.maxReturned, 10) || 500}</MaxReturned>`);
    parts.push(`  <ActiveStatus>${escXml(params.activeStatus || 'ActiveOnly')}</ActiveStatus>`);
    if (params.nameFilter) {
      parts.push('  <NameFilter>');
      parts.push(`    <MatchCriterion>${escXml(params.nameFilter.matchCriterion || 'Contains')}</MatchCriterion>`);
      parts.push(`    <Name>${escXml(params.nameFilter.name)}</Name>`);
      parts.push('  </NameFilter>');
    }
  }

  parts.push('</ItemInventoryQueryRq>');

  return wrapInEnvelope(parts.join('\n    '));
}

// ─── Sales Order ────────────────────────────────────────────────

/**
 * Build a SalesOrderAddRq.
 * orderData.customerName — required, QB customer FullName
 * orderData.customerRef — optional, QB FullName path (e.g. 'AcmeCo:Main')
 * orderData.poNumber — optional PO number
 * orderData.memo — optional memo
 * orderData.items[] — { name, description, qty, rate }
 */
function buildSalesOrderAdd(orderData) {
  const parts = ['<SalesOrderAddRq>',  '  <SalesOrderAdd>'];

  // Customer reference
  parts.push('    <CustomerRef>');
  parts.push(`      <FullName>${escXml(orderData.customerRef || orderData.customerName)}</FullName>`);
  parts.push('    </CustomerRef>');

  if (orderData.poNumber) {
    parts.push(`    <PONumber>${escXml(orderData.poNumber)}</PONumber>`);
  }

  if (orderData.memo) {
    parts.push(`    <Memo>${escXml(orderData.memo)}</Memo>`);
  }

  // Line items
  for (const item of orderData.items) {
    parts.push('    <SalesOrderLineAdd>');
    parts.push('      <ItemRef>');
    parts.push(`        <FullName>${escXml(item.name)}</FullName>`);
    parts.push('      </ItemRef>');
    if (item.description) {
      parts.push(`      <Desc>${escXml(item.description)}</Desc>`);
    }
    parts.push(`      <Quantity>${Number(item.qty) || 1}</Quantity>`);
    if (item.rate != null) {
      parts.push(`      <Rate>${Number(item.rate).toFixed(2)}</Rate>`);
    }
    parts.push('    </SalesOrderLineAdd>');
  }

  parts.push('  </SalesOrderAdd>');
  parts.push('</SalesOrderAddRq>');

  return wrapInEnvelope(parts.join('\n    '));
}

/**
 * Build a SalesOrderQueryRq.
 * params.txnId — specific transaction ID
 * params.refNumber — specific reference/order number
 * params.customerFullName — filter by customer
 * params.maxReturned — default 50
 */
function buildSalesOrderQuery(params = {}) {
  const parts = ['<SalesOrderQueryRq>'];

  if (params.txnId) {
    parts.push(`  <TxnID>${escXml(params.txnId)}</TxnID>`);
  } else {
    if (params.refNumber) {
      parts.push(`  <RefNumber>${escXml(params.refNumber)}</RefNumber>`);
    }
    if (params.customerFullName) {
      parts.push('  <EntityFilter>');
      parts.push(`    <FullName>${escXml(params.customerFullName)}</FullName>`);
      parts.push('  </EntityFilter>');
    }
    parts.push(`  <MaxReturned>${parseInt(params.maxReturned, 10) || 50}</MaxReturned>`);
  }

  parts.push('</SalesOrderQueryRq>');

  return wrapInEnvelope(parts.join('\n    '));
}

// ─── Invoice ────────────────────────────────────────────────────

/**
 * Build an InvoiceAddRq.
 * invoiceData.customerName — required
 * invoiceData.customerRef — optional QB FullName path
 * invoiceData.poNumber — optional
 * invoiceData.memo — optional
 * invoiceData.items[] — { name, description, qty, rate }
 */
function buildInvoiceAdd(invoiceData) {
  const parts = ['<InvoiceAddRq>', '  <InvoiceAdd>'];

  parts.push('    <CustomerRef>');
  parts.push(`      <FullName>${escXml(invoiceData.customerRef || invoiceData.customerName)}</FullName>`);
  parts.push('    </CustomerRef>');

  if (invoiceData.poNumber) {
    parts.push(`    <PONumber>${escXml(invoiceData.poNumber)}</PONumber>`);
  }

  if (invoiceData.memo) {
    parts.push(`    <Memo>${escXml(invoiceData.memo)}</Memo>`);
  }

  for (const item of invoiceData.items) {
    parts.push('    <InvoiceLineAdd>');
    parts.push('      <ItemRef>');
    parts.push(`        <FullName>${escXml(item.name)}</FullName>`);
    parts.push('      </ItemRef>');
    if (item.description) {
      parts.push(`      <Desc>${escXml(item.description)}</Desc>`);
    }
    parts.push(`      <Quantity>${Number(item.qty) || 1}</Quantity>`);
    if (item.rate != null) {
      parts.push(`      <Rate>${Number(item.rate).toFixed(2)}</Rate>`);
    }
    parts.push('    </InvoiceLineAdd>');
  }

  parts.push('  </InvoiceAdd>');
  parts.push('</InvoiceAddRq>');

  return wrapInEnvelope(parts.join('\n    '));
}

/**
 * Build an InvoiceQueryRq.
 * params.txnId — specific transaction ID
 * params.refNumber — specific invoice number
 * params.customerFullName — filter by customer
 * params.maxReturned — default 50
 */
function buildInvoiceQuery(params = {}) {
  const parts = ['<InvoiceQueryRq>'];

  if (params.txnId) {
    parts.push(`  <TxnID>${escXml(params.txnId)}</TxnID>`);
  } else {
    if (params.refNumber) {
      parts.push(`  <RefNumber>${escXml(params.refNumber)}</RefNumber>`);
    }
    if (params.customerFullName) {
      parts.push('  <EntityFilter>');
      parts.push(`    <FullName>${escXml(params.customerFullName)}</FullName>`);
      parts.push('  </EntityFilter>');
    }
    parts.push(`  <MaxReturned>${parseInt(params.maxReturned, 10) || 50}</MaxReturned>`);
  }

  parts.push('</InvoiceQueryRq>');

  return wrapInEnvelope(parts.join('\n    '));
}

// ─── Inventory Item Add ─────────────────────────────────────────

const QB_NAME_MAX_LENGTH = 31;

/**
 * Build an ItemInventoryAddRq.
 * itemData.name — required, item name (truncated to 31 chars for QB)
 * itemData.sales_description — optional sales description
 * itemData.sales_price — required, sales price
 * itemData.income_account — income account (default: "Sales of Product Income")
 * itemData.purchase_description — optional purchase description
 * itemData.purchase_cost — required, purchase cost
 * itemData.cogs_account — COGS account (default: "Cost of Goods Sold")
 * itemData.asset_account — asset account (default: "Inventory Asset")
 * itemData.quantity_on_hand — qty on hand (default: 0)
 * itemData.reorder_point — optional reorder point
 * itemData.is_taxable — optional boolean
 * itemData.sku — optional SKU / barcode
 *
 * Returns { qbxml, warnings } where warnings contains truncation notices.
 */
function buildItemInventoryAdd(itemData) {
  const warnings = [];
  let name = String(itemData.name || '').trim();

  if (name.length > QB_NAME_MAX_LENGTH) {
    const original = name;
    name = name.substring(0, QB_NAME_MAX_LENGTH);
    warnings.push(`Name truncated from "${original}" to "${name}" (QB 31-char limit)`);
  }

  // qbXML elements MUST be in SDK-specified order
  const parts = ['<ItemInventoryAddRq>', '  <ItemInventoryAdd>'];

  // 1. Name (required)
  parts.push(`    <Name>${escXml(name)}</Name>`);

  // 2. SalesTaxCodeRef (optional — "Tax" or "Non" for US edition)
  if (itemData.is_taxable != null) {
    parts.push('    <SalesTaxCodeRef>');
    parts.push(`      <FullName>${itemData.is_taxable ? 'Tax' : 'Non'}</FullName>`);
    parts.push('    </SalesTaxCodeRef>');
  }

  // 3. SalesDesc
  if (itemData.sales_description) {
    parts.push(`    <SalesDesc>${escXml(itemData.sales_description)}</SalesDesc>`);
  }

  // 4. SalesPrice
  parts.push(`    <SalesPrice>${Number(itemData.sales_price).toFixed(2)}</SalesPrice>`);

  // 5. IncomeAccountRef (required)
  parts.push('    <IncomeAccountRef>');
  parts.push(`      <FullName>${escXml(itemData.income_account || 'Construction Income:Materials Income')}</FullName>`);
  parts.push('    </IncomeAccountRef>');

  // 6. PurchaseDesc
  if (itemData.purchase_description) {
    parts.push(`    <PurchaseDesc>${escXml(itemData.purchase_description)}</PurchaseDesc>`);
  }

  // 7. PurchaseCost
  parts.push(`    <PurchaseCost>${Number(itemData.purchase_cost).toFixed(2)}</PurchaseCost>`);

  // 8. COGSAccountRef (required)
  parts.push('    <COGSAccountRef>');
  parts.push(`      <FullName>${escXml(itemData.cogs_account || 'Cost of Goods Sold')}</FullName>`);
  parts.push('    </COGSAccountRef>');

  // 9. AssetAccountRef (required)
  parts.push('    <AssetAccountRef>');
  parts.push(`      <FullName>${escXml(itemData.asset_account || 'Inventory Asset')}</FullName>`);
  parts.push('    </AssetAccountRef>');

  // 10. ReorderPoint (optional — must come before QuantityOnHand)
  if (itemData.reorder_point != null) {
    parts.push(`    <ReorderPoint>${Number(itemData.reorder_point)}</ReorderPoint>`);
  }

  // 11. QuantityOnHand
  const qty = Number(itemData.quantity_on_hand) || 0;
  parts.push(`    <QuantityOnHand>${qty}</QuantityOnHand>`);

  parts.push('  </ItemInventoryAdd>');
  parts.push('</ItemInventoryAddRq>');

  return { qbxml: wrapInEnvelope(parts.join('\n    ')), warnings };
}

module.exports = {
  buildCustomerQuery,
  buildItemQuery,
  buildItemInventoryQuery,
  buildSalesOrderAdd,
  buildSalesOrderQuery,
  buildInvoiceAdd,
  buildInvoiceQuery,
  buildItemInventoryAdd,
  escXml,
};
