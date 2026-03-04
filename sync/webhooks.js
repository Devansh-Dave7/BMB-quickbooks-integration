const axios = require('axios');
const config = require('../config');
const log = require('../db/log');

const TIMEOUT_MS = 10000;
const MAX_RETRIES = 2;

/**
 * Create a webhook dispatcher instance.
 * All methods are fire-and-forget — they log results but never block the SOAP flow.
 */
function createWebhookDispatcher() {
  return {
    fireOrderCreated,
    fireInvoiceCreated,
    fireInventoryUpdated,
    fireSyncError,
    fireCallback,
  };
}

/**
 * POST to the configured WEBHOOK_ORDER_CREATED URL.
 */
async function fireOrderCreated(payload) {
  const url = config.webhooks.orderCreated;
  if (!url) return;
  await sendWebhook('order_created', url, payload);
}

/**
 * POST to the configured WEBHOOK_INVOICE_CREATED URL.
 */
async function fireInvoiceCreated(payload) {
  const url = config.webhooks.invoiceCreated;
  if (!url) return;
  await sendWebhook('invoice_created', url, payload);
}

/**
 * POST to the configured WEBHOOK_INVENTORY_UPDATED URL.
 */
async function fireInventoryUpdated(payload) {
  const url = config.webhooks.inventoryUpdated;
  if (!url) return;
  await sendWebhook('inventory_updated', url, payload);
}

/**
 * POST to the configured WEBHOOK_SYNC_ERROR URL.
 */
async function fireSyncError(payload) {
  const url = config.webhooks.syncError;
  if (!url) return;
  await sendWebhook('sync_error', url, payload);
}

/**
 * POST to a per-request callback URL (set by the REST API caller).
 * Used for order/invoice/query result callbacks.
 */
async function fireCallback(callbackUrl, payload) {
  if (!callbackUrl) return;
  await sendWebhook('callback', callbackUrl, payload);
}

/**
 * Send a webhook POST with retry logic.
 * Fire-and-forget — errors are logged but never thrown to caller.
 */
async function sendWebhook(eventType, url, payload, attempt = 1) {
  try {
    const response = await axios.post(url, {
      event: eventType,
      timestamp: new Date().toISOString(),
      data: payload,
    }, {
      timeout: TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'BMB-QBWC-Server/1.0',
        'X-Webhook-Event': eventType,
      },
    });

    console.log(`[WEBHOOK] ${eventType} → ${url} (${response.status})`);

    log.logEvent({
      event: 'webhook',
      detail: {
        eventType,
        url,
        status: response.status,
        attempt,
      },
    });
  } catch (err) {
    const status = err.response ? err.response.status : 'NETWORK_ERROR';
    console.error(`[WEBHOOK] ${eventType} → ${url} FAILED (${status}, attempt ${attempt}/${MAX_RETRIES + 1}): ${err.message}`);

    if (attempt <= MAX_RETRIES) {
      const delay = attempt * 2000;
      console.log(`[WEBHOOK] Retrying in ${delay}ms...`);
      await sleep(delay);
      return sendWebhook(eventType, url, payload, attempt + 1);
    }

    log.logEvent({
      event: 'webhook_error',
      detail: {
        eventType,
        url,
        status,
        error: err.message,
        attempts: attempt,
      },
    });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { createWebhookDispatcher };
