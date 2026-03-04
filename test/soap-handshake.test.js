const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { config, setupTestDb, teardownTestDb, clearAllTables, createMockWebhookDispatcher } = require('./_setup');
const { buildService } = require('../soap/service');
const queue = require('../db/queue');
const cache = require('../db/cache');

// QBXML fixture responses for use in receiveResponseXML
const inventoryResponseXml = `<?xml version="1.0" ?>
<QBXML>
<QBXMLMsgsRs>
<ItemInventoryQueryRs statusCode="0" statusSeverity="Info" statusMessage="Status OK">
  <ItemInventoryRet>
    <ListID>80000010-0001</ListID>
    <Name>Widget A</Name>
    <FullName>Inventory:Widget A</FullName>
    <IsActive>true</IsActive>
    <QuantityOnHand>100</QuantityOnHand>
    <SalesPrice>19.99</SalesPrice>
  </ItemInventoryRet>
</ItemInventoryQueryRs>
</QBXMLMsgsRs>
</QBXML>`;

const salesOrderAddResponseXml = `<?xml version="1.0" ?>
<QBXML>
<QBXMLMsgsRs>
<SalesOrderAddRs statusCode="0" statusSeverity="Info" statusMessage="Status OK">
  <SalesOrderRet>
    <TxnID>TXN-SO-099</TxnID>
    <RefNumber>SO-5001</RefNumber>
    <CustomerRef>
      <ListID>80000001-1234</ListID>
      <FullName>Test Customer</FullName>
    </CustomerRef>
    <TotalAmount>299.99</TotalAmount>
  </SalesOrderRet>
</SalesOrderAddRs>
</QBXMLMsgsRs>
</QBXML>`;

describe('SOAP handshake — full lifecycle', () => {
  let svc;
  let mockDispatcher;
  let webhookCalls;

  before(() => setupTestDb());
  after(() => teardownTestDb());

  beforeEach(() => {
    clearAllTables();
    const mock = createMockWebhookDispatcher();
    mockDispatcher = mock.dispatcher;
    webhookCalls = mock.calls;
    svc = buildService(mockDispatcher).QBWebConnectorSvc.QBWebConnectorSvcSoap;
  });

  it('serverVersion returns version string', () => {
    const result = svc.serverVersion({});
    assert.equal(result.serverVersionResult, '1.0.0');
  });

  it('clientVersion accepts any version', () => {
    const result = svc.clientVersion({ strVersion: '2.3.0.1' });
    assert.equal(result.clientVersionResult, '');
  });

  it('authenticate rejects invalid credentials', () => {
    const result = svc.authenticate({ strUserName: 'wrong', strPassword: 'wrong' });
    assert.equal(result.authenticateResult.string[1], 'nvu');
  });

  it('authenticate returns "none" when queue is empty', () => {
    // Authenticate with valid creds — scheduler will queue background syncs.
    // We need a cycle where nothing queues. Set syncs to very high cycle numbers.
    config.sync.inventoryEveryN = 999;
    config.sync.customerEveryN = 999;

    const result = svc.authenticate({ strUserName: 'test_user', strPassword: 'test_pass' });
    assert.equal(result.authenticateResult.string[1], 'none');

    // Restore
    config.sync.inventoryEveryN = 1;
    config.sync.customerEveryN = 5;
  });

  it('authenticate succeeds and returns ticket + company file when work queued', () => {
    // Pre-queue an item
    queue.addToQueue({ type: 'CustomerQuery', qbxml: '<test/>' });

    // Temporarily disable scheduler queueing to test just the pre-queued item
    config.sync.inventoryEveryN = 999;
    config.sync.customerEveryN = 999;

    const result = svc.authenticate({ strUserName: 'test_user', strPassword: 'test_pass' });
    const [ticket, status] = result.authenticateResult.string;
    assert.ok(ticket.length > 0);
    assert.equal(status, config.qbwc.companyFile);

    config.sync.inventoryEveryN = 1;
    config.sync.customerEveryN = 5;
  });

  it('sendRequestXML pops next queue item', () => {
    queue.addToQueue({ type: 'TestReq', qbxml: '<myxml/>' });

    config.sync.inventoryEveryN = 999;
    config.sync.customerEveryN = 999;

    const authResult = svc.authenticate({ strUserName: 'test_user', strPassword: 'test_pass' });
    const ticket = authResult.authenticateResult.string[0];

    const sendResult = svc.sendRequestXML({ ticket });
    assert.equal(sendResult.sendRequestXMLResult, '<myxml/>');

    config.sync.inventoryEveryN = 1;
    config.sync.customerEveryN = 5;
  });

  it('sendRequestXML returns empty string when queue is empty', () => {
    config.sync.inventoryEveryN = 999;
    config.sync.customerEveryN = 999;

    // Must have work to get past 'none' — add then pop manually
    queue.addToQueue({ type: 'Test', qbxml: '<t/>' });
    const authResult = svc.authenticate({ strUserName: 'test_user', strPassword: 'test_pass' });
    const ticket = authResult.authenticateResult.string[0];

    svc.sendRequestXML({ ticket }); // pops the one item
    const result = svc.sendRequestXML({ ticket }); // queue now empty
    assert.equal(result.sendRequestXMLResult, '');

    config.sync.inventoryEveryN = 1;
    config.sync.customerEveryN = 5;
  });

  it('receiveResponseXML returns percentage and processes response', async () => {
    config.sync.inventoryEveryN = 999;
    config.sync.customerEveryN = 999;

    queue.addToQueue({ type: 'ItemInventoryQuery', qbxml: '<inv/>' });
    const authResult = svc.authenticate({ strUserName: 'test_user', strPassword: 'test_pass' });
    const ticket = authResult.authenticateResult.string[0];
    svc.sendRequestXML({ ticket });

    const result = svc.receiveResponseXML({ ticket, response: inventoryResponseXml });
    assert.ok(typeof result.receiveResponseXMLResult === 'number');
    assert.ok(result.receiveResponseXMLResult >= 0);

    // Give async processResponse time to finish
    await new Promise(r => setTimeout(r, 200));

    // Verify item was cached
    const items = cache.getAllInventory();
    assert.equal(items.length, 1);
    assert.equal(items[0].name, 'Widget A');

    config.sync.inventoryEveryN = 1;
    config.sync.customerEveryN = 5;
  });

  it('receiveResponseXML returns -1 on hresult error', () => {
    config.sync.inventoryEveryN = 999;
    config.sync.customerEveryN = 999;

    queue.addToQueue({ type: 'Test', qbxml: '<t/>' });
    const authResult = svc.authenticate({ strUserName: 'test_user', strPassword: 'test_pass' });
    const ticket = authResult.authenticateResult.string[0];
    svc.sendRequestXML({ ticket });

    const result = svc.receiveResponseXML({ ticket, response: '', hresult: '0x80040400', message: 'QB Error' });
    assert.equal(result.receiveResponseXMLResult, -1);

    config.sync.inventoryEveryN = 1;
    config.sync.customerEveryN = 5;
  });

  it('receiveResponseXML fires webhooks on sales order creation', async () => {
    config.sync.inventoryEveryN = 999;
    config.sync.customerEveryN = 999;

    queue.addToQueue({
      type: 'SalesOrderAdd',
      qbxml: '<so/>',
      priority: queue.PRIORITY.USER_ACTION,
      callbackUrl: 'https://example.com/hook',
    });

    const authResult = svc.authenticate({ strUserName: 'test_user', strPassword: 'test_pass' });
    const ticket = authResult.authenticateResult.string[0];
    svc.sendRequestXML({ ticket });

    svc.receiveResponseXML({ ticket, response: salesOrderAddResponseXml });

    await new Promise(r => setTimeout(r, 300));

    const orderCreated = webhookCalls.filter(c => c.event === 'order_created');
    assert.ok(orderCreated.length >= 1, 'order_created webhook should fire');
    assert.equal(orderCreated[0].payload.txnId, 'TXN-SO-099');

    const callbacks = webhookCalls.filter(c => c.event === 'callback');
    assert.ok(callbacks.length >= 1, 'callback webhook should fire');

    config.sync.inventoryEveryN = 1;
    config.sync.customerEveryN = 5;
  });

  it('getLastError returns empty string when no error', () => {
    config.sync.inventoryEveryN = 999;
    config.sync.customerEveryN = 999;

    queue.addToQueue({ type: 'Test', qbxml: '<t/>' });
    const authResult = svc.authenticate({ strUserName: 'test_user', strPassword: 'test_pass' });
    const ticket = authResult.authenticateResult.string[0];

    const result = svc.getLastError({ ticket });
    assert.equal(result.getLastErrorResult, '');

    config.sync.inventoryEveryN = 1;
    config.sync.customerEveryN = 5;
  });

  it('closeConnection returns OK', () => {
    config.sync.inventoryEveryN = 999;
    config.sync.customerEveryN = 999;

    queue.addToQueue({ type: 'Test', qbxml: '<t/>' });
    const authResult = svc.authenticate({ strUserName: 'test_user', strPassword: 'test_pass' });
    const ticket = authResult.authenticateResult.string[0];

    const result = svc.closeConnection({ ticket });
    assert.equal(result.closeConnectionResult, 'OK');

    config.sync.inventoryEveryN = 1;
    config.sync.customerEveryN = 5;
  });

  it('connectionError marks request as errored and returns done', () => {
    config.sync.inventoryEveryN = 999;
    config.sync.customerEveryN = 999;

    const qId = queue.addToQueue({ type: 'Test', qbxml: '<t/>' });
    const authResult = svc.authenticate({ strUserName: 'test_user', strPassword: 'test_pass' });
    const ticket = authResult.authenticateResult.string[0];
    svc.sendRequestXML({ ticket }); // marks as sent

    const result = svc.connectionError({ ticket, hresult: '0x80040400', message: 'Connection lost' });
    assert.equal(result.connectionErrorResult, 'done');

    const item = queue.getById(qId);
    assert.equal(item.status, 'error');

    config.sync.inventoryEveryN = 1;
    config.sync.customerEveryN = 5;
  });

  it('full lifecycle: authenticate → sendRequest → receiveResponse → close', async () => {
    config.sync.inventoryEveryN = 999;
    config.sync.customerEveryN = 999;

    queue.addToQueue({ type: 'ItemInventoryQuery', qbxml: '<inv/>' });

    // 1. Authenticate
    const authResult = svc.authenticate({ strUserName: 'test_user', strPassword: 'test_pass' });
    const ticket = authResult.authenticateResult.string[0];
    assert.ok(ticket);

    // 2. sendRequestXML
    const sendResult = svc.sendRequestXML({ ticket });
    assert.ok(sendResult.sendRequestXMLResult.length > 0);

    // 3. receiveResponseXML
    const recvResult = svc.receiveResponseXML({ ticket, response: inventoryResponseXml });
    assert.ok(recvResult.receiveResponseXMLResult >= 0);

    // 4. sendRequestXML again (should be empty now)
    const send2 = svc.sendRequestXML({ ticket });
    assert.equal(send2.sendRequestXMLResult, '');

    // 5. closeConnection
    const closeResult = svc.closeConnection({ ticket });
    assert.equal(closeResult.closeConnectionResult, 'OK');

    await new Promise(r => setTimeout(r, 200));

    // Verify inventory was cached
    assert.ok(cache.getAllInventory().length >= 1);

    config.sync.inventoryEveryN = 1;
    config.sync.customerEveryN = 5;
  });
});
