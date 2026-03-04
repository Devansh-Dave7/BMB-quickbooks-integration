const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { validateOrderPayload, validateQueryPayload } = require('../api/validators');

describe('validateOrderPayload', () => {
  it('passes valid payload', () => {
    const errors = validateOrderPayload({
      customer_name: 'Acme Corp',
      items: [{ name: 'Widget', qty: 2, rate: 10 }],
    });
    assert.equal(errors.length, 0);
  });

  it('requires customer_name', () => {
    const errors = validateOrderPayload({ items: [{ name: 'Widget' }] });
    assert.ok(errors.some(e => e.includes('customer_name')));
  });

  it('requires items array', () => {
    const errors = validateOrderPayload({ customer_name: 'Acme' });
    assert.ok(errors.some(e => e.includes('items')));
  });

  it('rejects empty items array', () => {
    const errors = validateOrderPayload({ customer_name: 'Acme', items: [] });
    assert.ok(errors.some(e => e.includes('items')));
  });

  it('requires item name', () => {
    const errors = validateOrderPayload({
      customer_name: 'Acme',
      items: [{ qty: 1 }],
    });
    assert.ok(errors.some(e => e.includes('items[0].name')));
  });

  it('rejects negative qty', () => {
    const errors = validateOrderPayload({
      customer_name: 'Acme',
      items: [{ name: 'Widget', qty: -1 }],
    });
    assert.ok(errors.some(e => e.includes('qty')));
  });

  it('rejects negative rate', () => {
    const errors = validateOrderPayload({
      customer_name: 'Acme',
      items: [{ name: 'Widget', rate: -5 }],
    });
    assert.ok(errors.some(e => e.includes('rate')));
  });

  it('allows optional callback_url string', () => {
    const errors = validateOrderPayload({
      customer_name: 'Acme',
      items: [{ name: 'Widget' }],
      callback_url: 'https://example.com/hook',
    });
    assert.equal(errors.length, 0);
  });

  it('rejects non-string callback_url', () => {
    const errors = validateOrderPayload({
      customer_name: 'Acme',
      items: [{ name: 'Widget' }],
      callback_url: 123,
    });
    assert.ok(errors.some(e => e.includes('callback_url')));
  });

  it('rejects non-object body', () => {
    const errors = validateOrderPayload(null);
    assert.ok(errors.length > 0);
  });
});

describe('validateQueryPayload', () => {
  it('passes valid payload', () => {
    const errors = validateQueryPayload({ type: 'CustomerQuery' });
    assert.equal(errors.length, 0);
  });

  it('requires type', () => {
    const errors = validateQueryPayload({});
    assert.ok(errors.some(e => e.includes('type')));
  });

  it('rejects invalid type', () => {
    const errors = validateQueryPayload({ type: 'FooQuery' });
    assert.ok(errors.some(e => e.includes('type')));
  });

  it('allows all valid types', () => {
    for (const type of ['CustomerQuery', 'ItemQuery', 'ItemInventoryQuery', 'SalesOrderQuery', 'InvoiceQuery']) {
      const errors = validateQueryPayload({ type });
      assert.equal(errors.length, 0, `${type} should be valid`);
    }
  });

  it('allows optional params object', () => {
    const errors = validateQueryPayload({ type: 'CustomerQuery', params: { fullName: 'Test' } });
    assert.equal(errors.length, 0);
  });

  it('rejects non-object params', () => {
    const errors = validateQueryPayload({ type: 'CustomerQuery', params: 'bad' });
    assert.ok(errors.some(e => e.includes('params')));
  });

  it('rejects non-object body', () => {
    const errors = validateQueryPayload(null);
    assert.ok(errors.length > 0);
  });
});
