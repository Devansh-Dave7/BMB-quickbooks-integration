const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Override config before loading module
require('./_setup');
const { wrapInEnvelope } = require('../qbxml/envelope');

describe('wrapInEnvelope', () => {
  it('wraps inner XML in QBXML envelope', () => {
    const inner = '<CustomerQueryRq></CustomerQueryRq>';
    const result = wrapInEnvelope(inner);

    assert.ok(result.includes('<?xml version="1.0" encoding="utf-8"?>'));
    assert.ok(result.includes('<?qbxml version="16.0"?>'));
    assert.ok(result.includes('<QBXML>'));
    assert.ok(result.includes('<QBXMLMsgsRq onError="stopOnError">'));
    assert.ok(result.includes(inner));
    assert.ok(result.includes('</QBXMLMsgsRq>'));
    assert.ok(result.includes('</QBXML>'));
  });

  it('uses configured XML version', () => {
    const result = wrapInEnvelope('<Test/>');
    assert.match(result, /qbxml version="16\.0"/);
  });

  it('returns multi-line string with correct structure', () => {
    const result = wrapInEnvelope('<InnerRq/>');
    const lines = result.split('\n');
    assert.equal(lines.length, 7);
    assert.equal(lines[0], '<?xml version="1.0" encoding="utf-8"?>');
    assert.equal(lines[6], '</QBXML>');
  });
});
