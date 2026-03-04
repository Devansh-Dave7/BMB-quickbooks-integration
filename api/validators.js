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

module.exports = {
  validateOrderPayload,
  validateQueryPayload,
};
