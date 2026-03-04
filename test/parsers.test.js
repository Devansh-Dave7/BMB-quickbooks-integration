const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

require('./_setup');
const {
  parseCustomerQueryRs,
  parseItemQueryRs,
  parseItemInventoryQueryRs,
  parseSalesOrderAddRs,
  parseSalesOrderQueryRs,
  parseInvoiceAddRs,
  parseInvoiceQueryRs,
  parseErrorResponse,
  detectResponseType,
} = require('../qbxml/parsers');

// ─── Fixtures ────────────────────────────────────────────────────

const customerQueryRsXml = `<?xml version="1.0" ?>
<QBXML>
<QBXMLMsgsRs>
<CustomerQueryRs statusCode="0" statusSeverity="Info" statusMessage="Status OK">
  <CustomerRet>
    <ListID>80000001-1234</ListID>
    <Name>Acme Corp</Name>
    <FullName>Acme Corp</FullName>
    <CompanyName>Acme Corporation</CompanyName>
    <Phone>555-0100</Phone>
    <Email>acme@example.com</Email>
    <Balance>1500.00</Balance>
    <IsActive>true</IsActive>
    <BillAddress>
      <Addr1>123 Main St</Addr1>
      <City>Springfield</City>
      <State>IL</State>
      <PostalCode>62701</PostalCode>
    </BillAddress>
  </CustomerRet>
</CustomerQueryRs>
</QBXMLMsgsRs>
</QBXML>`;

const multiCustomerXml = `<?xml version="1.0" ?>
<QBXML>
<QBXMLMsgsRs>
<CustomerQueryRs statusCode="0" statusSeverity="Info" statusMessage="Status OK">
  <CustomerRet>
    <ListID>80000001-1234</ListID>
    <Name>Acme Corp</Name>
    <FullName>Acme Corp</FullName>
    <IsActive>true</IsActive>
  </CustomerRet>
  <CustomerRet>
    <ListID>80000002-5678</ListID>
    <Name>Beta Inc</Name>
    <FullName>Beta Inc</FullName>
    <IsActive>false</IsActive>
  </CustomerRet>
</CustomerQueryRs>
</QBXMLMsgsRs>
</QBXML>`;

const customerErrorXml = `<?xml version="1.0" ?>
<QBXML>
<QBXMLMsgsRs>
<CustomerQueryRs statusCode="1" statusSeverity="Error" statusMessage="Could not find customer">
</CustomerQueryRs>
</QBXMLMsgsRs>
</QBXML>`;

const itemInventoryQueryRsXml = `<?xml version="1.0" ?>
<QBXML>
<QBXMLMsgsRs>
<ItemInventoryQueryRs statusCode="0" statusSeverity="Info" statusMessage="Status OK">
  <ItemInventoryRet>
    <ListID>80000010-0001</ListID>
    <Name>Widget A</Name>
    <FullName>Inventory:Widget A</FullName>
    <IsActive>true</IsActive>
    <QuantityOnHand>100</QuantityOnHand>
    <QuantityOnOrder>50</QuantityOnOrder>
    <QuantityOnSalesOrder>25</QuantityOnSalesOrder>
    <SalesPrice>19.99</SalesPrice>
    <PurchaseCost>8.50</PurchaseCost>
  </ItemInventoryRet>
</ItemInventoryQueryRs>
</QBXMLMsgsRs>
</QBXML>`;

const itemQueryRsXml = `<?xml version="1.0" ?>
<QBXML>
<QBXMLMsgsRs>
<ItemQueryRs statusCode="0" statusSeverity="Info" statusMessage="Status OK">
  <ItemInventoryRet>
    <ListID>80000010-0001</ListID>
    <Name>Widget A</Name>
    <FullName>Inventory:Widget A</FullName>
    <IsActive>true</IsActive>
    <QuantityOnHand>100</QuantityOnHand>
  </ItemInventoryRet>
  <ItemServiceRet>
    <ListID>80000020-0001</ListID>
    <Name>Consulting</Name>
    <FullName>Service:Consulting</FullName>
    <IsActive>true</IsActive>
    <SalesOrPurchase>
      <Price>200.00</Price>
    </SalesOrPurchase>
  </ItemServiceRet>
</ItemQueryRs>
</QBXMLMsgsRs>
</QBXML>`;

const salesOrderAddRsXml = `<?xml version="1.0" ?>
<QBXML>
<QBXMLMsgsRs>
<SalesOrderAddRs statusCode="0" statusSeverity="Info" statusMessage="Status OK">
  <SalesOrderRet>
    <TxnID>TXN-SO-001</TxnID>
    <RefNumber>SO-1001</RefNumber>
    <CustomerRef>
      <ListID>80000001-1234</ListID>
      <FullName>Acme Corp</FullName>
    </CustomerRef>
    <TotalAmount>199.90</TotalAmount>
  </SalesOrderRet>
</SalesOrderAddRs>
</QBXMLMsgsRs>
</QBXML>`;

const salesOrderAddErrorXml = `<?xml version="1.0" ?>
<QBXML>
<QBXMLMsgsRs>
<SalesOrderAddRs statusCode="3120" statusSeverity="Error" statusMessage="Object not found">
</SalesOrderAddRs>
</QBXMLMsgsRs>
</QBXML>`;

const salesOrderQueryRsXml = `<?xml version="1.0" ?>
<QBXML>
<QBXMLMsgsRs>
<SalesOrderQueryRs statusCode="0" statusSeverity="Info" statusMessage="Status OK">
  <SalesOrderRet>
    <TxnID>TXN-SO-001</TxnID>
    <RefNumber>SO-1001</RefNumber>
    <CustomerRef><FullName>Acme Corp</FullName></CustomerRef>
    <TotalAmount>199.90</TotalAmount>
    <IsManuallyClosed>false</IsManuallyClosed>
    <IsFullyInvoiced>true</IsFullyInvoiced>
  </SalesOrderRet>
</SalesOrderQueryRs>
</QBXMLMsgsRs>
</QBXML>`;

const invoiceAddRsXml = `<?xml version="1.0" ?>
<QBXML>
<QBXMLMsgsRs>
<InvoiceAddRs statusCode="0" statusSeverity="Info" statusMessage="Status OK">
  <InvoiceRet>
    <TxnID>TXN-INV-001</TxnID>
    <RefNumber>INV-2001</RefNumber>
    <CustomerRef>
      <ListID>80000001-1234</ListID>
      <FullName>Acme Corp</FullName>
    </CustomerRef>
    <TotalAmount>500.00</TotalAmount>
  </InvoiceRet>
</InvoiceAddRs>
</QBXMLMsgsRs>
</QBXML>`;

const invoiceQueryRsXml = `<?xml version="1.0" ?>
<QBXML>
<QBXMLMsgsRs>
<InvoiceQueryRs statusCode="0" statusSeverity="Info" statusMessage="Status OK">
  <InvoiceRet>
    <TxnID>TXN-INV-001</TxnID>
    <RefNumber>INV-2001</RefNumber>
    <CustomerRef><FullName>Acme Corp</FullName></CustomerRef>
    <TotalAmount>500.00</TotalAmount>
    <IsPaid>false</IsPaid>
  </InvoiceRet>
</InvoiceQueryRs>
</QBXMLMsgsRs>
</QBXML>`;

// ─── Tests ───────────────────────────────────────────────────────

describe('parseCustomerQueryRs', () => {
  it('parses single customer response', async () => {
    const { status, customers } = await parseCustomerQueryRs(customerQueryRsXml);
    assert.equal(status.statusCode, 0);
    assert.equal(customers.length, 1);
    const c = customers[0];
    assert.equal(c.listId, '80000001-1234');
    assert.equal(c.name, 'Acme Corp');
    assert.equal(c.companyName, 'Acme Corporation');
    assert.equal(c.phone, '555-0100');
    assert.equal(c.email, 'acme@example.com');
    assert.equal(c.balance, 1500);
    assert.equal(c.isActive, true);
    assert.equal(c.billingAddress.addr1, '123 Main St');
    assert.equal(c.billingAddress.city, 'Springfield');
  });

  it('parses multiple customers', async () => {
    const { customers } = await parseCustomerQueryRs(multiCustomerXml);
    assert.equal(customers.length, 2);
    assert.equal(customers[0].name, 'Acme Corp');
    assert.equal(customers[1].name, 'Beta Inc');
    assert.equal(customers[1].isActive, false);
  });

  it('returns empty customers on error status', async () => {
    const { status, customers } = await parseCustomerQueryRs(customerErrorXml);
    assert.equal(status.statusCode, 1);
    assert.equal(customers.length, 0);
  });
});

describe('parseItemQueryRs', () => {
  it('parses mixed item types', async () => {
    const { status, items } = await parseItemQueryRs(itemQueryRsXml);
    assert.equal(status.statusCode, 0);
    assert.equal(items.length, 2);
    assert.equal(items[0].name, 'Widget A');
    assert.equal(items[0].itemType, 'Inventory');
    assert.equal(items[0].qtyOnHand, 100);
    assert.equal(items[1].name, 'Consulting');
    assert.equal(items[1].itemType, 'Service');
    assert.equal(items[1].salesPrice, 200);
  });
});

describe('parseItemInventoryQueryRs', () => {
  it('parses inventory items', async () => {
    const { status, items } = await parseItemInventoryQueryRs(itemInventoryQueryRsXml);
    assert.equal(status.statusCode, 0);
    assert.equal(items.length, 1);
    const item = items[0];
    assert.equal(item.listId, '80000010-0001');
    assert.equal(item.name, 'Widget A');
    assert.equal(item.qtyOnHand, 100);
    assert.equal(item.qtyOnOrder, 50);
    assert.equal(item.qtyOnSalesOrder, 25);
    assert.equal(item.salesPrice, 19.99);
    assert.equal(item.cost, 8.5);
    assert.equal(item.itemType, 'Inventory');
  });
});

describe('parseSalesOrderAddRs', () => {
  it('parses successful sales order creation', async () => {
    const { status, order } = await parseSalesOrderAddRs(salesOrderAddRsXml);
    assert.equal(status.statusCode, 0);
    assert.ok(order);
    assert.equal(order.txnId, 'TXN-SO-001');
    assert.equal(order.txnNumber, 'SO-1001');
    assert.equal(order.customerName, 'Acme Corp');
    assert.equal(order.total, 199.90);
  });

  it('returns null order on error', async () => {
    const { status, order } = await parseSalesOrderAddRs(salesOrderAddErrorXml);
    assert.equal(status.statusCode, 3120);
    assert.equal(order, null);
  });
});

describe('parseSalesOrderQueryRs', () => {
  it('parses order query response', async () => {
    const { orders } = await parseSalesOrderQueryRs(salesOrderQueryRsXml);
    assert.equal(orders.length, 1);
    assert.equal(orders[0].txnId, 'TXN-SO-001');
    assert.equal(orders[0].isFullyInvoiced, true);
    assert.equal(orders[0].isManuallyClosed, false);
  });
});

describe('parseInvoiceAddRs', () => {
  it('parses successful invoice creation', async () => {
    const { status, invoice } = await parseInvoiceAddRs(invoiceAddRsXml);
    assert.equal(status.statusCode, 0);
    assert.ok(invoice);
    assert.equal(invoice.txnId, 'TXN-INV-001');
    assert.equal(invoice.txnNumber, 'INV-2001');
    assert.equal(invoice.customerName, 'Acme Corp');
    assert.equal(invoice.total, 500);
  });
});

describe('parseInvoiceQueryRs', () => {
  it('parses invoice query response', async () => {
    const { invoices } = await parseInvoiceQueryRs(invoiceQueryRsXml);
    assert.equal(invoices.length, 1);
    assert.equal(invoices[0].txnId, 'TXN-INV-001');
    assert.equal(invoices[0].isPaid, false);
  });
});

describe('parseErrorResponse', () => {
  it('extracts status from any response type', async () => {
    const status = await parseErrorResponse(salesOrderAddErrorXml);
    assert.equal(status.statusCode, 3120);
    assert.equal(status.statusSeverity, 'Error');
    assert.equal(status.statusMessage, 'Object not found');
  });
});

describe('detectResponseType', () => {
  it('detects CustomerQueryRs', async () => {
    assert.equal(await detectResponseType(customerQueryRsXml), 'CustomerQueryRs');
  });

  it('detects SalesOrderAddRs', async () => {
    assert.equal(await detectResponseType(salesOrderAddRsXml), 'SalesOrderAddRs');
  });

  it('detects InvoiceAddRs', async () => {
    assert.equal(await detectResponseType(invoiceAddRsXml), 'InvoiceAddRs');
  });

  it('detects ItemInventoryQueryRs', async () => {
    assert.equal(await detectResponseType(itemInventoryQueryRsXml), 'ItemInventoryQueryRs');
  });

  it('detects InvoiceQueryRs', async () => {
    assert.equal(await detectResponseType(invoiceQueryRsXml), 'InvoiceQueryRs');
  });
});
