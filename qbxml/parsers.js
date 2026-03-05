const { parseStringPromise } = require('xml2js');

/**
 * Parse raw QBXML response into a JS object.
 * Returns the content inside QBXMLMsgsRs.
 */
async function parseQBXML(xmlString) {
  const result = await parseStringPromise(xmlString, {
    explicitArray: false,
    ignoreAttrs: false,
    tagNameProcessors: [],
  });

  if (!result || !result.QBXML || !result.QBXML.QBXMLMsgsRs) {
    throw new Error('Invalid QBXML response: missing QBXMLMsgsRs');
  }

  return result.QBXML.QBXMLMsgsRs;
}

/**
 * Extract status info from a QB response node.
 * Every QB response has statusCode, statusSeverity, statusMessage as attributes.
 */
function extractStatus(responseNode) {
  const attrs = responseNode.$ || {};
  return {
    statusCode: parseInt(attrs.statusCode, 10) || 0,
    statusSeverity: attrs.statusSeverity || 'Info',
    statusMessage: attrs.statusMessage || '',
  };
}

/**
 * Safely get a nested value, handling xml2js structure.
 * xml2js with explicitArray:false returns strings for single values.
 */
function safeGet(obj, key, defaultVal = null) {
  if (!obj || obj[key] == null) return defaultVal;
  return obj[key];
}

/**
 * Extract text from a QB reference node (e.g. CustomerRef, ItemRef).
 * These have { ListID, FullName } structure.
 */
function extractRef(refNode) {
  if (!refNode) return { listId: null, fullName: null };
  return {
    listId: safeGet(refNode, 'ListID'),
    fullName: safeGet(refNode, 'FullName'),
  };
}

/**
 * Extract address from a QB address block.
 */
function extractAddress(addrNode) {
  if (!addrNode) return null;
  return {
    addr1: safeGet(addrNode, 'Addr1'),
    addr2: safeGet(addrNode, 'Addr2'),
    addr3: safeGet(addrNode, 'Addr3'),
    city: safeGet(addrNode, 'City'),
    state: safeGet(addrNode, 'State'),
    postalCode: safeGet(addrNode, 'PostalCode'),
    country: safeGet(addrNode, 'Country'),
  };
}

// ─── Customer Response Parser ───────────────────────────────────

/**
 * Parse CustomerQueryRs.
 * Returns array of customer objects ready for cache.upsertCustomer().
 */
async function parseCustomerQueryRs(xmlString) {
  const msgs = await parseQBXML(xmlString);
  const rs = msgs.CustomerQueryRs;
  if (!rs) throw new Error('No CustomerQueryRs in response');

  const status = extractStatus(rs);
  if (status.statusCode !== 0) {
    return { status, customers: [] };
  }

  // Normalize to array (xml2js returns object for single result)
  let items = rs.CustomerRet;
  if (!items) return { status, customers: [] };
  if (!Array.isArray(items)) items = [items];

  const customers = items.map((c) => ({
    listId: safeGet(c, 'ListID'),
    name: safeGet(c, 'Name'),
    fullName: safeGet(c, 'FullName'),
    companyName: safeGet(c, 'CompanyName'),
    phone: safeGet(c, 'Phone'),
    email: safeGet(c, 'Email'),
    balance: parseFloat(safeGet(c, 'Balance', '0')) || 0,
    creditLimit: parseFloat(safeGet(c, 'CreditLimit', '0')) || null,
    terms: c.TermsRef ? safeGet(c.TermsRef, 'FullName') : null,
    isActive: safeGet(c, 'IsActive') !== 'false',
    billingAddress: extractAddress(c.BillAddress),
    shippingAddress: extractAddress(c.ShipAddress),
    rawData: c,
  }));

  return { status, customers };
}

// ─── Item Response Parsers ──────────────────────────────────────

/**
 * Parse ItemQueryRs (mixed item types).
 * Returns array of item objects ready for cache.upsertInventoryItem().
 */
async function parseItemQueryRs(xmlString) {
  const msgs = await parseQBXML(xmlString);
  const rs = msgs.ItemQueryRs;
  if (!rs) throw new Error('No ItemQueryRs in response');

  const status = extractStatus(rs);
  if (status.statusCode !== 0) {
    return { status, items: [] };
  }

  const items = [];

  // ItemQueryRs can return multiple item types
  const itemTypes = [
    { key: 'ItemInventoryRet', type: 'Inventory' },
    { key: 'ItemNonInventoryRet', type: 'NonInventory' },
    { key: 'ItemServiceRet', type: 'Service' },
    { key: 'ItemOtherChargeRet', type: 'OtherCharge' },
    { key: 'ItemInventoryAssemblyRet', type: 'InventoryAssembly' },
    { key: 'ItemGroupRet', type: 'Group' },
  ];

  for (const { key, type } of itemTypes) {
    let retItems = rs[key];
    if (!retItems) continue;
    if (!Array.isArray(retItems)) retItems = [retItems];

    for (const item of retItems) {
      items.push(parseItemRet(item, type));
    }
  }

  return { status, items };
}

/**
 * Parse ItemInventoryQueryRs.
 */
async function parseItemInventoryQueryRs(xmlString) {
  const msgs = await parseQBXML(xmlString);
  const rs = msgs.ItemInventoryQueryRs;
  if (!rs) throw new Error('No ItemInventoryQueryRs in response');

  const status = extractStatus(rs);
  if (status.statusCode !== 0) {
    return { status, items: [] };
  }

  let retItems = rs.ItemInventoryRet;
  if (!retItems) return { status, items: [] };
  if (!Array.isArray(retItems)) retItems = [retItems];

  const items = retItems.map((item) => parseItemRet(item, 'Inventory'));
  return { status, items };
}

/**
 * Parse a single item return node into our standard format.
 */
function parseItemRet(item, itemType) {
  // SalesPrice can be in SalesOrPurchase or SalesAndPurchase or directly
  let salesPrice = null;
  let cost = null;

  if (item.SalesOrPurchase) {
    salesPrice = parseFloat(safeGet(item.SalesOrPurchase, 'Price', '0')) || null;
  }
  if (item.SalesAndPurchase) {
    salesPrice = parseFloat(safeGet(item.SalesAndPurchase, 'SalesPrice', '0')) || null;
    cost = parseFloat(safeGet(item.SalesAndPurchase, 'PurchaseCost', '0')) || null;
  }
  // Direct SalesPrice (some item types)
  if (item.SalesPrice) {
    salesPrice = parseFloat(item.SalesPrice) || null;
  }
  if (item.PurchaseCost) {
    cost = parseFloat(item.PurchaseCost) || null;
  }

  return {
    listId: safeGet(item, 'ListID'),
    name: safeGet(item, 'Name'),
    fullName: safeGet(item, 'FullName'),
    sku: safeGet(item, 'ManufacturerPartNumber') || safeGet(item, 'BarCodeValue') || null,
    description: safeGet(item, 'SalesDesc') || safeGet(item, 'FullName'),
    qtyOnHand: parseFloat(safeGet(item, 'QuantityOnHand', '0')) || 0,
    qtyOnOrder: parseFloat(safeGet(item, 'QuantityOnOrder', '0')) || 0,
    qtyOnSalesOrder: parseFloat(safeGet(item, 'QuantityOnSalesOrder', '0')) || 0,
    salesPrice,
    cost,
    itemType,
    isActive: safeGet(item, 'IsActive') !== 'false',
    rawData: item,
  };
}

// ─── Sales Order Response Parser ────────────────────────────────

/**
 * Parse SalesOrderAddRs.
 * Returns order confirmation data for order_responses table.
 */
async function parseSalesOrderAddRs(xmlString) {
  const msgs = await parseQBXML(xmlString);
  const rs = msgs.SalesOrderAddRs;
  if (!rs) throw new Error('No SalesOrderAddRs in response');

  const status = extractStatus(rs);
  if (status.statusCode !== 0) {
    return { status, order: null };
  }

  const ret = rs.SalesOrderRet;
  if (!ret) return { status, order: null };

  const customerRef = extractRef(ret.CustomerRef);
  const order = {
    txnId: safeGet(ret, 'TxnID'),
    txnNumber: safeGet(ret, 'RefNumber'),
    customerName: customerRef.fullName,
    total: parseFloat(safeGet(ret, 'TotalAmount', '0')) || 0,
    rawResponse: ret,
  };

  return { status, order };
}

/**
 * Parse SalesOrderQueryRs.
 */
async function parseSalesOrderQueryRs(xmlString) {
  const msgs = await parseQBXML(xmlString);
  const rs = msgs.SalesOrderQueryRs;
  if (!rs) throw new Error('No SalesOrderQueryRs in response');

  const status = extractStatus(rs);
  if (status.statusCode !== 0) {
    return { status, orders: [] };
  }

  let retOrders = rs.SalesOrderRet;
  if (!retOrders) return { status, orders: [] };
  if (!Array.isArray(retOrders)) retOrders = [retOrders];

  const orders = retOrders.map((o) => ({
    txnId: safeGet(o, 'TxnID'),
    txnNumber: safeGet(o, 'RefNumber'),
    customerName: o.CustomerRef ? safeGet(o.CustomerRef, 'FullName') : null,
    total: parseFloat(safeGet(o, 'TotalAmount', '0')) || 0,
    isManuallyClosed: safeGet(o, 'IsManuallyClosed') === 'true',
    isFullyInvoiced: safeGet(o, 'IsFullyInvoiced') === 'true',
  }));

  return { status, orders };
}

// ─── Invoice Response Parser ────────────────────────────────────

/**
 * Parse InvoiceAddRs.
 */
async function parseInvoiceAddRs(xmlString) {
  const msgs = await parseQBXML(xmlString);
  const rs = msgs.InvoiceAddRs;
  if (!rs) throw new Error('No InvoiceAddRs in response');

  const status = extractStatus(rs);
  if (status.statusCode !== 0) {
    return { status, invoice: null };
  }

  const ret = rs.InvoiceRet;
  if (!ret) return { status, invoice: null };

  const customerRef = extractRef(ret.CustomerRef);
  const invoice = {
    txnId: safeGet(ret, 'TxnID'),
    txnNumber: safeGet(ret, 'RefNumber'),
    customerName: customerRef.fullName,
    total: parseFloat(safeGet(ret, 'TotalAmount', '0')) || 0,
    rawResponse: ret,
  };

  return { status, invoice };
}

/**
 * Parse InvoiceQueryRs.
 */
async function parseInvoiceQueryRs(xmlString) {
  const msgs = await parseQBXML(xmlString);
  const rs = msgs.InvoiceQueryRs;
  if (!rs) throw new Error('No InvoiceQueryRs in response');

  const status = extractStatus(rs);
  if (status.statusCode !== 0) {
    return { status, invoices: [] };
  }

  let retInvoices = rs.InvoiceRet;
  if (!retInvoices) return { status, invoices: [] };
  if (!Array.isArray(retInvoices)) retInvoices = [retInvoices];

  const invoices = retInvoices.map((inv) => ({
    txnId: safeGet(inv, 'TxnID'),
    txnNumber: safeGet(inv, 'RefNumber'),
    customerName: inv.CustomerRef ? safeGet(inv.CustomerRef, 'FullName') : null,
    total: parseFloat(safeGet(inv, 'TotalAmount', '0')) || 0,
    isPaid: safeGet(inv, 'IsPaid') === 'true',
  }));

  return { status, invoices };
}

// ─── Item Inventory Add Response Parser ─────────────────────────

/**
 * Parse ItemInventoryAddRs.
 * Returns { status, item } with the newly created inventory item.
 */
async function parseItemInventoryAddRs(xmlString) {
  const msgs = await parseQBXML(xmlString);
  const rs = msgs.ItemInventoryAddRs;
  if (!rs) throw new Error('No ItemInventoryAddRs in response');

  const status = extractStatus(rs);
  if (status.statusCode !== 0) {
    return { status, item: null };
  }

  const ret = rs.ItemInventoryRet;
  if (!ret) return { status, item: null };

  const item = parseItemRet(ret, 'Inventory');
  return { status, item };
}

// ─── Generic Error Parser ───────────────────────────────────────

/**
 * Parse any QBXML response and extract just the status/error info.
 * Useful for quick error checking without knowing the response type.
 */
async function parseErrorResponse(xmlString) {
  const msgs = await parseQBXML(xmlString);

  // Find the first *Rs key in the response
  const rsKey = Object.keys(msgs).find((k) => k.endsWith('Rs'));
  if (!rsKey) return { statusCode: -1, statusSeverity: 'Error', statusMessage: 'No response found' };

  return extractStatus(msgs[rsKey]);
}

/**
 * Detect the response type from raw QBXML.
 * Returns the key like 'CustomerQueryRs', 'SalesOrderAddRs', etc.
 */
async function detectResponseType(xmlString) {
  const msgs = await parseQBXML(xmlString);
  return Object.keys(msgs).find((k) => k.endsWith('Rs')) || null;
}

module.exports = {
  parseQBXML,
  parseCustomerQueryRs,
  parseItemQueryRs,
  parseItemInventoryQueryRs,
  parseItemInventoryAddRs,
  parseSalesOrderAddRs,
  parseSalesOrderQueryRs,
  parseInvoiceAddRs,
  parseInvoiceQueryRs,
  parseErrorResponse,
  detectResponseType,
};
