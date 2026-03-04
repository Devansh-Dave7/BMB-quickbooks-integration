const config = require('../config');

/**
 * API key authentication middleware.
 * Expects the key in the X-API-Key header.
 */
function apiKeyAuth(req, res, next) {
  if (!config.apiKey) {
    console.warn('[SECURITY] API_KEY is not configured — rejecting all REST requests');
    return res.status(500).json({ error: 'Server misconfigured: API key not set' });
  }

  const providedKey = req.headers['x-api-key'];

  if (!providedKey) {
    return res.status(401).json({ error: 'Missing X-API-Key header' });
  }

  // Constant-time comparison to prevent timing attacks
  if (!timingSafeEqual(providedKey, config.apiKey)) {
    return res.status(403).json({ error: 'Invalid API key' });
  }

  next();
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;

  const crypto = require('crypto');
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Request validation middleware factory.
 * Takes a validation function that returns an array of error strings.
 */
function validate(validationFn) {
  return (req, res, next) => {
    const errors = validationFn(req.body);
    if (errors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }
    next();
  };
}

/**
 * Generic error handler middleware.
 */
function errorHandler(err, req, res, _next) {
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);

  if (config.nodeEnv === 'production') {
    return res.status(500).json({ error: 'Internal server error' });
  }

  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
    stack: err.stack,
  });
}

module.exports = {
  apiKeyAuth,
  validate,
  errorHandler,
};
