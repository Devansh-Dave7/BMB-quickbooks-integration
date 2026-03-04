#!/usr/bin/env node

/**
 * Generate a .qwc file for QuickBooks Web Connector.
 *
 * Usage:
 *   node qwc/generate-qwc.js --url https://your-server.com
 *   node qwc/generate-qwc.js --url https://your-server.com --minutes 2 --output bmb.qwc
 *
 * The generated file is imported into QBWC on the machine running QB Desktop.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

// ─── CLI Arguments ──────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));

const APP_URL = args.url || args.u || '';
const MINUTES = parseInt(args.minutes || args.m || '5', 10);
const OUTPUT = args.output || args.o || 'bmb-voice-sync.qwc';
const USERNAME = args.username || config.qbwc.username;
const SUPPORT_URL = args.support || APP_URL;

if (!APP_URL) {
  console.error('Error: --url is required (your server\'s public URL)');
  console.error('');
  console.error('Usage:');
  console.error('  node qwc/generate-qwc.js --url https://your-server.com');
  console.error('');
  console.error('Options:');
  console.error('  --url       Public HTTPS URL of your QBWC server (required)');
  console.error('  --minutes   Sync interval in minutes (default: 5)');
  console.error('  --username  QBWC username (default: from .env)');
  console.error('  --support   Support URL (default: same as --url)');
  console.error('  --output    Output filename (default: bmb-voice-sync.qwc)');
  process.exit(1);
}

// Validate URL
try {
  const parsed = new URL(APP_URL);
  if (parsed.protocol !== 'https:' && !APP_URL.includes('localhost')) {
    console.warn('Warning: QBWC requires HTTPS for production. HTTP is only accepted for localhost.');
  }
} catch {
  console.error(`Error: Invalid URL: ${APP_URL}`);
  process.exit(1);
}

// ─── Generate GUIDs ─────────────────────────────────────────────

const ownerId = generateGuid();
const fileId = generateGuid();

// ─── Build .qwc XML ─────────────────────────────────────────────

const soapEndpoint = APP_URL.replace(/\/$/, '') + '/qbwc';

const qwcXml = `<?xml version="1.0"?>
<QBWCXML>
  <AppName>BMB Voice Order Sync</AppName>
  <AppID></AppID>
  <AppURL>${escXml(soapEndpoint)}</AppURL>
  <AppDescription>Voice AI order creation and inventory sync for BMB Enterprises</AppDescription>
  <AppSupport>${escXml(SUPPORT_URL)}</AppSupport>
  <UserName>${escXml(USERNAME)}</UserName>
  <OwnerID>${ownerId}</OwnerID>
  <FileID>${fileId}</FileID>
  <QBType>QBFS</QBType>
  <Scheduler>
    <RunEveryNMinutes>${MINUTES}</RunEveryNMinutes>
  </Scheduler>
  <IsReadOnly>false</IsReadOnly>
</QBWCXML>
`;

// ─── Write File ─────────────────────────────────────────────────

const outputPath = path.resolve(OUTPUT);
fs.writeFileSync(outputPath, qwcXml, 'utf8');

console.log(`Generated: ${outputPath}`);
console.log('');
console.log('Configuration:');
console.log(`  App Name:     BMB Voice Order Sync`);
console.log(`  SOAP URL:     ${soapEndpoint}`);
console.log(`  Username:     ${USERNAME}`);
console.log(`  Owner ID:     ${ownerId}`);
console.log(`  File ID:      ${fileId}`);
console.log(`  QB Type:      QBFS (QuickBooks Financial Software)`);
console.log(`  Sync Every:   ${MINUTES} minutes`);
console.log(`  Read Only:    false`);
console.log('');
console.log('Next steps:');
console.log('  1. Copy this .qwc file to the machine running QuickBooks Desktop');
console.log('  2. Open QuickBooks Web Connector');
console.log('  3. Click "Add an application" and select this .qwc file');
console.log(`  4. When prompted, enter the password configured in your .env file`);
console.log('  5. Authorize the application in QuickBooks when prompted');

// ─── Helpers ────────────────────────────────────────────────────

function generateGuid() {
  const bytes = crypto.randomBytes(16);
  // Set version 4 (random)
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  // Set variant bits
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `{${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}}`;
}

function escXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      result[key] = val;
    } else if (argv[i].startsWith('-')) {
      const key = argv[i].slice(1);
      const val = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : 'true';
      result[key] = val;
    }
  }
  return result;
}
