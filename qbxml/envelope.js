const config = require('../config');

/**
 * Wrap inner QBXML request XML in the standard QBXML envelope.
 * QB Desktop requires this exact format with the processing instruction.
 */
function wrapInEnvelope(innerXml) {
  const version = config.qbwc.xmlVersion;
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<?qbxml version="${version}"?>`,
    '<QBXML>',
    '  <QBXMLMsgsRq onError="stopOnError">',
    `    ${innerXml}`,
    '  </QBXMLMsgsRq>',
    '</QBXML>',
  ].join('\n');
}

module.exports = { wrapInEnvelope };
