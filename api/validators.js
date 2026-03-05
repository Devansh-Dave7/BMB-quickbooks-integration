/**
 * Validate a POST /api/order or POST /api/invoice request body.
 */
function validateOrderPayload(body) {
  const errors = [];

  if (!body || typeof body !== 'object') {
    return ['Request body must be a JSON object'];
  }

  if (!body.customer_name || typeof body.customer_name !== 'string') {
    errors.push('customer_name is required and must be a string');
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    errors.push('items must be a non-empty array');
  } else {
    body.items.forEach((item, i) => {
      if (!item.name || typeof item.name !== 'string') {
        errors.push(`items[${i}].name is required and must be a string`);
      }
      if (item.qty != null && (typeof item.qty !== 'number' || item.qty <= 0)) {
        errors.push(`items[${i}].qty must be a positive number`);
      }
      if (item.rate != null && (typeof item.rate !== 'number' || item.rate < 0)) {
        errors.push(`items[${i}].rate must be a non-negative number`);
      }
    });
  }

  if (body.callback_url && typeof body.callback_url !== 'string') {
    errors.push('callback_url must be a string');
  }

  return errors;
}

/**
 * Validate a POST /api/query request body.
 */
function validateQueryPayload(body) {
  const errors = [];

  if (!body || typeof body !== 'object') {
    return ['Request body must be a JSON object'];
  }

  const validTypes = [
    'CustomerQuery', 'ItemQuery', 'ItemInventoryQuery',
    'SalesOrderQuery', 'InvoiceQuery',
  ];

  if (!body.type || !validTypes.includes(body.type)) {
    errors.push(`type is required and must be one of: ${validTypes.join(', ')}`);
  }

  if (body.params && typeof body.params !== 'object') {
    errors.push('params must be an object');
  }

  if (body.callback_url && typeof body.callback_url !== 'string') {
    errors.push('callback_url must be a string');
  }

  return errors;
}

/**
 * Validate a POST /api/inventory/add request body.
 * Accepts { items: [...] } or a single item object (wrapped into items[]).
 */
function validateInventoryAddPayload(body) {
  const errors = [];

  if (!body || typeof body !== 'object') {
    return ['Request body must be a JSON object'];
  }

  // Allow single item or items array
  let items = body.items;
  if (!items && body.name) {
    // Single item submitted directly — normalize to array
    items = [body];
    body.items = items;
  }

  if (!Array.isArray(items) || items.length === 0) {
    errors.push('items must be a non-empty array (or provide a single item with "name")');
  } else {
    items.forEach((item, i) => {
      if (!item.name || typeof item.name !== 'string') {
        errors.push(`items[${i}].name is required and must be a string`);
      }
      if (item.sales_price == null || typeof item.sales_price !== 'number' || item.sales_price < 0) {
        errors.push(`items[${i}].sales_price is required and must be a non-negative number`);
      }
      if (item.purchase_cost == null || typeof item.purchase_cost !== 'number' || item.purchase_cost < 0) {
        errors.push(`items[${i}].purchase_cost is required and must be a non-negative number`);
      }
      if (item.income_account != null && typeof item.income_account !== 'string') {
        errors.push(`items[${i}].income_account must be a string`);
      }
      if (item.cogs_account != null && typeof item.cogs_account !== 'string') {
        errors.push(`items[${i}].cogs_account must be a string`);
      }
      if (item.asset_account != null && typeof item.asset_account !== 'string') {
        errors.push(`items[${i}].asset_account must be a string`);
      }
      if (item.quantity_on_hand != null && (typeof item.quantity_on_hand !== 'number' || item.quantity_on_hand < 0)) {
        errors.push(`items[${i}].quantity_on_hand must be a non-negative number`);
      }
      if (item.reorder_point != null && (typeof item.reorder_point !== 'number' || item.reorder_point < 0)) {
        errors.push(`items[${i}].reorder_point must be a non-negative number`);
      }
    });
  }

  if (body.callback_url && typeof body.callback_url !== 'string') {
    errors.push('callback_url must be a string');
  }

  return errors;
}

module.exports = {
  validateOrderPayload,
  validateQueryPayload,
  validateInventoryAddPayload,
};
