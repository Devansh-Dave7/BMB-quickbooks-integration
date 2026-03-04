const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',

  // QBWC SOAP auth
  qbwc: {
    username: process.env.QBWC_USERNAME || 'bmb_voice_sync',
    password: process.env.QBWC_PASSWORD || '',
    companyFile: process.env.QBWC_COMPANY_FILE || '',
    xmlVersion: process.env.QBXML_VERSION || '16.0',
  },

  // REST API auth
  apiKey: process.env.API_KEY || '',

  // Sync cycle settings
  sync: {
    inventoryEveryN: parseInt(process.env.INVENTORY_SYNC_EVERY_N_CYCLES, 10) || 1,
    customerEveryN: parseInt(process.env.CUSTOMER_SYNC_EVERY_N_CYCLES, 10) || 5,
  },

  // Outbound webhook URLs
  webhooks: {
    orderCreated: process.env.WEBHOOK_ORDER_CREATED || '',
    invoiceCreated: process.env.WEBHOOK_INVOICE_CREATED || '',
    inventoryUpdated: process.env.WEBHOOK_INVENTORY_UPDATED || '',
    syncError: process.env.WEBHOOK_SYNC_ERROR || '',
  },

  // Database path
  dbPath: path.join(__dirname, '..', 'data', 'bmb-qbwc.db'),

  logLevel: process.env.LOG_LEVEL || 'info',
};

module.exports = config;
