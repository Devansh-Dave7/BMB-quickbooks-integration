const crypto = require('crypto');
const config = require('../config');
const session = require('./session');
const queue = require('../db/queue');
const cache = require('../db/cache');
const log = require('../db/log');
const parsers = require('../qbxml/parsers');
const { queueBackgroundSyncs } = require('../sync/scheduler');

const SERVER_VERSION = '1.0.0';

/**
 * Build the SOAP service definition object for the `soap` npm package.
 * Each method returns its result via a callback or direct return.
 *
 * The soap package calls these as:
 *   methodName(args, callback)
 * where args contains the SOAP request parameters.
 */
function buildService(webhookDispatcher) {
  return {
    QBWebConnectorSvc: {
      QBWebConnectorSvcSoap: {

        /**
         * serverVersion()
         * Returns the server version string. Informational only.
         */
        serverVersion: function (_args) {
          console.log('[SOAP] serverVersion called');
          return { serverVersionResult: SERVER_VERSION };
        },

        /**
         * clientVersion(strVersion)
         * Validates the QBWC client version. Return:
         *   "" = accept this version
         *   "W:message" = warning (continue anyway)
         *   "E:message" = error (reject connection)
         */
        clientVersion: function (args) {
          const clientVer = args.strVersion || 'unknown';
          console.log(`[SOAP] clientVersion: ${clientVer}`);

          // Accept any QBWC version
          return { clientVersionResult: '' };
        },

        /**
         * authenticate(strUserName, strPassword)
         * Validates credentials and returns [ticket, status].
         * Status codes:
         *   "" or company file path = valid, has work (empty = any company file)
         *   "none" = valid credentials but no work to do
         *   "nvu" = invalid user/password
         */
        authenticate: function (args) {
          const { strUserName, strPassword } = args;
          console.log(`[SOAP] authenticate: user=${strUserName}`);

          // Validate credentials
          if (!validateCredentials(strUserName, strPassword)) {
            console.warn(`[SOAP] authenticate FAILED for user: ${strUserName}`);
            log.logEvent({
              event: 'authenticate',
              detail: { success: false, user: strUserName },
            });
            return {
              authenticateResult: { string: ['', 'nvu'] },
            };
          }

          // Advance sync cycle and queue background syncs
          const cycle = session.nextSyncCycle();
          queueBackgroundSyncs(cycle);

          // Check if there's work in the queue (including just-queued syncs)
          const queueDepth = queue.getQueueDepth();
          const ticket = session.createSession();

          log.logEvent({
            ticket,
            event: 'authenticate',
            detail: { success: true, user: strUserName, queueDepth, cycle },
          });

          if (queueDepth === 0) {
            console.log(`[SOAP] authenticate OK, no work to do (cycle ${cycle})`);
            session.destroySession(ticket);
            return {
              authenticateResult: { string: [ticket, 'none'] },
            };
          }

          console.log(`[SOAP] authenticate OK, ${queueDepth} items in queue (cycle ${cycle})`);

          // Return ticket + company file path (empty = accept any)
          return {
            authenticateResult: { string: [ticket, config.qbwc.companyFile || ''] },
          };
        },

        /**
         * sendRequestXML(ticket, strHCPResponse, strCompanyFileName, qbXMLCountry, qbXMLMajorVers, qbXMLMinorVers)
         * Pop next QBXML request from queue and return it.
         * Return empty string when queue is empty (triggers closeConnection).
         */
        sendRequestXML: function (args) {
          const { ticket } = args;
          console.log(`[SOAP] sendRequestXML: ticket=${ticket}`);

          if (!session.isValidSession(ticket)) {
            console.warn('[SOAP] sendRequestXML: invalid ticket');
            return { sendRequestXMLResult: '' };
          }

          const request = queue.popNext();

          if (!request) {
            console.log('[SOAP] sendRequestXML: queue empty, signaling done');
            log.logEvent({
              ticket,
              event: 'sendRequest',
              detail: { queueEmpty: true },
            });
            return { sendRequestXMLResult: '' };
          }

          session.incrementRequestsSent(ticket);

          console.log(`[SOAP] sendRequestXML: sending ${request.type} (${request.id})`);
          log.logEvent({
            ticket,
            event: 'sendRequest',
            requestType: request.type,
            detail: { queueId: request.id, type: request.type },
          });

          return { sendRequestXMLResult: request.qbxml };
        },

        /**
         * receiveResponseXML(ticket, response, hresult, message)
         * Parse the QB response and route to appropriate handler.
         * Returns:
         *   positive int = percentage complete (triggers another sendRequestXML)
         *   -1 = error occurred
         */
        receiveResponseXML: function (args) {
          const { ticket, response, hresult, message } = args;
          console.log(`[SOAP] receiveResponseXML: ticket=${ticket}`);

          if (!session.isValidSession(ticket)) {
            console.warn('[SOAP] receiveResponseXML: invalid ticket');
            return { receiveResponseXMLResult: -1 };
          }

          // Check for QB-level error (hresult)
          if (hresult) {
            console.error(`[SOAP] receiveResponseXML QB error: ${hresult} - ${message}`);
            session.setLastError(ticket, `QB Error: ${hresult} - ${message}`);
            log.logEvent({
              ticket,
              event: 'error',
              detail: { hresult, message },
            });
            // Mark the sent item as errored
            const sentItem = queue.getCurrentSent();
            if (sentItem) queue.markError(sentItem.id);
            return { receiveResponseXMLResult: -1 };
          }

          session.incrementResponsesReceived(ticket);

          // Process the response asynchronously but return immediately
          // (QBWC expects a quick response)
          processResponse(ticket, response, webhookDispatcher).catch((err) => {
            console.error('[SOAP] Error processing response:', err.message);
          });

          // Calculate percentage complete
          const remaining = queue.getQueueDepth();
          const sess = session.getSession(ticket);
          const total = sess.requestsSent + remaining;
          const pct = total > 0 ? Math.floor((sess.responsesReceived / total) * 100) : 100;

          console.log(`[SOAP] receiveResponseXML: ${pct}% complete (${remaining} remaining)`);
          return { receiveResponseXMLResult: pct };
        },

        /**
         * getLastError(ticket)
         * Return the last error string for this session.
         */
        getLastError: function (args) {
          const { ticket } = args;
          const error = session.getLastError(ticket) || '';
          console.log(`[SOAP] getLastError: ${error || '(none)'}`);
          return { getLastErrorResult: error };
        },

        /**
         * closeConnection(ticket)
         * Called when QBWC is done (queue empty or error).
         * Clean up session.
         */
        closeConnection: function (args) {
          const { ticket } = args;
          const sess = session.getSession(ticket);

          console.log(`[SOAP] closeConnection: ticket=${ticket}`);

          log.logEvent({
            ticket,
            event: 'close',
            detail: sess ? {
              requestsSent: sess.requestsSent,
              responsesReceived: sess.responsesReceived,
            } : {},
          });

          session.destroySession(ticket);
          session.cleanupStaleSessions();

          return { closeConnectionResult: 'OK' };
        },

        /**
         * connectionError(ticket, hresult, message)
         * Called when QBWC encounters a connection-level error.
         */
        connectionError: function (args) {
          const { ticket, hresult, message } = args;

          console.error(`[SOAP] connectionError: ${hresult} - ${message}`);

          log.logEvent({
            ticket,
            event: 'error',
            detail: { connectionError: true, hresult, message },
          });

          // Mark any in-flight request as errored
          const sentItem = queue.getCurrentSent();
          if (sentItem) queue.markError(sentItem.id);

          session.destroySession(ticket);
          return { connectionErrorResult: 'done' };
        },
      },
    },
  };
}

/**
 * Validate QBWC credentials using constant-time comparison.
 */
function validateCredentials(username, password) {
  if (!config.qbwc.username || !config.qbwc.password) {
    console.error('[SOAP] QBWC credentials not configured');
    return false;
  }

  const userMatch = safeCompare(username || '', config.qbwc.username);
  const passMatch = safeCompare(password || '', config.qbwc.password);
  return userMatch && passMatch;
}

/**
 * Constant-time string comparison.
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Process a QBXML response — detect type, parse, cache data, fire webhooks.
 */
async function processResponse(ticket, responseXml, webhookDispatcher) {
  const sentItem = queue.getCurrentSent();
  const responseType = await parsers.detectResponseType(responseXml);

  console.log(`[SOAP] Processing response type: ${responseType}`);

  try {
    switch (responseType) {
      case 'CustomerQueryRs':
        await handleCustomerQueryRs(responseXml);
        break;

      case 'ItemQueryRs':
        await handleItemQueryRs(responseXml, webhookDispatcher);
        break;

      case 'ItemInventoryQueryRs':
        await handleItemInventoryQueryRs(responseXml, webhookDispatcher);
        break;

      case 'SalesOrderAddRs':
        await handleSalesOrderAddRs(responseXml, sentItem, webhookDispatcher);
        break;

      case 'InvoiceAddRs':
        await handleInvoiceAddRs(responseXml, sentItem, webhookDispatcher);
        break;

      case 'ItemInventoryAddRs':
        await handleItemInventoryAddRs(responseXml, sentItem, webhookDispatcher);
        break;

      case 'CustomerAddRs':
        await handleCustomerAddRs(responseXml, sentItem);
        break;

      case 'SalesOrderQueryRs':
      case 'InvoiceQueryRs':
        // Query responses — fire callback if one was set
        if (sentItem && sentItem.callback_url) {
          const parsed = await parsers.parseErrorResponse(responseXml);
          if (webhookDispatcher) {
            webhookDispatcher.fireCallback(sentItem.callback_url, {
              type: responseType,
              queueId: sentItem.id,
              status: parsed.statusCode === 0 ? 'success' : 'error',
              response: responseXml,
            });
          }
        }
        break;

      default:
        console.warn(`[SOAP] Unknown response type: ${responseType}`);
    }

    // Mark the sent queue item as completed
    if (sentItem) {
      queue.markCompleted(sentItem.id);
    }

    log.logEvent({
      ticket,
      event: 'receiveResponse',
      requestType: responseType,
      detail: { queueId: sentItem ? sentItem.id : null, success: true },
    });
  } catch (err) {
    console.error(`[SOAP] Error handling ${responseType}:`, err.message);

    if (sentItem) {
      queue.markError(sentItem.id);
    }

    session.setLastError(ticket, err.message);

    log.logEvent({
      ticket,
      event: 'error',
      requestType: responseType,
      detail: { queueId: sentItem ? sentItem.id : null, error: err.message },
    });

    if (webhookDispatcher) {
      webhookDispatcher.fireSyncError({
        responseType,
        queueId: sentItem ? sentItem.id : null,
        error: err.message,
      });
    }
  }
}

/**
 * Handle CustomerQueryRs — update customer cache.
 */
async function handleCustomerQueryRs(xml) {
  const { status, customers } = await parsers.parseCustomerQueryRs(xml);

  if (status.statusCode !== 0) {
    throw new Error(`CustomerQuery error: ${status.statusMessage}`);
  }

  if (customers.length > 0) {
    cache.bulkUpsertCustomers(customers);
    console.log(`[SOAP] Cached ${customers.length} customers`);
  }
}

/**
 * Handle ItemQueryRs — update inventory cache.
 */
async function handleItemQueryRs(xml, webhookDispatcher) {
  const { status, items } = await parsers.parseItemQueryRs(xml);

  if (status.statusCode !== 0) {
    throw new Error(`ItemQuery error: ${status.statusMessage}`);
  }

  if (items.length > 0) {
    cache.bulkUpsertInventory(items);
    console.log(`[SOAP] Cached ${items.length} items (ItemQuery)`);

    if (webhookDispatcher) {
      webhookDispatcher.fireInventoryUpdated({
        itemCount: items.length,
        source: 'ItemQuery',
        syncTime: new Date().toISOString(),
      });
    }
  }
}

/**
 * Handle ItemInventoryQueryRs — update inventory cache.
 */
async function handleItemInventoryQueryRs(xml, webhookDispatcher) {
  const { status, items } = await parsers.parseItemInventoryQueryRs(xml);

  if (status.statusCode !== 0) {
    throw new Error(`ItemInventoryQuery error: ${status.statusMessage}`);
  }

  if (items.length > 0) {
    cache.bulkUpsertInventory(items);
    console.log(`[SOAP] Cached ${items.length} inventory items`);

    if (webhookDispatcher) {
      webhookDispatcher.fireInventoryUpdated({
        itemCount: items.length,
        source: 'ItemInventoryQuery',
        syncTime: new Date().toISOString(),
      });
    }
  }
}

/**
 * Handle SalesOrderAddRs — store order response, fire webhook.
 */
async function handleSalesOrderAddRs(xml, sentItem, webhookDispatcher) {
  const { status, order } = await parsers.parseSalesOrderAddRs(xml);

  if (status.statusCode !== 0) {
    throw new Error(`SalesOrderAdd error [${status.statusCode}]: ${status.statusMessage}`);
  }

  if (order) {
    const { v4: uuidv4 } = require('uuid');
    const callbackUrl = sentItem ? sentItem.callback_url : null;

    cache.storeOrderResponse({
      id: `or_${uuidv4().slice(0, 12)}`,
      queueId: sentItem ? sentItem.id : null,
      type: 'SalesOrder',
      txnId: order.txnId,
      txnNumber: order.txnNumber,
      customerName: order.customerName,
      total: order.total,
      callbackUrl,
      rawResponse: order.rawResponse,
    });

    console.log(`[SOAP] Sales order created: ${order.txnNumber} (TxnID: ${order.txnId})`);

    // Fire webhooks
    if (webhookDispatcher) {
      webhookDispatcher.fireOrderCreated({
        type: 'SalesOrder',
        txnId: order.txnId,
        txnNumber: order.txnNumber,
        customerName: order.customerName,
        total: order.total,
        queueId: sentItem ? sentItem.id : null,
      });

      if (callbackUrl) {
        webhookDispatcher.fireCallback(callbackUrl, {
          type: 'SalesOrder',
          txnId: order.txnId,
          txnNumber: order.txnNumber,
          customerName: order.customerName,
          total: order.total,
          status: 'created',
        });
      }
    }
  }
}

/**
 * Handle InvoiceAddRs — store response, fire webhook.
 */
async function handleInvoiceAddRs(xml, sentItem, webhookDispatcher) {
  const { status, invoice } = await parsers.parseInvoiceAddRs(xml);

  if (status.statusCode !== 0) {
    throw new Error(`InvoiceAdd error [${status.statusCode}]: ${status.statusMessage}`);
  }

  if (invoice) {
    const { v4: uuidv4 } = require('uuid');
    const callbackUrl = sentItem ? sentItem.callback_url : null;

    cache.storeOrderResponse({
      id: `or_${uuidv4().slice(0, 12)}`,
      queueId: sentItem ? sentItem.id : null,
      type: 'Invoice',
      txnId: invoice.txnId,
      txnNumber: invoice.txnNumber,
      customerName: invoice.customerName,
      total: invoice.total,
      callbackUrl,
      rawResponse: invoice.rawResponse,
    });

    console.log(`[SOAP] Invoice created: ${invoice.txnNumber} (TxnID: ${invoice.txnId})`);

    if (webhookDispatcher) {
      webhookDispatcher.fireInvoiceCreated({
        type: 'Invoice',
        txnId: invoice.txnId,
        txnNumber: invoice.txnNumber,
        customerName: invoice.customerName,
        total: invoice.total,
        queueId: sentItem ? sentItem.id : null,
      });

      if (callbackUrl) {
        webhookDispatcher.fireCallback(callbackUrl, {
          type: 'Invoice',
          txnId: invoice.txnId,
          txnNumber: invoice.txnNumber,
          customerName: invoice.customerName,
          total: invoice.total,
          status: 'created',
        });
      }
    }
  }
}

/**
 * Handle ItemInventoryAddRs — upsert new item into cache, fire webhook.
 */
async function handleItemInventoryAddRs(xml, sentItem, webhookDispatcher) {
  const { status, item } = await parsers.parseItemInventoryAddRs(xml);

  if (status.statusCode !== 0) {
    throw new Error(`ItemInventoryAdd error [${status.statusCode}]: ${status.statusMessage}`);
  }

  if (item) {
    cache.bulkUpsertInventory([item]);
    console.log(`[SOAP] Inventory item added: ${item.fullName} (ListID: ${item.listId})`);

    if (webhookDispatcher) {
      webhookDispatcher.fireInventoryUpdated({
        itemCount: 1,
        source: 'ItemInventoryAdd',
        item: { listId: item.listId, name: item.name, fullName: item.fullName },
        queueId: sentItem ? sentItem.id : null,
        syncTime: new Date().toISOString(),
      });

      const callbackUrl = sentItem ? sentItem.callback_url : null;
      if (callbackUrl) {
        webhookDispatcher.fireCallback(callbackUrl, {
          type: 'ItemInventoryAdd',
          listId: item.listId,
          name: item.name,
          fullName: item.fullName,
          status: 'created',
        });
      }
    }
  }
}

/**
 * Handle CustomerAddRs — cache the new customer.
 * Status 3100 = "name already in use" — not an error, customer exists.
 */
async function handleCustomerAddRs(xml, sentItem) {
  const { status, customer } = await parsers.parseCustomerAddRs(xml);

  if (status.statusCode === 3100) {
    console.log(`[SOAP] CustomerAdd: customer already exists (3100), continuing`);
    return;
  }

  if (status.statusCode !== 0) {
    throw new Error(`CustomerAdd error [${status.statusCode}]: ${status.statusMessage}`);
  }

  if (customer) {
    cache.upsertCustomer(customer);
    console.log(`[SOAP] Customer created: ${customer.fullName || customer.name} (ListID: ${customer.listId})`);
  }
}

module.exports = { buildService };
