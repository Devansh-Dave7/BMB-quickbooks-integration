const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const soap = require('soap');
const config = require('./config');
const { getDb } = require('./db/schema');
const { buildService } = require('./soap/service');
const { createWebhookDispatcher } = require('./sync/webhooks');
const apiRoutes = require('./api/routes');

const app = express();

// ─── Security & Middleware ───────────────────────────────────────

app.use(helmet());
app.use(cors());
app.use(morgan(config.nodeEnv === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// ─── Initialize Database ────────────────────────────────────────

getDb();
console.log('[SERVER] SQLite database initialized');

// ─── REST API Routes ────────────────────────────────────────────

app.use('/api', apiRoutes);

// ─── Health Check (no auth required) ────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Start Server & Mount SOAP ──────────────────────────────────

const server = app.listen(config.port, () => {
  console.log(`[SERVER] BMB QBWC Server running on port ${config.port}`);
  console.log(`[SERVER] REST API: http://localhost:${config.port}/api/status`);
  console.log(`[SERVER] SOAP/WSDL: http://localhost:${config.port}/qbwc?wsdl`);
  console.log(`[SERVER] Environment: ${config.nodeEnv}`);

  // Mount SOAP service after Express is listening
  const wsdlPath = path.join(__dirname, 'soap', 'wsdl.xml');
  const wsdlXml = fs.readFileSync(wsdlPath, 'utf8');

  const webhookDispatcher = createWebhookDispatcher();
  const soapService = buildService(webhookDispatcher);

  soap.listen(app, '/qbwc', soapService, wsdlXml, () => {
    console.log('[SERVER] SOAP service mounted at /qbwc');
  });
});

// ─── Graceful Shutdown ──────────────────────────────────────────

function shutdown(signal) {
  console.log(`\n[SERVER] ${signal} received, shutting down...`);
  server.close(() => {
    const { closeDb } = require('./db/schema');
    closeDb();
    console.log('[SERVER] Database closed. Goodbye.');
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;
