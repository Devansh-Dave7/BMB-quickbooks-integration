const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const config = require('../config');

let db;

function getDb() {
  if (db) return db;

  // Ensure data directory exists
  const dataDir = path.dirname(config.dbPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  db = new DatabaseSync(config.dbPath);

  // Enable WAL mode for better concurrent read performance
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  initTables(db);
  return db;
}

function initTables(db) {
  db.exec(`
    -- Pending QBXML requests waiting for next sync
    CREATE TABLE IF NOT EXISTS request_queue (
      id TEXT PRIMARY KEY,
      priority INTEGER DEFAULT 10,
      type TEXT NOT NULL,
      qbxml TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      callback_url TEXT,
      metadata TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      sent_at TEXT,
      completed_at TEXT
    );

    -- Cached inventory from QB
    CREATE TABLE IF NOT EXISTS inventory_cache (
      list_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      full_name TEXT,
      sku TEXT,
      description TEXT,
      qty_on_hand REAL DEFAULT 0,
      qty_on_order REAL DEFAULT 0,
      qty_on_sales_order REAL DEFAULT 0,
      sales_price REAL,
      cost REAL,
      item_type TEXT,
      is_active INTEGER DEFAULT 1,
      raw_data TEXT,
      synced_at TEXT DEFAULT (datetime('now'))
    );

    -- Cached customers from QB
    CREATE TABLE IF NOT EXISTS customer_cache (
      list_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      full_name TEXT,
      company_name TEXT,
      phone TEXT,
      email TEXT,
      balance REAL DEFAULT 0,
      credit_limit REAL,
      terms TEXT,
      is_active INTEGER DEFAULT 1,
      billing_address TEXT,
      shipping_address TEXT,
      raw_data TEXT,
      synced_at TEXT DEFAULT (datetime('now'))
    );

    -- Responses from QB for orders/invoices created
    CREATE TABLE IF NOT EXISTS order_responses (
      id TEXT PRIMARY KEY,
      queue_id TEXT,
      type TEXT,
      txn_id TEXT,
      txn_number TEXT,
      customer_name TEXT,
      total REAL,
      status TEXT DEFAULT 'created',
      callback_url TEXT,
      callback_sent INTEGER DEFAULT 0,
      raw_response TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Sync log for debugging
    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket TEXT,
      event TEXT,
      request_type TEXT,
      detail TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Pricing metadata (static product info, joined with inventory_cache for live QB prices)
    CREATE TABLE IF NOT EXISTS pricing_metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      qb_item_name TEXT NOT NULL,
      tonnage REAL,
      seer2 REAL,
      tier TEXT,
      efficiency_tier TEXT,
      ahri_ref TEXT,
      outdoor_model TEXT,
      indoor_model TEXT,
      outdoor_price REAL,
      indoor_price REAL,
      csv_price REAL,
      condenser_dims TEXT,
      airhandler_dims TEXT,
      electrical TEXT,
      heat_kit_type TEXT,
      voltage_specs TEXT,
      warranty_level TEXT,
      warranty_program TEXT,
      labor_years INTEGER,
      parts_years INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_queue_status_priority
      ON request_queue(status, priority, created_at);

    CREATE INDEX IF NOT EXISTS idx_inventory_name
      ON inventory_cache(name COLLATE NOCASE);

    CREATE INDEX IF NOT EXISTS idx_inventory_sku
      ON inventory_cache(sku COLLATE NOCASE);

    CREATE INDEX IF NOT EXISTS idx_customer_name
      ON customer_cache(name COLLATE NOCASE);

    CREATE INDEX IF NOT EXISTS idx_customer_phone
      ON customer_cache(phone);

    CREATE INDEX IF NOT EXISTS idx_order_responses_queue
      ON order_responses(queue_id);

    CREATE INDEX IF NOT EXISTS idx_sync_log_ticket
      ON sync_log(ticket, created_at);

    CREATE INDEX IF NOT EXISTS idx_pm_category
      ON pricing_metadata(category);

    CREATE INDEX IF NOT EXISTS idx_pm_cat_tonnage
      ON pricing_metadata(category, tonnage);

    CREATE INDEX IF NOT EXISTS idx_pm_qb_name
      ON pricing_metadata(qb_item_name COLLATE NOCASE);

    CREATE INDEX IF NOT EXISTS idx_pm_outdoor_model
      ON pricing_metadata(outdoor_model COLLATE NOCASE);

    CREATE INDEX IF NOT EXISTS idx_pm_indoor_model
      ON pricing_metadata(indoor_model COLLATE NOCASE);
  `);
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { getDb, closeDb };
