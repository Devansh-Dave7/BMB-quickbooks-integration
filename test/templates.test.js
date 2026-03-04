const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

require('./_setup');
const {
  escXml,
  buildCustomerQuery,
  buildItemQuery,
  buildItemInventoryQuery,
  buildSalesOrderAdd,
  buildSalesOrderQuery,
  buildInvoiceAdd,
  buildInvoiceQuery,
} = require('../qbxml/templates');

describe('escXml', () => {
  it('escapes ampersand', () => {
    assert.equal(escXml('A&B'), 'A&amp;B');
  });

  it('escapes angle brackets', () => {
    assert.equal(escXml('<tag>'), '&lt;tag&gt;');
  });

  it('escapes quotes', () => {
    assert.equal(escXml('"hello" & \'world\''), '&quot;hello&quot; &amp; &apos;world&apos;');
  });

  it('returns empty string for null/undefined', () => {
    assert.equal(escXml(null), '');
    assert.equal(escXml(undefined), '');
  });

  it('coerces numbers to string', () => {
    assert.equal(escXml(42), '42');
  });
});

describe('buildCustomerQuery', () => {
  it('builds default query with MaxReturned 500', () => {
    const xml = buildCustomerQuery();
    assert.ok(xml.includes('<CustomerQueryRq>'));
    assert.ok(xml.includes('<MaxReturned>500</MaxReturned>'));
    assert.ok(xml.includes('<ActiveStatus>ActiveOnly</ActiveStatus>'));
  });

  it('builds query with exact fullName', () => {
    const xml = buildCustomerQuery({ fullName: 'Acme Corp' });
    assert.ok(xml.includes('<FullName>Acme Corp</FullName>'));
    assert.ok(!xml.includes('<MaxReturned>'));
  });

  it('builds query with name filter', () => {
    const xml = buildCustomerQuery({ nameFilter: { matchCriterion: 'StartsWith', name: 'Acme' } });
    assert.ok(xml.includes('<NameFilter>'));
    assert.ok(xml.includes('<MatchCriterion>StartsWith</MatchCriterion>'));
    assert.ok(xml.includes('<Name>Acme</Name>'));
  });

  it('escapes special characters in fullName', () => {
    const xml = buildCustomerQuery({ fullName: 'A&B <Corp>' });
    assert.ok(xml.includes('A&amp;B &lt;Corp&gt;'));
  });
});

describe('buildItemQuery', () => {
  it('builds default query', () => {
    const xml = buildItemQuery();
    assert.ok(xml.includes('<ItemQueryRq>'));
    assert.ok(xml.includes('<MaxReturned>500</MaxReturned>'));
  });

  it('builds query with fullName', () => {
    const xml = buildItemQuery({ fullName: 'Widget' });
    assert.ok(xml.includes('<FullName>Widget</FullName>'));
  });
});

describe('buildItemInventoryQuery', () => {
  it('builds default inventory query', () => {
    const xml = buildItemInventoryQuery();
    assert.ok(xml.includes('<ItemInventoryQueryRq>'));
    assert.ok(xml.includes('<MaxReturned>500</MaxReturned>'));
  });

  it('respects custom maxReturned', () => {
    const xml = buildItemInventoryQuery({ maxReturned: 5000 });
    assert.ok(xml.includes('<MaxReturned>5000</MaxReturned>'));
  });
});

describe('buildSalesOrderAdd', () => {
  const baseOrder = {
    customerName: 'John Doe',
    items: [{ name: 'Widget A', qty: 2, rate: 9.99 }],
  };

  it('builds valid SalesOrderAddRq', () => {
    const xml = buildSalesOrderAdd(baseOrder);
    assert.ok(xml.includes('<SalesOrderAddRq>'));
    assert.ok(xml.includes('<SalesOrderAdd>'));
    assert.ok(xml.includes('<FullName>John Doe</FullName>'));
    assert.ok(xml.includes('<SalesOrderLineAdd>'));
    assert.ok(xml.includes('<FullName>Widget A</FullName>'));
    assert.ok(xml.includes('<Quantity>2</Quantity>'));
    assert.ok(xml.includes('<Rate>9.99</Rate>'));
  });

  it('uses customerRef when provided', () => {
    const xml = buildSalesOrderAdd({ ...baseOrder, customerRef: 'Acme:Main' });
    assert.ok(xml.includes('<FullName>Acme:Main</FullName>'));
  });

  it('includes optional PO number and memo', () => {
    const xml = buildSalesOrderAdd({ ...baseOrder, poNumber: 'PO-123', memo: 'Test memo' });
    assert.ok(xml.includes('<PONumber>PO-123</PONumber>'));
    assert.ok(xml.includes('<Memo>Test memo</Memo>'));
  });

  it('defaults quantity to 1 when not provided', () => {
    const xml = buildSalesOrderAdd({ customerName: 'X', items: [{ name: 'Item' }] });
    assert.ok(xml.includes('<Quantity>1</Quantity>'));
  });
});

describe('buildSalesOrderQuery', () => {
  it('builds query with txnId', () => {
    const xml = buildSalesOrderQuery({ txnId: 'TXN-123' });
    assert.ok(xml.includes('<TxnID>TXN-123</TxnID>'));
    assert.ok(!xml.includes('<MaxReturned>'));
  });

  it('builds query with customerFullName', () => {
    const xml = buildSalesOrderQuery({ customerFullName: 'Acme' });
    assert.ok(xml.includes('<EntityFilter>'));
    assert.ok(xml.includes('<FullName>Acme</FullName>'));
    assert.ok(xml.includes('<MaxReturned>50</MaxReturned>'));
  });
});

describe('buildInvoiceAdd', () => {
  it('builds valid InvoiceAddRq', () => {
    const xml = buildInvoiceAdd({
      customerName: 'Jane Doe',
      items: [{ name: 'Service B', description: 'Consulting', qty: 1, rate: 150.00 }],
    });
    assert.ok(xml.includes('<InvoiceAddRq>'));
    assert.ok(xml.includes('<InvoiceAdd>'));
    assert.ok(xml.includes('<FullName>Jane Doe</FullName>'));
    assert.ok(xml.includes('<InvoiceLineAdd>'));
    assert.ok(xml.includes('<Desc>Consulting</Desc>'));
    assert.ok(xml.includes('<Rate>150.00</Rate>'));
  });
});

describe('buildInvoiceQuery', () => {
  it('builds query with refNumber', () => {
    const xml = buildInvoiceQuery({ refNumber: 'INV-001' });
    assert.ok(xml.includes('<RefNumber>INV-001</RefNumber>'));
  });

  it('builds default query with MaxReturned 50', () => {
    const xml = buildInvoiceQuery();
    assert.ok(xml.includes('<InvoiceQueryRq>'));
    assert.ok(xml.includes('<MaxReturned>50</MaxReturned>'));
  });
});
